import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';
import {
  convertPdf,
  convertSample,
  documentDirectory,
  documentResources,
  getDocument,
  getDocumentRecord,
  listDocuments,
  outputRoot,
  projectRoot,
  readDocumentFormulas,
  readDocumentMarkdown,
  readJson,
  removeDocument,
  translateDocument
} from './lib/document-service.js';
import { buildPreviewHtml, collectResources } from './lib/preview.js';
import { createConsoleProgress } from './lib/progress.js';
import { API_ENDPOINTS } from './lib/api-catalog.js';
import { buildOpenApi } from './lib/openapi.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(currentDir, 'web');
const port = Number(process.env.PORT ?? 3000);
const packageInfo = await readJson(path.join(projectRoot, 'package.json'), {});
const mcpServerConfig = {
  command: 'node',
  args: [path.join(projectRoot, 'src', 'mcp.js')],
  cwd: projectRoot
};

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

function translateFlag(value) {
  return value === undefined ? undefined : wantsTranslate(value);
}

function requestBaseUrl(request) {
  const forwardedProto = request.get('x-forwarded-proto')?.split(',')[0].trim();
  const forwardedHost = request.get('x-forwarded-host')?.split(',')[0].trim();
  return `${forwardedProto || request.protocol}://${forwardedHost || request.get('host')}`;
}

function mcpHttpAuthorized(request) {
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token) return true;
  return request.get('authorization') === `Bearer ${token}`;
}

async function handleConvert(request, response, next) {
  try {
    if (!request.file) {
      response.status(400).json({ error: '请选择一个 PDF 文件。' });
      return;
    }

    const progressId = validProgressId(request.body?.progressId)
      ? request.body.progressId
      : null;
    let result;
    try {
      result = await convertPdf(request.file.buffer, {
        sourceName: request.file.originalname,
        translate: translateFlag(request.body?.translate),
        onProgress: progressHandler(progressId)
      });
    } catch (error) {
      finishProgress(progressId, { ok: false, error: error.message });
      throw error;
    }

    finishProgress(progressId, { ok: true, id: result.id });
    response
      .status(201)
      .location(`/api/documents/${encodeURIComponent(result.id)}`)
      .json(result);
  } catch (error) {
    next(error);
  }
}

