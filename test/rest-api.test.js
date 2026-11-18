import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'pdfx-rest-'));
process.env.PDF_PARSE_X_OUTPUT = root;
process.env.LLM_BASE_URL = '';
process.env.LLM_API_KEY = '';
process.env.MATH_LLM_ENABLED = 'false';
process.env.FIGURE_LLM_ENABLED = 'false';
process.env.TRANSLATE_ENABLED = 'false';
process.env.SAMPLE_PDF = path.join(process.cwd(), 'pdfs', 'software-05-00038.pdf');

const { app } = await import('../src/server.js');
const { samplePdf } = await import('../src/lib/document-service.js');

async function seed(id, { zh = false } = {}) {
  const directory = path.join(root, id);
  await mkdir(path.join(directory, 'figs'), { recursive: true });
  await mkdir(path.join(directory, 'tables'), { recursive: true });
  await writeFile(
    path.join(directory, 'metadata.json'),
    JSON.stringify({
      title: `Title ${id}`,
      sourceFile: `${id}.pdf`,
      generatedAt: '2026-03-01T00:00:00.000Z'
    }),
    'utf8'
  );
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify({
      pages: 2,
      figures: 1,
      tables: 1,
      equations: 0,
      tokenCoverage: 99,
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

let server;
let base;

before(async () => {
  await seed('doc-a');
  await seed('doc-b', { zh: true });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test('GET /api/documents lists documents', async () => {
  const response = await fetch(`${base}/api/documents`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.documents.length, 2);
  assert.ok(payload.documents.some((document) => document.id === 'doc-a'));
});

test('GET /api/meta exposes MCP config and the endpoint catalog', async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.name, 'pdf-parse-x');
  assert.ok(meta.mcp.args[0].endsWith(path.join('src', 'mcp.js')));
  assert.equal(meta.mcp.stdio.vscode.servers['pdf-parse-x'].type, 'stdio');
  assert.equal(meta.mcp.http.url, `${base}/mcp`);
  assert.equal(meta.mcp.http.vscode.servers['pdf-parse-x'].type, 'http');
  assert.equal(meta.mcp.http.authRequired, false);
  assert.ok(meta.endpoints.some((endpoint) => endpoint.path === '/api/documents'));
  assert.ok(meta.endpoints.some((endpoint) => endpoint.path === '/api/documents/:id/formulas'));
});

test('MCP is available over Streamable HTTP', async () => {
  const client = new Client({ name: 'pdfx-http-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'convert_pdf'));
    assert.ok(tools.tools.some((tool) => tool.name === 'get_document'));

    const listed = await client.callTool({ name: 'list_documents', arguments: {} });
    assert.notEqual(listed.isError, true);
    assert.ok(JSON.parse(listed.content[0].text).documents.length >= 2);
  } finally {
    await client.close();
  }
});

test('MCP HTTP honours MCP_HTTP_TOKEN', async () => {
  process.env.MCP_HTTP_TOKEN = 'test-token';
  const client = new Client({ name: 'pdfx-http-auth-test', version: '1.0.0' });
  try {
    const unauthorised = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(unauthorised.status, 401);

    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.mcp.http.authRequired, true);
    assert.ok(!JSON.stringify(meta).includes('test-token'));

    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer test-token' } }
      })
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'list_documents'));
  } finally {
    delete process.env.MCP_HTTP_TOKEN;
    await client.close();
  }
});

test('GET /api/openapi.json describes the REST and MCP surface', async () => {
  const response = await fetch(`${base}/api/openapi.json`);
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.match(document.openapi, /^3\./);
  assert.equal(document.servers[0].url, base);
  assert.ok(document.paths['/api/documents/{id}'].get);
  assert.ok(
    document.paths['/api/documents/{id}/markdown'].get.parameters.some(
      (parameter) => parameter.name === 'lang'
    )
  );
  assert.ok(
    document.paths['/api/documents'].post.requestBody.content['multipart/form-data']
  );
  assert.ok(document.paths['/mcp'].post);
});

