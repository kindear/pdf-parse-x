import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'pdfx-mcp-'));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function seed(id, { zh = false } = {}) {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, 'figs'), { recursive: true });
  await mkdir(path.join(directory, 'tables'), { recursive: true });
  await writeFile(
    path.join(directory, 'metadata.json'),
    JSON.stringify({ title: `Title ${id}`, sourceFile: `${id}.pdf` }),
    'utf8'
  );
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify({
      pages: 3,
      figures: 1,
      tables: 1,
      equations: 0,
      tokenCoverage: 98,
      warnings: []
    }),
    'utf8'
  );
  await writeFile(path.join(directory, 'main.md'), `# ${id}\n`, 'utf8');
  await writeFile(
    path.join(directory, 'formulas.json'),
    JSON.stringify({ formulas: { 1: 'E = mc^2' }, sources: {} }),
    'utf8'
  );
  await writeFile(path.join(directory, 'figs', 'figure-01.png'), 'image', 'utf8');
  await writeFile(path.join(directory, 'tables', 'table-01.md'), '| a |\n', 'utf8');
  if (zh) await writeFile(path.join(directory, 'main_zh.md'), `# ${id} 中文\n`, 'utf8');
}

let client;

before(async () => {
  await seed('doc-a');
  await seed('doc-b', { zh: true });

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  );
  Object.assign(env, {
    PDF_PARSE_X_OUTPUT: root,
    LLM_BASE_URL: '',
    LLM_API_KEY: '',
    MATH_LLM_ENABLED: 'false',
    FIGURE_LLM_ENABLED: 'false',
    TRANSLATE_ENABLED: 'false',
    SAMPLE_PDF: path.join(projectRoot, 'pdfs', 'software-05-00038.pdf')
  });

  client = new Client({ name: 'pdfx-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, 'src', 'mcp.js')],
      cwd: projectRoot,
      env,
      stderr: 'ignore'
    })
  );
});

after(async () => {
  await client?.close();
  await rm(root, { recursive: true, force: true });
});

test('MCP exposes the full tool set and resource templates', async () => {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      'convert_pdf',
      'convert_sample',
      'delete_document',
      'get_document',
      'list_documents',
      'read_markdown',
      'translate_document'
    ]
  );

  const templates = await client.listResourceTemplates();
  assert.deepEqual(
    templates.resourceTemplates.map((template) => template.uriTemplate).sort(),
    [
      'pdfx://documents/{id}/formulas',
      'pdfx://documents/{id}/markdown',
      'pdfx://documents/{id}/markdown-zh',
      'pdfx://documents/{id}/report'
    ]
  );
});

test('MCP lists, reads and deletes documents', async () => {
  const listed = await client.callTool({ name: 'list_documents', arguments: {} });
  assert.notEqual(listed.isError, true);
  const documents = JSON.parse(listed.content[0].text).documents;
  assert.equal(documents.length, 2);

  const detail = await client.callTool({
    name: 'get_document',
    arguments: { id: 'doc-a' }
  });
  assert.notEqual(detail.isError, true);
  const document = JSON.parse(detail.content[0].text);
  assert.equal(document.report.pages, 3);
  assert.equal(document.resources.figures.length, 1);

  const english = await client.callTool({
    name: 'read_markdown',
    arguments: { id: 'doc-a' }
  });
  assert.equal(english.content[0].text, '# doc-a\n');

  const chinese = await client.callTool({
    name: 'read_markdown',
    arguments: { id: 'doc-b', lang: 'zh' }
  });
  assert.equal(chinese.content[0].text, '# doc-b 中文\n');

  const missingChinese = await client.callTool({
    name: 'read_markdown',
    arguments: { id: 'doc-a', lang: 'zh' }
  });
  assert.equal(missingChinese.isError, true);
  assert.match(missingChinese.content[0].text, /中文版尚未生成/);

  const removed = await client.callTool({
    name: 'delete_document',
    arguments: { id: 'doc-a' }
  });
  assert.notEqual(removed.isError, true);
  assert.equal(JSON.parse(removed.content[0].text).ok, true);

  const missing = await client.callTool({
    name: 'get_document',
    arguments: { id: 'doc-a' }
  });
  assert.equal(missing.isError, true);
});

test('MCP resources serve markdown and report content', async () => {
  const markdown = await client.readResource({
    uri: 'pdfx://documents/doc-b/markdown'
  });
  assert.equal(markdown.contents[0].text, '# doc-b\n');

  const chinese = await client.readResource({
    uri: 'pdfx://documents/doc-b/markdown-zh'
  });
  assert.equal(chinese.contents[0].text, '# doc-b 中文\n');

  const report = await client.readResource({
    uri: 'pdfx://documents/doc-b/report'
  });
  assert.equal(JSON.parse(report.contents[0].text).pages, 3);

  const formulas = await client.readResource({
    uri: 'pdfx://documents/doc-b/formulas'
  });
  assert.equal(JSON.parse(formulas.contents[0].text).formulas['1'], 'E = mc^2');

  const listed = await client.listResources();
  assert.ok(listed.resources.some((resource) => resource.uri === 'pdfx://documents'));
});

test('MCP converts the sample PDF without touching model configuration', async () => {
  const missing = await client.callTool({
    name: 'convert_pdf',
    arguments: { path: path.join(root, 'missing.pdf') }
  });
  assert.equal(missing.isError, true);

  const converted = await client.callTool({
    name: 'convert_sample',
    arguments: {}
  });
  assert.notEqual(converted.isError, true);
  const result = JSON.parse(converted.content[0].text);
  assert.equal(result.pages, 22);
  assert.equal(result.hasChinese, false);
  assert.match(result.previewUrl, /^\/preview\//);
});
