import test from 'node:test';
import assert from 'node:assert/strict';
import { superscriptAffiliationMarks } from '../src/lib/markdown-builder.js';

test('numeric affiliation markers become superscript digits', () => {
  const authors =
    'Muhammad Hassam Aslam Khan 1,*, Daniel Stapleton 2, Medha Kulkarni 2, Md Rifat Ullah 2 and Rajeev R. Raje 4';
  const result = superscriptAffiliationMarks(authors);

  assert.ok(result.includes('Khan \u00b9,*'));
  assert.ok(result.includes('Stapleton \u00b2'));
  assert.ok(result.includes('Raje \u2074'));
  assert.ok(!/[^\u00b9\u00b2\u00b3\u2074-\u2079]\d/.test(result.replace(/[1-4]/g, '')));
});

test('attached numeric markers keep their original spacing', () => {
  const result = superscriptAffiliationMarks(
    'Qianqian Qi1,2 · Robert A. Bagheri2 · Peter G. M. van der Heijden2,3'
  );
  assert.ok(result.includes('Qi\u00b9,\u00b2'));
  assert.ok(result.includes('Bagheri\u00b2'));
  assert.ok(result.includes('Heijden\u00b2,\u00b3'));
});

test('letter markers are converted when affiliations use letter prefixes', () => {
  const authors =
    'Yunfan Gaoa, Yun Xiongb, Kangxiang Jiab, Meng Wangc, and Haofen Wang a,c';
  const markers = new Set(['a', 'b', 'c']);
  const result = superscriptAffiliationMarks(authors, markers);

  assert.ok(result.includes('Gao\u1d43'));
  assert.ok(result.includes('Xiong\u1d47'));
  assert.ok(result.includes('Ji\u1d43\u1d47'));
  assert.ok(result.includes('Wang\u1d9c'));
  assert.ok(result.includes('Wang \u1d43,\u1d9c'));
});

test('letter markers are ignored without letter-prefixed affiliations', () => {
  const authors = 'Jane Smitha, John Doeb';
  const result = superscriptAffiliationMarks(authors, new Set());
  assert.equal(result, authors);
});

test('plain author lists stay untouched', () => {
  const authors = 'Jane Doe, John Smith, and Alice Brown';
  const result = superscriptAffiliationMarks(authors, new Set(['a', 'b', 'c']));
  assert.equal(result, authors);
});
