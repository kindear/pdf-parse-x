import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  cleanLine,
  groupItemsIntoLines,
  isPageFurniture,
  isLikelyHeading,
  joinParagraphLines,
  joinTextItems,
  markdownTable,
  normalizeInline,
  normalizeTableHeader,
  repairDropCapLines,
  romanToNumber,
  toCsv
} from './text-utils.js';

const MIN_RULE_WIDTH = 90;
const CAPTION_LOOKBACK = 72;
const TABLE_GROUP_GAP = 360;

function multiplyMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function pathToSegments(pathData, ctm) {
  const segments = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  for (let index = 0; index < pathData.length; ) {
    const command = pathData[index++];
    if (command === 0) {
      x = pathData[index++];
      y = pathData[index++];
      startX = x;
      startY = y;
    } else if (command === 1) {
      const nextX = pathData[index++];
      const nextY = pathData[index++];
      segments.push([transformPoint(ctm, x, y), transformPoint(ctm, nextX, nextY)]);
      x = nextX;
      y = nextY;
    } else if (command === 2) {
      // Curves are irrelevant for table-rule detection.
      index += 6;
      x = pathData[index - 2];
      y = pathData[index - 1];
    } else if (command === 3) {
      if (x !== startX || y !== startY) {
        segments.push([transformPoint(ctm, x, y), transformPoint(ctm, startX, startY)]);
      }
      x = startX;
      y = startY;
    } else {
      // Unknown path operator: stop rather than misread the remaining bytes.
      break;
    }
  }

  return segments;
}

async function extractRules(page) {
  const operatorList = await page.getOperatorList();
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const horizontal = [];
  const vertical = [];
  const images = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === OPS.save) {
      stack.push(ctm.slice());
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrix(ctm, args);
    } else if (fn === OPS.paintImageXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transformPoint(ctm, x, y));
      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      images.push({ name: args[0], left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) });
    } else if (fn === OPS.constructPath) {
      const paths = args?.[1] ?? [];
      for (const pathData of paths) {
        if (!pathData || typeof pathData.length !== 'number') continue;
        for (const [[x1, y1], [x2, y2]] of pathToSegments(pathData, ctm)) {
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);
          if (height <= 0.8 && width >= MIN_RULE_WIDTH) {
            horizontal.push({
              x1: Math.min(x1, x2),
              x2: Math.max(x1, x2),
              y: (y1 + y2) / 2
            });
          } else if (width <= 0.8 && height >= 18) {
            vertical.push({
              y1: Math.min(y1, y2),
              y2: Math.max(y1, y2),
              x: (x1 + x2) / 2
            });
          }
        }
      }
    } else if (fn === OPS.rectangle) {
      const [x, y, width, height] = args;
      const corners = [
        transformPoint(ctm, x, y),
        transformPoint(ctm, x + width, y),
        transformPoint(ctm, x + width, y + height),
        transformPoint(ctm, x, y + height)
      ];
      for (let corner = 0; corner < 4; corner += 1) {
        const [x1, y1] = corners[corner];
        const [x2, y2] = corners[(corner + 1) % 4];
        if (Math.abs(y2 - y1) <= 0.8 && Math.abs(x2 - x1) >= MIN_RULE_WIDTH) {
          horizontal.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
        } else if (Math.abs(x2 - x1) <= 0.8 && Math.abs(y2 - y1) >= 18) {
          vertical.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
        }
      }
    }
  }

  return {
    horizontal: dedupeHorizontalRules(horizontal),
    vertical: dedupeVerticalRules(vertical),
    images
  };
}

function dedupeHorizontalRules(rules) {
  const sorted = [...rules].sort((a, b) => b.y - a.y || a.x1 - b.x1);
  const output = [];
  for (const rule of sorted) {
    const duplicate = output.some(
      (existing) =>
        Math.abs(existing.y - rule.y) < 0.8 &&
        Math.abs(existing.x1 - rule.x1) < 1.2 &&
        Math.abs(existing.x2 - rule.x2) < 1.2
    );
    if (!duplicate) output.push(rule);
  }
  return output;
}

function dedupeVerticalRules(rules) {
  const sorted = [...rules].sort((a, b) => a.x - b.x || b.y1 - a.y1);
  const output = [];
  for (const rule of sorted) {
    const duplicate = output.some(
      (existing) =>
        Math.abs(existing.x - rule.x) < 0.8 &&
        Math.abs(existing.y1 - rule.y1) < 1.2 &&
        Math.abs(existing.y2 - rule.y2) < 1.2
    );
    if (!duplicate) output.push(rule);
  }
  return output;
}

function groupRules(rules, pageHeight) {
  const usable = rules.filter(
    (rule) => rule.y > 42 && rule.y < pageHeight - 42 && rule.x2 - rule.x1 >= MIN_RULE_WIDTH
  );
  const groups = [];

  for (const rule of usable.sort((a, b) => b.y - a.y)) {
    let group = groups.find((candidate) => {
      const last = candidate.rules[candidate.rules.length - 1];
      return (
        Math.abs(candidate.x1 - rule.x1) < 3 &&
        Math.abs(candidate.x2 - rule.x2) < 3 &&
        last.y - rule.y > 2 &&
        last.y - rule.y < TABLE_GROUP_GAP
      );
    });

    if (!group) {
      group = { x1: rule.x1, x2: rule.x2, rules: [] };
      groups.push(group);
    }
    group.rules.push(rule);
  }

  return groups.filter((group) => group.rules.length >= 2);
}

function looksLikeTableReference(text) {
  const value = normalizeInline(text);
  if (!/^Table\s+(?:\d+|[IVXLC]+)\b/i.test(value)) return false;
  return /\b(?:concludes|reports|show|shows|summarizes|provides|presents|displays|compares|lists)\b/i.test(
    value
  );
}

