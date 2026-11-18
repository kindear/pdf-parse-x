import { API_ENDPOINTS } from './api-catalog.js';

const JSON_CONTENT = 'application/json';

function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function tagFor(path) {
  if (path === '/mcp') return 'MCP';
  if (path === '/api/meta' || path === '/api/openapi.json') return 'Meta';
  if (path.startsWith('/preview') || path.startsWith('/translate')) return 'Pages';
  if (path.includes('/translation') || path.endsWith('/translate')) return 'Translation';
  if (path.startsWith('/api/progress')) return 'Progress';
  return 'Documents';
}

function parametersFor(endpoint) {
  const parameters = [];
  if (endpoint.path.includes(':id')) {
    parameters.push({
      name: 'id',
      in: 'path',
      required: true,
      description: '文档 ID',
      schema: { type: 'string' }
    });
  }
  if (endpoint.path === '/api/documents/:id/markdown') {
    parameters.push({
      name: 'lang',
      in: 'query',
      required: false,
      description: 'en（默认）或 zh',
      schema: { type: 'string', enum: ['en', 'zh'], default: 'en' }
    });
  }
  return parameters;
}

function requestBodyFor(endpoint) {
  if (endpoint.method !== 'POST' && endpoint.method !== 'PUT') return undefined;

  if (endpoint.path === '/api/documents') {
    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['pdf'],
            properties: {
              pdf: { type: 'string', format: 'binary', description: 'PDF 文件' },
              translate: { type: 'boolean', description: '是否同时生成中文版' },
              progressId: { type: 'string', description: 'SSE 进度 ID' }
            }
          }
        }
      }
    };
  }

  if (endpoint.path === '/api/documents/sample') {
    return {
      required: false,
      content: {
        [JSON_CONTENT]: {
          schema: {
            type: 'object',
            properties: {
              translate: { type: 'boolean' },
              progressId: { type: 'string' }
            }
          }
        }
      }
    };
  }

  if (endpoint.path === '/api/documents/:id/translation') {
    return {
      required: false,
      content: {
        [JSON_CONTENT]: {
          schema: {
            type: 'object',
            properties: { progressId: { type: 'string' } }
          }
        }
      }
    };
  }

  if (endpoint.path === '/mcp') {
    return {
      required: true,
      content: {
        [JSON_CONTENT]: {
          schema: { type: 'object', description: 'JSON-RPC 2.0 MCP 消息' }
        }
      }
    };
  }

  return undefined;
}

function errorResponse(description) {
  return {
    description,
    content: {
      [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/Error' } }
    }
  };
}

function successContent(endpoint) {
  if (endpoint.path === '/api/documents/:id/markdown') {
    return { 'text/markdown': { schema: { type: 'string' } } };
  }
  if (endpoint.path === '/api/progress/:id') {
    return { 'text/event-stream': { schema: { type: 'string' } } };
  }
  if (endpoint.path === '/mcp') {
    return {
      [JSON_CONTENT]: { schema: { type: 'object' } },
      'text/event-stream': { schema: { type: 'string' } }
    };
  }
  if (endpoint.path.startsWith('/preview') || endpoint.path.startsWith('/translate')) {
    return { 'text/html': { schema: { type: 'string' } } };
  }
  return { [JSON_CONTENT]: { schema: { type: 'object' } } };
}

function responsesFor(endpoint) {
  const status =
    endpoint.method === 'POST' &&
    (endpoint.path === '/api/documents' || endpoint.path === '/api/documents/sample')
      ? '201'
      : '200';
  const responses = {
    [status]: { description: '成功', content: successContent(endpoint) }
  };
  if (endpoint.path.startsWith('/api/documents')) {
    responses['400'] = errorResponse('参数错误');
    responses['404'] = errorResponse('文档不存在');
  }
  if (endpoint.path === '/mcp') {
    responses['401'] = errorResponse('访问令牌无效');
  }
  return responses;
}

export function buildOpenApi({ baseUrl, version = '1.0.0', mcpAuthRequired = false } = {}) {
  const paths = {};

  for (const endpoint of API_ENDPOINTS) {
    const path = toOpenApiPath(endpoint.path);
    const operation = {
      summary: endpoint.description,
      tags: [tagFor(endpoint.path)],
      responses: responsesFor(endpoint)
    };
    const parameters = parametersFor(endpoint);
    if (parameters.length) operation.parameters = parameters;
    const requestBody = requestBodyFor(endpoint);
    if (requestBody) operation.requestBody = requestBody;
    if (endpoint.path === '/mcp' && mcpAuthRequired) {
      operation.security = [{ bearerAuth: [] }];
    }

    paths[path] ??= {};
    paths[path][endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'pdf-parse-x API',
      version,
      description:
        'PDF → Markdown converter REST API，以及供远程客户端使用的 MCP Streamable HTTP 端点。'
    },
    servers: baseUrl ? [{ url: baseUrl }] : [],
    tags: [
      { name: 'Documents' },
      { name: 'Translation' },
      { name: 'Meta' },
      { name: 'Progress' },
      { name: 'Pages' },
      { name: 'MCP' }
    ],
    paths,
    components: {
      securitySchemes: {
        ...(mcpAuthRequired
          ? { bearerAuth: { type: 'http', scheme: 'bearer' } }
          : {})
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } }
        }
      }
    }
  };
}
