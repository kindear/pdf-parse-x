import {
  appendLine,
  cleanLine,
  collapseSpacedCaps,
  escapeMarkdownText,
  headingLevel,
  isLetteredSubheading,
  isLikelyHeading,
  isOrphanAccentLine,
  isPageFurniture,
  isRomanSectionHeading,
  joinParagraphLines,
  median,
  normalizeInline
} from './text-utils.js';

const REFERENCE_START = /^\d+\.\s+\S/;
const BRACKET_REFERENCE_START = /^\[\d+\]\s*\S/;
const AUTHOR_YEAR_REFERENCE_START =
  /^[A-Z][^\n]{0,180}\((?:19|20)\d{2}\)[.,]?\s*/;
const ABSTRACT_START = /^Abstract\b[\u2013\u2014:.\-]?\s*/i;
const KEYWORDS_START = /^(?:Index Terms|Keywords)\b[\u2013\u2014:.\-]?\s*/i;
const RQ_START = /^(RQ\d+:)\s*(.*)$/;

function looksLikeAuthorLine(line) {
  const value = normalizeInline(line);
  if (!value) return false;
  if (/^\d+\s+[A-Z]/.test(value)) return false;
  if (/^Abstract$/i.test(value)) return false;
  if (/^Table|^Figure|^Fig\.|^Keywords:/i.test(value)) return false;
  if (value.includes('·')) return true;
  const commaCount = (value.match(/,/g) ?? []).length;
  return (
    commaCount >= 2 &&
    (/[A-Z][a-z]+\s+[A-Z]/.test(value) || /\*/.test(value))
  );
}

function formatAffiliations(lines) {
  const correspondence = lines.find((line) => /^\*\s*Correspondence/i.test(line));
  const affiliationLines = lines.filter(
    (line) => !/^\*\s*Correspondence/i.test(line)
  );
  const groups = [];

  for (const line of affiliationLines) {
    if (
      /^\d+\s+/.test(line) ||
      /^[a-z]\s?[A-Z]/.test(line) ||
      looksLikeAffiliation(line)
    ) {
      groups.push([line]);
    } else if (groups.length) {
      groups[groups.length - 1].push(line);
    }
  }

  const affiliationText = groups
    .map((group) => `*${group.join(' ')}*`)
    .join('  \n');
  const correspondenceText = correspondence?.replace(/^\*\s*/, '');

  return [affiliationText, correspondenceText ? `*${correspondenceText}*` : '']
    .filter(Boolean)
    .join('  \n');
}

function formatMetadataLines(lines) {
  return lines.map((line) => {
    const match = line.match(/^([A-Za-z][A-Za-z /]+):\s*(.*)$/);
    return match ? `**${match[1].trim()}:** ${match[2].trim()}` : line;
  });
}

function looksLikeAffiliation(text) {
  return /(?:University|Universit[àé]|Institute|College|Laboratory|Laboratorios|Department|Faculty|School of|Center for|Centre for|Academy of)/i.test(
    normalizeInline(text)
  );
}

