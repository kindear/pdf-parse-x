import 'dotenv/config';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { convertPdfToMarkdown } from './lib/pdf-parser.js';
import { buildPreviewHtml, collectResources } from './lib/preview.js';
import { createConsoleProgress } from './lib/progress.js';
import { getTranslateConfig, translateOutputDir } from './lib/translate.js';
import { safeOutputName } from './lib/text-utils.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');
const webRoot = path.join(currentDir, 'web');
const outputRoot = path.join(projectRoot, 'output');
const samplePdfName = process.env.SAMPLE_PDF ?? 'software-05-00038.pdf';
const samplePdf = path.isAbsolute(samplePdfName)
  ? samplePdfName
  : [path.join(projectRoot, 'pdfs', samplePdfName), path.join(projectRoot, samplePdfName)].find(
      (candidate) => existsSync(candidate)
    ) ?? path.join(projectRoot, samplePdfName);
const port = Number(process.env.PORT ?? 3000);

await mkdir(outputRoot, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension !== '.pdf') {
      callback(new Error('只支持 PDF 文件。'));
      return;
    }
    callback(null, true);
  }
});

function validJobId(value) {
  // Dots are allowed so ids such as `2102.08942v1` stay addressable; `..` is
  // still rejected explicitly and `jobDir` re-checks the resolved path.
  return (
    typeof value === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,120}$/i.test(value) &&
    !value.includes('..')
  );
}

function jobDir(jobId) {
  if (!validJobId(jobId)) return null;
  const resolved = path.resolve(outputRoot, jobId);
  if (!resolved.startsWith(`${outputRoot}${path.sep}`)) return null;
  return resolved;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// --- live conversion progress -------------------------------------------------

const progressChannels = new Map();

function validProgressId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{7,63}$/i.test(value);
}

function broadcastProgress(progressId, event) {
  const listeners = progressChannels.get(progressId);
  if (!listeners) return;
  const frame = `event: progress\ndata: ${JSON.stringify(event)}\n\n`;
  for (const listener of listeners) {
    try {
      listener.write(frame);
    } catch {
      // A closed tab must not break the conversion.
    }
  }
}

