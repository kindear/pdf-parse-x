import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import { locateFigureWithLlm } from './figure-llm.js';
import { extractLayout } from './pdf-layout.js';
import { buildMarkdown } from './markdown-builder.js';
import { computeReport } from './report.js';
import {
  loadFormulaOverrides,
  finalizeLatex,
  resolveFormulaLatex
} from './formula-latex.js';
import {
  convertEquationWithLlm,
  getFormulaLlmConfig,
  mapWithConcurrency,
  rescueEquationsWithLlm
} from './formula-llm.js';
import { writePreviewFile } from './preview.js';
import {
  getMathLlmConfig,
  isMathDebrisLine,
  loadMathLineCache,
  mathLineCacheKey,
  needsMathTranscription,
  rescueFragmentsWithLlm,
  saveMathLineCache,
  transcribeBlockWithLlm,
  transcribeLineWithLlm
} from './math-llm.js';
import { getTranslateConfig, translateMarkdown } from './translate.js';
import {
  markdownTable,
  normalizeInline,
  safeOutputName,
  toCsv
} from './text-utils.js';

function imageExtension(buffer) {
  if (!buffer || buffer.length < 4) return 'bin';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return 'webp';
  }
  return 'bin';
}

async function normalizeImage(buffer) {
  return sharp(buffer)
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer({ resolveWithObject: true });
}

async function stackImages(buffers, destination) {
  const normalized = [];
  for (const buffer of buffers) {
    const { data, info } = await normalizeImage(buffer);
    normalized.push({ data, width: info.width, height: info.height });
  }

  if (normalized.length === 1) {
    await writeFile(destination, normalized[0].data);
    return { width: normalized[0].width, height: normalized[0].height };
  }

  const sameWidth = normalized.every(
    (image) => Math.abs(image.width - normalized[0].width) <= Math.max(4, normalized[0].width * 0.02)
  );
  const sameHeight = normalized.every(
    (image) => Math.abs(image.height - normalized[0].height) <= Math.max(4, normalized[0].height * 0.02)
  );

  if (sameWidth) {
    const width = Math.max(...normalized.map((image) => image.width));
    const height = normalized.reduce((sum, image) => sum + image.height, 0);
    let top = 0;
    const composites = normalized.map((image) => {
      const entry = {
        input: image.data,
        left: Math.round((width - image.width) / 2),
        top
      };
      top += image.height;
      return entry;
    });
    await sharp({
      create: { width, height, channels: 3, background: '#ffffff' }
    })
      .composite(composites)
      .png()
      .toFile(destination);
    return { width, height };
  }

  if (sameHeight) {
    const width = normalized.reduce((sum, image) => sum + image.width, 0);
    const height = Math.max(...normalized.map((image) => image.height));
    let left = 0;
    const composites = normalized.map((image) => {
      const entry = {
        input: image.data,
        left,
        top: Math.round((height - image.height) / 2)
      };
      left += image.width;
      return entry;
    });
    await sharp({
      create: { width, height, channels: 3, background: '#ffffff' }
    })
      .composite(composites)
      .png()
      .toFile(destination);
    return { width, height };
  }

  const columns = 2;
  const cellWidth = Math.max(...normalized.map((image) => image.width));
  const rows = Math.ceil(normalized.length / columns);
  const rowHeights = [];
  for (let row = 0; row < rows; row += 1) {
    const rowImages = normalized.slice(row * columns, row * columns + columns);
    rowHeights.push(Math.max(...rowImages.map((image) => image.height)));
  }
  const width = cellWidth * columns;
  const height = rowHeights.reduce((sum, value) => sum + value, 0);
  const composites = [];
  let top = 0;
  for (let row = 0; row < rows; row += 1) {
    const rowImages = normalized.slice(row * columns, row * columns + columns);
    for (let column = 0; column < rowImages.length; column += 1) {
      composites.push({
        input: rowImages[column].data,
        left: column * cellWidth,
        top
      });
    }
    top += rowHeights[row];
  }
  await sharp({
    create: { width, height, channels: 3, background: '#ffffff' }
  })
    .composite(composites)
    .png()
    .toFile(destination);
  return { width, height };
}

function imagesForPage(imageResult, pageNumber) {
  const page = imageResult.pages.find((candidate) => candidate.pageNumber === pageNumber);
  return page?.images ?? [];
}

export function splitImagesForFigures(images, figures, warnings, page) {
  const unmatched = figures.map(() => []);
  if (!page?.rules?.images) return unmatched;
  if (figures.length > 1) {
    const candidates = figures.map((figure) => splitImagesForFigures(images, [figure], warnings, page)[0]);
    const counts = new Map();
    for (const group of candidates) for (const image of group) counts.set(image.name, (counts.get(image.name) ?? 0) + 1);
    return candidates.map((group) => group.some((image) => counts.get(image.name) > 1) ? [] : group);
  }
  if (!figures.length) return unmatched;
  const figure = figures[0];
  const boxes = page.rules.images.filter((box) =>
    box.right - box.left >= 60 && box.top - box.bottom >= 40 &&
    box.bottom >= figure.captionY - 2 &&
    box.top <= page.height && box.right - box.left < page.width * 0.98
  );
  const starts = boxes.filter((box) => box.bottom - figure.captionTop <= 60);
  if (starts.length !== 1) return unmatched;
  const tiles = [starts[0]];
  while (true) {
    const last = tiles[tiles.length - 1];
    const adjacent = boxes.filter((box) => !tiles.includes(box) &&
      Math.abs(box.bottom - last.top) < 2 &&
      Math.abs(box.left - last.left) < 2 && Math.abs(box.right - last.right) < 2);
    if (adjacent.length > 1) return unmatched;
    if (!adjacent.length) break;
    tiles.push(adjacent[0]);
  }
  const matching = tiles.reverse().map((box) => images.filter((image) => image.name === box.name));
  return matching.every((matches) => matches.length === 1) ? [matching.map((matches) => matches[0])] : unmatched;
}

/**
 * Estimate the figure area from the caption and the surrounding body text.
 * The largest whitespace gap next to the caption is where the figure lives, so
 * the crop never grows into a full-page screenshot.
 */
