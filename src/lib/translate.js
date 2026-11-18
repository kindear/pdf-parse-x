import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { mapWithConcurrency } from './formula-llm.js';

const PROMPT = [
  '你是学术论文翻译专家。请把下面 JSON 中每个 item 的 text 从英文翻译成简体中文。',
  '要求：',
  '- 忠实、准确、通顺，保持学术语体；不要总结，不要增删内容，不要遗漏句子成分。',
  '- 格式必须与英文原文一致：行数不变、句子数量与顺序不变，保留原有的换行、标题层级、列表符号、引用/斜体/加粗标记和缩进；不要随意删除或新增换行，不要把多行合并成一行。',
  '- 允许修复明显的抽取错误：若原文里混入孤立的数学残渣、重复片段或乱码字符（如 `∑ ∑`、`1 3`、重复的括号片段），可以删除这些干扰信息；但不得删除正常正文，也不得为了修复而改写事实。',
  '- 标点：中文使用全角标点（，。；：、？！（）），不要在汉字之间插入空格，也不要在汉字与全角标点之间加空格。',
  '- 占位符（形如 %%K0%%、%%K1%%）代表公式、链接、引用编号、代码和强调标记，必须原样保留、位置不变，不要翻译或改写；占位符附近不要添加空格或换行。',
  '- 数学密集的句子也要翻译：把其中的英文描述译成中文，公式、变量、上下标、运算符与符号原样保留，不得删除公式，也不得改变公式的 LaTeX/Markdown 格式。',
  '- 术语统一：同一术语全文用同一译法。建议：similarity→相似度、word embedding→词嵌入、corpus→语料库、approximate nearest neighbor→近似最近邻、dimension→维度、dataset→数据集、baseline→基线。',
  '- 保留不译：作者姓名、机构名称、LSH/PMI/SVD/BERT 等缩写（首次出现可附中文）、URL、邮箱、DOI、代码标识、数学符号。',
  '- 引用编号如 [12]、[4,5] 保持原格式，不要改成上标或全角括号。',
  '- 若条目是参考文献（如 “Beh, E. J., … (2023). …”），将 text 原样返回，不翻译。',
  '- JSON 顶层的 section 字段是当前子章节标题，仅作上下文参考：不要翻译它，也不要写进译文。',
  '- 只输出 JSON：{"items":[{"id":<原 id>,"text":"译文"}]}，条数与顺序必须与输入一致，不要输出代码围栏或任何解释。',
  '输入：'
].join('\n');

const MAX_SEGMENT_CHARS = 1400;
const CJK = /[\u4e00-\u9fff]/gu;
const HAS_LETTERS = /\p{L}/u;
const MATH_SYMBOLS =
  /[\u2211\u220f\u222b\u221a\u2248\u2260\u2264\u2265\u00b1\u00d7\u00f7\u221e\u2202\u2207\u03b1-\u03c9\u0391-\u03a9]/g;

/** Lines carrying several formulas/symbols get one extra focused retry. */
function isMathDense(item) {
  const raw = (item?.store ?? []).join(' ');
  if (!raw) return false;
  const glyphs = (raw.match(MATH_SYMBOLS) ?? []).length;
  const formulas = (raw.match(/\$[^$\n]+\$/g) ?? []).length;
  return glyphs + formulas * 2 >= 3;
}

const RETRY_PROMPT = [
  '下面这些句子包含大量数学符号或公式片段，第一次翻译没有译出中文。',
  '请把其中的英文描述全部翻译成简体中文；即使整句大部分是符号，也必须输出中文句子，不得整句返回英文。',
  '数学符号、变量名、公式、上标/下标、运算符、数字、缩写与占位符 %%K0%% 一律原样保留，不删除、不改写、不改变公式格式（包括 LaTeX 的括号与上下标）。',
  '保持原有行数、句子顺序与标点，不要新增或删除换行，不要解释。',
  '只输出 JSON：{"items":[{"id":<原 id>,"text":"译文"}]}。',
  '输入：'
].join('\n');