test('document detail and sub-resources are RESTful', async () => {  const detail = await (await fetch(`${base}/api/documents/doc-a`)).json();
  assert.equal(detail.id, 'doc-a');
  assert.equal(detail.metadata.title, 'Title doc-a');
  assert.equal(detail.report.pages, 2);
  assert.equal(detail.resources.figures.length, 1);

  const metadata = await (await fetch(`${base}/api/documents/doc-a/metadata`)).json();
  assert.equal(metadata.title, 'Title doc-a');

  const report = await (await fetch(`${base}/api/documents/doc-a/report`)).json();
  assert.equal(report.pages, 2);

  const formulas = await (await fetch(`${base}/api/documents/doc-a/formulas`)).json();
  assert.equal(formulas.formulas['1'], 'E = mc^2');

  const resources = await (await fetch(`${base}/api/documents/doc-a/resources`)).json();
  assert.equal(resources.id, 'doc-a');
  assert.equal(resources.tables.length, 1);
});

test('markdown endpoint returns text/markdown and handles missing translations', async () => {
  const english = await fetch(`${base}/api/documents/doc-a/markdown`);
  assert.equal(english.status, 200);
  assert.match(english.headers.get('content-type'), /text\/markdown/);
  assert.equal(await english.text(), '# doc-a\n');

  const chinese = await fetch(`${base}/api/documents/doc-b/markdown?lang=zh`);
  assert.equal(chinese.status, 200);
  assert.equal(await chinese.text(), '# doc-b 中文\n');

  const missing = await fetch(`${base}/api/documents/doc-a/markdown?lang=zh`);
  assert.equal(missing.status, 404);

  const invalidLang = await fetch(`${base}/api/documents/doc-a/markdown?lang=fr`);
  assert.equal(invalidLang.status, 400);
});

test('translation status and unavailable translation report correctly', async () => {
  const status = await (await fetch(`${base}/api/documents/doc-b/translation`)).json();
  assert.equal(status.hasChinese, true);
  assert.equal(status.chineseMarkdownUrl, '/output/doc-b/main_zh.md');

  const translate = await fetch(`${base}/api/documents/doc-a/translation`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(translate.status, 400);
  assert.match((await translate.json()).error, /模型未配置/);

  const alias = await fetch(`${base}/api/documents/doc-a/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(alias.status, 400);
});

test('preview and translate pages stay available', async () => {
  const preview = await fetch(`${base}/preview/doc-a`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /text\/html/);

  const translatePage = await fetch(`${base}/translate/doc-a`);
  assert.equal(translatePage.status, 200);
  assert.match(await translatePage.text(), /生成中文版/);
});

test('invalid ids and missing documents use 400/404', async () => {
  const invalid = await fetch(`${base}/api/documents/bad..id`);
  assert.equal(invalid.status, 400);

  const missing = await fetch(`${base}/api/documents/not-there`);
  assert.equal(missing.status, 404);

  const missingResources = await fetch(`${base}/api/documents/not-there/resources`);
  assert.equal(missingResources.status, 404);

  const deleteMissing = await fetch(`${base}/api/documents/not-there`, {
    method: 'DELETE'
  });
  assert.equal(deleteMissing.status, 404);
});

test('POST /api/documents validates uploads', async () => {
  const noFile = await fetch(`${base}/api/documents`, { method: 'POST' });
  assert.equal(noFile.status, 400);

  const notPdf = new FormData();
  notPdf.append('pdf', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const badFile = await fetch(`${base}/api/documents`, {
    method: 'POST',
    body: notPdf
  });
  assert.equal(badFile.status, 400);

  const alias = await fetch(`${base}/api/convert`, { method: 'POST' });
  assert.equal(alias.status, 400);
});

test('POST /api/documents converts a PDF end to end', async () => {
  const pdf = await readFile(samplePdf);
  const form = new FormData();
  form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'sample.pdf');

  const response = await fetch(`${base}/api/documents`, {
    method: 'POST',
    body: form
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.ok(created.id);
  assert.equal(response.headers.get('location'), `/api/documents/${created.id}`);
  assert.equal(created.pages, 22);

  const markdown = await fetch(`${base}/api/documents/${created.id}/markdown`);
  assert.equal(markdown.status, 200);
  assert.ok((await markdown.text()).length > 1000);

  const deleted = await fetch(`${base}/api/documents/${created.id}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).ok, true);

  const afterDelete = await fetch(`${base}/api/documents/${created.id}`);
  assert.equal(afterDelete.status, 404);
});

test('POST /api/documents/sample converts the workspace sample', async () => {
  const response = await fetch(`${base}/api/documents/sample`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.id, 'software-05-00038');
  assert.equal(created.hasChinese, false);

  const deleted = await fetch(`${base}/api/documents/${created.id}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
});