function isTableCaptionStart(text) {
  const value = normalizeInline(text);
  // "Table 3. ..." (Arabic) and IEEE "TABLE III" / "TABLE III. Title" (Roman).
  if (/^Table\s+\d+[.:]?\s+[A-Z0-9(]/.test(value)) return true;
  return /^TABLE\s+[IVXLC]+\b/.test(value);
}

function collectSideCaptionLines(items, group, number) {
  const captionItems = items.filter(
    (item) =>
      item.x < group.x1 - 2 &&
      item.y >= group.rules[group.rules.length - 1].y - 10 &&
      item.y <= group.rules[0].y + 24 &&
      !isPageFurniture(item.text)
  );
  if (!captionItems.length) return [];

  const lines = groupItemsIntoLines(captionItems);
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^Table\\s+${number}\\b`, 'i').test(normalizeInline(line.text))
  );
  if (startIndex < 0) return [];

  const collected = [lines[startIndex]];
  let previous = lines[startIndex];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const gap = previous.y - line.y;
    if (gap > 18) break;
    if (/^(?:Table|Figure|Fig\.)\s+\d+/i.test(normalizeInline(line.text))) break;
    collected.push(line);
    previous = line;
  }

  return collected;
}

function findTableCaption(group, lines, items, pageHeight) {
  const tableTop = group.rules[0].y;
  const tableBottom = group.rules[group.rules.length - 1].y;
  const candidates = lines
    .filter(
      (line) =>
        isTableCaptionStart(line.text) &&
        !looksLikeTableReference(line.text) &&
        ((line.y > tableTop - 2 &&
          line.y < Math.min(pageHeight - 20, tableTop + CAPTION_LOOKBACK)) ||
          (line.x < group.x1 - 2 &&
            line.y <= tableTop + 16 &&
            line.y >= tableBottom - 16))
    )
    .sort((a, b) => b.y - a.y);

  if (!candidates.length) return null;

  const candidate = candidates[0];
  const number = extractNumber(candidate.text);
  if (candidate.x < group.x1 - 2) {
    const sideLines = collectSideCaptionLines(items, group, number);
    if (sideLines.length) {
      return { line: sideLines[0], lines: sideLines };
    }
  }

  const captionLines = lines
    .filter(
      (line) =>
        line.y >= tableTop - 2 &&
        line.y <= candidate.y + 2 &&
        !looksLikeTableReference(line.text)
    )
    .sort((a, b) => b.y - a.y);

  return { line: candidate, lines: captionLines };
}

function findHeaderSeparator(group, tableTop) {
  const internal = group.rules
    .filter((rule) => rule.y < tableTop - 2)
    .sort((a, b) => b.y - a.y);
  if (internal.length) return internal[0].y;
  return tableTop - Math.min(24, Math.max(12, (tableTop - group.rules[group.rules.length - 1].y) * 0.15));
}

function itemsInBox(items, box) {
  return items.filter(
    (item) =>
      item.x + item.width >= box.left - 1 &&
      item.x <= box.right + 1 &&
      item.y <= box.top + 1 &&
      item.y >= box.bottom - 1
  );
}

function mergeHeaderCells(items) {
  const visualLines = groupByY(items, 4);
  const cells = [];

  for (const line of visualLines) {
    const sorted = [...line.items].sort((a, b) => a.x - b.x);
    const lineCells = [];

    for (const item of sorted) {
      const last = lineCells[lineCells.length - 1];
      if (last && item.x - (last.x + last.width) < 6) {
        last.items.push(item);
        last.width = Math.max(last.x + last.width, item.x + item.width) - last.x;
        last.x = Math.min(last.x, item.x);
        last.height = Math.max(last.height, item.height);
      } else {
        lineCells.push({
          x: item.x,
          y: line.y,
          width: item.width,
          height: item.height,
          items: [item]
        });
      }
    }

    cells.push(...lineCells);
  }

  return cells
    .map((cell) => ({
      ...cell,
      text: normalizeTableHeader(joinTextItems(cell.items))
    }))
    .filter((cell) => cell.text);
}

function clusterColumnAnchors(items) {
  const centers = items
    .map((item) => item.x + item.width / 2)
    .sort((a, b) => a - b);
  const clusters = [];
  for (const center of centers) {
    const last = clusters[clusters.length - 1];
    if (last && center - last.center < 22) {
      last.values.push(center);
      last.center = last.values.reduce((sum, value) => sum + value, 0) / last.values.length;
    } else {
      clusters.push({ center, values: [center] });
    }
  }
  return clusters.map((cluster) => cluster.center);
}

function nearestIndex(value, anchors) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < anchors.length; index += 1) {
    const distance = Math.abs(value - anchors[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function groupByY(items, tolerance = 4) {
  const groups = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let group = groups.find((candidate) => Math.abs(candidate.y - item.y) < tolerance);
    if (!group) {
      group = { y: item.y, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.sort((a, b) => b.y - a.y);
}

function joinCellItems(items) {
  if (!items.length) return '';
  const lines = groupByY(items, 3.2);
  let text = '';
  for (const line of lines) {
    const lineText = joinTextItems(line.items);
    text = text ? `${text} ${lineText}` : lineText;
  }
  return cleanLine(text);
}

function buildTableModel(items, group, captionLine, captionLines, pageNumber) {
  const tableTop = group.rules[0].y;
  const tableBottom = group.rules[group.rules.length - 1].y;
  const tableItems = items.filter(
    (item) =>
      item.x + item.width >= group.x1 - 2 &&
      item.y <= tableTop + 1 &&
      item.y >= tableBottom - 1
  );
  const right = Math.max(
    group.x2,
    ...tableItems.map((item) => item.x + item.width)
  );
  const box = {
    left: group.x1,
    right,
    top: tableTop,
    bottom: tableBottom
  };
  const headerSeparator = findHeaderSeparator(group, tableTop);
  const boxItems = itemsInBox(items, box);
  const headerItems = boxItems.filter((item) => item.y <= tableTop + 1 && item.y >= headerSeparator - 1);
  const dataItems = boxItems.filter((item) => item.y < headerSeparator - 1 && item.y >= tableBottom - 1);

  let headerCells = mergeHeaderCells(headerItems);
  let anchors = headerCells.map((cell) => cell.x + cell.width / 2);

  if (headerCells.length < 2) {
    anchors = clusterColumnAnchors(dataItems);
    headerCells = anchors.map((anchor, index) => ({
      text: `Column ${index + 1}`,
      x: anchor,
      width: 0,
      y: headerSeparator,
      items: []
    }));
  }

  if (anchors.length < 2 || dataItems.length === 0) {
    return null;
  }

  const col0Boundary = (anchors[0] + anchors[1]) / 2;
  const firstColumnItems = dataItems.filter(
    (item) => item.x + item.width / 2 < col0Boundary
  );
  let rowLabels = groupByY(firstColumnItems, 4).map((grouped) => ({
    y: grouped.y,
    text: joinCellItems(grouped.items)
  }));

  if (!rowLabels.length) {
    rowLabels = groupByY(dataItems, 5).map((grouped) => ({
      y: grouped.y,
      text: ''
    }));
  }

  const rows = rowLabels.map((label) => ({
    label: label.text,
    y: label.y,
    cells: Array.from({ length: anchors.length }, () => [])
  }));

  for (const item of dataItems) {
    const column = nearestIndex(item.x + item.width / 2, anchors);
    const row = nearestIndex(item.y, rowLabels.map((label) => label.y));
    rows[row].cells[column].push(item);
  }

  const tableRows = rows.map((row) => {
    const label = row.label || joinCellItems(row.cells[0]);
    return [label, ...row.cells.slice(1).map((cellItems) => joinCellItems(cellItems))];
  });

  const nonEmpty = tableRows.reduce(
    (count, row) => count + row.filter((cell) => normalizeInline(cell)).length,
    0
  );
  const totalCells = tableRows.length * anchors.length;
  const confidence = totalCells ? nonEmpty / totalCells : 0;

  const caption = cleanLine(captionLines.map((line) => line.text).join(' '));
  const headers = headerCells.map((cell) => normalizeTableHeader(cell.text));

  return {
    pageNumber,
    number: extractNumber(caption),
    caption,
    captionLines: captionLines.map((line) => ({
      y: line.y,
      x: line.x,
      text: line.text
    })),
    captionY: captionLine.y,
    captionTop: Math.max(...captionLines.map((line) => line.y + line.height)),
    box,
    headerSeparator,
    headers,
    rows: tableRows,
    markdown: markdownTable(headers, tableRows),
    csv: toCsv([headers, ...tableRows]),
    confidence,
    ruleCount: group.rules.length,
    sourceText: boxItems.map((item) => item.text).join(' ')
  };
}

function extractNumber(text) {
  const match = normalizeInline(text).match(/^(Table|Figure|Fig\.?)\s+(\d+)/i);
  if (match) return Number(match[2]);

  const roman = normalizeInline(text).match(
    /^(?:Table|TABLE)\s+([IVXLC]+)\b/
  );
  if (roman) return romanToNumber(roman[1]);

  return null;
}

function fallbackTableFromCaption(lines, items, captionLine, pageHeight, pageNumber) {
  const tableTop = captionLine.y - 4;
  const nextHeading = lines
    .filter(
      (line) =>
        line.y < tableTop - 12 &&
        (isLikelyHeading(line.text) || /^Figure\s+\d+[.:]\s+/i.test(line.text))
    )
    .sort((a, b) => b.y - a.y)[0];
  const bottomLimit = nextHeading ? nextHeading.y + 4 : 48;
  const contentLines = lines
    .filter((line) => line.y < tableTop && line.y > bottomLimit)
    .sort((a, b) => b.y - a.y);

  if (contentLines.length < 3) return null;

  const candidateRows = contentLines
    .map((line) => ({
      ...line,
      cellCount: line.items.filter((item) => item.str ?? item.text).length
    }))
    .filter((line) => line.cellCount >= 2);

  if (candidateRows.length < 2) return null;

  const xValues = candidateRows.flatMap((line) => line.items.map((item) => item.x + item.width / 2));
  const anchors = clusterColumnAnchors(
    xValues.map((center) => ({ x: center, width: 0, y: 0 }))
  );
  if (anchors.length < 2) return null;

  const captionLines = lines.filter(
    (line) => line.y >= tableTop - 1 && line.y <= captionLine.y + 2
  );
  const caption = cleanLine(captionLines.map((line) => line.text).join(' '));
  const tableRows = candidateRows.map((line) => {
    const cells = Array.from({ length: anchors.length }, () => []);
    for (const item of line.items) {
      cells[nearestIndex(item.x + item.width / 2, anchors)].push(item);
    }
    return cells.map((itemsInCell) => joinCellItems(itemsInCell));
  });
  if (tableRows.length < 2) return null;

  const headers = tableRows.shift();
  return {
    pageNumber,
    number: extractNumber(caption),
    caption,
    captionLines: captionLines.map((line) => ({
      y: line.y,
      x: line.x,
      text: line.text
    })),
    captionY: captionLine.y,
    captionTop: Math.max(...captionLines.map((line) => line.y + line.height)),
    box: {
      left: Math.min(...anchors) - 12,
      right: Math.max(...anchors) + 24,
      top: tableTop,
      bottom: bottomLimit
    },
    headerSeparator: tableTop,
    headers,
    rows: tableRows,
    markdown: markdownTable(headers, tableRows),
    csv: toCsv([headers, ...tableRows]),
    confidence: 0.45,
    ruleCount: 0,
    fallback: true
  };
}

function tableLikeItems(line, captionX, sideCaption) {
  return line.items.filter(
    (item) =>
      item.x > (sideCaption ? captionX + 40 : captionX - 2) &&
      !isPageFurniture(item.text)
  );
}

function lineLooksTabular(line, caption, sideCaption) {
  const candidates = tableLikeItems(line, caption.x, sideCaption);
  if (!candidates.length) return false;

  const numericTokens = normalizeInline(line.text).match(/\b\d[\d,.]*%?/g) ?? [];
  if (numericTokens.length >= 2) return true;

  if (candidates.length < 2) return false;
  const xPositions = candidates
    .map((item) => Math.round(item.x / 6) * 6)
    .filter((value, index, values) => values.indexOf(value) === index);
  return xPositions.length >= 2;
}

function looksLikeProseLine(line, caption) {
  const text = normalizeInline(line.text);
  if (line.x > caption.x + 24 || text.length < 40) return false;
  const stopwords = (
    text.match(
      /\b(?:the|of|and|in|to|for|with|that|this|we|our|is|are|be|as|by|on|from|shows|show|provide|provides|report|reports)\b/gi
    ) ?? []
  ).length;
  return stopwords >= 3;
}

function buildFallbackTable(lines, items, caption, pageHeight, pageNumber, pageWidth = 0) {
  const captionText = normalizeInline(caption.text);
  const number = extractNumber(captionText);
  if (!number) return null;

  // A caption centred on the page belongs to a full-width table; restricting
  // the crop to the caption's x would cut off the left half of the table.
  const captionCenter = caption.x + (caption.width ?? 0) / 2;
  const centeredCaption =
    pageWidth > 0 &&
    Math.abs(captionCenter - pageWidth / 2) < pageWidth * 0.08;

  const rightCaptionItems = caption.items.filter(
    (item) => item.x > caption.x + 80
  );
  const sideCaption =
    rightCaptionItems.length >= 2 &&
    rightCaptionItems.every(
      (item) => normalizeInline(item.text).length <= 20
    );
  const startIndex = lines.findIndex((line) => line === caption);
  if (startIndex < 0) return null;

  const included = [];
  let lastTabularY = null;
  let gapWithoutTable = 0;
  let sawDataRow = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.y > caption.y + 6) continue;
    if (line.y < 35) break;
    if (index > startIndex && /^(?:Table|Figure|Fig\.)\s+\d+/i.test(line.text)) break;
    if (
      index > startIndex &&
      /^\d+\.?\s+[A-Z]/.test(line.text) &&
      line.height >= 9.9
    ) {
      break;
    }

    if (sawDataRow && looksLikeProseLine(line, caption)) break;

    const tabular = lineLooksTabular(line, caption, sideCaption);
    const tableCandidates = tableLikeItems(line, caption.x, sideCaption);
    const numericCount = (
      normalizeInline(line.text).match(/\b\d[\d,.]*%?/g) ?? []
    ).length;
    const looksLikeBody =
      !centeredCaption &&
      line.x <= caption.x + 18 &&
      line.text.length > 45 &&
      tableCandidates.length === 0;

    if (looksLikeBody && sawDataRow && included.length >= 2) break;

    if (tabular) {
      included.push(line);
      lastTabularY = line.y;
      if (index > startIndex && numericCount >= 4) sawDataRow = true;
      gapWithoutTable = 0;
    } else if (included.length && line.y > (lastTabularY ?? line.y) - 28) {
      included.push(line);
      gapWithoutTable += 1;
    } else if (included.length) {
      gapWithoutTable += 1;
      if (gapWithoutTable >= 2) break;
    } else if (caption.y - line.y > 80) {
      break;
    }
  }

  if (included.length < 2 || lastTabularY === null) return null;

  const verticalItems = included.flatMap((line) => line.items).filter((item) => {
    if (isPageFurniture(item.text)) return false;
    if (centeredCaption) return true;
    return sideCaption ? item.x > caption.x + 40 : item.x >= caption.x - 2;
  });
  if (!verticalItems.length) return null;

  const detectedLeft = Math.max(
    0,
    Math.min(...verticalItems.map((item) => item.x)) - 4
  );
  const left = sideCaption
    ? Math.max(detectedLeft, caption.x + 110)
    : detectedLeft;
  const right = Math.min(
    10000,
    Math.max(...verticalItems.map((item) => item.x + item.width)) + 4
  );
  const top = Math.min(
    pageHeight,
    Math.max(
      caption.y + (caption.height ?? 9),
      ...included.map((line) => line.y + line.height)
    ) + 3
  );
  const bottom = Math.max(0, lastTabularY - 8);

  if (right - left < 40 || top - bottom < 24) return null;

  let resolvedCaption = captionText;
  if (sideCaption) {
    const leftCaptionItems = lines
      .filter((line) => line.y <= top + 6 && line.y >= bottom - 6)
      .flatMap((line) => line.items)
      .filter((item) => item.x < left - 2 && !isPageFurniture(item.text));
    if (leftCaptionItems.length) {
      const captionLines = groupItemsIntoLines(leftCaptionItems);
      const start = captionLines.findIndex((line) =>
        new RegExp(`^Table\\s+${number}\\b`, 'i').test(normalizeInline(line.text))
      );
      if (start >= 0) {
        resolvedCaption = joinParagraphLines(
          captionLines.slice(start).map((line) => line.text)
        );
      }
    }
  } else {
    const captionNeedsContinuation =
      /(?:[,(–—-]|\b(?:or|and|in|of|for|with|to|the|a|an|by|on|as|is|are|was|were))$/i.test(
        captionText
      );
    if (captionNeedsContinuation) {
      const continuationLines = lines
        .filter(
          (line) =>
            line.y < caption.y - 2 &&
            line.y > caption.y - 30 &&
            Math.abs(line.x - caption.x) < 6 &&
            !/^(?:Table|Figure|Fig\.)\s+\d+/i.test(line.text)
        )
        .sort((a, b) => b.y - a.y);
      if (continuationLines.length) {
        resolvedCaption = joinParagraphLines([
          captionText,
          ...continuationLines.map((line) => line.text)
        ]);
      }
    }
  }

  const captionLines = [caption];
  const captionTop = caption.y + (caption.height ?? 9);

  return {
    pageNumber,
    number,
    caption: cleanLine(resolvedCaption),
    captionLines: captionLines.map((line) => ({
      y: line.y,
      x: line.x,
      text: line.text
    })),
    captionY: caption.y,
    captionTop,
    box: { left, right, top, bottom },
    headerSeparator: top,
    headers: [],
    rows: [],
    markdown: '',
    csv: '',
    confidence: 0,
    ruleCount: 0,
    fallback: true,
    imageOnly: true,
    sourceText: items
      .filter(
        (item) =>
          item.y <= top + 1 &&
          item.y >= bottom - 1 &&
          item.x + item.width >= left - 2 &&
          item.x <= right + 2
      )
      .map((item) => item.text)
      .join(' ')
  };
}

function detectTables(lines, rules, items, pageHeight, pageNumber, pageWidth) {
  const tables = [];
  const usedCaptionY = new Set();
  const usedNumbers = new Set();

  for (const group of groupRules(rules.horizontal, pageHeight)) {
    const caption = findTableCaption(group, lines, items, pageHeight);
    if (!caption) continue;

    const table = buildTableModel(
      items,
      group,
      caption.line,
      caption.lines,
      pageNumber
    );
    if (!table) continue;

    // Cell density is not a quality signal: check-mark matrices and merged
    // headers are legitimately sparse. Only a grid with no usable data is kept
    // as the original crop; sparse grids still get a Markdown table plus the
    // low-confidence warning in the builder.
    if (!table.rows.length || table.confidence === 0) table.imageOnly = true;
    usedCaptionY.add(Math.round(caption.line.y * 10) / 10);
    usedNumbers.add(table.number);
    tables.push(table);
  }

  for (const line of lines) {
    const text = normalizeInline(line.text);
    if (!isTableCaptionStart(text)) continue;
    if (looksLikeTableReference(text)) continue;
    const number = extractNumber(text);
    const roundedY = Math.round(line.y * 10) / 10;
    if (usedNumbers.has(number) || usedCaptionY.has(roundedY)) continue;

    const fallback = buildFallbackTable(
      lines,
      items,
      line,
      pageHeight,
      pageNumber,
      pageWidth
    );
    if (fallback) {
      usedCaptionY.add(roundedY);
      usedNumbers.add(number);
      tables.push(fallback);
    }
  }

  // Rotated tables often place their captions at the page edge and cannot be
  // reconstructed from horizontal rules. Preserve the page as a rotated table
  // image. This is generic: any `Table N` edge caption is supported, and
  // multi-page tables are split into parts by the parser.
  for (const line of lines) {
    const text = normalizeInline(line.text);
    const match = text.match(/^Table\s*(\d+)/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number > 100) continue;
    if (looksLikeTableReference(text)) continue;
    if (line.y >= 90 && line.x >= 45) continue;
    if (tables.some((table) => table.number === number && table.pageNumber === pageNumber)) {
      continue;
    }

    const captionLines = lines
      .filter(
        (row) =>
          Math.abs(row.x - line.x) <= 12 &&
          row.y <= line.y + 20 &&
          row.y >= line.y - 160 &&
          !isPageFurniture(row.text)
      )
      .sort((a, b) => b.y - a.y);
    const edgeText = joinParagraphLines(
      captionLines
        .filter(
          (row) =>
            !new RegExp(`^Table\\s*${number}`, 'i').test(row.text)
        )
        .map((row) => row.text)
    )
      .replace(/\s+/g, ' ')
      .trim();
    const baseCaption =
      edgeText && !/^\(?continued\)?$/i.test(edgeText)
        ? edgeText
        : '';
    const caption = /^Table\b/i.test(baseCaption)
      ? baseCaption
      : `Table ${number}${baseCaption ? ` ${baseCaption}` : ''}`;

    // A rotated table fills its page, but the crop still has to hug the actual
    // ink: use the text extent instead of a fixed full-page rectangle so no
    // whole-page screenshot ends up in the Markdown.
    const contentItems = items.filter(
      (item) => !isPageFurniture(item.text) && normalizeInline(item.text)
    );
    const bounds = contentItems.length
      ? {
          left: Math.max(0, Math.min(...contentItems.map((item) => item.x)) - 6),
          right: Math.min(
            pageWidth,
            Math.max(...contentItems.map((item) => item.x + item.width)) + 6
          ),
          top: Math.min(
            pageHeight,
            Math.max(...contentItems.map((item) => item.y + item.height)) + 6
          ),
          bottom: Math.max(
            0,
            Math.min(...contentItems.map((item) => item.y)) - 6
          )
        }
      : {
          left: 46,
          right: pageWidth - 46,
          top: pageHeight - 45,
          bottom: 35
        };

    tables.push({
      pageNumber,
      number,
      part: 1,
      fileKey: `${String(number).padStart(2, '0')}-part-1`,
      caption,
      captionLines: captionLines.map((row) => ({
        y: row.y,
        x: row.x,
        text: row.text
      })),
      captionY: pageHeight - 55,
      captionTop: bounds.top,
      box: bounds,
      headerSeparator: bounds.top,
      headers: [],
      rows: [],
      markdown: '',
      csv: '',
      confidence: 0,
      ruleCount: 0,
      fallback: true,
      imageOnly: true,
      rotate: 90,
      sourceText: lines.map((row) => row.text).join(' ')
    });
  }

  return tables.sort((a, b) => b.captionY - a.captionY);
}

function equationNumber(text) {
  const match = normalizeInline(text).match(/\((\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

function detectEquations(lines, pageWidth, pageHeight, pageNumber) {
  const candidates = [];

  for (const line of lines) {
    if (line.y < 45 || line.y > pageHeight - 45) continue;
    const numberItem = line.items.find((item) =>
      /^\(\d+\)$/.test(normalizeInline(item.text))
    );
    if (!numberItem) continue;

    const number = Number(normalizeInline(numberItem.text).replace(/[()]/g, ''));
    if (number > 100) continue;
    if (numberItem.x < pageWidth * 0.5) continue;
    if (line.x < pageWidth * 0.28 && normalizeInline(line.text).length > 12) {
      continue;
    }

    candidates.push({
      line,
      number,
      numberBox: {
        x: numberItem.x,
        y: numberItem.y,
        width: numberItem.width,
        height: numberItem.height
      }
    });
  }

  if (!candidates.length) return [];

  const groups = candidates.map((candidate) => ({
    ...candidate,
    lines: []
  }));

  for (const line of lines) {
    if (line.x < pageWidth * 0.2 || line.y < 40 || line.y > pageHeight - 40) continue;
    if (isPageFurniture(line.text)) continue;

    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const distance = Math.abs(group.line.y - line.y);
      if (distance < nearestDistance) {
        nearest = group;
        nearestDistance = distance;
      }
    }

    if (nearest) {
      const anchor = nearest.line;
      const anchorWithoutNumber = normalizeInline(anchor.text)
        .replace(/\(\d+\)\s*$/, '')
        .trim();
      const isolatedNumber = anchorWithoutNumber.length === 0;
      const maxDistance = isolatedNumber ? 70 : 45;
      const withinFormulaWidth = isolatedNumber
        ? line.x >= pageWidth * 0.2
        : line.x >= anchor.x - 60 &&
          line.x <= anchor.x + anchor.width + 40;
      if (nearestDistance <= maxDistance && withinFormulaWidth) {
        nearest.lines.push(line);
      }
    }
  }

  return groups
    .filter((group) => group.lines.length)
    .map((group) => {
      const left = Math.max(0, Math.min(...group.lines.map((line) => line.x)) - 7);
      const right = Math.min(
        pageWidth,
        Math.max(...group.lines.map((line) => line.x + line.width)) + 7
      );
      const top = Math.min(
        pageHeight,
        Math.max(...group.lines.map((line) => line.y + line.height)) + 4
      );
      const bottom = Math.max(0, Math.min(...group.lines.map((line) => line.y)) - 6);

      return {
        pageNumber,
        number: group.number,
        anchorY: group.line.y,
        numberBox: group.numberBox,
        box: { left, right, top, bottom },
        lines: group.lines.map((line) => ({
          y: line.y,
          x: line.x,
          text: line.text
        }))
      };
    })
    .sort((a, b) => b.box.top - a.box.top);
}

const MATH_GLYPHS =
  /[\u2211\u220f\u222b\u221a\u2202\u2207\u00b1\u00d7\u00f7\u2248\u2260\u2264\u2265\u2261\u221e\u2192\u2190\u21d2\u03b1-\u03c9\u0391-\u03a9\u03d5\u03d1]/g;
const PROSE_STOPWORDS =
  /\b(?:the|and|of|in|for|with|that|this|are|is|was|were|be|if|then|when|where|such|from|by|as|on|at|to)\b/gi;

function countWords(text) {
  return (text.match(/[A-Za-z]{2,}/g) ?? []).length;
}

function dominantBodyFont(lines) {
  const counts = new Map();
  for (const line of lines) {
    if (countWords(line.text) < 4) continue;
    const font = line.fontName ?? '';
    if (!font) continue;
    counts.set(font, (counts.get(font) ?? 0) + 1);
  }

  let best = '';
  let bestCount = 0;
  for (const [font, count] of counts) {
    if (count > bestCount) {
      best = font;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Numbered display equations are found via their right-aligned `(n)` marker.
 * Unnumbered ones (common in Springer/Elsevier layouts) are detected by their
 * typography instead: short, symbol-heavy lines typeset in a font other than
 * the body font, clustered vertically. Their text layer is usually scrambled
 * (separate runs for sum limits, fractions and radicals), so the region is kept
 * as a crop and can be transcribed to LaTeX by the vision model.
 */
function detectUnnumberedEquations(lines, pageWidth, pageHeight, pageNumber, numbered) {
  const bodyFont = dominantBodyFont(lines);
  const blocked = [];
  for (const equation of numbered) {
    // Nearby fragments (sum limits, fraction numerators) belong to the numbered
    // equation even when they sit outside its exact box.
    blocked.push({
      left: equation.box.left - 12,
      right: equation.box.right + 12,
      top: equation.box.top + 36,
      bottom: equation.box.bottom - 36
    });
  }

  const inBlocked = (line) =>
    blocked.some(
      (box) =>
        line.y <= box.top && line.y >= box.bottom && line.x >= box.left && line.x <= box.right
    );

  const candidates = lines.filter((line) => {
    const text = normalizeInline(line.text);
    if (!text || text.length > 90) return false;
    if (line.y < 45 || line.y > pageHeight - 45) return false;
    if (isPageFurniture(text)) return false;
    if (/^(?:Table|Figure|Fig\.)\s*\d/i.test(text)) return false;
    if (inBlocked(line)) return false;

    const glyphs = (text.match(MATH_GLYPHS) ?? []).length;
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    const stopwords = (text.match(PROSE_STOPWORDS) ?? []).length;
    const operator = /[=\u2248\u2264\u2265<>]/.test(text);
    // Math-font lines may carry a few multi-letter names (`log`, `min`); plain
    // prose sharing the line still has everyday stopwords and stays rejected.
    const words = countWords(text);
    if (words > 3 && !(operator && words <= 6)) return false;
    // Two or more everyday words means this is prose with inline math.
    if (stopwords >= 2) return false;
    if (letters > 24 && glyphs < 2) return false;
    const mathish = glyphs > 0 || letters <= 2;
    if (!mathish) return false;

    // Body-font prose without math glyphs is never a display equation.
    if (bodyFont && line.fontName === bodyFont) return false;

    // A display equation is set apart from the text block: indented, centered,
    // or clearly narrower than the body column.
    const indented = line.x > pageWidth * 0.16;
    const narrow = line.width < pageWidth * 0.55;
    return indented || narrow;
  });

  const clusters = [];
  for (const line of [...candidates].sort((a, b) => b.y - a.y)) {
    const current = clusters[clusters.length - 1];
    // Compare with the line just added (limits sit right under the row above),
    // but keep a cap on the total height so two equations never fuse.
    const gap = current ? current.lastY - line.y : Number.POSITIVE_INFINITY;
    const span = current ? current.top - line.y : Number.POSITIVE_INFINITY;
    if (current && gap <= 26 && span <= 40) {
      current.lines.push(line);
      current.lastY = line.y;
      current.top = Math.max(current.top, line.y + line.height);
      continue;
    }
    clusters.push({ lines: [line], top: line.y + line.height, lastY: line.y });
  }

  return clusters
    .filter((cluster) => {
      const joined = cluster.lines.map((line) => normalizeInline(line.text)).join(' ');
      const glyphs = (joined.match(MATH_GLYPHS) ?? []).length;
      const hasOperator = /[=\u2248\u2264\u2265<>]/.test(joined);
      const width =
        Math.max(...cluster.lines.map((line) => line.x + line.width)) -
        Math.min(...cluster.lines.map((line) => line.x));
      // Real display equations carry an operator; a formula typeset over
      // several baselines (limit, numerator, denominator) is accepted even when
      // it is narrow, as long as the cluster really stacks math rows.
      if (!hasOperator) return false;
      // A sentence that swallows an inline formula (`… = 1200 benchmark
      // observations. We propose…`) is running text, not a display equation.
      if (/\.\s+[A-Z]/.test(joined)) return false;
      const stacked = cluster.lines.length >= 3 && glyphs >= 2;
      if (width < pageWidth * 0.25 && glyphs < 3 && !stacked) return false;
      if (width > pageWidth * 0.95) return false;
      return true;
    })
    .map((cluster) => {
      const left = Math.max(0, Math.min(...cluster.lines.map((line) => line.x)) - 8);
      const right = Math.min(
        pageWidth,
        Math.max(...cluster.lines.map((line) => line.x + line.width)) + 8
      );
      const top = Math.min(
        pageHeight,
        Math.max(...cluster.lines.map((line) => line.y + line.height)) + 5
      );
      const bottom = Math.max(0, Math.min(...cluster.lines.map((line) => line.y)) - 5);

      return {
        pageNumber,
        number: null,
        unnumbered: true,
        anchorY: Math.max(...cluster.lines.map((line) => line.y)),
        numberBox: null,
        box: { left, right, top, bottom },
        lines: cluster.lines.map((line) => ({
          y: line.y,
          x: line.x,
          text: line.text
        }))
      };
    })
    .sort((a, b) => b.box.top - a.box.top);
}

