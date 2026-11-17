const PAGE_FURNITURE_PATTERNS = [
  /^arXiv:\S+\s+\[[^\]]+\]\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}$/i,
  /^[\p{L}][\p{L}\p{N} .&-]{1,100}\s+\d{4},\s*\d+,\s*\d+\s+\d+\s+of\s+\d+$/iu,
  /^[\p{L}][\p{L}\p{N} .&-]{1,100}\s+\d{4},\s*\d+,\s*\d+\s+https?:\/\/doi\.org\/\S+$/iu,
  /^\d+\s+of\s+\d+$/i,
  /^Page\s+\d+(\s+of\s+\d+)?$/i,
  /^https?:\/\/doi\.org\/\S+$/i,
  /^https?:\/\/\S+$/i,
  /^[\p{L}][\p{L}\p{N} .&-]{1,100}\s+\d{4},\s*\d+,\s*\d+$/iu,
  /^\s*\d{1,4}\s*$/,
  /^(?:\d+\s+)?[\p{L}][\p{L}\p{N} .&-]{1,100}\s+\(\d{4}\)\s+\d+:\d+[–-]\d+(?:\s+\d+)?$/iu,
  /^Extended author information available on the last page of the article$/i
];

const KNOWN_HEADINGS = new Set([
  'abstract',
  'references',
  'acknowledgments',
  'acknowledgements',
  'abbreviations',
  'author contributions',
  'funding',
  'institutional review board statement',
  'informed consent statement',
  'data availability statement',
  'conflicts of interest',
  'disclaimer/publisher’s note',
  "disclaimer/publisher's note",
  'conclusions',
  'introduction',
  'related work',
  'materials and methods',
  'results',
  'discussion'
]);

const ROMAN_SUBSCRIPTS = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ'
};

/**
 * Collapse whitespace and remove control characters that PDF text layers
 * sometimes contain. The source text is otherwise left untouched.
 */
