import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { translateMarkdown } from '../src/lib/translate.js';

const config = {
  enabled: true,
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key',
  model: 'test-model',
  concurrency: 2,
  timeoutMs: 5000,
  temperature: 0
};

function echoFetch(counter = { calls: 0 }) {
  const fetchImpl = async (_url, init) => {
    counter.calls += 1;
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: json.items.map((item) => ({
                    id: item.id,
                    text: `译:${item.text}（中文译文内容）`
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };
  return { fetchImpl, counter };
}

test('translation keeps structure, math, links and references intact', async () => {
  const markdown = [
    '<!-- page: 1 -->',
    '# Introduction',
    'The model uses $x^2$ and [a link](https://example.com/page).',
    '$$\nE = mc^2\n$$',
    '![Figure 1](figs/figure-01.png)',
    '**Figure 1.** Accuracy over time.',
    '1. Author A. A paper.',
    '2. Author B. Another paper.'
  ].join('\n\n');

  const { fetchImpl } = echoFetch();
  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.skipped, false);
  assert.ok(result.translated > 0);
  assert.equal(result.failed, 0);

  assert.ok(result.markdown.includes('<!-- page: 1 -->'));
  assert.ok(result.markdown.includes('# 译:Introduction'));
  assert.ok(result.markdown.includes('$x^2$'));
  assert.ok(result.markdown.includes('[a link](https://example.com/page)'));
  assert.ok(result.markdown.includes('$$\nE = mc^2\n$$'));
  assert.ok(result.markdown.includes('![Figure 1](figs/figure-01.png)'));
  assert.ok(result.markdown.includes('1. Author A. A paper.'));
  assert.ok(result.markdown.includes('2. Author B. Another paper.'));
});

test('table cells are translated while the table shape survives', async () => {
  const markdown = [
    '| Method | Accuracy |',
    '| --- | --- |',
    '| BERT | 88.1 |'
  ].join('\n');

  const { fetchImpl } = echoFetch();
  const result = await translateMarkdown(markdown, { config, fetchImpl });

  const lines = result.markdown.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '| --- | --- |');
  assert.ok(lines[0].includes('译:Method'));
  assert.ok(lines[0].includes('译:Accuracy'));
  assert.ok(lines[2].includes('译:BERT'));
  assert.ok(lines[2].includes('88.1'));
});

test('batches stay inside one subsection and carry its title', async () => {
  const markdown = [
    '# Alpha',
    'First paragraph about alpha.',
    'Second paragraph about alpha.',
    '# Beta',
    'Third paragraph about beta.'
  ].join('\n\n');

  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    requests.push(json);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: json.items.map((item) => ({
                    id: item.id,
                    text: `译:${item.text}（中文译文内容）`
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(requests.length, 2);
  const alpha = requests.find((request) => request.section === 'Alpha');
  const beta = requests.find((request) => request.section === 'Beta');
  assert.ok(alpha, 'Alpha batch carries its section title');
  assert.ok(beta, 'Beta batch carries its section title');
  // Heading + two paragraphs for Alpha; heading + one paragraph for Beta.
  assert.equal(alpha.items.length, 3);
  assert.equal(beta.items.length, 2);
});

test('items dropped by a truncated section answer are retried one by one', async () => {
  const markdown = [
    'First paragraph about alpha.',
    'Second paragraph about alpha.'
  ].join('\n\n');

  let calls = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    calls += 1;
    // Simulate a truncated answer: only the first item of a multi-item batch.
    const items = json.items.length > 1 ? json.items.slice(0, 1) : json.items;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: items.map((item) => ({ id: item.id, text: `译:${item.text}（中文译文内容）` }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.failed, 0);
  assert.ok(result.markdown.includes('译:First paragraph'));
  assert.ok(result.markdown.includes('译:Second paragraph'));
  // Batch attempt + one individual retry for the dropped item.
  assert.equal(calls, 2);
});

test('math-dense lines are translated with formulas kept intact', async () => {
  const markdown =
    'The term $\\sum_i p_i$ measures the distance between $p_{ij}$ and $p_{+j}$ values.';
  const prompts = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    prompts.push(prompt);
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    calls += 1;
    const items = json.items.map((item) => ({
      id: item.id,
      // First two attempts come back untranslated; the third one works.
      text: calls < 3 ? item.text : `译:${item.text}（中文译文内容）`
    }));
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ items }) } }] };
      }
    };
  };

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.failed, 0);
  assert.equal(calls, 3);
  assert.ok(result.markdown.includes('译:'));
  // Formulas keep their `$...$` form after the round trip.
  assert.ok(result.markdown.includes('$\\sum_i p_i$'));
  assert.ok(result.markdown.includes('$p_{ij}$'));
  assert.match(prompts[0], /格式必须与英文原文一致/);
  assert.match(prompts[0], /数学密集的句子也要翻译/);
});

