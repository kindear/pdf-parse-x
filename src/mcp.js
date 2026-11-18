#!/usr/bin/env node
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// MCP clients may launch the process from another directory, so load the
// project .env explicitly instead of relying on process.cwd().
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

const {
  convertPdf,
  convertSample,
  getDocument,
  getDocumentRecord,
  listDocuments,
  readDocumentFormulas,
  readDocumentMarkdown,
  removeDocument,
  translateDocument
} = await import('./lib/document-service.js');

export function createMcpServer() {
  const server = new McpServer(
    { name: 'pdf-parse-x', version: '1.0.0' },
    {
      instructions: [
        'pdf-parse-x 把带文本层的 PDF 转成 Markdown，并保留图片、表格、公式与参考文献。',
        '典型流程：convert_pdf -> list_documents / get_document -> read_markdown；需要中文时调用 translate_document。',
        '所有文档都在项目的 output/ 目录中；转换与翻译可能耗时较长，支持 progress 通知。'
      ].join('\n')
    }
  );

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error?.message ?? String(error) }]
  };
}

function progressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || progressToken === null) return null;

  let last = -1;
  return (percent, message) => {
    const progress = Math.max(0, Math.min(100, Math.round(percent)));
    if (progress === last) return;
    last = progress;
    // Notifications are best effort: a disconnected client must not fail the job.
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, total: 100, message }
      })
      .catch(() => {});
  };
}

function conversionProgress(notify) {
  if (!notify) return undefined;
  return (event) => {
    const stepTotal = event.total || 5;
    let percent;
    if (event.status === 'progress' && Number(event.progress?.total) > 0) {
      percent =
        ((event.index - 1 + event.progress.done / event.progress.total) / stepTotal) * 100;
    } else if (event.status === 'start') {
      percent = ((event.index - 1) / stepTotal) * 100;
    } else {
      percent = (event.index / stepTotal) * 100;
    }
    notify(percent, [event.label, event.detail].filter(Boolean).join(' · '));
  };
}