function buildFrontMatter(pageText, metadata) {
  const rawLines = String(pageText ?? '')
    .split(/\r?\n/)
    .map((line) => cleanLine(line))
    .filter((line) => line && !isPageFurniture(line));

  const researchIndex = rawLines.findIndex((line) => /^RESEARCH$/i.test(line));
  const articleIndex = rawLines.findIndex((line) => /^Article$/i.test(line));
  let metadataLines = [];
  let lines = rawLines;

  if (researchIndex >= 0) {
    lines = rawLines.slice(researchIndex + 1);
  } else if (articleIndex >= 0) {
    metadataLines = rawLines.slice(0, articleIndex);
    lines = rawLines.slice(articleIndex + 1);
  }

  let authorIndex = lines.findIndex((line, index) => index > 0 && looksLikeAuthorLine(line));
  if (authorIndex < 0) {
    authorIndex = Math.min(2, lines.length);
  }

  const titleLines = lines.slice(0, authorIndex);
  let cursor = authorIndex;
  const authorLines = [];

  while (
    cursor < lines.length &&
    !/^\d+\s+[A-Z]/.test(lines[cursor]) &&
    !/^\*\s*Correspondence/i.test(lines[cursor]) &&
    !ABSTRACT_START.test(lines[cursor]) &&
    !looksLikeAffiliation(lines[cursor]) &&
    !/^(?:(?:Received|Revised|Accepted|Published|Copyright)\b|©)/i.test(lines[cursor])
  ) {
    if (!/^[\d,\s]+$/.test(lines[cursor])) {
      authorLines.push(lines[cursor]);
    }
    cursor += 1;
  }

  while (
    cursor < lines.length &&
    !ABSTRACT_START.test(lines[cursor]) &&
    /^(?:(?:Received|Revised|Accepted|Published|Copyright)\b|©)/i.test(lines[cursor])
  ) {
    metadataLines.push(lines[cursor]);
    cursor += 1;
  }

  const affiliationLines = [];
  while (
    cursor < lines.length &&
    !ABSTRACT_START.test(lines[cursor]) &&
    !/^(?:(?:Received|Revised|Accepted|Published|Copyright)\b|©)/i.test(lines[cursor])
  ) {
    if (
      /^\d+\s+/.test(lines[cursor]) ||
      /^\*\s*Correspondence/i.test(lines[cursor]) ||
      looksLikeAffiliation(lines[cursor])
    ) {
      affiliationLines.push(lines[cursor]);
    } else if (affiliationLines.length) {
      affiliationLines[affiliationLines.length - 1] += ` ${lines[cursor]}`;
    }
    cursor += 1;
  }

  const abstractLines = [];
  if (cursor < lines.length && ABSTRACT_START.test(lines[cursor])) {
    const first = lines[cursor].replace(ABSTRACT_START, '').trim();
    if (first) abstractLines.push(first);
    cursor += 1;
    while (cursor < lines.length && !KEYWORDS_START.test(lines[cursor])) {
      abstractLines.push(lines[cursor]);
      cursor += 1;
    }
  }

  const keywordsLines = [];
  if (cursor < lines.length && KEYWORDS_START.test(lines[cursor])) {
    const first = lines[cursor].replace(KEYWORDS_START, '').trim();
    if (first) keywordsLines.push(first);
    cursor += 1;
  }
  while (
    cursor < lines.length &&
    !/^(?:(?:\d+|[IVXLCDM]+)\.?\s+)?Introduction$/i.test(lines[cursor]) &&
    !/^\d+\.?\s+[A-Z]/.test(lines[cursor])
  ) {
    keywordsLines.push(lines[cursor]);
    cursor += 1;
  }

  const title =
    normalizeInline(titleLines.join(' ')) ||
    normalizeInline(metadata.title) ||
    'PDF Document';
  const authors = normalizeInline(authorLines.join(' '));
  const abstract = joinParagraphLines(abstractLines);
  const keywords = joinParagraphLines(keywordsLines)
    .replace(/^(?:Index Terms|Keywords)\s*[:\u2013\u2014-]?\s*/i, '')
    .trim();
  const blocks = [];

  blocks.push({ type: 'heading', level: 1, text: title });

  if (authors) {
    blocks.push({ type: 'paragraph', text: authors });
  }

  if (affiliationLines.length) {
    const affiliations = formatAffiliations(affiliationLines);
    if (affiliations) blocks.push({ type: 'paragraph', text: affiliations });
  }

  if (metadataLines.length) {
    blocks.push({
      type: 'blockquote',
      lines: formatMetadataLines(metadataLines)
    });
  }

  if (abstract) {
    blocks.push({ type: 'heading', level: 2, text: 'Abstract' });
    blocks.push({ type: 'paragraph', text: abstract });
  }

  if (keywords) {
    blocks.push({
      type: 'paragraph',
      text: `**Keywords:** ${keywords}`
    });
  }

  return { blocks, title };
}

