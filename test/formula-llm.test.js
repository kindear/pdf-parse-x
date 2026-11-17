import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertEquationWithLlm,
  getFormulaLlmConfig,
  mapWithConcurrency
} from '../src/lib/formula-llm.js';

test('concurrency pool never exceeds the configured width', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak <= 3, true);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
});

test('OpenAI-compatible formula provider returns validated tagged LaTeX', async () => {
  let requestBody = null;
  const fetchImpl = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '$$ E_p = \\frac{S_p}{p} $$'
            }
          }
        ]
      })
    };
  };

  const latex = await convertEquationWithLlm(
    {
      number: 2,
      lines: [{ text: 'Sp Ep =, (2)' }]
    },
    {
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'mimo-flash',
      vision: false,
      fetchImpl
    }
  );

  assert.ok(latex);
  assert.match(latex, /\\tag\{2\}/);
  assert.equal(requestBody.model, 'mimo-flash');
  assert.match(requestBody.messages[0].content, /Equation number in the PDF: \(2\)/);
});

test('formula provider is disabled without explicit configuration', async () => {
  const config = getFormulaLlmConfig({
    baseUrl: '',
    apiKey: ''
  });
  assert.equal(config.enabled, false);

  const latex = await convertEquationWithLlm(
    { number: 1, lines: [] },
    { enabled: false }
  );
  assert.equal(latex, null);
});

test('vision requests require an image and report the reason for fallback', async () => {
  let failure;
  const result = await convertEquationWithLlm({ number: 1, lines: [] }, {
    enabled: true, baseUrl: 'https://example.invalid/v1', vision: true,
    onFailure: (reason) => { failure = reason; },
    fetchImpl: () => { throw new Error('must not call the model'); }
  });
  assert.equal(result, null);
  assert.equal(failure, '公式截图不可用');
});

test('provider HTTP failures are distinguished from invalid LaTeX', async () => {
  let failure;
  const result = await convertEquationWithLlm({ number: 1, lines: [] }, {
    enabled: true, baseUrl: 'https://example.invalid/v1', vision: false,
    onFailure: (reason) => { failure = reason; },
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  assert.equal(result, null);
  assert.match(failure, /HTTP 429/);
});
