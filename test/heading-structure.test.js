import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHeadingStructure } from '../src/lib/markdown-builder.js';

const heading = (level, text) => ({ type: 'heading', level, text });

test('numbered subsections must belong to the current top-level section', () => {
  const blocks = [
    heading(2, '3. Materials and Methods'),
    heading(3, '3.1. Performance Metrics'),
    heading(3, '2.3. Some Other Section'),
    heading(3, '3.2. Measured Timing Decomposition'),
    heading(2, '4. Results'),
    heading(3, '4.1. Merge Sort Scaling')
  ];

  const result = validateHeadingStructure(blocks);
  assert.deepEqual(
    result.map((block) => block.type),
    ['heading', 'heading', 'paragraph', 'heading', 'heading', 'heading']
  );
  assert.equal(result[2].text, '2.3. Some Other Section');
});

test('top-level numbers must increase and stay unique', () => {
  const blocks = [
    heading(2, '1 Introduction'),
    heading(2, '1 Introduction'),
    heading(2, '2 Related Work')
  ];

  const result = validateHeadingStructure(blocks);
  assert.deepEqual(
    result.map((block) => block.type),
    ['heading', 'paragraph', 'heading']
  );
});

test('duplicate subsection numbers are demoted', () => {
  const blocks = [
    heading(2, '5. Results'),
    heading(3, '5.1. Scaling'),
    heading(3, '5.1. Scaling')
  ];

  const result = validateHeadingStructure(blocks);
  assert.deepEqual(
    result.map((block) => block.type),
    ['heading', 'heading', 'paragraph']
  );
});

test('run-in text inside a numbered section is not a heading', () => {
  const blocks = [
    heading(2, '1. Introduction'),
    heading(3, 'Workload Computation-to-Communication Structure'),
    { type: 'paragraph', text: 'Computation-to-communication ratio ...' },
    heading(3, 'A. Lettered Subsection'),
    heading(2, 'II. Roman Section'),
    heading(2, '2. Related Work')
  ];

  const result = validateHeadingStructure(blocks);
  assert.deepEqual(
    result.map((block) => block.type),
    ['heading', 'paragraph', 'paragraph', 'heading', 'heading', 'heading']
  );
});

test('back matter keywords stay headings', () => {
  const blocks = [
    heading(2, '7. Conclusions'),
    heading(2, 'Abbreviations'),
    heading(2, 'References'),
    heading(2, 'Appendix A')
  ];

  const result = validateHeadingStructure(blocks);
  assert.ok(result.every((block) => block.type === 'heading'));
});

test('documents without numbering keep their unnumbered headings', () => {
  const blocks = [
    heading(2, 'Abstract'),
    heading(2, 'Overview'),
    heading(3, 'Naive RAG')
  ];

  const result = validateHeadingStructure(blocks);
  assert.ok(result.every((block) => block.type === 'heading'));
});