server.registerTool(
  'convert_pdf',
  {
    title: '转换 PDF',
    description:
      '把一个本地 PDF 转换为 Markdown，保留图片、表格与公式；可选同时生成中文版。返回文档 ID、统计和文件路径。',
    inputSchema: {
      path: z.string().min(1).describe('PDF 文件路径（绝对路径或相对当前目录）'),
      translate: z
        .boolean()
        .optional()
        .describe('是否生成中文版；省略时遵循 TRANSLATE_ENABLED')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  async ({ path: inputPath, translate }, extra) => {
    try {
      const resolved = path.resolve(inputPath);
      await access(resolved, constants.R_OK);
      if (path.extname(resolved).toLowerCase() !== '.pdf') {
        throw new Error('只支持 PDF 文件。');
      }
      const notify = progressReporter(extra);
      const result = await convertPdf(resolved, {
        translate,
        onProgress: conversionProgress(notify)
      });
      return jsonResult(result);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'convert_sample',
  {
    title: '转换示例 PDF',
    description: '转换项目 pdfs/ 目录中的示例 PDF，用于快速验证环境；可选同时生成中文版。',
    inputSchema: {
      translate: z
        .boolean()
        .optional()
        .describe('是否生成中文版；省略时遵循 TRANSLATE_ENABLED')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  async ({ translate }, extra) => {
    try {
      const notify = progressReporter(extra);
      const result = await convertSample({
        translate,
        onProgress: conversionProgress(notify)
      });
      return jsonResult(result);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'list_documents',
  {
    title: '列出文档',
    description: '列出 output/ 中已转换的文档，按转换时间倒序，包含统计、URL 与中文版状态。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    try {
      return jsonResult({ documents: await listDocuments() });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'get_document',
  {
    title: '读取文档信息',
    description: '读取单个文档的元数据、完整性报告、翻译状态以及 figs/、tables/ 资源清单。',
    inputSchema: {
      id: z.string().min(1).describe('文档 ID（list_documents 返回）')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ id }) => {
    try {
      return jsonResult(await getDocument(id));
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'read_markdown',
  {
    title: '读取 Markdown',
    description: '读取文档的 Markdown 正文；lang=zh 时读取 main_zh.md（需先翻译）。',
    inputSchema: {
      id: z.string().min(1).describe('文档 ID'),
      lang: z.enum(['en', 'zh']).optional().describe('en（默认）或 zh')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ id, lang }) => {
    try {
      const result = await readDocumentMarkdown(id, lang ?? 'en');
      return { content: [{ type: 'text', text: result.markdown }] };
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'translate_document',
  {
    title: '翻译为中文',
    description: '为已有文档生成 main_zh.md，复用 translations.json 缓存；会先检查模型配置。',
    inputSchema: {
      id: z.string().min(1).describe('文档 ID')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  async ({ id }, extra) => {
    try {
      const notify = progressReporter(extra);
      const result = await translateDocument(id, {
        onProgress: ({ done, total }) =>
          notify?.(
            total > 0 ? (done / total) * 100 : 0,
            `翻译 ${done}/${total} 段`
          )
      });
      return jsonResult(result);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  'delete_document',
  {
    title: '删除文档',
    description: '删除文档目录及其图片、表格与缓存文件；不可恢复。',
    inputSchema: {
      id: z.string().min(1).describe('文档 ID')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  async ({ id }) => {
    try {
      return jsonResult(await removeDocument(id));
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerResource(
  'documents',
  'pdfx://documents',
  {
    title: '文档列表',
    description: 'output/ 中所有已转换文档的 JSON 摘要',
    mimeType: 'application/json'
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({ documents: await listDocuments() }, null, 2)
      }
    ]
  })
);

const markdownTemplate = new ResourceTemplate('pdfx://documents/{id}/markdown', {
  list: async () => {
    const documents = await listDocuments();
    return {
      resources: documents
        .filter((document) => document.hasMarkdown)
        .map((document) => ({
          uri: `pdfx://documents/${encodeURIComponent(document.id)}/markdown`,
          name: `${document.id} · Markdown`,
          description: document.title,
          mimeType: 'text/markdown'
        }))
    };
  }
});

server.registerResource(
  'document-markdown',
  markdownTemplate,
  {
    title: '英文 Markdown',
    description: '文档的 main.md 全文',
    mimeType: 'text/markdown'
  },
  async (uri, variables) => {
    const { markdown } = await readDocumentMarkdown(
      decodeURIComponent(variables.id),
      'en'
    );
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdown }] };
  }
);

const chineseMarkdownTemplate = new ResourceTemplate(
  'pdfx://documents/{id}/markdown-zh',
  {
    list: async () => {
      const documents = await listDocuments();
      return {
        resources: documents
          .filter((document) => document.hasChinese)
          .map((document) => ({
            uri: `pdfx://documents/${encodeURIComponent(document.id)}/markdown-zh`,
            name: `${document.id} · 中文 Markdown`,
            description: document.title,
            mimeType: 'text/markdown'
          }))
      };
    }
  }
);

server.registerResource(
  'document-markdown-zh',
  chineseMarkdownTemplate,
  {
    title: '中文 Markdown',
    description: '文档的 main_zh.md 全文（需要先翻译）',
    mimeType: 'text/markdown'
  },
  async (uri, variables) => {
    const { markdown } = await readDocumentMarkdown(
      decodeURIComponent(variables.id),
      'zh'
    );
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdown }] };
  }
);

server.registerResource(
  'document-report',
  new ResourceTemplate('pdfx://documents/{id}/report', {
    list: async () => {
      const documents = await listDocuments();
      return {
        resources: documents.map((document) => ({
          uri: `pdfx://documents/${encodeURIComponent(document.id)}/report`,
          name: `${document.id} · 报告`,
          description: document.title,
          mimeType: 'application/json'
        }))
      };
    }
  }),
  {
    title: '完整性报告',
    description: '文档的 report.json（覆盖率、图表公式统计、警告）',
    mimeType: 'application/json'
  },
  async (uri, variables) => {
    const document = await getDocumentRecord(decodeURIComponent(variables.id));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(document.report, null, 2)
        }
      ]
    };
  }
);

server.registerResource(
  'document-formulas',
  new ResourceTemplate('pdfx://documents/{id}/formulas', {
    list: async () => {
      const documents = await listDocuments();
      const resources = [];
      for (const document of documents) {
        try {
          await readDocumentFormulas(document.id);
          resources.push({
            uri: `pdfx://documents/${encodeURIComponent(document.id)}/formulas`,
            name: `${document.id} · 公式`,
            description: document.title,
            mimeType: 'application/json'
          });
        } catch {
          // Documents without formulas simply have nothing to expose.
        }
      }
      return { resources };
    }
  }),
  {
    title: '公式 LaTeX',
    description: '文档的 formulas.json（公式编号、LaTeX 与 sources 来源）',
    mimeType: 'application/json'
  },
  async (uri, variables) => {
    const formulas = await readDocumentFormulas(decodeURIComponent(variables.id));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(formulas, null, 2)
        }
      ]
    };
  }
);

  return server;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