app.get('/api/documents', async (_request, response, next) => {
  try {
    response.json({ documents: await listDocuments() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/openapi.json', (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json(
    buildOpenApi({
      baseUrl: requestBaseUrl(request),
      version: packageInfo.version ?? '1.0.0',
      mcpAuthRequired: Boolean(process.env.MCP_HTTP_TOKEN)
    })
  );
});

app.get('/api/meta', (request, response) => {
  const httpUrl = `${requestBaseUrl(request)}/mcp`;
  const authRequired = Boolean(process.env.MCP_HTTP_TOKEN);
  const httpHeaders = authRequired
    ? { headers: { Authorization: 'Bearer <MCP_HTTP_TOKEN>' } }
    : {};
  const stdio = {
    ...mcpServerConfig,
    vscode: {
      servers: { 'pdf-parse-x': { type: 'stdio', ...mcpServerConfig } }
    },
    generic: {
      mcpServers: {
        'pdf-parse-x': {
          command: mcpServerConfig.command,
          args: mcpServerConfig.args
        }
      }
    }
  };
  const http = {
    url: httpUrl,
    authRequired,
    vscode: {
      servers: { 'pdf-parse-x': { type: 'http', url: httpUrl, ...httpHeaders } }
    },
    generic: {
      mcpServers: { 'pdf-parse-x': { url: httpUrl, ...httpHeaders } }
    }
  };

  response.json({
    name: 'pdf-parse-x',
    version: packageInfo.version ?? '1.0.0',
    mcp: {
      ...mcpServerConfig,
      ...stdio,
      stdio,
      http
    },
    endpoints: API_ENDPOINTS
  });
});

app.post('/api/documents', upload.single('pdf'), handleConvert);
app.post('/api/convert', upload.single('pdf'), handleConvert);

app.get('/api/documents/:id', async (request, response, next) => {
  try {
    response.json(await getDocument(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/markdown', async (request, response, next) => {
  try {
    const lang = typeof request.query.lang === 'string' ? request.query.lang : 'en';
    const { markdown } = await readDocumentMarkdown(request.params.id, lang);
    response.type('text/markdown').send(markdown);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/metadata', async (request, response, next) => {
  try {
    const document = await getDocumentRecord(request.params.id);
    response.json(document.metadata);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/report', async (request, response, next) => {
  try {
    const document = await getDocumentRecord(request.params.id);
    response.json(document.report);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/formulas', async (request, response, next) => {
  try {
    response.json(await readDocumentFormulas(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/resources', async (request, response, next) => {
  try {
    const resources = await documentResources(request.params.id);
    response.json({ id: request.params.id, ...resources });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/translation', async (request, response, next) => {
  try {
    const document = await getDocumentRecord(request.params.id);
    response.json({
      id: document.id,
      hasChinese: document.hasChinese,
      translation: document.report?.translation ?? null,
      chinesePreviewUrl: document.chinesePreviewUrl,
      chineseMarkdownUrl: document.chineseMarkdownUrl
    });
  } catch (error) {
    next(error);
  }
});

async function handleSampleConversion(request, response, next) {
  try {
    const progressId = validProgressId(request.body?.progressId)
      ? request.body.progressId
      : null;
    let result;
    try {
      result = await convertSample({
        translate: translateFlag(request.body?.translate),
        onProgress: progressHandler(progressId)
      });
    } catch (error) {
      finishProgress(progressId, { ok: false, error: error.message });
      throw error;
    }

    finishProgress(progressId, { ok: true, id: result.id });
    response
      .status(201)
      .location(`/api/documents/${encodeURIComponent(result.id)}`)
      .json(result);
  } catch (error) {
    next(error);
  }
}

app.post('/api/documents/sample', handleSampleConversion);
app.post('/api/convert-sample', handleSampleConversion);

async function handleTranslation(request, response, next) {
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

  try {
    emit('start');
    const result = await translateDocument(request.params.id, {
      onProgress: ({ done, total }) => emit('progress', { progress: { done, total } })
    });

    emit('done', {
      durationMs: Date.now() - startedAt,
      detail: `${result.translated}/${result.total} 段`
    });
    finishProgress(progressId, { ok: true, id: result.id });
    response.json(result);
  } catch (error) {
    emit('error', { durationMs: Date.now() - startedAt, detail: error.message });
    finishProgress(progressId, { ok: false, error: error.message });
    next(error);
  }
}

app.put('/api/documents/:id/translation', handleTranslation);
app.post('/api/documents/:id/translate', handleTranslation);

app.delete('/api/documents/:id', async (request, response, next) => {
  try {
    response.json(await removeDocument(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/translate/:id', (request, response) => {
  const id = request.params.id;
  let directory;
  try {
    directory = documentDirectory(id);
  } catch {
    response.status(400).send('无效的文档 ID。');
    return;
  }
  if (!existsSync(path.join(directory, 'main.md')) && !existsSync(path.join(directory, 'main_zh.md'))) {
    response.status(404).send('文档不存在。');
    return;
  }
  // The page runs the translation in its own tab and then jumps to the preview.
  response.set('Cache-Control', 'no-store');
  response.sendFile(path.join(webRoot, 'translate.html'));
});

app.get('/preview/:id', async (request, response, next) => {
  try {
    const id = request.params.id;
    const directory = documentDirectory(id);
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

app.use('/mcp', (request, response, next) => {
  response.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization',
    'Access-Control-Expose-Headers': 'mcp-session-id'
  });
  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }
  next();
});

app.all('/mcp', async (request, response, next) => {
  if (!mcpHttpAuthorized(request)) {
    response.status(401).json({ error: 'MCP HTTP 访问令牌无效。' });
    return;
  }

  let server;
  let transport;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    transport?.close().catch(() => {});
    server?.close().catch(() => {});
  };

  try {
    server = createMcpServer();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', cleanup);
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    cleanup();
    if (!response.headersSent) next(error);
    else response.end();
  }
});

app.use('/output', express.static(outputRoot, { index: false }));
app.use(express.static(webRoot, { extensions: ['html'] }));

app.use((error, _request, response, _next) => {
  const isUploadError =
    error instanceof multer.MulterError || error.message === '只支持 PDF 文件。';
  const status = isUploadError ? 400 : error.status ?? 500;
  const message =
    error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
      ? '文件超过 100 MB 限制。'
      : error.message || '服务器处理失败。';
  if (status >= 500) console.error(error);
  response.status(status).json({ error: message });
});

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(port, () => {
    console.log(`pdf-parse-x preview server: http://localhost:${port}`);
  });
}

export { app };