/**
 * Join the stray math fragments that belong to an equation (sum signs, limits,
 * `k=1`, lone digits) into the nearest equation box. Without this they stay in
 * the text flow and show up as `∑ ∑ …` noise inside paragraphs.
 */
function absorbMathFragments(lines, equations, pageHeight) {
  if (!equations.length) return;

  const taken = new Set();
  for (const equation of equations) {
    for (const line of equation.lines ?? []) {
      taken.add(`${line.y}:${line.x}:${line.text}`);
    }
  }

  for (const line of lines) {
    const text = normalizeInline(line.text);
    if (!text || text.length > 40) continue;
    if (line.y < 45 || line.y > pageHeight - 45) continue;
    const key = `${line.y}:${line.x}:${line.text}`;
    if (taken.has(key)) continue;

    const words = countWords(text);
    const glyphs = (text.match(MATH_GLYPHS) ?? []).length;
    const symbolFragment = glyphs > 0 && words <= 1;
    const tinyFragment = text.length <= 8 && /^[\d\s.,·+\-–—=]+$/.test(text);
    // Sum limits that lost their equation row: `i j`, `i j k=1`, `k=1`.
    const limitFragment =
      text.length <= 12 && /^(?:[a-z](?:\s*=\s*\d+)?\s*)+$/i.test(text);
    if (!symbolFragment && !tinyFragment && !limitFragment) continue;

    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const equation of equations) {
      const distance = Math.abs((equation.anchorY ?? equation.box.top) - line.y);
      if (distance < nearestDistance) {
        nearest = equation;
        nearestDistance = distance;
      }
    }

    if (!nearest || nearestDistance > (symbolFragment ? 72 : limitFragment ? 40 : 42)) continue;

    taken.add(key);
    nearest.lines = nearest.lines ?? [];
    nearest.lines.push({ y: line.y, x: line.x, text: line.text });
    nearest.box = {
      left: Math.min(nearest.box.left, line.x - 6),
      right: Math.max(nearest.box.right, line.x + line.width + 6),
      top: Math.max(nearest.box.top, line.y + line.height + 4),
      bottom: Math.min(nearest.box.bottom, line.y - 4)
    };
  }
}

