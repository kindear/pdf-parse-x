import test from 'node:test';
import assert from 'node:assert/strict';
import { locateFigureWithLlm } from '../src/lib/figure-llm.js';

test('figure localization accepts only bounded, high-confidence rectangles', async () => {
  const options = { enabled: true, baseUrl: 'https://example.invalid/v1', vision: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"box":[100,200,800,700],"confidence":0.95}' } }] }) }) };
  assert.deepEqual(await locateFigureWithLlm({ caption: 'Figure 1' }, { data: Buffer.from('image') }, options), [100, 200, 800, 700]);
  options.fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"box":[100,200,1200,700],"confidence":0.95}' } }] }) });
  assert.equal(await locateFigureWithLlm({ caption: 'Figure 1' }, { data: Buffer.from('image') }, options), null);
});