function figureCropBox(page, figure) {
  const captionTop = Number.isFinite(figure.captionTop)
    ? figure.captionTop
    : figure.captionY + 10;
  const captionBottom = Number.isFinite(figure.captionY)
    ? figure.captionY
    : captionTop;

  const lineAbove = page.lines
    .filter((line) => line.y > captionTop + 2)
    .sort((a, b) => a.y - b.y)[0];
  const lineBelow = page.lines
    .filter((line) => line.y < captionBottom - 2)
    .sort((a, b) => b.y - a.y)[0];

  const gapAbove = lineAbove ? captionTop - lineAbove.y : 0;
  const gapBelow = lineBelow ? lineBelow.y - captionBottom : 0;
  if (gapAbove < 24 && gapBelow < 24) return null;

  let top;
  let bottom;
  if (gapAbove >= gapBelow) {
    top = lineAbove ? lineAbove.y - lineAbove.height - 6 : captionTop + 320;
    bottom = captionBottom - 4;
  } else {
    top = captionTop + 4;
    bottom = lineBelow ? lineBelow.y + 2 : captionBottom - 320;
  }

  const split = page.columnSplit;
  const captionX = figure.captionLines?.[0]?.x ?? 0;
  const twoColumn = page.twoColumn && Number.isFinite(split);
  const leftBound = twoColumn && captionX >= split ? split : 0;
  const rightBound = twoColumn && captionX < split ? split : page.width;

  const left = Math.max(0, leftBound);
  const right = Math.min(page.width, rightBound);
  const topLimited = Math.min(page.height - 4, top);
  const bottomLimited = Math.max(4, bottom);
  if (topLimited - bottomLimited < 24) return null;

  // A crop that still covers most of the page is not useful; keep it bounded.
  const maxHeight = page.height * 0.8;
  const clippedTop = Math.min(topLimited, bottomLimited + maxHeight);

  return { left, right, top: clippedTop, bottom: bottomLimited };
}

/**
 * PDF screenshots can have fractional pixel sizes, which sharp rejects.
 * Clamp and floor every extract rectangle.
 */
function extractRect(source, left, top, width, height) {
  const maxWidth = Math.floor(source.width);
  const maxHeight = Math.floor(source.height);
  const safeLeft = Math.max(0, Math.min(Math.floor(left), maxWidth - 1));
  const safeTop = Math.max(0, Math.min(Math.floor(top), maxHeight - 1));
  return {
    left: safeLeft,
    top: safeTop,
    width: Math.max(1, Math.min(Math.floor(width), maxWidth - safeLeft)),
    height: Math.max(1, Math.min(Math.floor(height), maxHeight - safeTop))
  };
}

async function cropScreenshot({ screenshot, page, region, destination }) {
  if (!screenshot || !page) return null;

  const scaleX = screenshot.width / page.width;
  const scaleY = screenshot.height / page.height;
  const left = Math.max(0, Math.floor(region.left * scaleX));
  const top = Math.max(0, Math.floor((page.height - region.top) * scaleY));
  const width = Math.max(1, Math.ceil((region.right - region.left) * scaleX));
  const height = Math.max(1, Math.ceil((region.top - region.bottom) * scaleY));

  const rect = extractRect(screenshot, left, top, width, height);

  await sharp(Buffer.from(screenshot.data))
    .extract(rect)
    .png()
    .toFile(destination);

  return { width: rect.width, height: rect.height };
}

async function saveFigure({
  figure,
  images,
  outputDir,
  screenshot,
  page,
  index,
  warnings,
  aiOptions
}) {
  const padded = String(figure.number ?? index + 1).padStart(2, '0');
  const partsDir = path.join(outputDir, 'figs', 'parts');
  const destination = path.join(outputDir, 'figs', `figure-${padded}.png`);
  await mkdir(path.dirname(destination), { recursive: true });

  if (images.length) {
    if (images.length > 1) {
      await mkdir(partsDir, { recursive: true });
      for (let partIndex = 0; partIndex < images.length; partIndex += 1) {
        const partPath = path.join(
          partsDir,
          `figure-${padded}-${String(partIndex + 1).padStart(2, '0')}.png`
        );
        const { data } = await normalizeImage(images[partIndex].data);
        await writeFile(partPath, data);
      }
    }

    const dimensions = await stackImages(
      images.map((image) => image.data),
      destination
    );
    figure.file = `figs/figure-${padded}.png`;
    figure.width = dimensions.width;
    figure.height = dimensions.height;
    figure.parts = images.length;
    figure.fallback = false;
    return;
  }

  if (screenshot && aiOptions?.enabled) {
    const box = await locateFigureWithLlm(figure, screenshot, aiOptions);
    if (box) {
      const source = Buffer.from(screenshot.data);
      const metadata = await sharp(source).metadata();
      const left = Math.floor(box[0] * metadata.width / 1000);
      const top = Math.floor(box[1] * metadata.height / 1000);
      const right = Math.min(metadata.width, Math.ceil(box[2] * metadata.width / 1000));
      const bottom = Math.min(metadata.height, Math.ceil(box[3] * metadata.height / 1000));
      await sharp(source).extract({ left, top, width: right - left, height: bottom - top }).png().toFile(destination);
      figure.file = `figs/figure-${padded}.png`;
      figure.width = right - left;
      figure.height = bottom - top;
      figure.parts = 0;
      figure.fallback = false;
      figure.aiLocated = true;
      warnings.push(`图 ${figure.number ?? index + 1} 由模型定位裁剪，请对照第 ${page.pageNumber} 页核对。`);
      return;
    }
  }

  if (screenshot) {
    const region = figureCropBox(page, figure);
    if (region) {
      try {
        const size = await cropScreenshot({
          screenshot,
          page,
          region,
          destination
        });
        if (size) {
          figure.file = `figs/figure-${padded}.png`;
          figure.width = size.width;
          figure.height = size.height;
          figure.parts = 0;
          figure.fallback = true;
          warnings.push(
            `图 ${figure.number ?? index + 1} 未找到内嵌位图，已按图注范围裁剪第 ${page.pageNumber} 页。`
          );
          return;
        }
      } catch {
        // Fall through to the "no image" branch below.
      }
    }
  }

  figure.file = '';
  figure.parts = 0;
  figure.fallback = true;
  warnings.push(
    `图 ${figure.number ?? index + 1} 未能可靠定位，已跳过整页截图以便正文保持整洁。`
  );
}

