export const API_ENDPOINTS = Object.freeze([
  {
    method: 'GET',
    path: '/api/documents',
    description: '列出已转换文档（统计、URL、中文版状态）'
  },
  {
    method: 'POST',
    path: '/api/documents',
    description: '上传 PDF 并转换；multipart 字段 pdf，可选 translate、progressId'
  },
  {
    method: 'POST',
    path: '/api/documents/sample',
    description: '转换工作区示例 PDF；可选 translate、progressId',
    internal: true
  },
  {
    method: 'GET',
    path: '/api/documents/:id',
    description: '文档摘要、元数据、报告与资源清单'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/markdown',
    description: 'Markdown 正文；?lang=zh 读取中文版'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/metadata',
    description: 'PDF 元数据'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/report',
    description: '完整性报告'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/formulas',
    description: '公式 LaTeX 与来源'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/resources',
    description: '图片、表格与文件清单'
  },
  {
    method: 'GET',
    path: '/api/documents/:id/translation',
    description: '翻译状态与中文版 URL'
  },
  {
    method: 'PUT',
    path: '/api/documents/:id/translation',
    description: '生成或刷新中文版；可传 progressId'
  },
  {
    method: 'DELETE',
    path: '/api/documents/:id',
    description: '删除文档及全部资源'
  },
  {
    method: 'GET',
    path: '/api/meta',
    description: 'MCP 配置（stdio / HTTP）与接口目录',
    internal: true
  },
  {
    method: 'GET',
    path: '/api/openapi.json',
    description: 'OpenAPI 3.1 规范',
    internal: true
  },
  {
    method: 'POST',
    path: '/mcp',
    description: 'MCP Streamable HTTP 端点，支持远程调用',
    internal: true
  },
  {
    method: 'GET',
    path: '/api/progress/:id',
    description: 'SSE 进度流（progress / done）',
    internal: true
  },
  {
    method: 'GET',
    path: '/preview/:id',
    description: 'HTML 预览页；?lang=zh 切换中文',
    internal: true
  },
  {
    method: 'GET',
    path: '/translate/:id',
    description: '独立翻译页面',
    internal: true
  }
]);

/** 首页目录与 OpenAPI 只展示公开接口；internal 接口保持可调用。 */
export const PUBLIC_API_ENDPOINTS = Object.freeze(
  API_ENDPOINTS.filter((endpoint) => !endpoint.internal)
);
