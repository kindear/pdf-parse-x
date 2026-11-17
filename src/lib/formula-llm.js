import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { finalizeLatex } from './formula-latex.js';

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text ?? '';
      })
      .join('');
  }
  return '';
}

export function getFormulaLlmConfig(options = {}) {
  const env = process.env;
  const baseUrl =
    options.baseUrl ??
    env.FORMULA_LLM_BASE_URL ??
    '';
  const apiKey =
    options.apiKey ??
    env.FORMULA_LLM_API_KEY ??
    '';
  const allowNoKey =
    options.allowNoKey ??
    env.FORMULA_LLM_ALLOW_NO_KEY === 'true';

  return {
    enabled:
      options.enabled ??
      (Boolean(baseUrl) && (Boolean(apiKey) || allowNoKey)),
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    apiKey,
    model: options.model ?? env.FORMULA_LLM_MODEL ?? 'mimo-flash',
    vision:
      options.vision ??
      (env.FORMULA_LLM_VISION ?? 'true') !== 'false',
    timeoutMs: Number(
      options.timeoutMs ?? env.FORMULA_LLM_TIMEOUT_MS ?? 30000
    ),
    concurrency: Math.max(
      1,
      Number(options.concurrency ?? env.FORMULA_LLM_CONCURRENCY ?? 3)
    ),
    maxImages: Math.max(
      0,
      Number(options.maxImages ?? env.FORMULA_LLM_MAX_IMAGES ?? 0)
    ),
    temperature: Number(options.temperature ?? 0)
  };
}

function equationPrompt(equation) {
  const rawText = (equation.lines ?? [])
    .map((line) => line.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    'You transcribe PDF display equations into LaTeX.',
    'Return only the LaTeX expression body.',
    'Do not wrap it in markdown fences, do not add $$ delimiters, do not add an equation number or \\tag.',
    'If the equation spans several lines, separate the rows with \\\\ inside a single \\begin{aligned}...\\end{aligned} block.',
    'Preserve fractions, roots, summations, integrals, subscripts, superscripts, Greek symbols, primes, accents and punctuation.',
    'Use \\left( \\right), \\frac, \\sum, \\prod, \\int, \\partial, \\nabla and \\mathrm for upright multi-letter names.',
    'Never invent content that is not visible in the image.',
    `Equation number in the PDF: (${equation.number}).`,
    rawText ? `Noisy PDF text layer for reference only: ${rawText}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

export async function convertEquationWithLlm(equation, options = {}) {
  const config = getFormulaLlmConfig(options);
  if (!config.enabled || !config.baseUrl) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const prompt = equationPrompt(equation);
  const content = [{ type: 'text', text: prompt }];

  if (config.vision && !options.imagePath) {
    options.onFailure?.('公式截图不可用');
    return null;
  }
  if (config.vision && options.imagePath) {
    try {
      const image = await readFile(options.imagePath);
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeTypeFor(options.imagePath)};base64,${image.toString('base64')}`
        }
      });
    } catch {
      options.onFailure?.('无法读取公式截图');
      return null;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey
          ? { authorization: `Bearer ${config.apiKey}` }
          : {})
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: [
          {
            role: 'user',
            content:
              content.length > 1
                ? content
                : content[0].text
          }
        ]
      })
    });

    if (!response.ok) {
      options.onFailure?.(`模型服务返回 HTTP ${response.status}`);
      return null;
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message?.content;
    const body = firstString(message);
    if (!body) {
      options.onFailure?.('模型返回空内容');
      return null;
    }

    const latex = finalizeLatex(body, equation.number);
    if (!latex) options.onFailure?.('模型输出未通过 LaTeX 校验');
    return latex;
  } catch (error) {
    options.onFailure?.(error.name === 'AbortError' ? '模型请求超时' : `模型请求失败${error.cause?.code ? ` (${error.cause.code})` : ''}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve equations with a bounded worker pool so large papers do not issue
 * dozens of concurrent requests. `resolve` must return a value or null.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length).fill(null);
  if (!items.length) return results;

  let cursor = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length));

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