function detectFigures(lines, pageHeight, pageNumber) {
  const figures = [];
  const captionCandidates = lines
    .filter((line) =>
      /^(?:Fig\.\s*\d+[.:]?|Figure\s+\d+[.:])\s+/i.test(normalizeInline(line.text))
    )
    .sort((a, b) => b.y - a.y);

  for (const captionLine of captionCandidates) {
    const captionLines = [captionLine];
    let previous = captionLine;
    for (const line of lines
      .filter((candidate) => candidate.y < previous.y - 1)
      .sort((a, b) => b.y - a.y)) {
      const gap = previous.y - line.y;
      if (gap > 18 || line.y < 40) break;
      if (/^(?:Figure|Table)\s+\d+[.:]\s+/i.test(normalizeInline(line.text))) {
        break;
      }
      if (line.text && !isPageFurniture(line.text)) {
        captionLines.push(line);
        previous = line;
      }
    }

    const caption = cleanLine(captionLines.map((line) => line.text).join(' '));
    figures.push({
      pageNumber,
      number: extractNumber(caption),
      caption,
      captionLines: captionLines.map((line) => ({
        y: line.y,
        x: line.x,
        text: line.text
      })),
      captionY: captionLine.y,
      captionTop: Math.max(...captionLines.map((line) => line.y + line.height))
    });
  }

  return figures.sort((a, b) => b.captionY - a.captionY);
}

