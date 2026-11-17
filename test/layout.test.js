import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractLayout } from '../src/lib/pdf-layout.js';
import { resolveFixture } from './fixtures.js';

const sample = resolveFixture('software-05-00038.pdf');
const ieeeSample = resolveFixture('2312.10997v5.pdf');

test('IEEE Fig. captions with a period after the number are detected', { skip: !existsSync(ieeeSample) }, async () => {
  const layout = await extractLayout(new Uint8Array(await readFile(ieeeSample)));
  assert.deepEqual(layout.pages.flatMap((page) => page.figures).map((figure) => figure.number), [1, 2, 3, 4, 5, 6]);
});

test('sample PDF layout detects all figures, tables, and equations', { skip: !existsSync(sample) }, async () => {
  const data = new Uint8Array(await readFile(sample));
  const layout = await extractLayout(data);

  assert.equal(layout.totalPages, 22);
  const tables = layout.pages.flatMap((page) => page.tables);
  const figures = layout.pages.flatMap((page) => page.figures);
  const equations = layout.pages.flatMap((page) => page.equations);

  assert.equal(tables.length, 8);
  assert.equal(figures.length, 6);
  assert.equal(equations.length, 9);
  assert.deepEqual(
    equations.map((equation) => equation.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
  assert.ok(equations.every((equation) => equation.box.bottom < equation.box.top));
  assert.ok(equations.every((equation) => equation.anchorY >= equation.box.bottom));
  assert.ok(
    equations.every(
      (equation) =>
        equation.numberBox &&
        equation.numberBox.x > equation.box.left &&
        equation.numberBox.x < equation.box.right
    )
  );

  const table5 = tables.find((table) => table.number === 5);
  assert.deepEqual(table5.headers, ['Size', 'Language', 'T1 (s)', 'T16 (s)', 'S16', 'E16 (%)']);
  assert.deepEqual(table5.rows[0], ['4M', 'Rust', '1.1301', '0.1107', '10.211', '63.82']);
  assert.equal(table5.rows.length, 8);
  assert.equal(table5.confidence, 1);

  const table2 = tables.find((table) => table.number === 2);
  assert.equal(table2.rows.length, 4);
  assert.match(table2.rows[0][1], /Native code/);
  assert.match(table2.rows[3][2], /inherited read-only mmap/);
});
