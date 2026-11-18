import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertPdfToMarkdown } from './pdf-parser.js';
import { getTranslateConfig, translateOutputDir } from './translate.js';
import { safeOutputName } from './text-utils.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(currentDir, '..', '..');
export const outputRoot = path.resolve(
  process.env.PDF_PARSE_X_OUTPUT ?? path.join(projectRoot, 'output')
);

const samplePdfName = process.env.SAMPLE_PDF ?? 'software-05-00038.pdf';
export const samplePdf = path.isAbsolute(samplePdfName)
  ? samplePdfName
  : [path.join(projectRoot, 'pdfs', samplePdfName), path.join(projectRoot, samplePdfName)].find(
      (candidate) => existsSync(candidate)
    ) ?? path.join(projectRoot, samplePdfName);

export class DocumentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
  }
}

export function validDocumentId(value) {
  // Dots are allowed so ids such as `2102.08942v1` stay addressable; `..` is
  // still rejected explicitly and `documentDirectory` re-checks the path.
  return (
    typeof value === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,120}$/i.test(value) &&
    !value.includes('..')
  );
}

export function documentDirectory(id) {
  if (!validDocumentId(id)) throw new DocumentError('无效的文档 ID。', 400);
  const resolved = path.resolve(outputRoot, id);
  if (!resolved.startsWith(`${outputRoot}${path.sep}`)) {
    throw new DocumentError('无效的文档 ID。', 400);
  }
  return resolved;
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fileExists(filePath) {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

export function documentUrls(id) {
  const encoded = encodeURIComponent(id);
  return {
    preview: `/preview/${encoded}`,
    chinesePreview: `/preview/${encoded}?lang=zh`,
    markdown: `/output/${encoded}/main.md`,
    chineseMarkdown: `/output/${encoded}/main_zh.md`,
    metadata: `/output/${encoded}/metadata.json`,
    report: `/output/${encoded}/report.json`,
    metadataApi: `/api/documents/${encoded}/metadata`,
    reportApi: `/api/documents/${encoded}/report`,
    resources: `/api/documents/${encoded}/resources`,
    translate: `/api/documents/${encoded}/translate`
  };
}

function summaryFromRecords(id, metadata, report, hasChinese, hasMarkdown) {
  const urls = documentUrls(id);
  return {
    id,
    title: metadata?.title ?? report?.title ?? id,
    sourceFile: metadata?.sourceFile ?? `${id}.pdf`,
    pages: report?.pages ?? 0,
    figures: report?.figures ?? 0,
    tables: report?.tables ?? 0,
    equations: report?.equations ?? 0,
    coverage: report?.tokenCoverage ?? null,
    hasChinese,
    hasMarkdown,
    generatedAt: metadata?.generatedAt ?? report?.generatedAt ?? null,
    apiUrl: `/api/documents/${encodeURIComponent(id)}`,
    previewUrl: urls.preview,
    chinesePreviewUrl: hasChinese ? urls.chinesePreview : null,
    markdownUrl: urls.markdown,
    chineseMarkdownUrl: hasChinese ? urls.chineseMarkdown : null,
    metadataUrl: urls.metadata,
    reportUrl: urls.report,
    metadataApiUrl: urls.metadataApi,
    reportApiUrl: urls.reportApi,
    resourcesUrl: urls.resources,
    translateUrl: urls.translate
  };
}

async function generatedAtFor(directory, metadata, report) {
  const explicit = metadata?.generatedAt ?? report?.generatedAt ?? null;
  if (explicit) return explicit;
  return stat(path.join(directory, 'main.md'))
    .then((value) => value.mtime.toISOString())
    .catch(() => null);
}

export async function listDocuments() {
  await mkdir(outputRoot, { recursive: true });
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !validDocumentId(entry.name)) continue;
    const directory = path.join(outputRoot, entry.name);
    const [metadata, report, hasChinese, hasMarkdown] = await Promise.all([
      readJson(path.join(directory, 'metadata.json')),
      readJson(path.join(directory, 'report.json')),
      fileExists(path.join(directory, 'main_zh.md')),
      fileExists(path.join(directory, 'main.md'))
    ]);
    if (!metadata && !report) continue;

    const summary = summaryFromRecords(entry.name, metadata, report, hasChinese, hasMarkdown);
    summary.generatedAt = await generatedAtFor(directory, metadata, report);
    documents.push(summary);
  }

  return documents.sort((a, b) =>
    String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? ''))
  );
}

async function walkFiles(directory, relative = '') {
  const base = path.join(directory, relative);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(directory, next)));
    } else if (entry.isFile()) {
      const info = await stat(path.join(directory, next));
      files.push({ path: next.split(path.sep).join('/'), bytes: info.size });
    }
  }
  return files;
}

function classifyFile(file) {
  if (file.path.startsWith('figs/equations/')) return 'equations';
  if (file.path.startsWith('figs/parts/')) return 'parts';
  if (file.path.startsWith('figs/')) return 'figures';
  if (file.path.startsWith('tables/')) return 'tables';
  return 'files';
}

export async function documentResources(id) {
  const directory = documentDirectory(id);
  const exists = await stat(directory)
    .then(() => true)
    .catch(() => false);
  if (!exists) throw new DocumentError('文档不存在。', 404);
  const files = (await walkFiles(directory)).map((file) => ({
    ...file,
    name: path.posix.basename(file.path),
    kind: classifyFile(file),
    url: `/output/${encodeURIComponent(id)}/${encodeURI(file.path)}`
  }));

  return {
    files: files.filter((file) => file.kind === 'files'),
    figures: files.filter((file) => file.kind === 'figures'),
    parts: files.filter((file) => file.kind === 'parts'),
    equations: files.filter((file) => file.kind === 'equations'),
    tables: files.filter((file) => file.kind === 'tables')
  };
}

