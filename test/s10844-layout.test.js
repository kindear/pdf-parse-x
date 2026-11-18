import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractLayout } from '../src/lib/pdf-layout.js';
import { resolveFixture } from './fixtures.js';

const sample = resolveFixture('s10844-026-01076-1.pdf');

test(
  'Springer sample detects figures, tables 1-11, and all numbered equations',
  { skip: !existsSync(sample) },
  async () => {
    const data = new Uint8Array(await readFile(sample));
    const layout = await extractLayout(data);

    assert.equal(layout.totalPages, 36);

    const tables = layout.pages.flatMap((page) => page.tables);
    const figures = layout.pages.flatMap((page) => page.figures);
    const equations = layout.pages.flatMap((page) => page.equations);

    const numbers = [...new Set(tables.map((table) => table.number))].sort(
      (a, b) => a - b
    );
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(tables.filter((table) => table.number === 5).length, 2);

    assert.equal(figures.length, 2);
    assert.match(figures[0].caption, /^Fig\. 1/);
    assert.match(figures[1].caption, /^Fig\. 2/);

    const numbered = equations.filter((equation) => equation.number !== null);
    const unnumbered = equations.filter((equation) => equation.number === null);

    assert.equal(numbered.length, 17);
    assert.deepEqual(
      numbered.map((equation) => equation.number),
      Array.from({ length: 17 }, (_, index) => index + 1)
    );

    // The paper also has unnumbered display equations (cosine distance, word
    // vectors, GloVe/SVD variants). They must be detected as standalone blocks
    // so they can be rendered as `$$...$$` instead of leaking into prose.
    assert.ok(
      unnumbered.length >= 4,
      `expected at least 4 unnumbered display equations, got ${unnumbered.length}`
    );
    assert.ok(
      unnumbered.every(
        (equation) =>
          equation.box.bottom < equation.box.top && equation.lines.length >= 1
      )
    );

    const table6 = tables.find((table) => table.number === 6);
    assert.match(table6.caption, /Bold value indicates/);
    assert.ok(table6.box.bottom < table6.box.top);
  }
);