function markCaptionLines(consumed, captionLines, lines) {
  for (const captionLine of captionLines) {
    const captionText = normalizeInline(captionLine.text);
    const tableMatch = captionText.match(/^Table\s+\d+\b/i);
    const match = lines.find((line) => {
      if (Math.abs(line.y - captionLine.y) >= 2.2) return false;
      if (normalizeInline(line.text) === captionText) return true;
      if (!tableMatch) return false;
      return new RegExp(`^${tableMatch[0].replace(/\s+/g, '\\s+')}\\b`, 'i').test(
        normalizeInline(line.text)
      );
    });
    if (match) consumed.add(match);
  }
}

function insideAnyTableBox(line, tables) {
  return tables.some(
    (table) =>
      line.y <= table.box.top + 2 &&
      line.y >= table.box.bottom - 2
  );
}

function insideAnyEquationBox(line, equations) {
  return equations.some(
    (equation) =>
      line.y <= equation.box.top + 2 &&
      line.y >= equation.box.bottom - 2 &&
      line.x >= equation.box.left - 2 &&
      line.x <= equation.box.right + 2
  );
}

function nextBodyLine(entries, startIndex) {
  for (let index = startIndex + 1; index < entries.length; index += 1) {
    if (entries[index].kind === 'line') return entries[index].line;
  }
  return null;
}

function isUnnumberedHeading(line, nextLine, leftMargin) {
  if (!line || !nextLine) return false;
  if (line.x > leftMargin + 2) return false;
  if (line.text.length > 100) return false;
  if (!/^[A-Z]/.test(line.text)) return false;
  if (/[.!?;:,]$/.test(line.text)) return false;
  if (!nextLine || nextLine.x <= leftMargin + 8) return false;
  if (!/f2|f3/i.test(line.fontName ?? '')) return false;
  if (/\b(?:is|are|was|were|be|been|has|have|can|may|should|would|will)\b/i.test(line.text)) {
    return false;
  }
  return !/^(?:Table|Figure|Keywords:)/i.test(line.text);
}

