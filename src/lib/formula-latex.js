import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import katex from 'katex';

/**
 * Formula LaTeX is intentionally not hard-coded per paper.
 *
 * Callers can supply a generic mapping through `options.formulaLatex`, or place
 * a sidecar JSON file next to the PDF:
 *
 *   paper.formulas.json          { "1": "E = mc^2" }
 *   paper.pdf.formulas.json      { "1": "E = mc^2" }
 *   formulas/paper.json          { "1": "E = mc^2" }
 *
 * The parser never assumes a specific equation number belongs to a specific
 * paper. If no override is available, the original PDF equation crop is kept.
 */
export function normalizeLatexResponse(value) {
  let latex = String(value ?? '').trim();
  if (!latex) return '';

  latex = latex
    .replace(/^```(?:latex|tex)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:latex|tex)\s*[:：]\s*/i, '')
    .trim();

  const blockMatch = latex.match(/^\$\$([\s\S]*?)\$\$$/);
  if (blockMatch) {
    latex = blockMatch[1].trim();
  } else {
    latex = latex
      .replace(/^\\\[([\s\S]*?)\\\]$/, '$1')
      .replace(/^\\\(([\s\S]*?)\\\)$/, '$1')
      .replace(/^\$([\s\S]*?)\$$/, '$1')
      .trim();
  }

  return latex.replace(/\\tag\{[^{}]+\}\s*$/, '').trim();
}

export function validateLatex(latex) {
  if (!latex) return false;
  try {
    katex.renderToString(latex, {
      displayMode: true,
      output: 'mathml',
      throwOnError: true,
      strict: 'ignore',
      trust: false
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Multi-line display equations are common in journals. A bare `\\` is invalid
 * outside an environment, so wrap such bodies in `gathered` before validation.
 */
export function wrapMultilineLatex(latex) {
  const value = String(latex ?? '').trim();
  if (!value) return '';
  if (!/\\\\/.test(value)) return value;
  if (/\\begin\{/.test(value)) return value;

  const rows = value
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 2) return rows[0] ?? value;

  return `\\begin{gathered} ${rows.join(' \\\\ ')} \\end{gathered}`;
}

/**
 * Normalize, wrap and tag an equation body. Returns null when KaTeX rejects the
 * result so callers can fall back to the original PDF crop.
 */
export function finalizeLatex(body, number) {
  const wrapped = wrapMultilineLatex(normalizeLatexResponse(body));
  if (!wrapped) return null;

  const latex = /\\tag\{/.test(wrapped)
    ? wrapped
    : `${wrapped} \\tag{${number}}`;

  return validateLatex(latex) ? latex : null;
}

function sidecarCandidates({
  pdfPath,
  sourceName,
  outputDir,
  refresh = false,
  options
}) {
  const candidates = [];
  const sources = [];

  if (pdfPath && !/^https?:/i.test(pdfPath)) {
    sources.push(path.resolve(pdfPath));
  }
  if (sourceName && !/^https?:/i.test(sourceName)) {
    const filename = path.basename(sourceName);
    const stem = filename.replace(/\.[^.]+$/, '');
    sources.push(
      path.resolve(process.cwd(), `${filename}.formulas.json`),
      path.resolve(process.cwd(), `${stem}.formulas.json`),
      path.resolve(process.cwd(), 'formulas', `${stem}.json`)
    );
  }

  for (const source of sources) {
    const directory = path.dirname(source);
    const filename = path.basename(source);
    const stem = filename.replace(/\.[^.]+$/, '');
    candidates.push(
      path.join(directory, `${filename}.formulas.json`),
      path.join(directory, `${stem}.formulas.json`),
      path.join(directory, 'formulas', `${stem}.json`)
    );
  }

  if (options?.formulaDirectory) {
    candidates.push(path.resolve(options.formulaDirectory, 'formulas.json'));
  }

  // The conversion output keeps its own copy so a finished document folder is
  // self-contained and portable. It is read last so an authoring sidecar next
  // to the PDF always wins.
  if (outputDir && refresh !== true) {
    const stem = String(sourceName ?? 'formulas')
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]+$/, '');
    candidates.push(
      path.resolve(outputDir, 'formulas.json'),
      path.resolve(outputDir, `${stem}.formulas.json`)
    );
  }

  return candidates;
}
export async function loadFormulaOverrides({
  pdfPath,
  sourceName,
  outputDir,
  refresh = false,
  options
} = {}) {
  const overrides = {
    ...(options?.formulaLatex ?? {})
  };

  for (const candidate of sidecarCandidates({
    pdfPath,
    sourceName,
    outputDir,
    refresh,
    options
  })) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'));
      const mapping = parsed?.formulas ?? parsed;
      if (mapping && typeof mapping === 'object') {
        for (const [key, value] of Object.entries(mapping)) {
          if (overrides[key] === undefined) overrides[key] = value;
        }
      }
    } catch {
      // A malformed sidecar should not stop PDF conversion. The equation will
      // fall back to the original crop.
    }
    break;
  }

  return overrides;
}

export function resolveFormulaLatex(equation, overrides = {}) {
  if (!equation) return null;

  const raw =
    equation.customLatex ??
    overrides[equation.number] ??
    overrides[String(equation.number)] ??
    null;
  if (!raw) return null;

  return finalizeLatex(raw, equation.number);
}

