import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMathLlmConfig,
  isMathDebrisLine,
  needsMathTranscription,
  rescueFragmentsWithLlm,
  transcribeBlockWithLlm,
  transcribeLineWithLlm
} from '../src/lib/math-llm.js';

const config = {
  enabled: true,
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key',
  model: 'test-model',
  concurrency: 2,
  timeoutMs: 5000,
  maxLines: 10,
  temperature: 0
};

test('prose lines with math glyphs need transcription', () => {
  assert.equal(
    needsMathTranscription({
      text: 'because of ∑ ∑ j in K-dimensional space, respectively, the elements of X'
    }),
    true
  );
  assert.equal(
    needsMathTranscription({
      text: '∑ ∑ pij = xij, and these are transformed into standardized residuals'
    }),
    true
  );
});

test('plain prose and already rebuilt inline math are left alone', () => {
  assert.equal(
    needsMathTranscription({
      text: 'Correspondence analysis is an exploratory method for contingency tables.'
    }),
    false
  );
  assert.equal(
    needsMathTranscription({
      text: 'The proportions sum to one for each row.',
      mathText: 'The proportions sum to one for each row.'
    }),
    false
  );
  assert.equal(
    needsMathTranscription({
      text: 'The term $p_{ij}$ appears here.',
      mathText: 'The term $p_{ij}$ appears here.'
    }),
    false
  );
  assert.equal(needsMathTranscription({ text: '| Method | Score |' }), false);
});

test('leftover math noise triggers transcription even with inline math', () => {
  assert.equal(
    needsMathTranscription({
      text: '∑ ∑ j = 1, 2, · · ·, J. The joint observed proportion is pij = xij/x++ with',
      mathText:
        '∑ ∑ j = 1, 2, · · ·, J. The joint observed proportion is $p_{ij}$ = $x_{ij}$ $/x_{++}$ with'
    }),
    true
  );

  assert.equal(
    needsMathTranscription({
      text: 'The squared χ2-distance between rows i and i′ of X is',
      mathText: 'The squared $\\chi^{2}$ -distance between rows i and $i^{\\prime}$ of X is'
    }),
    false
  );
});

test('structural damage triggers transcription', () => {
  // The ∑ glyph was dropped and only its limit `=j` survived.
  assert.equal(
    needsMathTranscription({
      text: 'where p_{i+} =j pij and p_{+j} =i pij are the margins',
      mathText: 'where $p_{i+}$ =j $p_{ij}$ and $p_{+j}$ =i $p_{ij}$ are the margins'
    }),
    true
  );
  // Transpose mark left outside the bracket.
  assert.equal(
    needsMathTranscription({
      text: 'and [ u1k ,u2k , · · · ,uIk ]T are the left singular vectors'
    }),
    true
  );
  // A fraction shredded into repeated 1/2 blocks.
  assert.equal(
    needsMathTranscription({
      text: '− 1 2 − 1 2 so the terms p+ drop out',
      mathText: '− $1_{2}$ − $1_{2}$ so the terms $p_{+}$ drop out'
    }),
    true
  );
});

test('vertical math debris lines are recognised', () => {
  assert.equal(isMathDebrisLine('pi+ p+j       / ∑i'), true);
  assert.equal(isMathDebrisLine('∑j'), true);
  assert.equal(isMathDebrisLine('(pij −pi+ p+j )2'), true);
  assert.equal(isMathDebrisLine('= 0.5'), true);

  assert.equal(isMathDebrisLine('total inertia is calculated as (pij −pi+ p+j )2'), false);
  assert.equal(isMathDebrisLine('and the sum over all cells'), false);
  assert.equal(isMathDebrisLine('Table 5 shows the results'), false);
  assert.equal(isMathDebrisLine(''), false);
});

test('block transcription keeps the strict paragraph prompt', async () => {
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
                content:
                  'total inertia is calculated as $\\frac{(p_{ij}-p_{i+}p_{+j})^2}{p_{i+}p_{+j}}$ divided by the total.'
              }
            }
          ]
        };
      }
    };
  };

  const text = await transcribeBlockWithLlm(Buffer.from('fake-png'), config, { fetchImpl });
  assert.match(promptText, /exact order/);
  assert.match(promptText, /Never add, drop, duplicate, reorder/);
  assert.match(text, /\\frac/);
});

test('page rescue returns markdown per listed fragment', async () => {
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
                    { id: 'line-1', text: 'the term $p_{ij}$ is used' },
                    { id: 'block-1', text: '$$\n\\sum_i x_i\n$$' }
                  ]
                })
              }
            }
          ]
        };
      }
    };
  };

  const rescued = await rescueFragmentsWithLlm({
    imageBuffer: Buffer.from('png'),
    fragments: [
      { id: 'line-1', text: 'the term pij is used' },
      { id: 'block-1', text: 'sum over i' }
    ],
    config,
    fetchImpl
  });

  assert.equal(rescued.get('line-1'), 'the term $p_{ij}$ is used');
  assert.match(rescued.get('block-1'), /\\sum_i/);
  assert.match(promptText, /line-1/);
  assert.match(promptText, /block-1/);
});

test('transcribeLineWithLlm returns the markdown line', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[1].type, 'image_url');
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '  the term $\\sum_j p_{ij}$ equals one.  ' } }]
        };
      }
    };
  };

  const text = await transcribeLineWithLlm(Buffer.from('fake-png'), config, { fetchImpl });
  assert.equal(text, 'the term $\\sum_j p_{ij}$ equals one.');
});

test('unusable transcriptions are rejected', async () => {
  const fenced = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: '```markdown\n$ a + b $\n```' } }] };
    }
  });
  assert.equal(
    await transcribeLineWithLlm(Buffer.from('fake'), config, { fetchImpl: fenced }),
    '$ a + b $'
  );

  const failing = async () => ({ ok: false, status: 500, async json() { return {}; } });
  assert.equal(
    await transcribeLineWithLlm(Buffer.from('fake'), config, { fetchImpl: failing }),
    null
  );
});

test('math transcription can be disabled and capped', () => {
  const disabled = getMathLlmConfig(
    {},
    { LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k', MATH_LLM_ENABLED: 'false' }
  );
  assert.equal(disabled.enabled, false);

  const capped = getMathLlmConfig(
    {},
    { LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k', MATH_LLM_MAX_LINES: '5' }
  );
  assert.equal(capped.enabled, true);
  assert.equal(capped.maxLines, 5);
});