function buildPageBlocks(page, figures, tables, equations, state, unassignedImages = []) {
  const entries = [];
  const consumed = new Set();

  for (const table of tables) {
    markCaptionLines(consumed, table.captionLines, page.lines);
    entries.push({ kind: 'table', y: table.captionY, table });
  }

  for (const figure of figures) {
    markCaptionLines(consumed, figure.captionLines, page.lines);
    entries.push({ kind: 'figure', y: figure.captionY, figure });
  }

  for (const equation of equations) {
    entries.push({
      kind: 'equation',
      y: equation.anchorY ?? equation.box.top,
      equation
    });
  }

  for (const image of unassignedImages) {
    entries.push({ kind: 'figure', y: image.anchorY, figure: {
      number: null, caption: `未关联图片（第 ${image.pageNumber} 页，按页面位置插入）`, file: image.file, fallback: false
    } });
  }

  for (const line of page.lines) {
    if (isPageFurniture(line.text)) continue;
    if (isOrphanAccentLine(line.text)) continue;
    if (consumed.has(line)) continue;
    if (insideAnyTableBox(line, tables)) continue;
    if (insideAnyEquationBox(line, equations)) continue;
    entries.push({ kind: 'line', y: line.y, line });
  }

  if (page.twoColumn) {
    // Two-column pages are already in reading order; blocks must be inserted
    // next to the line they visually follow instead of re-sorting by y.
    const lineOrder = new Map(
      page.lines.map((line, index) => [line, index])
    );
    const insertIndex = (entry) => {
      const box = entry.table?.box ?? entry.figure?.box ?? entry.equation?.box;
      for (let index = 0; index < page.lines.length; index += 1) {
        const line = page.lines[index];
        if (line.y >= entry.y - 1) continue;
        if (box) {
          const right = line.x + line.width;
          if (right < box.left - 2 || line.x > box.right + 2) continue;
        }
        return index;
      }
      return page.lines.length;
    };

    entries.sort((a, b) => {
      const keyA =
        a.kind === 'line' ? lineOrder.get(a.line) : insertIndex(a) - 0.5;
      const keyB =
        b.kind === 'line' ? lineOrder.get(b.line) : insertIndex(b) - 0.5;
      return keyA - keyB;
    });
  } else {
    entries.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 0.5) {
        const priority = { table: 0, figure: 0, equation: 0, line: 1 };
        return priority[a.kind] - priority[b.kind];
      }
      return b.y - a.y;
    });
  }

  const bodyLines = entries
    .filter((entry) => entry.kind === 'line')
    .map((entry) => entry.line);
  const leftMargin = page.twoColumn
    ? Math.min(...bodyLines.map((line) => line.x), 0)
    : median(
        bodyLines.filter((line) => line.text.length > 24).map((line) => line.x)
      ) || Math.min(...bodyLines.map((line) => line.x), 0);

  const blocks = [];
  let paragraph = '';
  let paragraphStartX = null;
  let previousLine = null;
  let paragraphIsList = false;

  const flushParagraph = () => {
    if (!paragraph) return;
    blocks.push({
      type: 'paragraph',
      text: paragraph,
      list: paragraphIsList
    });
    paragraph = '';
    paragraphStartX = null;
    previousLine = null;
    paragraphIsList = false;
  };

  const startParagraph = (text, line, list = false) => {
    paragraph = text;
    paragraphStartX = line?.x ?? leftMargin;
    previousLine = line;
    paragraphIsList = list;
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry.kind === 'table') {
      flushParagraph();
      blocks.push({
        type: 'table',
        table: entry.table
      });
      continue;
    }

    if (entry.kind === 'figure') {
      flushParagraph();
      blocks.push({
        type: 'figure',
        figure: entry.figure
      });
      continue;
    }

    if (entry.kind === 'equation') {
      flushParagraph();
      blocks.push({
        type: 'equation',
        equation: entry.equation
      });
      continue;
    }

    const line = entry.line;
    const text = normalizeInline(line.text);
    if (!text) continue;
    // Inline formulas keep `$...$` delimiters; headings and reference starts are
    // still detected on the plain text so the patterns stay stable.
    const bodyText = line.mathText
      ? normalizeInline(line.mathText)
      : text;

    if (/^Disclaimer\/Publisher/i.test(text) && state.inReferences) {
      state.inReferences = false;
      state.referenceStyle = null;
    }

    if (state.inReferences) {
      if (!state.referenceStyle) {
        state.referenceStyle = REFERENCE_START.test(text)
          ? 'numbered'
          : BRACKET_REFERENCE_START.test(text)
            ? 'bracket'
            : 'author-year';
      }

      const startsReference =
        (state.referenceStyle === 'numbered' && REFERENCE_START.test(text)) ||
        (state.referenceStyle === 'bracket' &&
          BRACKET_REFERENCE_START.test(text)) ||
        (state.referenceStyle === 'author-year' &&
          AUTHOR_YEAR_REFERENCE_START.test(text));

      if (startsReference) {
        // Every bibliography entry starts on its own line; continuations are
        // joined inside the entry only.
        flushParagraph();
        startParagraph(bodyText, line, state.referenceStyle === 'numbered');
        continue;
      }

      if (!isLikelyHeading(text)) {
        // Reference continuations must stay inside the current reference,
        // including lines that start with a page or article number.
        if (!paragraph) {
          startParagraph(bodyText, line, state.referenceStyle === 'numbered');
        } else {
          paragraph = appendLine(paragraph, bodyText);
          previousLine = line;
        }
        continue;
      }

      // A numbered bibliography line ("84. Wang, ...") also looks like a
      // numbered heading. Only an explicit section heading ends the list.
      if (
        !isRomanSectionHeading(text) &&
        !isLetteredSubheading(text) &&
        !/^(?:acknowledg|appendix|appendix\s)/i.test(text)
      ) {
        if (!paragraph) {
          startParagraph(bodyText, line, state.referenceStyle === 'numbered');
        } else {
          paragraph = appendLine(paragraph, bodyText);
          previousLine = line;
        }
        continue;
      }

      state.inReferences = false;
      state.referenceStyle = null;
    }

    const numberedMatch = text.match(/^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/);
    const numberedHeading =
      Boolean(numberedMatch) &&
      line.height >= 9.9 &&
      numberedMatch[1].split('.').length <= 4 &&
      numberedMatch[2].length <= 110 &&
      !/[.;:,]$/.test(numberedMatch[2]) &&
      !/^\d/.test(numberedMatch[2]) &&
      !/\b(?:is|are|was|were|has|have|can|may|should|would|will)\b/i.test(
        numberedMatch[2]
      );
    const knownHeading = isLikelyHeading(text) || numberedHeading || /^(?:\d+\.?\s+)?Introduction$/i.test(text);
    const following = nextBodyLine(entries, index);
    const unnumbered = isUnnumberedHeading(line, following, leftMargin);
    const isHeading = knownHeading || unnumbered;

    if (isHeading) {
      flushParagraph();
      const level = knownHeading ? headingLevel(text) : 3;
      blocks.push({ type: 'heading', level, text: collapseSpacedCaps(text) });
      state.inReferences = /^References$/i.test(text);
      state.referenceStyle = null;
      continue;
    }

    const rqMatch = text.match(RQ_START);
    if (rqMatch) {
      flushParagraph();
      startParagraph(`- **${rqMatch[1]}** ${rqMatch[2]}`, line, true);
      continue;
    }

    if (!paragraph) {
      startParagraph(bodyText, line, false);
      continue;
    }

    const verticalGap = previousLine ? previousLine.y - line.y : 0;
    const newByIndent =
      line.x > leftMargin + 8 &&
      previousLine !== null &&
      previousLine.x <= leftMargin + 8;
    const newByGap = verticalGap > Math.max(17, Math.max(previousLine?.height ?? 10, line.height) * 1.55);
    const newRq = paragraphIsList && text.startsWith('RQ');

    if (newByIndent || newByGap || newRq) {
      flushParagraph();
      startParagraph(bodyText, line, false);
      continue;
    }

    paragraph = appendLine(paragraph, bodyText);
    previousLine = line;
  }

  flushParagraph();
  return blocks;
}