const COLUMN_GAP_MIN_WIDTH = 8;
const COLUMN_MIN_LINES_PER_SIDE = 12;

function findColumnSplit(items, pageWidth, pageHeight) {
  const minX = pageWidth * 0.32;
  const maxX = pageWidth * 0.68;

  // A single-column page is dominated by body lines that run almost the full
  // text width; two-column pages only have a few full-width lines (title,
  // abstract, wide figures).
  const wide = items.filter((item) => item.width > pageWidth * 0.55);
  if (wide.length > items.length * 0.15) return null;

  // Full-width lines span the gutter by design, so the gutter is located from
  // column-width items only.
  const narrow = items.filter((item) => item.width <= pageWidth * 0.52);
  // Journal bodies are bottom-heavy: ignoring the header band avoids treating
  // a centered title/affiliation block as the gutter.
  const lowerBand = narrow.filter((item) => item.y <= pageHeight * 0.7);
  const sample = lowerBand.length >= 15 ? lowerBand : narrow;
  if (sample.length < 15) return null;

  const crosses = (item, x) => item.x < x - 1 && item.x + item.width > x + 1;

  let best = null;
  for (let x = minX; x <= maxX; x += 1) {
    let crossings = 0;
    for (const item of sample) {
      if (crosses(item, x)) crossings += 1;
    }
    if (!best || crossings < best.crossings) best = { x, crossings };
  }
  if (!best) return null;

  if (best.crossings > Math.max(2, Math.floor(sample.length * 0.05))) {
    return null;
  }

  const leftItems = sample.filter((item) => item.x + item.width <= best.x + 1);
  const rightItems = sample.filter((item) => item.x >= best.x - 1);
  if (leftItems.length < 12 || rightItems.length < 12) return null;

  // The two clusters must be separated by a real gutter; on a single-column
  // page the short lines overlap the candidate split instead.
  const leftEdge = Math.max(...leftItems.map((item) => item.x + item.width));
  const rightEdge = Math.min(...rightItems.map((item) => item.x));
  if (rightEdge - leftEdge < COLUMN_GAP_MIN_WIDTH) return null;

  return (leftEdge + rightEdge) / 2;
}

