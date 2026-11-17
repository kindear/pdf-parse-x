import test from 'node:test';
import assert from 'node:assert/strict';
import { splitImagesForFigures } from '../src/lib/pdf-parser.js';

test('embedded image order alone never establishes a figure match', () => {
  const images = [{ data: 'first' }, { data: 'second' }];
  assert.deepEqual(splitImagesForFigures(images, [{ number: 1 }], []), [[]]);
  assert.deepEqual(splitImagesForFigures(images, [{ number: 1 }, { number: 2 }], []), [[], []]);
});

test('reassembles vertically adjacent tiles in page order', () => {
  const images = [{ name: 'bottom' }, { name: 'top' }];
  const page = { width: 600, height: 800, rules: { images: [
    { name: 'bottom', left: 50, right: 500, bottom: 120, top: 300 },
    { name: 'top', left: 50, right: 500, bottom: 300, top: 480 }
  ] } };
  assert.deepEqual(splitImagesForFigures(images, [{ captionY: 100, captionTop: 112 }], [], page), [[images[1], images[0]]]);
});

test('matches only a uniquely positioned image above a caption', () => {
  const images = [{ name: 'img-a' }, { name: 'other' }];
  const figures = [{ number: 1, captionY: 100, captionTop: 112 }];
  const page = { width: 600, height: 800, rules: { images: [
    { name: 'img-a', left: 50, right: 500, bottom: 120, top: 400 }
  ] } };
  assert.deepEqual(splitImagesForFigures(images, figures, [], page), [[images[0]]]);
  page.rules.images.push({ name: 'other', left: 50, right: 500, bottom: 125, top: 350 });
  assert.deepEqual(splitImagesForFigures(images, figures, [], page), [[]]);
});

test('multiple captions do not claim the same image', () => {
  const images = [{ name: 'a' }];
  const page = { width: 600, height: 800, rules: { images: [
    { name: 'a', left: 50, right: 500, bottom: 120, top: 300 }
  ] } };
  const figures = [{ captionY: 100, captionTop: 112 }, { captionY: 101, captionTop: 113 }];
  assert.deepEqual(splitImagesForFigures(images, figures, [], page), [[], []]);
});