function formatCaption(kind, number, caption) {
  const escaped = escapeMarkdownText(caption);
  if (!number) return `**${kind}.** ${escaped}`;
  const prefix = kind === 'Figure' ? '(?:Figure|Fig\\.)' : 'Table';
  return escaped.replace(
    new RegExp(`^${prefix}\\s+${number}\\s*[.:]?\\s*`, 'i'),
    `**${kind} ${number}.** `
  );
}

function tableBlock(table) {
  const number = table.number ?? 0;
  const caption = table.part
    ? `**Table ${number} (part ${table.part}).** ${escapeMarkdownText(table.caption)}`
    : formatCaption('Table', number, table.caption);
  const lines = [caption, ''];

  if (table.imageOnly && table.image) {
    const label = table.part
      ? `Table ${number} (part ${table.part})`
      : `Table ${number}`;
    lines.push(`![${label}](${table.image})`);
    return lines.join('\n');
  }

  lines.push(table.markdown);
  if (table.image) {
    lines.push('', `[查看表格原图](${table.image})`);
  }
  if (table.confidence < 0.8) {
    lines.push(
      '',
      '> 自动重建的表格单元格可能不完整，请同时查看表格原图。'
    );
  }
  if (table.fallback) {
    lines.push('', '> 未检测到完整的表格框线，已使用文本布局回退重建。');
  }
  return lines.join('\n');
}