test('hard line breaks with two trailing spaces survive translation', async () => {
  const markdown = ['*a Institute one*  ', '*b Institute two*  '].join('\n');

  const { fetchImpl } = echoFetch();
  const result = await translateMarkdown(markdown, { config, fetchImpl });

  const lines = result.markdown.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('  '), 'first affiliation keeps its hard break');
  assert.ok(lines[1].endsWith('  '), 'second affiliation keeps its hard break');
});

test('bold keyword labels keep rendering before Chinese text', async () => {
  const markdown = '**Keywords:** Large language model, retrieval.';
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    const items = json.items.map((item) => ({
      id: item.id,
      // Keep the bold placeholder tokens around the translated label.
      text: '%%K0%%关键词：%%K1%%大语言模型、检索。'
    }));
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ items }) } }] };
      }
    };
  };

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  // `**关键词：**大…` does not render in marked; punctuation moves outside.
  assert.ok(result.markdown.includes('**关键词**：'));
  assert.ok(!result.markdown.includes('**关键词：**'));
});

test('line breaks added by the model are collapsed to keep line counts', async () => {
  const markdown = 'First paragraph about alpha and beta.';
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ id: 1, text: '译:关于阿尔法与贝塔的第一段。\n这是额外的一行。' }]
              })
            }
          }
        ]
      };
    }
  });

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.markdown.split('\n').length, 1);
  assert.ok(result.markdown.includes('译:关于阿尔法与贝塔的第一段。 这是额外的一行。'));
});

test('failing model keeps the English source', async () => {
  const markdown = '# Introduction\n\nThis paragraph should stay.';
  const fetchImpl = async () => ({ ok: false, status: 500, async json() { return {}; } });

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.skipped, false);
  assert.ok(result.failed > 0);
  assert.ok(result.markdown.includes('# Introduction'));
  assert.ok(result.markdown.includes('This paragraph should stay.'));
});