function finishProgress(progressId, payload) {
  const listeners = progressChannels.get(progressId);
  if (!listeners) return;
  progressChannels.delete(progressId);
  const frame = `event: done\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners) {
    try {
      listener.write(frame);
      listener.end();
    } catch {
      // ignore
    }
  }
}

app.get('/api/progress/:id', (request, response) => {
  const id = request.params.id;
  if (!validProgressId(id)) {
    response.status(400).end();
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write('retry: 2000\n\n');

  const listeners = progressChannels.get(id) ?? new Set();
  listeners.add(response);
  progressChannels.set(id, listeners);

  const heartbeat = setInterval(() => {
    try {
      response.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 15000);

  request.on('close', () => {
    clearInterval(heartbeat);
    listeners.delete(response);
    if (!listeners.size) progressChannels.delete(id);
  });
});

function progressHandler(progressId, logStep = createConsoleProgress()) {
  return (event) => {
    logStep(event);
    if (progressId) broadcastProgress(progressId, event);
  };
}

/** Translation is opt-in: only an explicit `translate=true` starts it. */
function wantsTranslate(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

async function listDocuments() {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !validJobId(entry.name)) continue;
    const directory = path.join(outputRoot, entry.name);
    const [metadata, report] = await Promise.all([
      readJson(path.join(directory, 'metadata.json')),
      readJson(path.join(directory, 'report.json'))
    ]);
    if (!metadata && !report) continue;

    let generatedAt = metadata?.generatedAt ?? report?.generatedAt ?? null;
    if (!generatedAt) {
      try {
        generatedAt = (await stat(path.join(directory, 'main.md'))).mtime.toISOString();
      } catch {
        generatedAt = null;
      }
    }

    const hasChinese = await stat(path.join(directory, 'main_zh.md'))
      .then(() => true)
      .catch(() => false);

    documents.push({
      id: entry.name,
      title: metadata?.title ?? report?.title ?? entry.name,
      sourceFile: metadata?.sourceFile ?? `${entry.name}.pdf`,
      pages: report?.pages ?? 0,
      figures: report?.figures ?? 0,
      tables: report?.tables ?? 0,
      equations: report?.equations ?? 0,
      coverage: report?.tokenCoverage ?? null,
      hasChinese,
      generatedAt,
      previewUrl: `/preview/${encodeURIComponent(entry.name)}`,
      chinesePreviewUrl: hasChinese
        ? `/preview/${encodeURIComponent(entry.name)}?lang=zh`
        : null,
      markdownUrl: `/output/${encodeURIComponent(entry.name)}/main.md`,
      reportUrl: `/output/${encodeURIComponent(entry.name)}/report.json`
    });
  }

  return documents.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

app.get('/api/documents', async (_request, response, next) => {
  try {
    response.json({ documents: await listDocuments() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', async (request, response, next) => {
  try {
    const directory = jobDir(request.params.id);
    if (!directory) {
      response.status(400).json({ error: '无效的文档 ID。' });
      return;
    }
    const [metadata, report] = await Promise.all([
      readJson(path.join(directory, 'metadata.json')),
      readJson(path.join(directory, 'report.json'))
    ]);
    if (!metadata && !report) {
      response.status(404).json({ error: '文档不存在。' });
      return;
    }
    response.json({ metadata, report });
  } catch (error) {
    next(error);
  }
});

app.post('/api/convert', upload.single('pdf'), async (request, response, next) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: '请选择一个 PDF 文件。' });
      return;
    }

    const base = safeOutputName(
      path.basename(request.file.originalname, path.extname(request.file.originalname))
    );
    const jobId = `${base}-${Date.now().toString(36)}`;
    const outputDir = path.join(outputRoot, jobId);
    const progressId = validProgressId(request.body?.progressId)
      ? request.body.progressId
      : null;
    const wantsTranslation = wantsTranslate(request.body?.translate);

    let result;
    try {
      result = await convertPdfToMarkdown(request.file.buffer, {
        sourceName: request.file.originalname,
        outputDir,
        translate: wantsTranslation ? { enabled: true } : undefined,
        onProgress: progressHandler(progressId)
      });
    } catch (error) {
      finishProgress(progressId, { ok: false, error: error.message });
      throw error;
    }
    finishProgress(progressId, { ok: true, id: jobId });

    response.json({
      id: jobId,
      title: result.metadata.title,
      hasChinese: Boolean(result.mainZhPath),
      previewUrl: `/preview/${encodeURIComponent(jobId)}`,
      chinesePreviewUrl: result.mainZhPath
        ? `/preview/${encodeURIComponent(jobId)}?lang=zh`
        : null,
      markdownUrl: `/output/${encodeURIComponent(jobId)}/main.md`,
      reportUrl: `/output/${encodeURIComponent(jobId)}/report.json`,
      report: result.report
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/convert-sample', async (request, response, next) => {
  try {
    if (!existsSync(samplePdf)) {
      response.status(404).json({ error: '工作区中没有找到示例 PDF。' });
      return;
    }

    const jobId = safeOutputName(
      path.basename(samplePdf, path.extname(samplePdf))
    );
    const outputDir = path.join(outputRoot, jobId);
    const progressId = validProgressId(request.body?.progressId)
      ? request.body.progressId
      : null;
    const wantsTranslation = wantsTranslate(request.body?.translate);

    let result;
    try {
      result = await convertPdfToMarkdown(samplePdf, {
        outputDir,
        translate: wantsTranslation ? { enabled: true } : undefined,
        onProgress: progressHandler(progressId)
      });
    } catch (error) {
      finishProgress(progressId, { ok: false, error: error.message });
      throw error;
    }
    finishProgress(progressId, { ok: true, id: jobId });

    response.json({
      id: jobId,
      title: result.metadata.title,
      hasChinese: Boolean(result.mainZhPath),
      previewUrl: `/preview/${encodeURIComponent(jobId)}`,
      chinesePreviewUrl: result.mainZhPath
        ? `/preview/${encodeURIComponent(jobId)}?lang=zh`
        : null,
      markdownUrl: `/output/${encodeURIComponent(jobId)}/main.md`,
      reportUrl: `/output/${encodeURIComponent(jobId)}/report.json`,
      report: result.report
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/:id/translate', async (request, response, next) => {
  try {
    const directory = jobDir(request.params.id);
    if (!directory) {
      response.status(400).json({ error: '无效的文档 ID。' });
      return;
    }

    const config = getTranslateConfig({ enabled: true });
    if (!config.enabled || !config.baseUrl) {
      response.status(400).json({
        error: '模型未配置，无法生成中文版（请设置 LLM_BASE_URL / LLM_API_KEY）。'
      });
      return;
    }

    const progressId = validProgressId(request.body?.progressId)
      ? request.body.progressId
      : null;
    const logStep = createConsoleProgress();
    const startedAt = Date.now();
    const emit = (status, extra = {}) => {
      const event = { index: 1, total: 1, label: '生成中文版', status, ...extra };
      logStep(event);
      if (progressId) broadcastProgress(progressId, event);
    };

    emit('start');
    const result = await translateOutputDir({
      directory,
      config,
      onProgress: ({ done, total }) => emit('progress', { progress: { done, total } })
    });

    if (!result.ok) {
      emit('error', { durationMs: Date.now() - startedAt, detail: result.error });
      finishProgress(progressId, { ok: false, error: result.error });
      response.status(400).json({ error: result.error });
      return;
    }

    emit('done', {
      durationMs: Date.now() - startedAt,
      detail: `${result.translated}/${result.total} 段 · ${result.markdown.length.toLocaleString('en-US')} 字符`
    });
    finishProgress(progressId, { ok: true, id: request.params.id });

    response.json({
      ok: true,
      id: request.params.id,
      translated: result.translated,
      total: result.total,
      failed: result.failed,
      chinesePreviewUrl: `/preview/${encodeURIComponent(request.params.id)}?lang=zh`
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/documents/:id', async (request, response, next) => {
  try {
    const directory = jobDir(request.params.id);
    if (!directory) {
      response.status(400).json({ error: '无效的文档 ID。' });
      return;
    }
    await rm(directory, { recursive: true, force: true });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/preview/:id', async (request, response, next) => {
  try {
    const id = request.params.id;
    if (!validJobId(id)) {
      response.status(400).send('无效的文档 ID。');
      return;
    }

    const directory = jobDir(id);
    const [markdown, chineseMarkdown] = await Promise.all([
      readFile(path.join(directory, 'main.md'), 'utf8').catch(() => null),
      readFile(path.join(directory, 'main_zh.md'), 'utf8').catch(() => null)
    ]);
    if (markdown === null && chineseMarkdown === null) {
      response.status(404).send('文档不存在。');
      return;
    }

    const lang = request.query.lang === 'zh' && chineseMarkdown ? 'zh' : 'en';
    const activeMarkdown = lang === 'zh' ? chineseMarkdown : markdown ?? chineseMarkdown;

    const [metadata, report] = await Promise.all([
      readJson(path.join(directory, 'metadata.json')),
      readJson(path.join(directory, 'report.json'))
    ]);
    const { figures, tables } = collectResources(activeMarkdown);
    const previewPath = `/preview/${encodeURIComponent(id)}`;
    const languages = [
      { code: 'en', label: 'English', href: previewPath },
      ...(chineseMarkdown
        ? [{ code: 'zh', label: '中文', href: `${previewPath}?lang=zh` }]
        : [])
    ];

    // Rendered on every request, so edits to main.md show up immediately and
    // no duplicate preview.html has to be stored next to the document.
    const html = buildPreviewHtml({
      title: metadata?.title,
      markdown: activeMarkdown,
      metadata: metadata ?? {},
      report: report ?? {},
      figures,
      tables,
      lang,
      languages,
      baseHref: `/output/${encodeURIComponent(id)}/`,
      backUrl: '/'
    });

    response.set('Cache-Control', 'no-store');
    response.type('html').send(html);
  } catch (error) {
    next(error);
  }
});

app.use('/output', express.static(outputRoot, { index: false }));
app.use(express.static(webRoot, { extensions: ['html'] }));

app.use((error, _request, response, _next) => {
  const status = error instanceof multer.MulterError ? 400 : 500;
  const message =
    error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
      ? '文件超过 100 MB 限制。'
      : error.message || '服务器处理失败。';
  console.error(error);
  response.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`pdf-parse-x preview server: http://localhost:${port}`);
});
