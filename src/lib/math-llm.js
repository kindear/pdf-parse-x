import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { decodeHtmlEntities, normalizeInline } from './text-utils.js';

const PROMPT = [
  'You transcribe one line of a PDF page image into Markdown.',
  'Rules:',
  '- Output exactly one line of Markdown that matches the visible content.',
  '- Use $...$ for inline math; use $$...$$ only when the line is a display equation.',
  '- Keep wording, citations like [12], numbers and punctuation unchanged.',
  '- Reproduce math symbols faithfully (sums with limits, subscripts, superscripts, fractions, radicals).',
  '- Do not translate, do not explain, do not wrap the answer in code fences.',
  'Output the Markdown line only.'
].join('\n');

const BLOCK_PROMPT = [
  'You transcribe one paragraph fragment from a PDF page image into Markdown.',
  'Rules:',
  '- Keep every word, number, symbol and the exact order of the visible text.',
  '- Never add, drop, duplicate, reorder or summarise anything.',
  '- Convert formulas to inline $...$ LaTeX; use $$...$$ only when the fragment is itself a display equation.',
  '- Reproduce fractions, sums with their limits, subscripts, superscripts and radicals faithfully.',
  '- Join the wrapped lines of the paragraph into one Markdown paragraph.',
  '- Do not translate, do not explain, do not wrap the answer in code fences.',
  'Output the Markdown paragraph only.'
].join('\n');

/** Upright multi-letter math names that are fine inside a formula fragment. */
const MATH_NAME_WORDS = new Set([
  'log', 'max', 'min', 'exp', 'cos', 'sin', 'tan', 'arg', 'lim', 'sup', 'inf', 'det', 'cov', 'var'
]);

/** Three-letter English words are the shortest reliable prose signal. */
const SHORT_PROSE_WORDS =
  /\b(?:the|and|for|are|was|were|with|from|that|this|then|than|not|but|can|may|all|its|our|per|each|such|which|where|when|have|has|had|into|over|more|less|also|only|other|these|those|their|they|them|between|through|under|above|below|about|would|should|could)\b/i;

/**
 * Vertical math debris: numerator/denominator rows, lone sum signs and
 * superscript runs that the text layer emitted as separate lines. Such a line
 * carries no real prose word but does carry math syntax.
 */
export function isMathDebrisLine(text) {
  const value = normalizeInline(text);
  if (!value || value.length > 70) return false;
  if (/^\s*\|/.test(value)) return false;

  const longWords = (value.match(/[A-Za-z]{4,}/g) ?? []).filter(
    (word) => !MATH_NAME_WORDS.has(word.toLowerCase())
  );
  if (longWords.length || SHORT_PROSE_WORDS.test(value)) return false;
  return /[\u2211\u220f\u222b\u221a=+/()^_]/.test(value) || /\d/.test(value);
}

/** Glyphs that almost never appear in running prose. */
const HARD_MATH =
  /[\u2211\u220f\u222b\u221a\u221e\u2202\u2207\u00b1\u00d7\u00f7\u2248\u2260\u2264\u2265\u03b1-\u03c9\u0391-\u03a9]/g;

