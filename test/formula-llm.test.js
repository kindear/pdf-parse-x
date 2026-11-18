import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertEquationWithLlm,
  getFormulaLlmConfig,
  mapWithConcurrency,
  parseRescueResponse,
  rescueEquationsWithLlm
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

test('fused marginal totals trigger one focused retry', async () => {
  const answers = [
    '\\frac{p_{ij}-p_{i+p+j}}{\\sqrt{p_i + p_j}}',
    '\\frac{p_{ij}-p_{i+}p_{+j}}{\\sqrt{p_{i+}p_{+j}}}'
  ];
  let calls = 0;
  const fetchImpl = async () => {
    const content = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  const latex = await convertEquationWithLlm(
    { number: 3, lines: [] },
    {
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'mimo-flash',
      vision: false,
      fetchImpl
    }
  );

  assert.equal(calls, 2);
  assert.match(latex, /p_\{i\+\}p_\{\+j\}/);
  assert.doesNotMatch(latex, /i\+p\+j/);
});

test('page rescue only asks for the failed equations', async () => {
  let promptText = '';
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    promptText = body.messages[0].content[0].text;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    { id: 'p6-1', latex: '\\sum_i x_i' },
                    { id: '7', latex: '' }
                  ]
                })
              }
            }
          ]
        };
      }
    };
  };

  const rescued = await rescueEquationsWithLlm({
    imageBuffer: Buffer.from('png'),
    equations: [
      { key: 'p6-1', number: null },
      { key: '7', number: 7 }
    ],
    config: {
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      vision: true,
      timeoutMs: 5000,
      temperature: 0
    },
    fetchImpl
  });

  assert.equal(rescued.get('p6-1'), '\\sum_i x_i');
  assert.equal(rescued.get('7'), '');
  assert.match(promptText, /p6-1/);
  assert.match(promptText, /numbered \(7\)/);
});

test('rescue response parser rejects unusable payloads', () => {
  assert.equal(parseRescueResponse('not json').size, 0);
  const parsed = parseRescueResponse('```json\n{"items":[{"id":1,"latex":"x"}]}\n```');
  assert.equal(parsed.get('1'), 'x');
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
