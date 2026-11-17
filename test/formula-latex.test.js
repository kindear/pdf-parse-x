import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadFormulaOverrides,
  normalizeLatexResponse,
  resolveFormulaLatex,
  validateLatex
} from '../src/lib/formula-latex.js';
import { renderMarkdown } from '../src/lib/preview.js';

test('image attributes remain valid on sanitized self-closing image tags', () => {
  const { html } = renderMarkdown('<div class="equation-fallback"><img src="figs/equation.png" width="200" alt="Equation 1" loading="lazy"></div>');
  assert.match(html, /width="200"/);
  assert.match(html, /loading="lazy" decoding="async">/);
  assert.doesNotMatch(html, /\/ decoding=/);
});

test('formula overrides are generic and add the equation tag', () => {
  const overrides = {
    2: '$$ E_p = \\frac{S_p}{p} $$'
  };

  const latex = resolveFormulaLatex({ number: 2 }, overrides);
  assert.ok(latex);
  assert.match(latex, /\\frac\{S_p\}\{p\}/);
  assert.match(latex, /\\tag\{2\}/);
  assert.equal(resolveFormulaLatex({ number: 2 }, {}), null);
});

test('LaTeX response normalization and validation are provider agnostic', () => {
  assert.equal(
    normalizeLatexResponse('```latex\nE = mc^2\n```'),
    'E = mc^2'
  );
  assert.equal(normalizeLatexResponse('\\[\\frac{1}{2}\\]'), '\\frac{1}{2}');
  assert.equal(validateLatex('\\frac{1}{2}'), true);
  assert.equal(validateLatex('\\frac{1}{'), false);
});

test('multi-line equation bodies are wrapped so KaTeX accepts them', () => {
  const wrapped = resolveFormulaLatex(
    { number: 5 },
    { 5: 'a = b \\\\ c = d' }
  );

  assert.ok(wrapped);
  assert.match(wrapped, /\\begin\{gathered\}/);
  assert.match(wrapped, /\\tag\{5\}/);

  const aligned = resolveFormulaLatex(
    { number: 6 },
    { 6: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}' }
  );
  assert.ok(aligned);
  assert.match(aligned, /\\begin\{aligned\}/);
  assert.doesNotMatch(aligned, /\\begin\{gathered\}/);
});

test('formula overrides can be loaded from a sidecar JSON file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-formulas-'));
  try {
    const pdfPath = path.join(directory, 'paper.pdf');
    await writeFile(
      path.join(directory, 'paper.formulas.json'),
      JSON.stringify({ 1: 'E = mc^2', 3: '\\sum_{i=1}^n x_i' }),
      'utf8'
    );

    const overrides = await loadFormulaOverrides({ pdfPath });
    assert.equal(overrides[1], 'E = mc^2');
    assert.equal(overrides[3], '\\sum_{i=1}^n x_i');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('formula overrides can be read back from the output directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-formulas-out-'));
  try {
    const outputDir = path.join(directory, 'paper');
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'formulas.json'),
      JSON.stringify({ version: 1, formulas: { 2: 'E_p = \\frac{S_p}{p}' } }),
      'utf8'
    );

    const pdfPath = path.join(directory, 'missing.pdf');
    const overrides = await loadFormulaOverrides({ pdfPath, outputDir });
    assert.equal(overrides[2], 'E_p = \\frac{S_p}{p}');

    // refresh must ignore the emitted copy and ask for a fresh resolution.
    const refreshed = await loadFormulaOverrides({
      pdfPath,
      outputDir,
      refresh: true
    });
    assert.equal(refreshed[2], undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('markdown display math renders to MathML instead of literal $$', () => {
  const result = renderMarkdown(
    'Before\n\n$$\nE_p = \\frac{S_p}{p}, \\tag{2}\n$$\n\nAfter'
  );

  assert.equal(result.html.includes('$$'), false);
  assert.match(result.html, /<div class="math-row">/);
  assert.match(result.html, /<span class="math-number">\(2\)<\/span>/);
  assert.match(result.html, /<math\b/);
  assert.equal(result.html.includes('\\tag'), false);
});

test('inline $...$ math renders as inline MathML', () => {
  const result = renderMarkdown('Speedup is $T_1 / T_p$ here, and $$x^2$$ alone.');

  assert.equal(result.html.includes('$'), false);
  assert.equal((result.html.match(/class="math-inline"/g) ?? []).length, 1);
  assert.match(result.html, /<span class="math-inline"[^>]*>[\s\S]*<math/);
  assert.equal((result.html.match(/class="math-display"/g) ?? []).length, 1);
});