async function saveUnassignedImages({
  imageResult,
  assignedImages,
  layout,
  outputDir
}) {
  const unassigned = [];
  for (const page of imageResult.pages) {
    for (let index = 0; index < page.images.length; index += 1) {
      const image = page.images[index];
      if (assignedImages.has(`${page.pageNumber}:${image.name}`)) continue;
      const layoutPage = layout.pages.find((candidate) => candidate.pageNumber === page.pageNumber);
      const positions = (layoutPage?.rules?.images ?? []).filter((box) => box.name === image.name);
      const fileName = `page-${String(page.pageNumber).padStart(2, '0')}-image-${String(index + 1).padStart(2, '0')}.png`;
      const relative = `figs/unassigned/${fileName}`;
      const destination = path.join(outputDir, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      const { data, info } = await normalizeImage(image.data);
      await writeFile(destination, data);
      unassigned.push({
        pageNumber: page.pageNumber,
        file: relative,
        anchorY: positions.length === 1 ? positions[0].top : null,
        width: info.width,
        height: info.height
      });
    }
  }
  return unassigned;
}

function screenshotForPage(screenshots, pageNumber) {
  return screenshots.find((screenshot) => screenshot.pageNumber === pageNumber);
}

async function cropLineBuffer(screenshot, page, line) {
  const scaleX = screenshot.width / page.width;
  const scaleY = screenshot.height / page.height;
  const height = Math.max(line.height, 6);
  const left = (line.x - 8) * scaleX;
  const top = (page.height - (line.y + height * 0.55)) * scaleY;
  const width = (line.width + 16) * scaleX;
  const cropHeight = height * 1.5 * scaleY;
  const rect = extractRect(screenshot, left, top, width, cropHeight);

  return sharp(Buffer.from(screenshot.data)).extract(rect).png().toBuffer();
}

async function cropBlockBuffer(screenshot, page, lines) {
  const scaleX = screenshot.width / page.width;
  const scaleY = screenshot.height / page.height;
  const left = Math.min(...lines.map((line) => line.x)) - 10;
  const right = Math.max(...lines.map((line) => line.x + line.width)) + 10;
  const top = Math.max(...lines.map((line) => line.y + line.height)) + 6;
  const bottom = Math.min(...lines.map((line) => line.y)) - 6;
  const rect = extractRect(
    screenshot,
    left * scaleX,
    (page.height - top) * scaleY,
    Math.max(1, (right - left) * scaleX),
    Math.max(1, (top - bottom) * scaleY)
  );

  return sharp(Buffer.from(screenshot.data)).extract(rect).png().toBuffer();
}

function looksLikeHeadingLine(line) {
  const text = normalizeInline(line.text ?? '');
  if (!text || text.length > 80) return false;
  if (/[.!?;:]$/.test(text)) return false;
  return (text.match(/[A-Za-z]{2,}/g) ?? []).length <= 8;
}

/**
 * A block transcription has to be roughly as long as the source text; a much
 * shorter answer means content was dropped instead of re-typeset.
 */
function isPlausibleBlock(text, block) {
  if (!text) return false;
  const source = normalizeInline(block.map((line) => line.text).join(' '));
  if (source.length < 24) return true;
  const ratio = text.length / source.length;
  return ratio >= 0.4 && ratio <= 2.5;
}

/**
 * Vertical math debris (a numerator row, a denominator row plus a lone ∑) means
 * an inline formula was split over several text-layer lines. Collect those runs
 * together with the prose lines around them so the block can be re-typeset as
 * one paragraph instead of duplicated fragments.
 */
function collectBrokenMathBlocks(page) {
  const lines = page.lines;
  const insideBox = (line) =>
    (page.tables ?? []).some(
      (table) => line.y <= table.box.top + 2 && line.y >= table.box.bottom - 2
    ) ||
    (page.equations ?? []).some(
      (equation) =>
        line.y <= equation.box.top + 2 &&
        line.y >= equation.box.bottom - 2 &&
        line.x >= equation.box.left - 2 &&
        line.x <= equation.box.right + 2
    );

  const sameColumn = (a, b) => Math.abs(a.x - b.x) <= Math.max(28, page.width * 0.12);
  const stacked = (a, b) => Math.abs(a.y - b.y) <= Math.max(a.height, b.height) * 2.4;
  const nearEdge = (line) => line.y < page.height * 0.08 || line.y > page.height * 0.92;

  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!isMathDebrisLine(line.text) || insideBox(line) || nearEdge(line)) {
      index += 1;
      continue;
    }

    let start = index;
    let end = index;
    while (
      end + 1 < lines.length &&
      isMathDebrisLine(lines[end + 1].text) &&
      !insideBox(lines[end + 1]) &&
      !nearEdge(lines[end + 1]) &&
      stacked(lines[end], lines[end + 1])
    ) {
      end += 1;
    }

    let contextStart = start;
    for (let step = 0; step < 2 && contextStart > 0; step += 1) {
      const previous = lines[contextStart - 1];
      if (
        insideBox(previous) ||
        nearEdge(previous) ||
        !stacked(previous, lines[contextStart]) ||
        !sameColumn(previous, lines[contextStart]) ||
        looksLikeHeadingLine(previous)
      ) {
        break;
      }
      contextStart -= 1;
    }

    let contextEnd = end;
    if (contextEnd + 1 < lines.length) {
      const next = lines[contextEnd + 1];
      if (
        !insideBox(next) &&
        !nearEdge(next) &&
        stacked(next, lines[contextEnd]) &&
        sameColumn(next, lines[contextEnd]) &&
        !looksLikeHeadingLine(next)
      ) {
        contextEnd += 1;
      }
    }

    // One stray `1/2` fragment is handled by the residue rules; a block pass is
    // only worth it when at least two math rows really stacked.
    const blockLines = lines.slice(contextStart, Math.min(contextEnd + 1, contextStart + 8));
    const debrisCount = blockLines.filter((entry) => isMathDebrisLine(entry.text)).length;
    if (debrisCount < 2) {
      index = contextEnd + 1;
      continue;
    }

    blocks.push(blockLines);
    index = contextEnd + 1;
  }

  return blocks;
}

/**
 * Cross-line formulas are beyond line-level rules: crop the whole fragment and
 * let the vision model rebuild it as one paragraph, preserving content order.
 */
async function transcribeBrokenMathBlocks({
  layout,
  screenshots,
  outputDir,
  config,
  fetchImpl,
  warnings
}) {
  const stats = { blocks: 0, transcribed: 0, cached: 0, failed: 0, failedJobs: [] };

  const jobs = [];
  for (const page of layout.pages) {
    const screenshot = screenshotForPage(screenshots, page.pageNumber);
    if (!screenshot) continue;
    for (const block of collectBrokenMathBlocks(page)) jobs.push({ page, block, screenshot });
  }
  stats.blocks = jobs.length;
  if (!jobs.length) return stats;

  const cachePath = path.join(outputDir, 'math-lines.llm.json');
  const cache = await loadMathLineCache(cachePath);

  await mapWithConcurrency(jobs, config.concurrency, async ({ page, block, screenshot }) => {
    try {
      const buffer = await cropBlockBuffer(screenshot, page, block);
      const key = `block:${mathLineCacheKey(buffer, config.model)}`;
      let text = cache.lines[key];

      if (typeof text === 'string' && isPlausibleBlock(text, block)) {
        stats.cached += 1;
      } else {
        text = await transcribeBlockWithLlm(buffer, config, { fetchImpl });
        if (text && isPlausibleBlock(text, block)) {
          cache.lines[key] = text;
          stats.transcribed += 1;
        } else {
          text = null;
          delete cache.lines[key];
        }
      }

      if (!text) {
        stats.failed += 1;
        stats.failedJobs.push({ page, block, screenshot });
        return;
      }

      const anchor = block[0];
      anchor.mathText = text;
      anchor.mathSource = 'llm-block';
      for (let index = 1; index < block.length; index += 1) {
        block[index].blockMerged = true;
      }
    } catch {
      stats.failed += 1;
      stats.failedJobs.push({ page, block, screenshot });
    }
  });

  await saveMathLineCache(cachePath, cache).catch(() => {});
  return stats;
}