export async function getDocumentRecord(id) {
  const directory = documentDirectory(id);
  const [metadata, report, hasChinese, hasMarkdown] = await Promise.all([
    readJson(path.join(directory, 'metadata.json')),
    readJson(path.join(directory, 'report.json')),
    fileExists(path.join(directory, 'main_zh.md')),
    fileExists(path.join(directory, 'main.md'))
  ]);
  if (!metadata && !report) throw new DocumentError('文档不存在。', 404);

  const summary = summaryFromRecords(id, metadata, report, hasChinese, hasMarkdown);
  summary.generatedAt = await generatedAtFor(directory, metadata, report);
  return {
    ...summary,
    metadata: metadata ?? {},
    report: report ?? {}
  };
}

export async function getDocument(id) {
  const record = await getDocumentRecord(id);
  return {
    ...record,
    resources: await documentResources(id)
  };
}

export async function readDocumentMarkdown(id, lang = 'en') {
  if (lang !== 'en' && lang !== 'zh') throw new DocumentError('lang 只支持 en 或 zh。', 400);
  const directory = documentDirectory(id);
  const file = lang === 'zh' ? 'main_zh.md' : 'main.md';
  const markdown = await readFile(path.join(directory, file), 'utf8').catch(() => null);
  if (markdown === null) {
    throw new DocumentError(
      lang === 'zh' ? '中文版尚未生成。' : '文档不存在或缺少 main.md。',
      404
    );
  }
  return { id, lang, path: path.join(directory, file), markdown };
}

export async function readDocumentFormulas(id) {
  const directory = documentDirectory(id);
  const formulas = await readJson(path.join(directory, 'formulas.json'));
  if (!formulas) throw new DocumentError('该文档没有公式数据。', 404);
  return formulas;
}

function translateOption(translate) {
  if (translate === true) return { enabled: true };
  if (translate === false) return { enabled: false };
  return undefined;
}

async function finishConversion(id, result) {
  const hasChinese = Boolean(result.mainZhPath);
  const urls = documentUrls(id);
  return {
    id,
    title: result.metadata?.title ?? id,
    hasChinese,
    pages: result.report?.pages ?? 0,
    figures: result.report?.figures ?? 0,
    tables: result.report?.tables ?? 0,
    equations: result.report?.equations ?? 0,
    coverage: result.report?.tokenCoverage ?? null,
    outputDir: result.outputDir,
    mainPath: result.mainPath,
    mainZhPath: result.mainZhPath,
    apiUrl: `/api/documents/${encodeURIComponent(id)}`,
    previewUrl: urls.preview,
    chinesePreviewUrl: hasChinese ? urls.chinesePreview : null,
    markdownUrl: urls.markdown,
    chineseMarkdownUrl: hasChinese ? urls.chineseMarkdown : null,
    metadataUrl: urls.metadata,
    reportUrl: urls.report,
    resourcesUrl: urls.resources,
    report: result.report,
    metadata: result.metadata
  };
}

/**
 * Convert a PDF buffer or a local path into a new output document.
 * `translate` is intentionally tri-state: true/false force the behaviour,
 * undefined keeps the TRANSLATE_ENABLED default.
 */
export async function convertPdf(input, options = {}) {
  const sourceName =
    typeof input === 'string'
      ? path.basename(input)
      : options.sourceName ?? 'document.pdf';
  if (path.extname(sourceName).toLowerCase() !== '.pdf') {
    throw new DocumentError('只支持 PDF 文件。', 400);
  }

  const base = safeOutputName(path.basename(sourceName, path.extname(sourceName)));
  const id = options.id ?? `${base}-${Date.now().toString(36)}`;
  if (!validDocumentId(id)) throw new DocumentError('无效的文档 ID。', 400);
  const outputDir = path.join(outputRoot, id);
  await mkdir(outputRoot, { recursive: true });

  let result;
  try {
    result = await convertPdfToMarkdown(input, {
      sourceName,
      outputDir,
      translate: translateOption(options.translate),
      previewFile: options.previewFile,
      onProgress: options.onProgress
    });
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return finishConversion(id, result);
}

export async function convertSample(options = {}) {
  if (!existsSync(samplePdf)) throw new DocumentError('工作区中没有找到示例 PDF。', 404);
  return convertPdf(samplePdf, {
    id: safeOutputName(path.basename(samplePdf, path.extname(samplePdf))),
    translate: options.translate,
    previewFile: options.previewFile,
    onProgress: options.onProgress
  });
}

export async function translateDocument(id, options = {}) {
  const directory = documentDirectory(id);
  const config = getTranslateConfig({ enabled: true });
  if (!config.enabled || !config.baseUrl) {
    throw new DocumentError(
      '模型未配置，无法生成中文版（请设置 LLM_BASE_URL / LLM_API_KEY）。',
      400
    );
  }

  const result = await translateOutputDir({
    directory,
    config,
    onProgress: options.onProgress,
    fetchImpl: options.fetchImpl
  });
  if (!result.ok) {
    throw new DocumentError(result.error, /不存在/.test(result.error) ? 404 : 400);
  }

  const urls = documentUrls(id);
  return {
    ok: true,
    id,
    translated: result.translated,
    total: result.total,
    failed: result.failed,
    hasChinese: true,
    chinesePreviewUrl: urls.chinesePreview,
    chineseMarkdownUrl: urls.chineseMarkdown
  };
}

export async function removeDocument(id) {
  const directory = documentDirectory(id);
  const exists = await stat(directory)
    .then(() => true)
    .catch(() => false);
  if (!exists) throw new DocumentError('文档不存在。', 404);
  await rm(directory, { recursive: true, force: true });
  return { ok: true, id };
}
