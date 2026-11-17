import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkdown } from '../src/lib/markdown-builder.js';

test('unassigned images with page coordinates appear near their original position', () => {
  const line = (text, y) => ({ text, y, x: 50, width: 300, height: 10, fontName: '' });
  const result = buildMarkdown({
    layout: { totalPages: 2, pages: [{ lines: [] }, { pageNumber: 2, lines: [line('Text before image.', 700), line('Text after image.', 400)] }] },
    pdfTextPages: [{ text: 'Document title' }], metadata: {}, figures: [], tables: [],
    unassignedImages: [{ pageNumber: 2, anchorY: 550, file: 'figs/unassigned/test.png' }]
  }).markdown;
  assert.ok(result.indexOf('Text before image') < result.indexOf('figs/unassigned/test.png'));
  assert.ok(result.indexOf('figs/unassigned/test.png') < result.indexOf('Text after image'));
  assert.doesNotMatch(result, /附录：未关联图片/);
});