test('translation cache avoids repeat requests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-parse-x-zh-'));
  const cachePath = path.join(directory, 'translations.json');
  const markdown = '# Introduction\n\nA sentence about retrieval augmented generation.';

  try {
    const first = echoFetch();
    const initial = await translateMarkdown(markdown, {
      config,
      fetchImpl: first.fetchImpl,
      cachePath
    });
    assert.ok(first.counter.calls > 0);
    assert.ok(initial.markdown.includes('译:'));

    const second = echoFetch();
    const repeated = await translateMarkdown(markdown, {
      config,
      fetchImpl: second.fetchImpl,
      cachePath
    });
    assert.equal(second.counter.calls, 0);
    assert.equal(repeated.markdown, initial.markdown);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('each subsection is translated in a single request without a size budget', async () => {
  const contents = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    contents.push(prompt);
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: json.items.map((item) => ({ id: item.id, text: `译:${item.text}（中文译文内容）` }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const shortMarkdown = [
    '## 3 REVIEW OF LSH TECHNIQUES',
    'First paragraph about hashing families.',
    '## 4 DISTRIBUTED FRAMEWORKS',
    'Second paragraph about distributed indexing.'
  ].join('\n\n');

  const short = await translateMarkdown(shortMarkdown, { config, fetchImpl });
  assert.equal(short.failed, 0);
  // Each subsection is translated as its own request so context stays coherent.
  assert.equal(contents.length, 2);
  const shortPayloads = contents.map((prompt) =>
    JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')))
  );
  assert.deepEqual(
    shortPayloads.map((payload) => payload.section).sort(),
    ['3 REVIEW OF LSH TECHNIQUES', '4 DISTRIBUTED FRAMEWORKS']
  );
  assert.ok(short.markdown.includes('## 译:3 REVIEW OF LSH TECHNIQUES'));

  contents.length = 0;
  const longMarkdown = Array.from(
    { length: 30 },
    (_value, index) => `Paragraph ${index} ${'about parallel scaling behaviour '.repeat(5)}`
  ).join('\n\n');

  const long = await translateMarkdown(longMarkdown, { config, fetchImpl });
  assert.equal(long.failed, 0);
  // One section, no headings: every segment goes out in the same request.
  assert.equal(contents.length, 1);
  const longPayload = JSON.parse(
    contents[0].slice(contents[0].lastIndexOf('{"items"'))
  );
  assert.equal(longPayload.items.length, 30);
});

test('bold markers survive translation', async () => {
  const { fetchImpl } = echoFetch();
  const result = await translateMarkdown('**Figure 1.** Accuracy over time.', {
    config,
    fetchImpl
  });

  assert.ok(result.markdown.includes('**'));
  assert.ok(result.markdown.includes('译:'));
});

test('caption labels are localised deterministically', async () => {
  const { fetchImpl } = echoFetch();
  const result = await translateMarkdown(
    '**Table 3.** Cross entropy loss values.\n\n**Table 5 (part 1).** Continued metrics.',
    { config, fetchImpl }
  );

  assert.ok(result.markdown.includes('**\u8868 3.** '));
  assert.ok(result.markdown.includes('**\u8868 5 (part 1).** '));
  assert.ok(!result.markdown.includes('**Table 3.**'));
});

test('author-year reference entries stay in English', async () => {
  const { fetchImpl, counter } = echoFetch();
  const markdown = [
    '## Body',
    'A normal paragraph about correspondence analysis.',
    '## References',
    'Beh, E. J., Lombardo, R., & Wang, T. W. (2023). Power transformations. Springer Nature.',
    'BNC Consortium (2007) The British National Corpus, XML edition.'
  ].join('\n\n');

  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.ok(counter.calls > 0);
  assert.ok(result.markdown.includes('## 译:References'));
  assert.ok(
    result.markdown.includes(
      'Beh, E. J., Lombardo, R., & Wang, T. W. (2023). Power transformations. Springer Nature.'
    )
  );
  assert.ok(
    result.markdown.includes('BNC Consortium (2007) The British National Corpus, XML edition.')
  );
});

test('untranslated lines are retried once', async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    const isRetry = !prompt.includes('你是学术论文翻译专家');
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: json.items.map((item) => ({
                    id: item.id,
                    text: isRetry ? `中文译文：${item.text.slice(0, 4)}` : item.text
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const markdown = 'The value of p 1 and p 2 satisfies the relation described above.';
  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(calls, 2);
  assert.equal(result.failed, 0);
  assert.ok(/中文译文/.test(result.markdown));
});

test('lines that stay English after retry fall back to the source', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const json = JSON.parse(prompt.slice(prompt.lastIndexOf('{"items"')));
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: json.items.map((item) => ({ id: item.id, text: item.text }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const markdown = 'The value of p 1 and p 2 satisfies the relation described above.';
  const result = await translateMarkdown(markdown, { config, fetchImpl });

  assert.equal(result.failed, 1);
  assert.ok(result.markdown.includes('The value of p 1 and p 2 satisfies'));
});

test('disabled config skips work and reports it', async () => {
  const result = await translateMarkdown('# Title', {
    config: { ...config, enabled: false },
    fetchImpl: async () => {
      throw new Error('should not be called');
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.markdown, '# Title');
});
