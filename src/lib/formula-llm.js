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
    env.LLM_BASE_URL ??
    '';
  const apiKey =
    options.apiKey ??
    env.LLM_API_KEY ??
    '';
  const allowNoKey =
    options.allowNoKey ??
    env.LLM_ALLOW_NO_KEY === 'true';

  return {
    enabled:
      options.enabled ??
      (Boolean(baseUrl) && (Boolean(apiKey) || allowNoKey)),
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    apiKey,
    model: options.model ?? env.LLM_MODEL ?? 'mimo-flash',
    vision:
      options.vision ??
      (env.LLM_VISION ?? 'true') !== 'false',
    timeoutMs: Number(
      options.timeoutMs ?? env.LLM_TIMEOUT_MS ?? 30000
    ),
    concurrency: Math.max(
      1,
      Number(options.concurrency ?? env.LLM_CONCURRENCY ?? 3)
    ),
    maxImages: Math.max(
      0,
      Number(options.maxImages ?? env.LLM_MAX_IMAGES ?? 0)
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
    'Subscripts that contain a sign are braced individually: write p_{i+} and p_{+j}.',
    'Two margin symbols multiplied stay a product: \\sqrt{p_{i+}p_{+j}}, never p_{i+p+j} or p_i + p_j.',
    'Keep every sum, product and integral limit, including limits printed on the line below the symbol (\\sum_{i}\\sum_{j}, \\sum_{k=1}^{K}).',
    'Never invent content that is not visible in the image.',
    `Equation number in the PDF: ${
      equation.number === null || equation.number === undefined
        ? '(none, unnumbered display equation)'
        : `(${equation.number})`
    }.`,
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

/** `p_{i+p+j}` shows two marginal totals were fused into one subscript. */
const SUSPICIOUS_SUBSCRIPT = /_\{[^}]*[A-Za-z]\+[A-Za-z]\+[A-Za-z][^}]*\}/;
/** `p_{i+}-p_{+j}` reads two multiplied margins as a subtraction. */
const SUSPICIOUS_MARGIN_MINUS = /p_\{i\+\}\s*[-−]\s*p_\{\+j\}/;
const RETRY_HINT =
  'Retry: the previous answer merged marginal totals. Write each margin as its own braced subscript and multiply them, e.g. \\frac{p_{ij}-p_{i+}p_{+j}}{\\sqrt{p_{i+}p_{+j}}} (not p_{i+p+j} and not p_i + p_j).';

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

  const requestOnce = async (promptText) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const parts = [{ type: 'text', text: promptText }, ...content.slice(1)];
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
              content: parts.length > 1 ? parts : parts[0].text
            }
          ]
        })
      });

      if (!response.ok) {
        options.onFailure?.(`模型服务返回 HTTP ${response.status}`);
        return null;
      }
      const payload = await response.json();
      const body = firstString(payload?.choices?.[0]?.message?.content);
      if (!body) {
        options.onFailure?.('模型返回空内容');
        return null;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let body = await requestOnce(prompt);
    if (!body) return null;

    // Fused marginal totals are a known vision failure mode; one focused retry
    // fixes most of them without paying for a second pass on clean output.
    if (SUSPICIOUS_SUBSCRIPT.test(body) || SUSPICIOUS_MARGIN_MINUS.test(body)) {
      const retried = await requestOnce(`${prompt}\n${RETRY_HINT}`);
      if (retried && !SUSPICIOUS_SUBSCRIPT.test(retried) && !SUSPICIOUS_MARGIN_MINUS.test(retried)) {
        body = retried;
      }
    }

    const latex = finalizeLatex(body, equation.number);
    if (!latex) options.onFailure?.('模型输出未通过 LaTeX 校验');
    return latex;
  } catch (error) {
    options.onFailure?.(error.name === 'AbortError' ? '模型请求超时' : `模型请求失败${error.cause?.code ? ` (${error.cause.code})` : ''}`);
    return null;
  }
}

/**
 * Resolve equations with a bounded worker pool so large papers do not issue
 * dozens of concurrent requests. `resolve` must return a value or null.
 */
const RESCUE_PROMPT = [
  'You are given one PDF page image that contains several display equations.',
  'Transcribe only the equations listed below, in the same order.',
  'Rules:',
  '- Return only JSON: {"items":[{"id":"<id>","latex":"<body>"}]}.',
  '- `latex` is the expression body only: no $$ delimiters, no \\tag, no equation number.',
  '- Keep fractions, roots, sum limits, subscripts, superscripts and Greek symbols as printed.',
  '- If an equation is not visible, return an empty `latex` string for that id.'
].join('\n');

/** Parse `{"items":[{"id":..,"latex":..}]}` into a Map keyed by id. */
export function parseRescueResponse(text) {
  const cleaned = String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const result = new Map();
  if (start < 0 || end <= start) return result;

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return result;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(list)) return result;

  for (const entry of list) {
    const id = entry?.id;
    const latex = entry?.latex ?? entry?.text;
    if ((typeof id === 'string' || typeof id === 'number') && typeof latex === 'string') {
      result.set(String(id), latex);
    }
  }
  return result;
}

/**
 * Second chance for equations that failed the single-image pass: send the whole
 * page once and ask for the listed equations only. Successful equations never
 * take this path, so quality of the normal route is unchanged.
 */
export async function rescueEquationsWithLlm({
  imageBuffer,
  equations,
  config,
  fetchImpl
}) {
  const request = fetchImpl ?? globalThis.fetch;
  if (!config?.enabled || !config.baseUrl || typeof request !== 'function') return new Map();
  if (!imageBuffer?.length || !equations?.length) return new Map();

  const list = equations
    .map(
      (equation) =>
        `- id: ${JSON.stringify(String(equation.key))}${
          equation.number === null || equation.number === undefined
            ? ' (unnumbered)'
            : ` (numbered (${equation.number}))`
        }`
    )
    .join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await request(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${RESCUE_PROMPT}\nEquations:\n${list}` },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${imageBuffer.toString('base64')}`
                }
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) return new Map();
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
      : String(content ?? '');
    return parseRescueResponse(text);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

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