/**
 * Group a page into reading order. Two-column journal layouts share baselines
 * between columns, so a pure y-sort interleaves unrelated text. When a clear
 * gutter exists the page is read band by band: full-width lines stay in place
 * and each band is emitted left column then right column.
 */
export function groupPageLines(items, pageWidth, pageHeight) {
  if (items.length < COLUMN_MIN_LINES_PER_SIDE * 2) {
    const lines = groupItemsIntoLines(items);
    repairDropCapLines(lines);
    return { lines, twoColumn: false };
  }

  const split = findColumnSplit(items, pageWidth, pageHeight);
  if (!split) {
    const lines = groupItemsIntoLines(items);
    repairDropCapLines(lines);
    return { lines, twoColumn: false };
  }

  // Group by baseline first, then decide per line whether it really spans both
  // columns. A merged two-column line has a wide empty gap in the gutter; a
  // wide title or full-width caption does not.
  const rawLines = groupItemsIntoLines(items);
  const leftLines = [];
  const rightLines = [];
  const spanningLines = [];

  for (const line of rawLines) {
    const sorted = [...line.items].sort((a, b) => a.x - b.x);

    let largestGap = 0;
    let gapStart = 0;
    let gapEnd = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      const start = sorted[index - 1].x + sorted[index - 1].width;
      const end = sorted[index].x;
      if (end - start > largestGap) {
        largestGap = end - start;
        gapStart = start;
        gapEnd = end;
      }
    }

    const splitsGutter = largestGap > 6 && gapStart <= split + 2 && gapEnd >= split - 2;

    if (splitsGutter) {
      const leftItems = sorted.filter((item) => item.x + item.width <= gapStart + 1);
      const rightItems = sorted.filter((item) => item.x >= gapEnd - 1);
      const rest = sorted.filter(
        (item) => !leftItems.includes(item) && !rightItems.includes(item)
      );
      leftLines.push(...groupItemsIntoLines(leftItems));
      rightLines.push(...groupItemsIntoLines(rightItems));
      spanningLines.push(...groupItemsIntoLines(rest));
      continue;
    }

    if (line.x + line.width <= split + 2) {
      leftLines.push(line);
    } else if (line.x >= split - 2) {
      rightLines.push(line);
    } else {
      spanningLines.push(line);
    }
  }

  // Two real text columns produce many lines on both sides; anything less is a
  // centered single column with short lines and must keep the simple order.
  if (
    leftLines.length < COLUMN_MIN_LINES_PER_SIDE ||
    rightLines.length < COLUMN_MIN_LINES_PER_SIDE
  ) {
    const lines = groupItemsIntoLines(items);
    repairDropCapLines(lines);
    return { lines, twoColumn: false };
  }

  leftLines.sort((a, b) => b.y - a.y);
  rightLines.sort((a, b) => b.y - a.y);
  spanningLines.sort((a, b) => b.y - a.y);

  const ordered = [];
  let leftIndex = 0;
  let rightIndex = 0;

  const flushBand = (minY) => {
    while (leftIndex < leftLines.length && leftLines[leftIndex].y > minY) {
      ordered.push(leftLines[leftIndex]);
      leftIndex += 1;
    }
    while (rightIndex < rightLines.length && rightLines[rightIndex].y > minY) {
      ordered.push(rightLines[rightIndex]);
      rightIndex += 1;
    }
  };

  for (const line of spanningLines) {
    flushBand(line.y + 0.5);
    ordered.push(line);
  }
  flushBand(Number.NEGATIVE_INFINITY);

  repairDropCapLines(ordered);
  return { lines: ordered, twoColumn: true, split };
}