/**
 * Lines whose text layer interleaved math glyphs with prose cannot be fixed by
 * rules. Crop them and let the vision model re-typeset the line with `$...$`
 * math, then keep the result as `line.mathText` for the Markdown builder.
 */
async function transcribeMangledLines({
  layout,
  screenshots,
  outputDir,
  config,
  fetchImpl,
  warnings,
  emit
}) {
  const stats = {
    candidates: 0,
    transcribed: 0,
    cached: 0,
    failed: 0,
    blocks: 0,
    rescued: 0
  };
  if (!config.enabled) return stats;

  const blockStats = await transcribeBrokenMathBlocks({
    layout,
    screenshots,
    outputDir,
    config,
    fetchImpl,
    warnings
  });
  stats.blocks = blockStats.transcribed + blockStats.cached;

  const candidates = [];
  for (const page of layout.pages) {
    const screenshot = screenshotForPage(screenshots, page.pageNumber);
    if (!screenshot) continue;

    for (const line of page.lines) {
      if (line.blockMerged || line.mathSource === 'llm-block') continue;
      if (!needsMathTranscription(line)) continue;
      const insideTable = (page.tables ?? []).some(
        (table) =>
          line.y <= table.box.top + 2 && line.y >= table.box.bottom - 2
      );
      if (insideTable) continue;
      const insideEquation = (page.equations ?? []).some(
        (equation) =>
          line.y <= equation.box.top + 2 &&
          line.y >= equation.box.bottom - 2 &&
          line.x >= equation.box.left - 2 &&
          line.x <= equation.box.right + 2
      );
      if (insideEquation) continue;
      candidates.push({ page, line, screenshot });
    }
  }

  stats.candidates = candidates.length;
  if (!candidates.length) return stats;

  const budget =
    config.maxLines > 0 ? candidates.slice(0, config.maxLines) : candidates;
  if (candidates.length > budget.length) {
    warnings.push(
      `${candidates.length - budget.length} 行混排公式超出转写上限（MATH_LLM_MAX_LINES），已保留原文。`
    );
  }

  const cachePath = path.join(outputDir, 'math-lines.llm.json');
  const cache = await loadMathLineCache(cachePath);
  let done = 0;
  const failedLines = [];

  await mapWithConcurrency(budget, config.concurrency, async ({ page, line, screenshot }) => {
    try {
      const buffer = await cropLineBuffer(screenshot, page, line);
      const key = mathLineCacheKey(buffer, config.model);
      let text = cache.lines[key];

      if (typeof text === 'string' && text) {
        stats.cached += 1;
      } else {
        text = await transcribeLineWithLlm(buffer, config, { fetchImpl });
        if (text) {
          cache.lines[key] = text;
          stats.transcribed += 1;
        }
      }

      if (text) {
        line.mathText = text;
        line.mathSource = 'llm';
      } else {
        stats.failed += 1;
        failedLines.push({ page, line, screenshot });
      }
    } catch {
      stats.failed += 1;
      failedLines.push({ page, line, screenshot });
    } finally {
      done += 1;
      emit({
        index: 3,
        label: '公式 LaTeX',
        status: 'progress',
        progress: { done, total: budget.length }
      });
    }
  });

  await saveMathLineCache(cachePath, cache).catch(() => {});

  // Page-level rescue: only fragments whose own crop failed are listed, so the
  // normal route keeps its exact behaviour.
  const failedBlocks = blockStats.failedJobs ?? [];
  if (failedLines.length || failedBlocks.length) {
    const grouped = new Map();
    const addJob = (job, kind) => {
      const list = grouped.get(job.page.pageNumber) ?? [];
      list.push({
        ...job,
        kind,
        id: `${kind}-${list.length + 1}`,
        source: kind === 'block'
          ? job.block.map((entry) => entry.text).join(' ')
          : job.line.text
      });
      grouped.set(job.page.pageNumber, list);
    };
    for (const job of failedBlocks) addJob(job, 'block');
    for (const job of failedLines) addJob(job, 'line');

    await mapWithConcurrency([...grouped.values()], config.concurrency, async (items) => {
      const { screenshot } = items[0];
      try {
        const imageBuffer = await sharp(Buffer.from(screenshot.data)).png().toBuffer();
        const rescued = await rescueFragmentsWithLlm({
          imageBuffer,
          fragments: items.map((item) => ({ id: item.id, text: item.source })),
          config,
          fetchImpl
        });

        for (const item of items) {
          const text = rescued.get(item.id);
          if (!text) continue;
          if (item.kind === 'block') {
            if (!isPlausibleBlock(text, item.block)) continue;
            const anchor = item.block[0];
            anchor.mathText = text;
            anchor.mathSource = 'llm-block-rescue';
            for (let index = 1; index < item.block.length; index += 1) {
              item.block[index].blockMerged = true;
            }
          } else {
            item.line.mathText = text;
            item.line.mathSource = 'llm-rescue';
          }
          item.rescued = true;
          stats.rescued += 1;
        }
      } catch {
        // Rescue is best effort: keep the previous fallback on any failure.
      }
    });
  }

  const remainingBlocks = failedBlocks.filter((job) => !job.rescued).length;
  const remainingLines = failedLines.filter((job) => !job.rescued).length;
  if (remainingBlocks) {
    warnings.push(`${remainingBlocks} 段跨行公式未能转写，已保留 PDF 文本层内容。`);
  }
  if (remainingLines) {
    warnings.push(`${remainingLines} 行混排公式未能转写，已保留 PDF 文本层内容。`);
  }

  return stats;
}

