import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dehyphenateJoin,
  isOrphanAccentLine,
  isPageFurniture,
  joinParagraphLines,
  joinTextItems,
  markdownTable,
  normalizeTableHeader,
  renderInlineMath
} from '../src/lib/text-utils.js';
import { extractToc } from '../src/lib/preview.js';

test('inline math wraps subscripted variables in $...$', () => {
  const line = renderInlineMath(
    [
      { text: 'p', x: 0, y: 100, width: 4.6, height: 9.5 },
      { text: 'ij', x: 4.8, y: 98.6, width: 6, height: 6.6 },
      { text: '= x', x: 13, y: 100, width: 14, height: 9.5 },
      { text: 'ij', x: 27.4, y: 98.6, width: 6, height: 6.6 }
    ],
    9.5
  );

  assert.ok(line);
  assert.match(line, /\$p_\{ij\}\$/);
  assert.match(line, /x_\{ij\}\$/);
});

test('footnote-style superscript digits are not turned into math', () => {
  const line = renderInlineMath(
    [
      { text: 'Email', x: 0, y: 100, width: 24, height: 9.5 },
      { text: '1', x: 25, y: 102.4, width: 3, height: 6.6 },
      { text: 'Resources', x: 32, y: 100, width: 40, height: 9.5 }
    ],
    9.5
  );

  assert.equal(line, null);
});

test('joinTextItems keeps subscripts attached and inserts word spaces', () => {
  const text = joinTextItems([
    { text: 'T', x: 0, width: 6, height: 10 },
    { text: 'p', x: 6, width: 4, height: 7.6 },
    { text: '(s)', x: 10.4, width: 11, height: 10 },
    { text: 'Speedup', x: 28, width: 40, height: 10 }
  ]);

  assert.equal(normalizeTableHeader(text), 'Tp (s) Speedup');
});

test('dehyphenateJoin distinguishes real compounds from line-break hyphenation', () => {
  assert.equal(dehyphenateJoin('com-', 'ponent'), 'component');
  assert.equal(dehyphenateJoin('shared-', 'memory'), 'shared-memory');
  assert.equal(dehyphenateJoin('workload–', 'size'), 'workload–size');
  assert.equal(dehyphenateJoin('Rust-', 'based'), 'Rust-based');
});

test('joinParagraphLines repairs wrapped abstract text', () => {
  assert.equal(
    joinParagraphLines([
      'the measured com-',
      'ponent and workload–',
      'size conditions'
    ]),
    'the measured component and workload–size conditions'
  );
});

test('page furniture removal covers running headers and DOI footers', () => {
  assert.equal(isPageFurniture('Software 2026, 5, 38 7 of 22'), true);
  assert.equal(
    isPageFurniture('Software 2026, 5, 38 https://doi.org/10.3390/software5030038'),
    true
  );
  assert.equal(isPageFurniture('7. Conclusions'), false);
  assert.equal(isPageFurniture('Journal of Examples 2025, 4, 12 3 of 15'), true);
  assert.equal(isPageFurniture('9 Journal of Sample Studies (2024) 12:50–62'), true);
  assert.equal(isPageFurniture('Our study includes 3 of 15 participants'), false);
  assert.equal(isPageFurniture('Journal of Sample Studies'), false);
});

test('orphan accent lines are detected while normal text is preserved', () => {
  assert.equal(isOrphanAccentLine('∼'), true);
  assert.equal(isOrphanAccentLine('˜'), true);
  assert.equal(isOrphanAccentLine('Tp'), false);
});

test('markdownTable escapes pipes and pads rows', () => {
  const table = markdownTable(['A', 'B'], [['x|y', 'z']]);
  assert.match(table, /x\\\|y/);
  assert.match(table, /\| A \| B \|/);
});

test('preview TOC extracts heading hierarchy and stable IDs', () => {
  const toc = extractToc('# Title\n\n## 1. Introduction\n\n### 3.1. Metrics\n');
  assert.deepEqual(
    toc.map((entry) => [entry.level, entry.text]),
    [
      [1, 'Title'],
      [2, '1. Introduction'],
      [3, '3.1. Metrics']
    ]
  );
  assert.equal(toc[1].id, '1-introduction');
});