export function normalizeInline(text) {
  return String(text ?? '')
    .replace(/\u00ad/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Join positioned PDF.js text items into a readable line. PDF text items often
 * split words, subscripts, punctuation and citations into separate runs, so a
 * plain space join is not sufficient.
 */
export function joinTextItems(items) {
  const sorted = [...items]
    .filter((item) => normalizeInline(item.text ?? item.str ?? '').length > 0)
    .sort((a, b) => a.x - b.x);

  let out = '';
  let previous = null;

  for (const item of sorted) {
    const text = normalizeInline(item.text ?? item.str ?? '');
    if (!text) continue;

    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const previousText = previous.text ?? previous.str ?? '';
      const previousEndsWithOpen = /[(\[{]$/.test(previousText);
      const startsWithPunctuation = /^[,.;:!?%)\]}]/.test(text);
      const startsWithClosingQuote = /^[”’"]/.test(text);
      const isSubOrSuperscript = item.height < previous.height - 1.2;
      const previousEndsWithHyphen = /-$/.test(previousText);

      if (
        gap > 1.2 &&
        !startsWithPunctuation &&
        !startsWithClosingQuote &&
        !previousEndsWithOpen &&
        !isSubOrSuperscript &&
        !previousEndsWithHyphen
      ) {
        out += ' ';
      }
    }

    out += text;
    previous = {
      x: item.x,
      width: item.width,
      height: item.height,
      text,
      str: text
    };
  }

  return cleanLine(out);
}

export function cleanLine(text) {
  return normalizeInline(
    String(text ?? '')
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl')
      .replace(/\s+([,.;:!?%])/g, '$1')
      .replace(/\[\s+/g, '[')
      .replace(/\s+\]/g, ']')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/(\p{L}|\p{N})\s*[–—]\s*(\p{L}|\p{N})/gu, '$1–$2')
      .replace(/\s+([’'])\s+/g, '$1')
  );
}

/**
 * Group PDF.js text items into visual lines. The tolerance deliberately allows
 * subscripts and superscripts to remain attached to their parent line.
 */
export function groupItemsIntoLines(items, options = {}) {
  const tolerance = options.tolerance ?? 2.8;
  const filtered = items.filter((item) => normalizeInline(item.text ?? item.str ?? '').length > 0);
  const lines = [];

  for (const item of filtered) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const line of lines) {
      const distance = Math.abs(line.y - item.y);
      const allowed = Math.max(tolerance, Math.min(4.2, Math.max(item.height, line.height) * 0.38));
      if (distance <= allowed && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }

    if (best) {
      best.items.push(item);
      if (item.height > best.height) best.height = item.height;
    } else {
      lines.push({
        y: item.y,
        height: item.height,
        items: [item]
      });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    const mainItem = line.items.reduce(
      (best, item) => (item.height > best.height ? item : best),
      line.items[0]
    );
    line.y = mainItem.y;
    line.height = mainItem.height;
    line.x = Math.min(...line.items.map((item) => item.x));
    line.width =
      Math.max(...line.items.map((item) => item.x + item.width)) -
      Math.min(...line.items.map((item) => item.x));
    line.text = joinTextItems(line.items);
    line.mathText = renderInlineMath(line.items, mainItem.height);
    line.fontName = mainItem.fontName ?? '';
  }

  const ordered = lines.sort((a, b) => b.y - a.y);
  return ordered;
}

const MATH_GLYPHS = new Map([
  ['−', '-'], ['–', '-'], ['—', '-'], ['×', '\\times'], ['÷', '\\div'],
  ['±', '\\pm'], ['∓', '\\mp'], ['≤', '\\leq'], ['≥', '\\geq'], ['≠', '\\neq'],
  ['≈', '\\approx'], ['≡', '\\equiv'], ['≃', '\\simeq'], ['∝', '\\propto'],
  ['∞', '\\infty'], ['∑', '\\sum'], ['∏', '\\prod'], ['∫', '\\int'],
  ['√', '\\sqrt'], ['∂', '\\partial'], ['∇', '\\nabla'], ['∈', '\\in'],
  ['∉', '\\notin'], ['⊂', '\\subset'], ['∪', '\\cup'], ['∩', '\\cap'],
  ['∼', '\\sim'], ['→', '\\to'], ['←', '\\leftarrow'], ['⇒', '\\Rightarrow'],
  ['·', '\\cdot'], ['∘', '\\circ'], ['′', "'"], ['″', "''"],
  ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
  ['ε', '\\varepsilon'], ['ζ', '\\zeta'], ['η', '\\eta'], ['θ', '\\theta'],
  ['ι', '\\iota'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['μ', '\\mu'],
  ['ν', '\\nu'], ['ξ', '\\xi'], ['π', '\\pi'], ['ρ', '\\rho'], ['σ', '\\sigma'],
  ['ς', '\\varsigma'], ['τ', '\\tau'], ['υ', '\\upsilon'], ['φ', '\\varphi'],
  ['ϕ', '\\phi'], ['χ', '\\chi'], ['ψ', '\\psi'], ['ω', '\\omega'],
  ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
  ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Υ', '\\Upsilon'],
  ['Φ', '\\Phi'], ['Ψ', '\\Psi'], ['Ω', '\\Omega']
]);

const MATH_GLYPH_TEST =
  /[Α-Ωα-ω∑∏∫√∂∇∞≤≥≈≠±×÷·∼→←⇒∈∉⊂∪∩]/;

function latexifyMathText(text) {
  // Mathematical alphanumeric symbols (𝑝, 𝑥, 𝐻) decompose to plain ASCII.
  const normalized = String(text ?? '').normalize('NFKD');
  let out = '';
  for (const char of normalized) {
    const mapped = MATH_GLYPHS.get(char);
    if (mapped) {
      out += ` ${mapped} `;
      continue;
    }
    if (/[A-Za-z0-9]/.test(char)) {
      out += char;
      continue;
    }
    if (/[+\-=<>()\[\]\/,.:;!|'*]/.test(char)) {
      out += char;
      continue;
    }
    if (char === ' ') continue;
    out += `\\text{${char}}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Rebuild a line so inline math gets `$...$` delimiters.
 *
 * Journal PDFs typeset inline formulas with a smaller font for sub/superscripts
 * and sometimes the whole formula. Two patterns are handled:
 *
 *   1. a normal-size token followed by small, baseline-shifted scripts
 *      (`p` + `ij` -> `$p_{ij}$`);
 *   2. a run of small items that carries math glyphs.
 *
 * Everything else is returned as plain text so prose is never rewritten.
 */
export function renderInlineMath(items, mainHeight) {
  if (!items?.length || !(mainHeight > 0)) return null;

  const sorted = [...items]
    .filter((item) => normalizeInline(item.text ?? '').length)
    .sort((a, b) => a.x - b.x);
  if (sorted.length < 2) return null;

  const segments = [];
  const pushPlain = (item) => {
    const last = segments[segments.length - 1];
    if (last?.type === 'plain') {
      last.items.push(item);
      return;
    }
    segments.push({ type: 'plain', items: [item] });
  };

  let index = 0;
  while (index < sorted.length) {
    const item = sorted[index];
    const ratio = item.height / mainHeight;

    if (ratio <= 0.85) {
      const run = [item];
      index += 1;
      while (index < sorted.length && sorted[index].height / mainHeight <= 0.85) {
        run.push(sorted[index]);
        index += 1;
      }
      const latex = mathSegmentToLatex(run, mainHeight);
      if (latex) segments.push({ type: 'math', latex });
      else for (const entry of run) pushPlain(entry);
      continue;
    }

    const scripts = [];
    let next = index + 1;
    while (
      next < sorted.length &&
      sorted[next].height / mainHeight <= 0.8 &&
      Math.abs(sorted[next].y - item.y) >= 0.6 &&
      normalizeInline(sorted[next].text ?? '').length <= 6
    ) {
      scripts.push(sorted[next]);
      next += 1;
    }

    if (scripts.length) {
      const scriptText = scripts
        .map((entry) => normalizeInline(entry.text ?? ''))
        .join('');
      const baseText = normalizeInline(item.text ?? '');
      const baseEndsWithLetter = /\p{L}$/u.test(baseText);
      const scriptIsSymbols = /^[+\-=<>′]{1,4}$/.test(scriptText);
      // The script must sit right after its base glyph, otherwise it belongs
      // to a different formula fragment on the same line.
      const adjacent = scripts[0].x - (item.x + item.width) <= 2.5;
      const attach =
        adjacent &&
        (MATH_GLYPH_TEST.test(scriptText) ||
          (/[A-Za-z\u0391-\u03c9]/.test(scriptText) && baseEndsWithLetter) ||
          (scriptIsSymbols && baseEndsWithLetter) ||
          (/^\p{L}$/u.test(baseText) && /^\d{1,3}$/.test(scriptText)));
      if (attach) {
        const base = latexifyMathText(baseText);
        let sub = '';
        let sup = '';
        for (const entry of scripts) {
          const text = latexifyMathText(entry.text).replace(/\s+/g, '');
          if (entry.y < item.y - 0.6) sub += text;
          else sup += text;
        }
        let latex = base;
        if (sub) latex += `_{${sub}}`;
        if (sup) latex += `^{${sup}}`;
        segments.push({ type: 'math', latex });
        index = next;
        continue;
      }
    }

    pushPlain(item);
    index += 1;
  }

  if (!segments.some((segment) => segment.type === 'math')) return null;

  const rendered = segments
    .map((segment) =>
      segment.type === 'math' ? `$${segment.latex}$` : joinTextItems(segment.items)
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!rendered.includes('$') || rendered.length > 500) return null;
  return rendered;
}

function mathSegmentToLatex(items, mainHeight) {
  const baseItem = items.reduce(
    (best, item) => (item.height > best.height ? item : best),
    items[0]
  );
  const baseY = baseItem.y;

  let latex = '';
  let pendingScript = null;
  let pendingScriptText = '';
  let previousX = null;

  const flushScript = () => {
    if (pendingScript && pendingScriptText) {
      latex += `_{${pendingScriptText}}`;
    }
    pendingScript = null;
    pendingScriptText = '';
  };

  for (const item of items) {
    const ratio = item.height / mainHeight;
    const text = normalizeInline(item.text ?? '');
    if (!text) continue;

    const isSub = ratio <= 0.72 && item.y < baseY - 0.6;
    const isSup = ratio <= 0.72 && item.y > baseY + 0.6;

    if (isSub || isSup) {
      const kind = isSub ? 'sub' : 'sup';
      if (pendingScript && pendingScript !== kind) flushScript();
      pendingScript = kind;
      pendingScriptText += latexifyMathText(text).replace(/\s+/g, '');
      previousX = item.x + item.width;
      continue;
    }

    flushScript();
    // Preserve a visible gap between separate base tokens so unrelated
    // fragments are never fused into one formula.
    if (previousX !== null && item.x - previousX > 1.5) latex += ' ';
    latex += latexifyMathText(text);
    previousX = item.x + item.width;
  }
  flushScript();

  const trimmed = latex.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 120) return null;
  // Reject bodies made of prose words (no math glyph, no sub/superscript).
  if (!MATH_GLYPH_TEST.test(trimmed) && !/[_^]/.test(trimmed)) {
    if (!/^[A-Za-z0-9()[\]+\-=/.,]{2,6}$/.test(trimmed)) return null;
    // A bare number is a footnote marker or label, not a formula.
    if (!/\p{L}/u.test(trimmed)) return null;
  }
  return trimmed;
}

/**
 * Join a leading drop cap back onto the text the paragraph continues with.
 * PDF drop caps are single oversized letters whose baseline sits on the second
 * line, which otherwise fuses them into that line ("Lable").
 */
export function repairDropCapLines(lines) {
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const first = line?.items?.[0];
    if (!first) continue;

    const text = normalizeInline(first.text ?? '');
    if (!/^[A-Z]$/.test(text)) continue;

    const rest = line.items.slice(1);
    if (!rest.length) continue;
    const heights = rest
      .map((item) => item.height)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (!heights.length) continue;
    const medianHeight = heights[Math.floor(heights.length / 2)];
    if (first.height < medianHeight * 1.45) continue;

    const above = lines[index - 1];
    if (!above || Math.abs(above.y - line.y) > 40) continue;
    if (!/^[A-Z]{3,}/.test(normalizeInline(above.text ?? ''))) continue;

    line.items = rest;
    line.text = joinTextItems(rest);
    line.mathText = null;
    above.text = `${text}${above.text}`;
    above.items = [...above.items, first].sort((a, b) => a.x - b.x);
  }
}

export function isPageFurniture(text) {
  const normalized = normalizeInline(text);
  if (!normalized) return true;
  return PAGE_FURNITURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isOrphanAccentLine(text) {
  const normalized = normalizeInline(text);
  return /^[˜∼~^¯‾ˉˆ¨]+$/.test(normalized);
}

export function isLikelyHeading(text, options = {}) {
  const value = normalizeInline(text);
  if (!value || value.length > 140) return false;

  const lower = value.toLowerCase().replace(/[.:]+$/, '');
  if (KNOWN_HEADINGS.has(lower)) return true;

  const numbered = value.match(/^(\d+(?:\.\d+)*)\.\s+(\S.*)$/);
  if (numbered) {
    const [, numbering, title] = numbered;
    if (numbering.split('.').length > 4) return false;
    if (Number(numbering.split('.')[0]) > 99) return false;
    if (title.length > 110) return false;
    if (/[.;:,]$/.test(title)) return false;
    if (/^\d/.test(title)) return false;
    if (/\b(?:is|are|was|were|has|have|can|may|should|would|will)\b/i.test(title)) {
      return false;
    }
    return true;
  }

  if (isRomanSectionHeading(value)) return true;
  if (isLetteredSubheading(value)) return true;

  if (options.allowUnnumbered) {
    const looksLikeTitle =
      value.length >= 8 &&
      value.length <= 90 &&
      /^[A-Z]/.test(value) &&
      !/[.!?;:,]$/.test(value) &&
      !/\b(?:is|are|was|were|has|have|can|may|should|would|will)\b/i.test(value);
    if (looksLikeTitle) return true;
  }

  return false;
}

const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

export function romanToNumber(value) {
  const text = String(value ?? '').toUpperCase();
  if (!/^[IVXLCDM]+$/.test(text)) return null;

  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const current = ROMAN_VALUES[text[index]];
    const next = ROMAN_VALUES[text[index + 1]] ?? 0;
    total += current < next ? -current : current;
  }

  return total > 0 && total <= 399 ? total : null;
}

/**
 * IEEE-style papers use `II. OVERVIEW OF RAG` for sections. Small-caps fonts
 * often extract as `I NTRODUCTION`, so the title is compared case-insensitively
 * but must still look like an all-caps heading.
 */
export function isRomanSectionHeading(value) {
  const match = normalizeInline(value).match(/^([IVXLCDM]+)\.\s+(\S.*)$/);
  if (!match) return false;
  if (!romanToNumber(match[1])) return false;

  const title = match[2];
  if (title.length < 3 || title.length > 90) return false;
  if (/[.,;:]$/.test(title)) return false;

  const letters = title.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  const upper = (title.match(/[A-Z]/g) ?? []).length;
  return upper / letters.length >= 0.6;
}

/** `A. Naive Retrieval-Augmented Generation` style subsections. */
export function isLetteredSubheading(value) {
  const match = normalizeInline(value).match(/^([A-Z])\.\s+(\S.{2,80})$/);
  if (!match) return false;

  const title = match[2];
  if (/[.,;:]$/.test(title)) return false;
  if (title.includes(',')) return false;
  if (!/^[A-Z]/.test(title)) return false;
  if (/\b(?:et al|vol|pp|eds?)\b/i.test(title)) return false;
  return title.split(/\s+/).length <= 12;
}

/**
 * Repair letter-spaced small caps: `I NTRODUCTION` -> `INTRODUCTION`.
 * Only applied to headings that are already mostly uppercase.
 */
export function collapseSpacedCaps(text) {
  const value = normalizeInline(text);
  if (!value) return value;

  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return value;
  const upper = (value.match(/[A-Z]/g) ?? []).length;
  if (upper / letters.length < 0.8) return value;

  return value.replace(/\b([B-Z])\s+([A-Z]{3,})\b/g, '$1$2');
}

export function headingLevel(text, options = {}) {
  const value = normalizeInline(text);
  const lower = value.toLowerCase().replace(/[.:]+$/, '');
  if (KNOWN_HEADINGS.has(lower)) {
    if (lower === 'abstract') return 2;
    return 2;
  }

  const numbered = value.match(/^(\d+(?:\.\d+)*)\.?\s+/);
  if (numbered) {
    return Math.min(4, 1 + numbered[1].split('.').length);
  }

  if (isRomanSectionHeading(value)) return 2;
  if (isLetteredSubheading(value)) return 3;

  return options.defaultLevel ?? 3;
}

export function headingId(text) {
  return normalizeInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'section';
}

const REAL_COMPOUND_PREFIXES = new Set([
  'shared',
  'data',
  'multi',
  'false',
  'cross',
  'language',
  'component',
  'non',
  'pre',
  'post',
  'rust',
  'julia',
  'haskell',
  'python',
  'cpython',
  'numpy',
  'numba',
  'jit',
  'pickle',
  'total',
  'computation',
  'compute',
  'merge',
  'combine',
  'speedup',
  'efficiency',
  'sensitivity',
  'statistical',
  'final',
  'divide',
  'well',
  'high',
  'low',
  'real',
  'end',
  'self',
  'user',
  'read',
  'write',
  'single',
  'dual',
  'large',
  'small',
  'full',
  'open',
  'long',
  'short',
  'fine',
  'coarse',
  'task',
  'process',
  'thread',
  'memory',
  'time',
  'run',
  'load',
  'core',
  'worker',
  'pairwise',
  'hand',
  'built',
  'sha',
  'inter',
  'intra',
  'semi',
  'quasi',
  'state',
  'rule',
  'line',
  'column',
  'table',
  'figure',
  'page',
  'file',
  'test',
  'benchmark',
  'workload',
  'input',
  'output',
  'runtime',
  'implementation',
  'algorithm',
  'performance',
  'parallel',
  'serial',
  'local',
  'global',
  'boundary',
  'partial',
  'scalar',
  'order',
  'key',
  'value',
  'object',
  'cache',
  'cpu',
  'gil',
  'i/o',
  'two',
  'three',
  'four',
  'first',
  'second',
  'third',
  'top',
  'bottom',
  'left',
  'right',
  'up',
  'down',
  'out',
  'off',
  'on'
]);

export function dehyphenateJoin(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a) return b;
  if (!b) return a;

  if (/[–—]$/.test(a)) {
    return `${a}${b}`;
  }

  if (/-$/.test(a) && /^[a-z]/.test(b)) {
    const leftWord = a.match(/([A-Za-z]+)-$/)?.[1]?.toLowerCase() ?? '';
    if (REAL_COMPOUND_PREFIXES.has(leftWord)) {
      return `${a}${b}`;
    }
    return a.slice(0, -1) + b;
  }

  return `${a} ${b}`;
}

export function joinParagraphLines(lines) {
  let text = '';
  for (const line of lines) {
    text = text ? appendLine(text, line) : line;
  }
  return normalizeInline(text);
}

export function appendLine(paragraph, lineText) {
  return dehyphenateJoin(paragraph, lineText);
}

export function toSubscriptDigits(value) {
  return String(value)
    .split('')
    .map((character) => ROMAN_SUBSCRIPTS[character] ?? character)
    .join('');
}

export function normalizeTableHeader(text) {
  return normalizeInline(text)
    .replace(/([A-Za-z])\(/g, '$1 (')
    .replace(/\s+\(/g, ' (')
    .replace(/\s+\)/g, ')');
}

export function escapeMarkdownCell(value) {
  return normalizeInline(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeMarkdownText(value) {
  return String(value ?? '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownTable(headers, rows) {
  const normalizedHeaders = headers.map((header) => escapeMarkdownCell(header) || ' ');
  const width = Math.max(normalizedHeaders.length, ...rows.map((row) => row.length));
  while (normalizedHeaders.length < width) normalizedHeaders.push(' ');

  const headerLine = `| ${normalizedHeaders.join(' | ')} |`;
  const separatorLine = `| ${normalizedHeaders.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => {
    const cells = [...row];
    while (cells.length < width) cells.push('');
    return `| ${cells.map((cell) => escapeMarkdownCell(cell) || ' ').join(' | ')} |`;
  });

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

export function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = normalizeInline(cell);
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(',')
    )
    .join('\n');
}

export function slugify(value, fallback = 'document') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

export function safeOutputName(value, fallback = 'document') {
  return slugify(value, fallback);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function tokenizeForCoverage(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}
