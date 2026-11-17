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

    assert.equal(equations.length, 17);
    assert.deepEqual(
      equations.map((equation) => equation.number),
      Array.from({ length: 17 }, (_, index) => index + 1)
    );

    const table6 = tables.find((table) => table.number === 6);
    assert.match(table6.caption, /Bold value indicates/);
    assert.ok(table6.box.bottom < table6.box.top);
  }
);