/**
 * A translation that is still almost entirely English (typical for lines full of
 * math glyphs) is treated as a miss and retried once. References and author
 * lines are excluded by the caller.
 */
function needsRetry(source, translated) {
  const sourceWords = (String(source).match(/[A-Za-z]{4,}/g) ?? []).length;
  if (sourceWords < 4) return false;
  // Only a translation with no Chinese at all counts as a miss; anything with
  // Chinese mixed in is accepted as translated prose.
  return (String(translated).match(CJK) ?? []).length === 0;
}

export function getTranslateConfig(options = {}, env = process.env) {
  const baseUrl = String(options.baseUrl ?? env.LLM_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? '';
  const allowNoKey = options.allowNoKey ?? env.LLM_ALLOW_NO_KEY === 'true';
  const requested = options.enabled ?? env.TRANSLATE_ENABLED === 'true';

  return {
    enabled:
      Boolean(requested) && Boolean(baseUrl) && (Boolean(apiKey) || allowNoKey),
    baseUrl,
    apiKey,
    model: options.model ?? env.TRANSLATE_MODEL ?? env.LLM_MODEL ?? 'mimo-flash',
    concurrency: Math.max(
      1,
      Number(options.concurrency ?? env.TRANSLATE_CONCURRENCY ?? env.LLM_CONCURRENCY ?? 3)
    ),
    timeoutMs: Number(options.timeoutMs ?? env.LLM_TIMEOUT_MS ?? 120000),
    temperature: Number(options.temperature ?? 0)
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isMostlyChinese(text) {
  const value = String(text ?? '');
  const letters = value.replace(/[^\p{L}]/gu, '');
  if (!letters) return true;
  const cjk = (value.match(CJK) ?? []).length;
  return cjk / letters.length > 0.3;
}

/** Protect math, code, URLs, citations and HTML tags from the translator. */
function protectInline(text) {
  const store = [];
  const hold = (value) => {
    const token = `%%K${store.length}%%`;
    store.push(value);
    return token;
  };

  let value = String(text ?? '');

  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, (match) => hold(match));
  value = value.replace(/\$\$[\s\S]*?\$\$/g, (match) => hold(match));
  value = value.replace(
    /(?<![\\$])\$(?![\s$])([^$\n]{1,400}?)(?<![\s\\])\$(?![\d$])/g,
    (match) => hold(match)
  );
  value = value.replace(/`[^`\n]*`/g, (match) => hold(match));
  // Bold markers are kept by the model as tokens so captions keep their shape.
  value = value.replace(/\*\*/g, (match) => hold(match));
  value = value.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_match, label, url) =>
    `[${label}](${hold(url)})`
  );
  value = value.replace(/\[\d+(?:\s*[,\u2013\u2014-]\s*\d+)*\]/g, (match) => hold(match));
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, (match) => hold(match));

  return { text: value, store };
}

function restoreTokens(store, output) {
  if (!store.length) return String(output ?? '');
  return String(output).replace(/%%K(\d+)%%/g, (match, index) => {
    const original = store[Number(index)];
    return original === undefined ? match : original;
  });
}

function tokensIntact(template, translated) {
  const tokens = template.match(/%%K\d+%%/g) ?? [];
  return tokens.every((token) => translated.includes(token));
}

function splitLongText(text) {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?;:])\s+/);
  const parts = [];
  let current = '';

  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if (`${current} ${sentence}`.length > MAX_SEGMENT_CHARS) {
      parts.push(current);
      current = sentence;
    } else {
      current = `${current} ${sentence}`;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Blank-line separated blocks, keeping fenced code together. */
function splitBlocks(markdown) {
  const blocks = [];
  let buffer = [];
  let inFence = false;

  const flush = () => {
    if (buffer.length) {
      blocks.push(buffer.join('\n'));
      buffer = [];
    }
  };

  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    if (!inFence && !line.trim()) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

const REFERENCE_LINE = /^(?:\d+\.\s|\[\d+\]\s)/;
const TABLE_ROW = /^\s*\|/;
const CAPTION_PREFIX = /^\*\*\s*(Figure|Fig\.?|Table)\s+(\d+(?:\.\d+)?)([^*]*?)\.\s*\*\*\s*([\s\S]*)$/i;

/**
 * Figure/table captions keep a fixed label: only the caption body is sent to the
 * model so `**Table 3.**` can be rebuilt deterministically as `**表 3.**`.
 */
function splitCaption(body) {
  const match = body.match(CAPTION_PREFIX);
  if (!match) return null;
  const kind = /^table/i.test(match[1]) ? '表' : '图';
  const suffix = match[3].trim();
  return {
    label: `**${kind} ${match[2]}${suffix ? ` ${suffix}` : ''}.** `,
    rest: match[4]
  };
}

function classify(block) {
  const trimmed = block.trimStart();
  if (!trimmed) return 'raw';
  if (trimmed.startsWith('<!--')) return 'raw';
  if (trimmed.startsWith('```')) return 'raw';
  if (trimmed.startsWith('$$')) return 'raw';
  if (trimmed.startsWith('<')) return 'raw';

  const lines = block.split('\n');
  if (lines.every((line) => !line.trim() || REFERENCE_LINE.test(line.trim()))) {
    return 'raw';
  }
  if (lines.some((line) => TABLE_ROW.test(line))) return 'table';
  return 'text';
}

/** Keep heading/list/blockquote markers out of the model's hands. */
function splitPrefix(block) {
  const heading = block.match(/^(#{1,6}\s+)([\s\S]*)$/);
  if (heading) return { prefix: heading[1], body: heading[2] };

  const quote = block.match(/^((?:>\s?)+)([\s\S]*)$/);
  if (quote) return { prefix: quote[1], body: quote[2] };

  const list = block.match(/^((?:[-*+]|\d+[.)])\s+)([\s\S]*)$/);
  if (list) return { prefix: list[1], body: list[2] };

  return { prefix: '', body: block };
}

function splitTableRow(row) {
  const cells = [];
  let current = '';
  let escaped = false;
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');

  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells;
}

function parseTable(block) {
  return block.split('\n').map((line) => {
    if (!TABLE_ROW.test(line)) return { line, kind: 'other' };
    if (/^[\s|:-]+$/.test(line)) return { line, kind: 'separator' };
    return { line, kind: 'row', cells: splitTableRow(line) };
  });
}

const REFERENCE_HEADING =
  /^(?:#{1,6}\s+)?(?:\d+\.?\s+)?(?:References|Bibliography|Literature Cited|参考文献|引用文献)$/i;

function chineseCaptionLabels(text) {
  return text
    .replace(/\*\*\s*Figure\s+(\d+)([^*]*?)\.\*\*/gi, '**图 $1$2.**')
    .replace(/\*\*\s*Table\s+(\d+)([^*]*?)\.\*\*/gi, '**表 $1$2.**');
}

/** Each item maps to exactly one Markdown line; the model must not add breaks. */
function toSingleLine(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Deterministic typography cleanup the model cannot be trusted with:
 * no spaces between Chinese characters, no space before full-width
 * punctuation, one space between Chinese and Latin/digits.
 */
function tidyChinese(text) {
  return String(text ?? '')
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+([\uff0c\u3002\uff1b\uff1a\u3001\uff1f\uff01\uff09\u3011\u300d\u300f])/g, '$1')
    .replace(/([\uff08\u3010\u300c\u300e])[ \t]+/g, '$1')
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
    // marked does not close `**` when the following character is CJK, so move
    // the trailing punctuation outside the bold run (`**关键词：**大…` →
    // `**关键词**：大…`). The label still renders bold.
    .replace(/\*\*([^*\n]+?)([\uff1a:\uff0c\u3002\uff1b\u3001\uff01\uff1f])\*\*(?=[\u4e00-\u9fff])/g, '**$1**$2')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Translate Markdown prose into Chinese while preserving structure.
 * Headings, tables, captions, math, code and reference lists keep their shape;
 * segments the model cannot translate fall back to the English source.
 */
export async function translateMarkdown(markdown, options = {}) {
  const config = options.config ?? getTranslateConfig(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!config.enabled || !config.baseUrl || typeof fetchImpl !== 'function') {
    return { skipped: true, markdown, translated: 0, total: 0, failed: 0 };
  }

  const cache = options.cachePath ? await loadCache(options.cachePath) : new Map();
  const cacheKey = (text) => sha256(`${config.model}\u0000${text}`);

  const blocks = splitBlocks(markdown).map((raw) => ({ raw, kind: classify(raw) }));
  const items = new Map();
  let nextId = 1;
  let inReferences = false;
  // Every heading starts a new subsection; its segments share one batch so the
  // model sees continuous context and the request count stays low.
  let sectionIndex = 0;
  let sectionTitle = '';

  const addItem = (template, store) => {
    const id = nextId++;
    items.set(id, {
      template,
      store,
      translated: null,
      section: sectionIndex,
      sectionTitle
    });
    return id;
  };

  for (const block of blocks) {
    // Everything between `## References` and the next heading stays English:
    // bibliography entries (numeric, bracketed or author-year) are not prose.
    const isHeading = block.kind === 'text' && /^#{1,6}\s+\S/.test(block.raw);
    if (isHeading) {
      inReferences = REFERENCE_HEADING.test(block.raw.trim());
      sectionIndex += 1;
      sectionTitle = block.raw.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim();
    } else if (inReferences) {
      block.kind = 'raw';
      continue;
    }

    if (block.kind === 'text') {
      // Work line by line: soft line breaks (author lists, abstract blocks) and
      // list markers must survive the round trip through the model.
      block.lines = block.raw.split('\n').map((line) => {
        const { prefix, body } = splitPrefix(line);
        if (!body.trim()) return { prefix, empty: true, ids: [] };

        // Markdown hard breaks are two trailing spaces (or a tab). Keep them
        // away from the model and re-attach after translation so author lines
        // and affiliations never collapse into one paragraph.
        const trailing = (body.match(/(?: {2,}|\t+)$/) ?? [''])[0];
        const content = trailing ? body.slice(0, -trailing.length) : body;

        const caption = splitCaption(content);
        const target = caption ? caption.rest : content;
        if (!target.trim()) {
          return {
            prefix,
            empty: false,
            sourceText: content,
            caption,
            trailing,
            ids: [],
            store: []
          };
        }

        const protectedText = protectInline(target);
        return {
          prefix,
          empty: false,
          sourceText: content,
          caption,
          trailing,
          store: protectedText.store,
          ids: splitLongText(protectedText.text).map((piece) =>
            addItem(piece, protectedText.store)
          )
        };
      });
      continue;
    }

    if (block.kind === 'table') {
      block.rows = parseTable(block.raw);
      for (const row of block.rows) {
        if (row.kind !== 'row') continue;
        row.items = row.cells.map((cell) => {
          if (!HAS_LETTERS.test(cell) || isMostlyChinese(cell)) return null;
          const protectedCell = protectInline(cell.trim());
          return {
            id: addItem(protectedCell.text, protectedCell.store),
            store: protectedCell.store
          };
        });
      }
    }
  }

  const total = items.size;
  const pending = [];
  let cacheHits = 0;
  for (const [id, item] of items) {
    if (!HAS_LETTERS.test(item.template) || isMostlyChinese(item.template)) continue;
    const key = cacheKey(item.template);
    const cached = cache.get(key);
    // A cached copy that is still English (math-heavy lines) is retried.
    if (typeof cached === 'string' && !needsRetry(item.template, cached)) {
      item.translated = cached;
      cacheHits += 1;
      continue;
    }
    pending.push({
      id,
      text: item.template,
      key,
      section: item.section,
      sectionTitle: item.sectionTitle
    });
  }

  // One request per subsection: no character/item budget, so the model sees the
  // whole section in a single pass.
  const batches = [];
  let batch = { section: null, entries: [] };
  for (const entry of pending) {
    if (batch.entries.length && entry.section !== batch.section) {
      batches.push(batch);
      batch = { section: null, entries: [] };
    }
    if (!batch.entries.length) batch.section = entry.section;
    batch.entries.push(entry);
  }
  if (batch.entries.length) batches.push(batch);

  let done = 0;
  let firstError = null;

  const requestTranslations = async (prompt, entries) => {
    const payload = { items: entries.map((entry) => ({ id: entry.id, text: entry.text })) };
    // `items` stays first so consumers that slice from `{"items"` keep working.
    if (entries[0]?.sectionTitle) payload.section = entries[0].sectionTitle;
    const content = `${prompt}\n${JSON.stringify(payload)}`;
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
          messages: [{ role: 'user', content }]
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const messageContent = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(messageContent)
        ? messageContent
            .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
            .join('')
        : String(messageContent ?? '');
      return parseTranslationResponse(text);
    } finally {
      clearTimeout(timer);
    }
  };

  await mapWithConcurrency(batches, config.concurrency, async (current) => {
    try {
      const parsed = await requestTranslations(PROMPT, current.entries);

      for (const entry of current.entries) {
        const translated = parsed.get(entry.id);
        const item = items.get(entry.id);
        if (
          typeof translated === 'string' &&
          translated.trim() &&
          tokensIntact(item.template, translated)
        ) {
          const value = toSingleLine(translated);
          // Still-English answers are handled by the repair round below.
          if (!needsRetry(item.template, value)) {
            item.translated = value;
            cache.set(entry.key, value);
          }
        }
      }
    } catch (error) {
      firstError = firstError ?? error;
    } finally {
      done += current.entries.length;
      options.onProgress?.({ done: Math.min(done, pending.length), total: pending.length });
    }
  });

  // One repair round: every item that came back missing or still English goes
  // out again in a single request per subsection. Only if the batched repair
  // fails do we fall back to per-item requests, so the worst case equals the
  // previous multi-pass behaviour.
  const repairEntries = [];
  for (const entry of pending) {
    const item = items.get(entry.id);
    if (!item) continue;
    if (!item.translated || needsRetry(item.template, item.translated)) {
      item.translated = null;
      repairEntries.push(entry);
    }
  }

  const repairBatches = [];
  let repairBatch = { section: null, entries: [] };
  for (const entry of repairEntries) {
    if (repairBatch.entries.length && entry.section !== repairBatch.section) {
      repairBatches.push(repairBatch);
      repairBatch = { section: null, entries: [] };
    }
    if (!repairBatch.entries.length) repairBatch.section = entry.section;
    repairBatch.entries.push(entry);
  }
  if (repairBatch.entries.length) repairBatches.push(repairBatch);

  await mapWithConcurrency(repairBatches, config.concurrency, async (current) => {
    try {
      const parsed = await requestTranslations(RETRY_PROMPT, current.entries);
      for (const entry of current.entries) {
        const translated = parsed.get(entry.id);
        const item = items.get(entry.id);
        if (
          typeof translated === 'string' &&
          translated.trim() &&
          tokensIntact(item.template, translated) &&
          !needsRetry(item.template, translated)
        ) {
          item.translated = toSingleLine(translated);
          cache.set(entry.key, item.translated);
        }
      }
    } catch (error) {
      firstError = firstError ?? error;
    }
  });

  // Individual fallback for whatever the batched repair could not fix. Math
  // dense lines get one focused retry; everything else keeps the English source.
  const stillFailed = pending.filter((entry) => !items.get(entry.id)?.translated);
  if (stillFailed.length) {
    await mapWithConcurrency(stillFailed, config.concurrency, async (entry) => {
      try {
        const parsed = await requestTranslations(PROMPT, [entry]);
        const translated = parsed.get(entry.id);
        const item = items.get(entry.id);
        if (
          typeof translated === 'string' &&
          translated.trim() &&
          tokensIntact(item.template, translated)
        ) {
          let value = toSingleLine(translated);
          if (needsRetry(item.template, value)) {
            if (!isMathDense(item)) return;
            const retried = await requestTranslations(RETRY_PROMPT, [entry]);
            const second = retried.get(entry.id);
            if (
              typeof second !== 'string' ||
              !second.trim() ||
              !tokensIntact(item.template, second) ||
              needsRetry(item.template, second.trim())
            ) {
              return;
            }
            value = toSingleLine(second);
          }
          item.translated = value;
          cache.set(entry.key, value);
        }
      } catch (error) {
        firstError = firstError ?? error;
      }
    });
  }

  if (options.cachePath && cache.size) {
    await saveCache(options.cachePath, cache).catch(() => {});
  }
  const rebuilt = blocks.map((block) => {
    if (block.kind === 'raw') return block.raw;

    if (block.kind === 'table') {
      return block.rows
        .map((row) => {
          if (row.kind !== 'row') return row.line;
          const cells = row.cells.map((cell, index) => {
            const target = row.items?.[index];
            if (!target) return cell.trim();
            const item = items.get(target.id);
            return item?.translated
              ? chineseCaptionLabels(
                  toSingleLine(restoreTokens(target.store, item.translated))
                ).trim()
              : cell.trim();
          });
          return `| ${cells.join(' | ')} |`;
        })
        .join('\n');
    }

    const lines = block.lines.map((line) => {
      if (line.empty) return line.prefix;
      const trailing = line.trailing ?? '';
      if (line.caption && !line.ids.length) {
        return `${line.prefix}${line.caption.label.trimEnd()}${trailing}`;
      }
      const translated = line.ids.map((id) => {
        const item = items.get(id);
        return item?.translated
          ? toSingleLine(restoreTokens(line.store, item.translated))
          : null;
      });
      const complete = translated.length && translated.every((value) => value !== null);
      if (line.caption) {
        const body = complete ? translated.join('') : line.caption.rest;
        return `${line.prefix}${line.caption.label}${tidyChinese(body)}${trailing}`;
      }
      const body = complete ? translated.join('') : line.sourceText;
      return `${line.prefix}${chineseCaptionLabels(
        complete ? tidyChinese(body) : body
      )}${trailing}`;
    });
    return lines.join('\n');
  });

  const failedFinal = pending.filter((entry) => !items.get(entry.id)?.translated).length;

  return {
    skipped: false,
    markdown: rebuilt.join('\n\n'),
    translated: cacheHits + pending.length - failedFinal,
    cached: cacheHits,
    total,
    failed: failedFinal,
    error: firstError ? firstError.message : null
  };
}

function parseTranslationResponse(text) {
  const cleaned = String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const result = new Map();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
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
    const id = Number(entry?.id);
    const value = entry?.text;
    if (Number.isFinite(id) && typeof value === 'string') result.set(id, value);
  }
  return result;
}

async function loadCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return new Map(Object.entries(parsed.entries));
    }
  } catch {
    // Missing or stale cache: start empty.
  }
  return new Map();
}

