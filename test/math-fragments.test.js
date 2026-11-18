import test from 'node:test';
import assert from 'node:assert/strict';
import { isMathFragmentOnly } from '../src/lib/markdown-builder.js';

test('math-only fragments are recognised', () => {
  assert.equal(isMathFragmentOnly('∑ ∑'), true);
  assert.equal(isMathFragmentOnly('∑'), true);
  assert.equal(isMathFragmentOnly('√'), true);
  assert.equal(isMathFragmentOnly('2 2'), true);
  assert.equal(isMathFragmentOnly('1 3'), true);
  // Sum limits left behind by a display equation.
  assert.equal(isMathFragmentOnly('i j k=1'), true);
  assert.equal(isMathFragmentOnly('i j'), true);
  assert.equal(isMathFragmentOnly('k=1'), true);
});

test('readable text is never treated as a fragment', () => {
  assert.equal(isMathFragmentOnly('Table 3 summarizes the results'), false);
  assert.equal(isMathFragmentOnly('the joint observed proportion is 0.5'), false);
  assert.equal(isMathFragmentOnly('Section 5.1'), false);
  assert.equal(isMathFragmentOnly('(3)'), false);
  assert.equal(isMathFragmentOnly(''), false);
});