function figureBlock(figure) {
  const number = figure.number ?? 0;
  const caption = formatCaption('Figure', number, figure.caption);
  const lines = [];
  if (figure.file) {
    lines.push(`![Figure ${number || ''}](${figure.file})`);
    lines.push('');
  }
  lines.push(caption);
  if (figure.fallback) {
    lines.push('', '> 未能可靠定位图像，以上为图注所在页的截图，请对照原文核对。');
  }
  return lines.join('\n');
}

function equationBlock(equation) {
  if (equation.latex) {
    return `$$\n${equation.latex}\n$$`;
  }

  const number = equation.number ?? '';
  if (equation.file) {
    return [
      '<div class="equation-fallback">',
      `  <img src="${equation.file}" alt="Equation ${number}"${equation.width ? ` width="${Math.round(equation.width / 2)}"` : ''} loading="lazy">`,
      '</div>'
    ].join('\n');
  }

  return `<div class="equation-fallback"><span class="equation-missing">公式 ${number} 未生成</span></div>`;
}

function renderBlocks(blocks) {
  const output = [];
  for (const block of blocks) {
    if (block.type === 'comment') {
      output.push(block.text);
    } else if (block.type === 'heading') {
      output.push(`${'#'.repeat(block.level)} ${escapeMarkdownText(block.text)}`);
    } else if (block.type === 'paragraph') {
      const text = escapeMarkdownText(block.text);
      output.push(text);
    } else if (block.type === 'blockquote') {
      output.push(
        block.lines
          .map((line, index) => `> ${escapeMarkdownText(line)}${index < block.lines.length - 1 ? '  ' : ''}`)
          .join('\n')
      );
    } else if (block.type === 'table') {
      output.push(tableBlock(block.table));
    } else if (block.type === 'figure') {
      output.push(figureBlock(block.figure));
    } else if (block.type === 'equation') {
      output.push(equationBlock(block.equation));
    }
  }
  return output.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mergeCrossPageParagraphs(blocks) {
  const merged = [];

  for (const block of blocks) {
    if (block.type === 'comment') {
      merged.push(block);
      continue;
    }

    let previousIndex = merged.length - 1;
    while (previousIndex >= 0 && merged[previousIndex].type === 'comment') {
      previousIndex -= 1;
    }
    const previous = merged[previousIndex];

    if (
      block.type === 'paragraph' &&
      previous?.type === 'paragraph' &&
      !block.list &&
      !previous.list
    ) {
      const previousEndsOpen = !/[.!?;:]$/.test(previous.text);
      const shouldMerge =
        /-$/.test(previous.text) ||
        (previousEndsOpen && /^[a-z]/.test(block.text));
      if (shouldMerge) {
        previous.text = appendLine(previous.text, block.text);
        continue;
      }
    }

    merged.push(block);
  }

  return merged;
}

function mergeReferenceItems(blocks) {
  const merged = [];

  for (const block of blocks) {
    const isReference =
      block.type === 'paragraph' &&
      block.list &&
      /^\d+\.\s+/.test(block.text);
    const previous = merged[merged.length - 1];

    if (
      isReference &&
      previous?.type === 'paragraph' &&
      previous.list &&
      /^\d+\.\s+/.test(previous.text)
    ) {
      // A tight list keeps all references in one <ol>, even across a PDF page
      // break, so numbering cannot restart at 1.
      previous.text = `${previous.text}\n${block.text}`;
      continue;
    }

    merged.push(block);
  }

  return merged;
}

export function buildMarkdown({
  layout,
  pdfTextPages,
  metadata,
  figures,
  tables,
  equations = [],
  unassignedImages = []
}) {
  const page1Text = pdfTextPages?.[0]?.text ?? '';
  const page1 = layout.pages[0];
  const introLine = page1?.lines.find((line) =>
    /^(?:(?:\d+|[IVXLCDM]+)\.?\s+)?Introduction$/i.test(
      normalizeInline(line.text)
    )
  );
  // The body is built from positioned lines below; do not also absorb it into
  // front matter when the PDF has no explicit Abstract or Keywords labels.
  const introTextIndex = introLine
    ? page1Text.search(
        /^\s*(?:(?:\d+|[IVXLCDM]+)\.?\s+)?Introduction\s*$/im
      )
    : -1;
  const frontMatter = buildFrontMatter(introTextIndex >= 0 ? page1Text.slice(0, introTextIndex) : page1Text, metadata);
  const blocks = [
    { type: 'comment', text: '<!-- page: 1 -->' },
    ...frontMatter.blocks
  ];

  const figuresByPage = new Map();
  for (const figure of figures) {
    const list = figuresByPage.get(figure.pageNumber) ?? [];
    list.push(figure);
    figuresByPage.set(figure.pageNumber, list);
  }

  const tablesByPage = new Map();
  for (const table of tables) {
    const list = tablesByPage.get(table.pageNumber) ?? [];
    list.push(table);
    tablesByPage.set(table.pageNumber, list);
  }

  const equationsByPage = new Map();
  for (const equation of equations) {
    const list = equationsByPage.get(equation.pageNumber) ?? [];
    list.push(equation);
    equationsByPage.set(equation.pageNumber, list);
  }

  const state = { inReferences: false };

  // Some publishers start the first section on page 1 below the abstract.
  // Process that body separately while keeping the layout-based paragraph and
  // heading detection.
  const placedImages = new Set();
  if (introLine) {
    const introIndex = page1.lines.indexOf(introLine);
    const page1Body = {
      ...page1,
      lines:
        page1.twoColumn && introIndex >= 0
          ? page1.lines.slice(introIndex)
          : page1.lines.filter((line) => line.y <= introLine.y + 1)
    };
    const pageImages = unassignedImages.filter(
      (image) =>
        image.pageNumber === 1 &&
        Number.isFinite(image.anchorY) &&
        (page1.twoColumn || image.anchorY <= introLine.y + 1)
    );
    pageImages.forEach((image) => placedImages.add(image));
    blocks.push(...buildPageBlocks(page1Body, [], [], [], state, pageImages));
  }

  for (const page of layout.pages.slice(1)) {
    const pageImages = unassignedImages.filter((image) => image.pageNumber === page.pageNumber && Number.isFinite(image.anchorY));
    pageImages.forEach((image) => placedImages.add(image));
    if (!state.inReferences) {
      blocks.push({ type: 'comment', text: `<!-- page: ${page.pageNumber} -->` });
    }
    blocks.push(
      ...buildPageBlocks(
        page,
        (figuresByPage.get(page.pageNumber) ?? []).sort((a, b) => b.captionY - a.captionY),
        (tablesByPage.get(page.pageNumber) ?? []).sort((a, b) => b.captionY - a.captionY),
        (equationsByPage.get(page.pageNumber) ?? []).sort((a, b) => b.box.top - a.box.top),
        state,
        pageImages
      )
    );
  }

  const remainingImages = unassignedImages.filter((image) => !placedImages.has(image));
  if (remainingImages.length) {
    blocks.push({ type: 'heading', level: 2, text: '附录：未关联图片' });
    for (const image of remainingImages) {
      blocks.push({
        type: 'figure',
        figure: {
          number: null,
          caption: `未关联图片（第 ${image.pageNumber} 页）`,
          file: image.file,
          fallback: false
        }
      });
    }
  }

  const merged = mergeReferenceItems(mergeCrossPageParagraphs(blocks));
  const markdown = renderBlocks(merged);
  return {
    markdown: `${markdown}\n\n---\n\n*本文档由 pdf-parse-x 自动转换生成，共 ${layout.totalPages} 页。*`,
    title: frontMatter.title
  };
}
