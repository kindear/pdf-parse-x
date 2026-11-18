import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'pdfx-service-'));
process.env.PDF_PARSE_X_OUTPUT = root;

const {
  DocumentError,
  documentDirectory,
  documentResources,
  getDocument,
  getDocumentRecord,
  listDocuments,
  readDocumentFormulas,
  readDocumentMarkdown,
  removeDocument,
  validDocumentId
} = await import('../src/lib/document-service.js');

async function seed(id, { zh = false, generatedAt = '2026-01-01T00:00:00.000Z' } = {}) {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, 'figs', 'equations'), { recursive: true });
  await mkdir(path.join(directory, 'tables'), { recursive: true });
  await writeFile(
    path.join(directory, 'metadata.json'),
    JSON.stringify({ title: `Title ${id}`, sourceFile: `${id}.pdf`, generatedAt }),
    'utf8'
  );
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify({
      pages: 2,
      figures: 1,
      tables: 1,
      equations: 1,
      tokenCoverage: 99.5,
      warnings: []
    }),
    'utf8'
  );
  await writeFile(path.join(directory, 'main.md'), `# ${id}\n`, 'utf8');
  await writeFile(
    path.join(directory, 'formulas.json'),
    JSON.stringify({ formulas: { 1: 'E = mc^2' }, sources: { 1: 'llm' } }),
    'utf8'
  );
  await writeFile(path.join(directory, 'figs', 'figure-01.png'), 'image', 'utf8');
  await writeFile(path.join(directory, 'figs', 'equations', 'equation-01.png'), 'eq', 'utf8');
  await writeFile(path.join(directory, 'tables', 'table-01.md'), '| a |\n| - |\n', 'utf8');
  if (zh) await writeFile(path.join(directory, 'main_zh.md'), `# ${id} 中文\n`, 'utf8');
}

after(() => rm(root, { recursive: true, force: true }));

test('document ids reject traversal and accept dotted names', () => {
  assert.equal(validDocumentId('2102.08942v1'), true);
  assert.equal(validDocumentId('doc-1'), true);
  assert.equal(validDocumentId('..'), false);
  assert.equal(validDocumentId('../escape'), false);
  assert.equal(validDocumentId(''), false);
  assert.throws(() => documentDirectory('../escape'), (error) => {
    assert.ok(error instanceof DocumentError);
    assert.equal(error.status, 400);
    return true;
  });
});

test('listDocuments reports summaries in reverse chronological order', async () => {
  await seed('doc-a', { generatedAt: '2026-01-01T00:00:00.000Z' });
  await seed('doc-b', { zh: true, generatedAt: '2026-02-01T00:00:00.000Z' });

  const documents = await listDocuments();
  assert.deepEqual(
    documents.map((document) => document.id),
    ['doc-b', 'doc-a']
  );
  const doc = documents[0];
  assert.equal(doc.hasChinese, true);
  assert.equal(doc.hasMarkdown, true);
  assert.equal(doc.pages, 2);
  assert.equal(doc.coverage, 99.5);
  assert.equal(doc.previewUrl, '/preview/doc-b');
  assert.equal(doc.chinesePreviewUrl, '/preview/doc-b?lang=zh');
  assert.equal(doc.chineseMarkdownUrl, '/output/doc-b/main_zh.md');
});

test('getDocument includes metadata, report and classified resources', async () => {
  const document = await getDocument('doc-a');
  assert.equal(document.title, 'Title doc-a');
  assert.equal(document.metadata.sourceFile, 'doc-a.pdf');
  assert.equal(document.report.pages, 2);
  assert.equal(document.resources.figures.length, 1);
  assert.equal(document.resources.equations.length, 1);
  assert.equal(document.resources.tables[0].path, 'tables/table-01.md');
  assert.equal(document.resources.files[0].url, '/output/doc-a/formulas.json');
});

test('getDocumentRecord stays lightweight and resources can be listed alone', async () => {
  const record = await getDocumentRecord('doc-a');
  assert.equal(record.resources, undefined);
  const resources = await documentResources('doc-a');
  assert.equal(resources.figures[0].url, '/output/doc-a/figs/figure-01.png');
});

test('readDocumentMarkdown returns English and Chinese bodies', async () => {
  const english = await readDocumentMarkdown('doc-a');
  assert.equal(english.lang, 'en');
  assert.equal(english.markdown, '# doc-a\n');

  const formulas = await readDocumentFormulas('doc-a');
  assert.equal(formulas.formulas['1'], 'E = mc^2');
  assert.equal(formulas.sources['1'], 'llm');

  const chinese = await readDocumentMarkdown('doc-b', 'zh');
  assert.equal(chinese.lang, 'zh');
  assert.equal(chinese.markdown, '# doc-b 中文\n');

  await assert.rejects(
    readDocumentMarkdown('doc-a', 'zh'),
    (error) => error instanceof DocumentError && error.status === 404
  );
  await assert.rejects(
    readDocumentMarkdown('doc-a', 'fr'),
    (error) => error instanceof DocumentError && error.status === 400
  );
});

test('missing documents raise 404 and removeDocument deletes the directory', async () => {
  await assert.rejects(
    getDocument('not-there'),
    (error) => error instanceof DocumentError && error.status === 404
  );

  assert.deepEqual(await removeDocument('doc-a'), { ok: true, id: 'doc-a' });
  await assert.rejects(
    getDocumentRecord('doc-a'),
    (error) => error instanceof DocumentError && error.status === 404
  );
  await assert.rejects(
    removeDocument('doc-a'),
    (error) => error instanceof DocumentError && error.status === 404
  );
});