async function saveTableImage({ table, screenshot, page, outputDir }) {
  const key = String(table.fileKey ?? table.number ?? 0);
  const padded = key.padStart(2, '0');
  const destination = path.join(outputDir, 'tables', `table-${padded}.png`);
  await mkdir(path.dirname(destination), { recursive: true });

  if (!screenshot) return null;

  const scaleX = screenshot.width / page.width;
  const scaleY = screenshot.height / page.height;
  const tight = Boolean(table.imageOnly || table.fallback);
  const leftPdf = tight
    ? Math.max(0, table.box.left)
    : Math.max(0, table.box.left - 8);
  const rightPdf = tight
    ? Math.min(page.width, table.box.right)
    : Math.min(page.width, table.box.right + 8);
  const topPdf = Math.min(page.height, table.captionTop + 6);
  const bottomPdf = Math.max(0, table.box.bottom - 7);

  const left = Math.max(0, Math.floor(leftPdf * scaleX));
  const top = Math.max(0, Math.floor((page.height - topPdf) * scaleY));
  const width = Math.max(1, Math.ceil((rightPdf - leftPdf) * scaleX));
  const height = Math.max(1, Math.ceil((topPdf - bottomPdf) * scaleY));

  if (topPdf - bottomPdf < 24 || rightPdf - leftPdf < 24) {
    table.image = '';
    return null;
  }

  const buildPipeline = () =>
    sharp(Buffer.from(screenshot.data)).extract(
      extractRect(screenshot, left, top, width, height)
    );

  // `trim` occasionally rejects nearly-blank crops, so degrade gracefully and
  // never fall back to the whole-page screenshot.
  const attempts = table.rotate
    ? [
        () =>
          buildPipeline()
            .rotate(table.rotate)
            .trim({ threshold: 12 })
            .png()
            .toFile(destination),
        () => buildPipeline().rotate(table.rotate).png().toFile(destination)
      ]
    : [() => buildPipeline().png().toFile(destination)];

  for (const attempt of attempts) {
    try {
      await attempt();
      table.image = `tables/table-${padded}.png`;
      return table.image;
    } catch {
      // try the next strategy
    }
  }

  table.image = '';
  return null;
}

async function saveEquationImages({ equations, screenshots, layout, outputDir, warnings }) {
  const equationDir = path.join(outputDir, 'figs', 'equations');
  await mkdir(equationDir, { recursive: true });
  let counter = 0;

  for (const equation of equations) {
    counter += 1;
    const padded = equation.fileKey ?? String(counter).padStart(2, '0');
    const label = equation.number ?? equation.key ?? counter;
    const destination = path.join(equationDir, `equation-${padded}.png`);
    const page = layout.pages.find((candidate) => candidate.pageNumber === equation.pageNumber);
    const screenshot = screenshotForPage(screenshots, equation.pageNumber);

    if (!page || !screenshot) {
      warnings.push(`公式 ${label} 未生成截图，已跳过。`);
      continue;
    }

    const scaleX = screenshot.width / page.width;
    const scaleY = screenshot.height / page.height;
    const formulaRight =
      equation.latex && equation.numberBox
        ? Math.min(equation.box.right, equation.numberBox.x - 8)
        : equation.box.right;
    const left = Math.max(0, Math.floor(equation.box.left * scaleX));
    const top = Math.max(0, Math.floor((page.height - equation.box.top) * scaleY));
    const width = Math.max(1, Math.ceil((formulaRight - equation.box.left) * scaleX));
    const height = Math.max(1, Math.ceil((equation.box.top - equation.box.bottom) * scaleY));

    try {
      await sharp(Buffer.from(screenshot.data))
        .extract(extractRect(screenshot, left, top, width, height))
        .png()
        .toFile(destination);
      equation.file = `figs/equations/equation-${padded}.png`;
      equation.width = Math.floor(width);
      equation.height = Math.floor(height);
    } catch (error) {
      warnings.push(`公式 ${label} 截图裁剪失败：${error.message}`);
    }
  }
}

async function writeTableFiles({ table, outputDir }) {
  const padded = String(table.fileKey ?? table.number ?? 0).padStart(2, '0');
  const tableDir = path.join(outputDir, 'tables');
  await mkdir(tableDir, { recursive: true });

  const markdownPath = path.join(tableDir, `table-${padded}.md`);
  const csvPath = path.join(tableDir, `table-${padded}.csv`);
  const jsonPath = path.join(tableDir, `table-${padded}.json`);
  const caption = table.caption || `Table ${table.number ?? ''}`;
  const markdownLines = [`# ${caption}`, ''];
  const hasRows = !table.imageOnly && table.headers.length > 0 && table.rows.length > 0;
  if (hasRows) {
    // The reconstructed cells win over the crop; the image stays one click away.
    markdownLines.push(markdownTable(table.headers, table.rows));
    if (table.image) {
      markdownLines.push('', `[查看表格原图](${path.basename(table.image)})`);
    }
  } else if (table.image) {
    markdownLines.push(`![${caption}](${path.basename(table.image)})`);
  }
  const markdown = markdownLines.join('\n');

  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  if (hasRows) {
    await writeFile(csvPath, `${toCsv([table.headers, ...table.rows])}\n`, 'utf8');
  }
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        number: table.number,
        page: table.pageNumber,
        caption: table.caption,
        headers: table.headers,
        rows: table.rows,
        confidence: table.confidence,
        imageOnly: Boolean(table.imageOnly),
        image: table.image ?? null
      },
      null,
      2
    ),
    'utf8'
  );
}

function normalizeMetadata(info, sourceFile, fallbackTitle) {
  const raw = info?.info ?? {};
  return {
    title: normalizeInline(raw.Title) || fallbackTitle || path.basename(sourceFile, path.extname(sourceFile)),
    author: normalizeInline(raw.Author),
    subject: normalizeInline(raw.Subject),
    keywords: normalizeInline(raw.Keywords),
    creator: normalizeInline(raw.Creator),
    producer: normalizeInline(raw.Producer),
    creationDate: raw.CreationDate ? String(raw.CreationDate) : null,
    modificationDate: raw.ModDate ? String(raw.ModDate) : null,
    sourceFile: path.basename(sourceFile),
    generatedAt: new Date().toISOString()
  };
}

/**
 * Convert a PDF into a directory containing main.md, figs/ and tables/.
 */