async function saveCache(file, cache) {
  const entries = Object.fromEntries(cache);
  await writeFile(file, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
}

/**
 * Translate an already converted document on demand: reads `main.md`, writes
 * `main_zh.md`, refreshes the translation stats in `report.json`.
 */
export async function translateOutputDir(options = {}) {
  const directory = options.directory;
  const config = options.config ?? getTranslateConfig({ enabled: true });
  if (!config.enabled || !config.baseUrl) {
    return { ok: false, error: '模型未配置，无法生成中文版' };
  }

  const markdown = await readFile(path.join(directory, 'main.md'), 'utf8').catch(() => null);
  if (markdown === null) {
    return { ok: false, error: '文档不存在或缺少 main.md' };
  }

  const result = await translateMarkdown(markdown, {
    config,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
    cachePath: path.join(directory, 'translations.json')
  });

  if (result.skipped) {
    return { ok: false, error: '翻译未启用' };
  }

  await writeFile(path.join(directory, 'main_zh.md'), `${result.markdown}\n`, 'utf8');

  const reportPath = path.join(directory, 'report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8').catch(() => '{}'));
  report.translation = {
    model: config.model,
    translated: result.translated,
    total: result.total,
    failed: result.failed
  };
  if (result.failed) {
    report.warnings = [
      ...(Array.isArray(report.warnings) ? report.warnings : []),
      `${result.failed} 个片段未能完成翻译，已保留英文原文。`
    ];
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  return { ok: true, ...result };
}