/**
 * Running headers and footers (journal name + page number, author names) repeat
 * at the top and bottom of every page. Detect them by normalized text and drop
 * them from the body lines only; tables, figures and equations keep their own
 * line references.
 */
function stripRepeatedFurniture(pages) {
  const keyOf = (line) =>
    normalizeInline(line.text)
      .toLowerCase()
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim();

  const counts = new Map();
  for (const page of pages) {
    const seen = new Set();
    for (const line of page.lines) {
      const inBand = line.y >= page.height * 0.9 || line.y <= page.height * 0.08;
      if (!inBand) continue;
      const key = keyOf(line);
      if (!key || key.length < 4) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([key]) => key)
  );
  if (!repeated.size) return;

  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      const inBand = line.y >= page.height * 0.9 || line.y <= page.height * 0.08;
      if (!inBand) return true;
      const kept = !repeated.has(keyOf(line));
      if (!kept) page.furnitureRemoved = true;
      return kept;
    });
  }
}

export async function extractLayout(pdfData) {
  const loadingTask = getDocument({
    data: pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = textContent.items
        .filter((item) => typeof item.str === 'string' && item.str.trim())
        .map((item) => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height,
          fontName: item.fontName ?? ''
        }));

      const grouped = groupPageLines(items, viewport.width, viewport.height);
      const lines = grouped.lines;
      const rules = await extractRules(page);
      const tables = detectTables(
        lines,
        rules,
        items,
        viewport.height,
        pageNumber,
        viewport.width
      );
      const figures = detectFigures(lines, viewport.height, pageNumber);
      const numberedEquations = detectEquations(
        lines,
        viewport.width,
        viewport.height,
        pageNumber
      );
      const equations = [
        ...numberedEquations,
        ...detectUnnumberedEquations(
          lines,
          viewport.width,
          viewport.height,
          pageNumber,
          numberedEquations
        )
      ];
      absorbMathFragments(lines, equations, viewport.height);

      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        twoColumn: grouped.twoColumn === true,
        columnSplit: grouped.split ?? null,
        items,
        lines,
        rules,
        tables,
        figures,
        equations
      });
    }
  } finally {
    await pdf.destroy();
  }

  stripRepeatedFurniture(pages);

  return { pages, totalPages: pages.length };
}