export async function convertPdfToMarkdown(input, options = {}) {
  const sourceFile = typeof input === 'string' ? input : options.sourceName ?? 'document.pdf';
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  const outputDir = path.resolve(
    options.outputDir ??
      path.join(process.cwd(), 'output', safeOutputName(path.basename(sourceFile, path.extname(sourceFile))))
  );

  await mkdir(outputDir, { recursive: true });
  await rm(path.join(outputDir, 'figs'), { recursive: true, force: true });
  await rm(path.join(outputDir, 'tables'), { recursive: true, force: true });
  await mkdir(path.join(outputDir, 'figs'), { recursive: true });
  await mkdir(path.join(outputDir, 'tables'), { recursive: true });

  const warnings = [];
  const totalSteps = 5;
  const emit = (payload) => {
    if (typeof options.onProgress !== 'function') return;
    try {
      options.onProgress({ total: totalSteps, ...payload });
    } catch {
      // Progress reporting must never break a conversion.
    }
  };
  const step = async (index, label, task, detail) => {
    const startedAt = performance.now();
    emit({ index, label, status: 'start' });
    try {
      const value = await task();
      emit({
        index,
        label,
        status: 'done',
        durationMs: performance.now() - startedAt,
        detail: typeof detail === 'function' ? detail(value) : detail
      });
      return value;
    } catch (error) {
      emit({
        index,
        label,
        status: 'error',
        durationMs: performance.now() - startedAt,
        detail: error?.message ?? String(error)
      });
      throw error;
    }
  };

  const pdfData = new Uint8Array(buffer);
  const parser = new PDFParse({ data: buffer });

  try {
    const parsed = await step(
      1,
      '解析 PDF',
      async () => {
        const layout = await extractLayout(pdfData);
        const info = await parser.getInfo({ parsePageInfo: false });
        const textResult = await parser.getText({ pageJoiner: '' });
        const imageResult = await parser.getImage({
          imageThreshold: 0,
          imageDataUrl: false,
          imageBuffer: true
        });
        return { layout, info, textResult, imageResult };
      },
      ({ layout, textResult }) => {
        const figureCount = layout.pages.reduce((n, page) => n + page.figures.length, 0);
        const tableCount = layout.pages.reduce((n, page) => n + page.tables.length, 0);
        const equationCount = layout.pages.reduce(
          (n, page) => n + (page.equations?.length ?? 0),
          0
        );
        return `${layout.totalPages} 页 · ${figureCount} 图 · ${tableCount} 表 · ${equationCount} 公式 · ${textResult.text.length.toLocaleString('en-US')} 字符`;
      }
    );
    const { layout, info, textResult, imageResult } = parsed;

    const figures = layout.pages.flatMap((page) =>
      page.figures.map((figure) => ({
        ...figure,
        pageWidth: page.width,
        pageHeight: page.height
      }))
    );
    const tables = layout.pages.flatMap((page) => page.tables);
    const equations = layout.pages.flatMap((page) => page.equations ?? []);

    const rotatedTableParts = new Map();
    for (const table of tables) {
      if (!table.rotate) continue;
      const part = (rotatedTableParts.get(table.number) ?? 0) + 1;
      rotatedTableParts.set(table.number, part);
      table.part = part;
      table.fileKey = `${String(table.number).padStart(2, '0')}-part-${part}`;
    }

    const formulaOverrides = await loadFormulaOverrides({
      pdfPath: typeof input === 'string' ? path.resolve(input) : null,
      sourceName: sourceFile,
      outputDir,
      refresh: options.formulaLlm?.refresh === true,
      options
    });

    // Numbered equations keep their PDF number; unnumbered display equations
    // get a stable page-scoped key (`p5-1`) used for crops, caches and reports.
    const unnumberedCounters = new Map();
    for (const equation of equations) {
      if (equation.number !== null && equation.number !== undefined) {
        equation.key = String(equation.number);
        equation.fileKey = String(equation.number).padStart(2, '0');
      } else {
        const count = (unnumberedCounters.get(equation.pageNumber) ?? 0) + 1;
        unnumberedCounters.set(equation.pageNumber, count);
        equation.key = `p${equation.pageNumber}-${count}`;
        equation.fileKey = equation.key;
      }

      equation.customLatex = formulaOverrides[equation.key] ?? null;
      equation.latex = resolveFormulaLatex(equation, formulaOverrides);
    }

    let tableCounter = 0;
    for (const table of tables) {
      tableCounter += 1;
      if (!table.number) table.number = tableCounter;
    }

    const assignedImages = new Set();
    const screenshotsNeeded = new Set();
    for (const table of tables) screenshotsNeeded.add(table.pageNumber);
    for (const equation of equations) screenshotsNeeded.add(equation.pageNumber);
    for (const figure of figures) screenshotsNeeded.add(figure.pageNumber);

    let screenshots = [];
    let figureCounter = 0;
    await step(
      2,
      '提取资源',
      async () => {
        if (screenshotsNeeded.size) {
          try {
            const screenshotResult = await parser.getScreenshot({
              partial: [...screenshotsNeeded].sort((a, b) => a - b),
              scale: 2,
              imageDataUrl: false,
              imageBuffer: true
            });
            screenshots = screenshotResult.pages;
          } catch (error) {
            warnings.push(`页面截图生成失败：${error.message}`);
          }
        }

        const figuresByPage = new Map();
        for (const figure of figures) {
          const list = figuresByPage.get(figure.pageNumber) ?? [];
          list.push(figure);
          figuresByPage.set(figure.pageNumber, list);
        }

        for (const page of layout.pages) {
          const pageFigures = (figuresByPage.get(page.pageNumber) ?? []).sort(
            (a, b) => b.captionY - a.captionY
          );
          if (!pageFigures.length) continue;
          const pageImages = imagesForPage(imageResult, page.pageNumber);
          const groups = splitImagesForFigures(pageImages, pageFigures, warnings, page);
          for (let index = 0; index < pageFigures.length; index += 1) {
            figureCounter += 1;
            const figure = pageFigures[index];
            for (const image of groups[index] ?? []) assignedImages.add(`${page.pageNumber}:${image.name}`);
            if (!figure.number) figure.number = figureCounter;
            await saveFigure({
              figure,
              images: groups[index] ?? [],
              outputDir,
              screenshot: screenshotForPage(screenshots, page.pageNumber),
              page,
              index: figureCounter - 1,
              warnings,
              aiOptions: {
                ...(options.formulaLlm ?? {}),
                enabled: options.figureLlm?.enabled ?? process.env.FIGURE_LLM_ENABLED === 'true',
                ...(options.figureLlm ?? {})
              }
            });
          }
        }

        for (const table of tables) {
          const page = layout.pages.find((candidate) => candidate.pageNumber === table.pageNumber);
          const screenshot = screenshotForPage(screenshots, table.pageNumber);
          await saveTableImage({ table, screenshot, page, outputDir });
          await writeTableFiles({ table, outputDir });
        }

        await saveEquationImages({
          equations,
          screenshots,
          layout,
          outputDir,
          warnings
        });
      },
      () =>
        `${figureCounter} 图 · ${tables.length} 表 · ${equations.length} 公式${
          screenshots.length ? ` · ${screenshots.length} 页截图` : ''
        }`
    );

    const formulaLlm = getFormulaLlmConfig(options.formulaLlm ?? {});
    const mathLlmConfig = getMathLlmConfig({
      ...(options.mathLlm ?? {}),
      baseUrl: options.mathLlm?.baseUrl ?? formulaLlm.baseUrl,
      apiKey: options.mathLlm?.apiKey ?? formulaLlm.apiKey,
      model: options.mathLlm?.model ?? formulaLlm.model,
      concurrency: options.mathLlm?.concurrency ?? formulaLlm.concurrency,
      timeoutMs: options.mathLlm?.timeoutMs ?? formulaLlm.timeoutMs
    });
    let mathLineStats = null;
    await step(
      3,
      '公式 LaTeX',
      async () => {
        // Prose lines whose text layer mixed in math glyphs are re-typeset by
        // the vision model before the equation work starts.
        mathLineStats = await transcribeMangledLines({
          layout,
          screenshots,
          outputDir,
          config: mathLlmConfig,
          fetchImpl: options.mathLlm?.fetchImpl ?? options.formulaLlm?.fetchImpl,
          warnings,
          emit
        });

        if (!formulaLlm.enabled) return;
        const cachePath = path.join(outputDir, 'formulas.llm.json');
        const refresh = options.formulaLlm?.refresh === true;
        const cacheIdentity = createHash('sha256').update(buffer).update(JSON.stringify({ model: formulaLlm.model, baseUrl: formulaLlm.baseUrl, vision: formulaLlm.vision })).digest('hex');
        let llmCache = {};
        try {
          const cache = JSON.parse(await readFile(cachePath, 'utf8'));
          if (cache.version === 1 && cache.identity === cacheIdentity) llmCache = cache.formulas ?? {};
        } catch {
          llmCache = {};
        }

        const pending = [];
        for (const equation of equations) {
          if (equation.latex) continue;

          if (!refresh) {
            const cached = llmCache[equation.key];
            const reused = cached
              ? resolveFormulaLatex(
                  {
                    number: equation.number ?? null,
                    key: equation.key,
                    customLatex: cached
                  },
                  {}
                )
              : null;
            if (reused) {
              equation.latex = reused;
              equation.latexSource = 'llm';
              equation.latexCached = true;
              continue;
            }
          }

          pending.push(equation);
        }

        const budget =
          formulaLlm.maxImages > 0
            ? pending.slice(0, formulaLlm.maxImages)
            : pending;

        const failures = new Map();
        let completed = 0;

        await mapWithConcurrency(
          budget,
          formulaLlm.concurrency,
          async (equation) => {
            const latex = await convertEquationWithLlm(equation, {
              ...formulaLlm,
              fetchImpl: options.formulaLlm?.fetchImpl,
              onFailure: (reason) => failures.set(equation.key, reason),
              imagePath: equation.file
                ? path.join(outputDir, equation.file)
                : null
            });
            if (latex) {
              equation.latex = latex;
              equation.latexSource = 'llm';
              llmCache[equation.key] = latex;
            }
            completed += 1;
            emit({
              index: 3,
              label: '公式 LaTeX',
              status: 'progress',
              progress: { done: completed, total: budget.length }
            });
            return latex;
          }
        );

        // Page-level rescue for equations that failed their single-image pass.
        // Only the failed ids are sent, so successful formulas keep their exact
        // LaTeX and the normal route never changes.
        const rescueList = equations.filter(
          (equation) => !equation.latex && failures.has(equation.key)
        );
        if (rescueList.length && formulaLlm.vision) {
          const byPage = new Map();
          for (const equation of rescueList) {
            const list = byPage.get(equation.pageNumber) ?? [];
            list.push(equation);
            byPage.set(equation.pageNumber, list);
          }

          await mapWithConcurrency(
            [...byPage.values()],
            formulaLlm.concurrency,
            async (list) => {
              const pageNumber = list[0].pageNumber;
              const screenshot = screenshotForPage(screenshots, pageNumber);
              if (!screenshot) return;
              try {
                const imageBuffer = await sharp(Buffer.from(screenshot.data))
                  .png()
                  .toBuffer();
                const rescued = await rescueEquationsWithLlm({
                  imageBuffer,
                  equations: list,
                  config: formulaLlm,
                  fetchImpl: options.formulaLlm?.fetchImpl
                });
                for (const [key, body] of rescued) {
                  const equation = list.find((entry) => entry.key === key);
                  if (!equation) continue;
                  const latex = finalizeLatex(body, equation.number);
                  if (!latex) continue;
                  equation.latex = latex;
                  equation.latexSource = 'llm-rescue';
                  llmCache[equation.key] = latex;
                  failures.delete(equation.key);
                }
              } catch {
                // Rescue is best effort: failed equations keep the image fallback.
              }
            }
          );
        }

        for (const [key, reason] of failures) warnings.push(`公式 ${key}：${reason}，已保留原图。`);
        if (pending.length > budget.length) warnings.push(`${pending.length - budget.length} 个公式超出模型调用上限，已保留原图。`);

        if (Object.keys(llmCache).length) {
          await writeFile(
            cachePath,
            JSON.stringify({ version: 1, identity: cacheIdentity, formulas: llmCache }, null, 2),
            'utf8'
          );
        }
      },
      () => {
        const fromSidecar = equations.filter(
          (equation) => equation.latex && !equation.latexSource
        ).length;
        const fromModel = equations.filter(
          (equation) =>
            (equation.latexSource === 'llm' ||
              equation.latexSource === 'llm-rescue') &&
            !equation.latexCached
        ).length;
        const fromCache = equations.filter((equation) => equation.latexCached).length;
        const missing = equations.filter((equation) => !equation.latex).length;
        const parts = [];

        if (mathLineStats && mathLineStats.transcribed + mathLineStats.cached) {
          parts.push(`行内 ${mathLineStats.transcribed + mathLineStats.cached}`);
        }
        if (mathLineStats?.blocks) {
          parts.push(`跨行 ${mathLineStats.blocks}`);
        }
        if (mathLineStats?.rescued) {
          parts.push(`救援 ${mathLineStats.rescued}`);
        }

        if (!equations.length) {
          parts.push('无编号公式');
          return parts.join(' · ');
        }
        if (!formulaLlm.enabled) {
          parts.push(
            fromSidecar ? `${fromSidecar} 个来自 sidecar` : '模型未启用，公式使用原图'
          );
          return parts.join(' · ');
        }
        if (fromModel) parts.push(`模型 ${fromModel}`);
        if (fromCache) parts.push(`缓存 ${fromCache}`);
        if (fromSidecar) parts.push(`sidecar ${fromSidecar}`);
        if (missing) parts.push(`原图 ${missing}`);
        return parts.join(' · ') || '无变化';
      }
    );

    const fallbackFormulaCount = equations.filter(
      (equation) => !equation.latex
    ).length;
    if (fallbackFormulaCount) {
      warnings.push(
        `${fallbackFormulaCount} 个公式未能可靠重建为 LaTeX，已使用 PDF 原图回退。`
      );
    }

    // Keep the resolved LaTeX next to the converted document so the output
    // folder carries its own sidecar and can be re-converted offline.
    const resolvedFormulas = {};
    const formulaSources = {};
    let previousSources = {};
    try {
      const previous = JSON.parse(
        await readFile(path.join(outputDir, 'formulas.json'), 'utf8')
      );
      previousSources = previous?.sources ?? {};
    } catch {
      previousSources = {};
    }
    for (const equation of equations) {
      if (!equation.latex) continue;
      const key = equation.key ?? String(equation.number);
      resolvedFormulas[key] = equation.latex;
      let origin =
        equation.latexSource === 'llm' || equation.latexSource === 'llm-rescue'
          ? equation.latexCached
            ? 'llm-cache'
            : equation.latexSource === 'llm-rescue'
              ? 'llm-rescue'
              : 'llm'
          : equation.customLatex
            ? 'sidecar'
            : 'unknown';
      // Re-reading our own emitted copy must not erase the original provenance
      // (which formula came from the model and should be spot-checked).
      if (origin === 'sidecar' && previousSources[key] && previousSources[key] !== 'sidecar') {
        origin = previousSources[key];
      }
      formulaSources[key] = origin;
    }
    if (Object.keys(resolvedFormulas).length) {
      await writeFile(
        path.join(outputDir, 'formulas.json'),
        JSON.stringify(
          {
            version: 1,
            source: path.basename(sourceFile),
            generatedAt: new Date().toISOString(),
            sources: formulaSources,
            formulas: resolvedFormulas
          },
          null,
          2
        ),
        'utf8'
      );
    }

    const unassignedImages = await saveUnassignedImages({
      imageResult,
      assignedImages,
      layout,
      outputDir
    });

    let metadata = null;
    let markdownResult = null;
    let report = null;
    let mainPath = null;
    let mainZhPath = null;

    await step(
      4,
      '生成 Markdown',
      async () => {
        metadata = normalizeMetadata(info, sourceFile);
        markdownResult = buildMarkdown({
          layout,
          pdfTextPages: textResult.pages,
          metadata,
          figures,
          tables,
          equations,
          unassignedImages
        });
        metadata.title = markdownResult.title || metadata.title;

        report = computeReport({
          markdown: markdownResult.markdown,
          pdfText: textResult.text,
          layout,
          figures,
          tables,
          equations,
          warnings
        });

        mainPath = path.join(outputDir, 'main.md');
        await writeFile(mainPath, `${markdownResult.markdown}\n`, 'utf8');
        await writeFile(
          path.join(outputDir, 'metadata.json'),
          JSON.stringify(metadata, null, 2),
          'utf8'
        );
        await writeFile(
          path.join(outputDir, 'report.json'),
          JSON.stringify(report, null, 2),
          'utf8'
        );

        // The preview is normally rendered on demand from `main.md` (see the
        // server's /preview/:id route), so no duplicate HTML artifact is written.
        // Opt in when a standalone, double-clickable file is needed.
        const keepPreviewFile =
          options.previewFile === true || process.env.PERSIST_PREVIEW === 'true';
        if (keepPreviewFile) {
          const previewFigures = [
            ...figures,
            ...unassignedImages.map((image) => ({
              number: null,
              caption: `未关联图片（第 ${image.pageNumber} 页）`,
              file: image.file
            }))
          ];
          await writePreviewFile({
            outputDir,
            markdown: markdownResult.markdown,
            metadata,
            report,
            figures: previewFigures,
            tables,
            title: markdownResult.title
          });
        } else {
          // Drop a preview.html left over from an older run so the output folder
          // never carries a stale duplicate of main.md.
          await rm(path.join(outputDir, 'preview.html'), { force: true });
        }
      },
      () =>
        `${markdownResult.markdown.length.toLocaleString('en-US')} 字符 · 覆盖 ${report.tokenCoverage}%`
    );

    const translateConfig = getTranslateConfig(options.translate ?? {});
    let translation = null;
    await step(
      5,
      '生成中文版',
      async () => {
        mainZhPath = path.join(outputDir, 'main_zh.md');
        if (!translateConfig.enabled) {
          // Drop a Chinese copy from an earlier run so the folder never shows a
          // stale translation next to a regenerated main.md.
          await rm(mainZhPath, { force: true });
          return;
        }

        translation = await translateMarkdown(markdownResult.markdown, {
          config: translateConfig,
          fetchImpl: options.translate?.fetchImpl,
          cachePath: path.join(outputDir, 'translations.json'),
          onProgress: ({ done, total }) =>
            emit({
              index: 5,
              label: '生成中文版',
              status: 'progress',
              progress: { done, total }
            })
        });

        if (translation.skipped) {
          await rm(mainZhPath, { force: true });
          return;
        }

        await writeFile(mainZhPath, `${translation.markdown}\n`, 'utf8');
        report.translation = {
          model: translateConfig.model,
          translated: translation.translated,
          total: translation.total,
          failed: translation.failed
        };
        if (translation.failed) {
          warnings.push(
            `${translation.failed} 个片段未能完成翻译，已保留英文原文。`
          );
        }
        // report.json 在步骤 4 写入，翻译统计与警告需要补写一次。
        await writeFile(
          path.join(outputDir, 'report.json'),
          JSON.stringify(report, null, 2),
          'utf8'
        );
      },
      () => {
        if (!translateConfig.enabled) return '翻译未启用';
        if (!translation || translation.skipped) return '未生成（缺少模型配置）';
        const parts = [
          `${translation.translated}/${translation.total} 段`,
          `${translation.markdown.length.toLocaleString('en-US')} 字符`
        ];
        if (translation.failed) parts.push(`保留英文 ${translation.failed}`);
        return parts.join(' · ');
      }
    );

    return {
      outputDir,
      mainPath,
      mainZhPath: translation?.skipped === false ? mainZhPath : null,
      markdown: markdownResult.markdown,
      markdownZh: translation?.skipped === false ? translation.markdown : null,
      metadata,
      report,
      figures,
      tables,
      equations,
      unassignedImages
    };
  } finally {
    await parser.destroy();
  }
}
