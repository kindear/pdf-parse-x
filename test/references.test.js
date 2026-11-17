import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertPdfToMarkdown } from '../src/lib/pdf-parser.js';
import { renderMarkdown } from '../src/lib/preview.js';
import { resolveFixture } from './fixtures.js';

const sample = resolveFixture('software-05-00038.pdf');
const bracketSample = resolveFixture('2312.10997v5.pdf');

test(
  'IEEE bracket references break one entry per line',
  { skip: !existsSync(bracketSample), timeout: 120000 },
  async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-parse-x-bracket-refs-'));
    try {
      await convertPdfToMarkdown(bracketSample, {
        outputDir,
        formulaLlm: { enabled: false }
      });
      const markdown = await readFile(path.join(outputDir, 'main.md'), 'utf8');
      const referenceSection = markdown.slice(markdown.indexOf('## REFERENCES'));
      const entries = referenceSection
        .split(/\r?\n/)
        .filter((line) => /^\[\d+\]\s+\S/.test(line));

      assert.ok(entries.length >= 170, `expected >=170 entries, got ${entries.length}`);
      assert.match(entries[0], /^\[1\] /);
      assert.match(entries[1], /^\[2\] /);
      // Running headers/footers must not survive inside the bibliography.
      assert.equal(referenceSection.includes('A Survey on Locality'), false);

      const { html } = renderMarkdown(markdown);
      const htmlReferences = html.slice(html.indexOf('id="references"'));
      assert.ok(
        (htmlReferences.match(/<p>\[\d+\]/g) ?? []).length >= 170,
        '每个参考文献条目应渲染为独立段落'
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
);

test(
  'references stay in one ordered list across the PDF page break',
  { skip: !existsSync(sample), timeout: 60000 },
  async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-parse-x-refs-'));
    try {
      await convertPdfToMarkdown(sample, {
        outputDir,
        formulaLlm: { enabled: false }
      });
      const markdown = await readFile(path.join(outputDir, 'main.md'), 'utf8');
      const referenceSection = markdown.slice(markdown.indexOf('## References'));
      const referenceLines = referenceSection
        .split(/\r?\n/)
        .filter((line) => /^\d+\.\s+/.test(line));

      assert.equal(referenceLines.length, 15);
      assert.match(referenceLines[0], /^1\. Amdahl/);
      assert.match(referenceLines[14], /^15\. Curtsinger/);
      assert.equal(referenceSection.includes('<!-- page: 22 -->'), false);

      const { html } = renderMarkdown(markdown);
      const htmlReferences = html.slice(html.indexOf('<h2 id="references">'));
      const beforeDisclaimer = htmlReferences.slice(0, htmlReferences.indexOf('Disclaimer'));
      assert.equal((beforeDisclaimer.match(/<ol>/g) ?? []).length, 1);
      assert.equal((beforeDisclaimer.match(/<li>/g) ?? []).length, 15);
      // Without a sidecar or model the formulas keep their PDF crops.
      assert.equal((html.match(/class="equation-fallback"/g) ?? []).length, 9);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
);

test(
  'converted output carries its own formulas.json sidecar',
  { skip: !existsSync(sample), timeout: 60000 },
  async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-parse-x-sidecar-'));
    try {
      await convertPdfToMarkdown(sample, {
        outputDir,
        formulaLlm: { enabled: false },
        formulaLatex: {
          1: 'E = mc^2',
          2: 'S_p = \\frac{T_1}{T_p}'
        }
      });

      const emitted = JSON.parse(
        await readFile(path.join(outputDir, 'formulas.json'), 'utf8')
      );
      assert.equal(emitted.version, 1);
      assert.equal(emitted.source, 'software-05-00038.pdf');
      assert.deepEqual(Object.keys(emitted.formulas).sort(), ['1', '2']);
      assert.equal(emitted.sources['1'], 'sidecar');
      assert.match(emitted.formulas['1'], /\\tag\{1\}/);

      // The emitted file is itself a valid sidecar for a later run.
      const markdown = await readFile(path.join(outputDir, 'main.md'), 'utf8');
      assert.equal((markdown.match(/^\$\$$/gm) ?? []).length, 4);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
);
