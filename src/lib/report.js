import { isPageFurniture, tokenizeForCoverage } from './text-utils.js';

function normalizeCoverageText(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !isPageFurniture(line))
    .join('\n')
    .replace(/(\p{L})-\s*(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ');
}

export function computeReport({
  markdown,
  pdfText,
  layout,
  figures,
  tables,
  equations = [],
  warnings = []
}) {
  const normalizedPdf = normalizeCoverageText(pdfText);
  const formulaText = equations
    .flatMap((equation) => equation.lines.map((line) => line.text))
    .join('\n');
  const tableText = tables
    .map((table) => table.sourceText ?? '')
    .join('\n');
  // Inline math is emitted as LaTeX; strip the markup so its letters still
  // count as covered text instead of looking like lost content. Two variants
  // are compared: the spaced form (`p ij`) and the concatenated form (`pij`),
  // which is how the PDF text layer usually stores subscripts.
  const inlineMathText = (String(markdown ?? '').match(/\$[^$\n]{1,300}\$/g) ?? [])
    .map((span) => {
      const body = span.slice(1, -1);
      const spaced = body
        .replace(/\\[A-Za-z]+/g, ' ')
        .replace(/[{}$^_\\]/g, ' ');
      const joined = body
        .replace(/_\{([^{}]*)\}/g, '$1')
        .replace(/\^\{([^{}]*)\}/g, '$1')
        .replace(/\\[A-Za-z]+/g, ' ')
        .replace(/[{}$^_\\]/g, '');
      return `${spaced} ${joined}`;
    })
    .join(' ');
  const normalizedMarkdown = normalizeCoverageText(
    `${markdown}\n${formulaText}\n${tableText}\n${inlineMathText}`
  );
  const pdfTokens = new Set(tokenizeForCoverage(normalizedPdf));
  const markdownTokens = new Set(tokenizeForCoverage(normalizedMarkdown));
  const missingTokens = [...pdfTokens].filter((token) => !markdownTokens.has(token));

  const tokenCoverage = pdfTokens.size
    ? Number((((pdfTokens.size - missingTokens.length) / pdfTokens.size) * 100).toFixed(2))
    : 100;

  return {
    generatedAt: new Date().toISOString(),
    pages: layout.totalPages,
    figures: figures.length,
    tables: tables.length,
    equations: equations.length,
    latexEquations: equations.filter((equation) => equation.latex).length,
    llmEquations: equations.filter(
      (equation) => equation.latexSource === 'llm'
    ).length,
    equationImages: equations.filter((equation) => equation.file).length,
    tokenCoverage,
    missingTokenCount: missingTokens.length,
    missingTokenSamples: missingTokens.slice(0, 40),
    pdfCharacters: String(pdfText ?? '').length,
    markdownCharacters: markdown.length,
    tableConfidence: tables.map((table) => ({
      number: table.number,
      page: table.pageNumber,
      confidence: Number(table.confidence.toFixed(3)),
      fallback: Boolean(table.fallback)
    })),
    warnings
  };
}