export function getMathLlmConfig(options = {}, env = process.env) {
  const baseUrl = String(options.baseUrl ?? env.LLM_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? '';
  const allowNoKey = options.allowNoKey ?? env.LLM_ALLOW_NO_KEY === 'true';
  const requested = options.enabled ?? env.MATH_LLM_ENABLED !== 'false';

  return {
    enabled: Boolean(requested) && Boolean(baseUrl) && (Boolean(apiKey) || allowNoKey),
    baseUrl,
    apiKey,
    model: options.model ?? env.MATH_LLM_MODEL ?? env.LLM_MODEL ?? 'mimo-flash',
    concurrency: Math.max(
      1,
      Number(options.concurrency ?? env.MATH_LLM_CONCURRENCY ?? env.LLM_CONCURRENCY ?? 3)
    ),
    timeoutMs: Number(options.timeoutMs ?? env.LLM_TIMEOUT_MS ?? 120000),
    maxLines: Math.max(0, Number(options.maxLines ?? env.MATH_LLM_MAX_LINES ?? 80)),
    temperature: Number(options.temperature ?? 0)
  };
}

/**
 * A line needs LLM transcription when the PDF text layer mixed math glyphs into
 * prose (`∑ ∑ j in K-dimensional space …`) instead of giving a clean formula.
 */
export function needsMathTranscription(line) {
  const text = normalizeInline(line?.text ?? '');
  if (!text || text.length > 400) return false;
  if (/^\s*\|/.test(text)) return false;

  // Look at what is left once the already-rebuilt inline math is removed: a
  // line can have `$p_{ij}$` inline math and still carry stray `∑ ∑` noise.
  const mathText = line?.mathText ? normalizeInline(line.mathText) : '';
  const residual = mathText ? mathText.replace(/\$[^$\n]*\$/g, ' ') : text;

  // Structural damage that rules cannot repair: a sum limit left behind as
  // `=j` (the ∑ glyph was dropped by the text layer), a transpose mark `]T`,
  // or a fraction shredded into repeated `$1_{2}$` blocks.
  if (/(?:^|[\s(])=[a-z]\b/.test(residual)) return true;
  if (/\]\s?T\b/.test(residual)) return true;
  if (((mathText || text).match(/\$1_\{2\}\$/g) ?? []).length >= 2) return true;

  const glyphs = (residual.match(HARD_MATH) ?? []).length;
  const words = (residual.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (glyphs >= 2 && words >= 1) return true;
  return glyphs >= 1 && words >= 6;
}

/** Model meta answers (refusals, requests for input) are never transcriptions. */
const REFUSAL_ANSWER =
  /^(?:i (?:can'?t|cannot|don'?t|do not|am unable)|please (?:upload|provide|send|share)|no image|there (?:is|are) no (?:image|page)|as an ai|sorry)/i;

function stripResponse(text, limit = 2000) {
  const value = decodeHtmlEntities(
    String(text ?? '')
      .replace(/^\s*```(?:markdown|md)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
  );
  if (!value || value.length > limit) return null;
  if (REFUSAL_ANSWER.test(value)) return null;
  if (/```/.test(value)) return null;
  return value.replace(/\s+$/g, '');
}

async function requestTranscription(imageBuffer, config, prompt, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!config?.enabled || !config.baseUrl || typeof fetchImpl !== 'function') return null;
  if (!imageBuffer?.length) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
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
              { type: 'text', text: prompt },
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

    if (!response.ok) return null;
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
      : String(content ?? '');
    return stripResponse(text, options.limit ?? 2000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the vision model to re-typeset a single cropped line. Returns a Markdown
 * string with `$...$` math, or null when the transcription is unusable.
 */
export async function transcribeLineWithLlm(imageBuffer, config, options = {}) {
  return requestTranscription(imageBuffer, config, PROMPT, options);
}

/**
 * Re-typeset a whole paragraph fragment whose inline formula was split over
 * several text-layer lines (numerator, denominator, lone sums). The paragraph is
 * transcribed as one block so content and order stay intact.
 */
export async function transcribeBlockWithLlm(imageBuffer, config, options = {}) {
  return requestTranscription(imageBuffer, config, BLOCK_PROMPT, { ...options, limit: 4000 });
}

export function mathLineCacheKey(buffer, model) {
  return createHash('sha256').update(buffer).update(String(model)).digest('hex');
}

export async function loadMathLineCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.version === 1 && parsed.lines && typeof parsed.lines === 'object') {
      return parsed;
    }
  } catch {
    // Missing cache: start empty.
  }
  return { version: 1, lines: {} };
}

export async function saveMathLineCache(file, cache) {
  await writeFile(file, JSON.stringify(cache, null, 2), 'utf8');
}

const RESCUE_PROMPT = [
  'You are given one PDF page image with text fragments that a text layer failed to encode.',
  'Transcribe each listed fragment into Markdown, in the listed order.',
  'Rules:',
  '- Keep every word, number, symbol and the exact order of the visible content.',
  '- Use $...$ for inline math; use $$...$$ only when the fragment itself is a display equation.',
  '- Never add, drop, duplicate or reorder content. Do not translate.',
  '- Return only JSON: {"items":[{"id":"<id>","text":"<markdown>"}]}.',
  '- If a fragment is not visible, return an empty `text` for that id.'
].join('\n');

/**
 * Page-level second chance for fragments that failed their individual crop.
 * Only failed fragments are listed; successful ones keep the normal route.
 */
export async function rescueFragmentsWithLlm({
  imageBuffer,
  fragments,
  config,
  fetchImpl
}) {
  const request = fetchImpl ?? globalThis.fetch;
  if (!config?.enabled || !config.baseUrl || typeof request !== 'function') return new Map();
  if (!imageBuffer?.length || !fragments?.length) return new Map();

  const list = fragments
    .map(
      (fragment) =>
        `- id: ${JSON.stringify(String(fragment.id))} | source text: ${JSON.stringify(
          normalizeInline(fragment.text ?? '').slice(0, 240)
        )}`
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
              { type: 'text', text: `${RESCUE_PROMPT}\nFragments:\n${list}` },
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

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return new Map();
    let parsed = null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return new Map();
    }
    const parsedList = Array.isArray(parsed) ? parsed : parsed?.items;
    const result = new Map();
    if (!Array.isArray(parsedList)) return result;
    for (const entry of parsedList) {
      const id = entry?.id;
      const value = entry?.text;
      if ((typeof id === 'string' || typeof id === 'number') && typeof value === 'string') {
        const cleaned = stripResponse(value, 4000);
        if (cleaned) result.set(String(id), cleaned);
      }
    }
    return result;
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

