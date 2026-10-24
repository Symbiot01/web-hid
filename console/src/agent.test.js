'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODEL,
  cleanSource,
  createAgentControl,
  createGemini,
  entryFunction,
  entrySignature,
  imageOk,
  parseModelJson,
  sanitizeCaseItem,
  sourceHasEntry,
  wantsMoreCases,
} = require('./agent');
const { createApp } = require('./http');
const { createSessionToken, COOKIE_NAME } = require('./auth');

const KEY = 'k'.repeat(24);
const SOURCE = 'int solve(){return 0;}\nint main(){return solve();}\n';

function harness(steps, results) {
  const calls = [];
  const agent = createAgentControl({
    apiKey: KEY,
    generate: async (task) => {
      calls.push(task);
      const next = steps[task].shift();
      if (!next) throw new Error(`no script for ${task}`);
      return next;
    },
    run: async () => {
      const next = results.shift();
      if (!next) throw new Error('no run scripted');
      return next;
    },
  });
  return { agent, calls };
}

function passRun() {
  return { status: 'ran', compile: { ok: true, stderr: '' }, cases: [{ status: 'pass', actual: '3\n', reason: null }] };
}

test('parses model JSON and checks image bytes', () => {
  assert.equal(parseModelJson('```json\n{"ok":true}\n```').ok, true);
  assert.equal(parseModelJson('Here is the JSON:\n```json\n{"ok":true,}\n```\nHope this helps!').ok, true);
  assert.equal(cleanSource('```cpp\nint main() { return 0; }\n```'), 'int main() { return 0; }\n');
  assert.equal(imageOk(null), true);
  assert.equal(imageOk({ mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }), true);
  assert.equal(imageOk({ mime: 'image/jpeg', data: Buffer.from('nope').toString('base64') }), false);
  assert.equal(imageOk({ mime: 'text/plain', data: Buffer.from([0xff, 0xd8]).toString('base64') }), false);
  assert.equal(entryFunction('findMedianSortedArrays'), 'findMedianSortedArrays');
  assert.equal(entryFunction('Solution::findMedianSortedArrays(vector<int>& a)'), 'findMedianSortedArrays');
  assert.equal(entryFunction('main'), 'solve');
  assert.equal(entryFunction('not a function'), 'solve');
  assert.equal(entrySignature('solve', 'void solve(istream& in, ostream& out)'), 'void solve()');
  assert.equal(
    entrySignature('findMedianSortedArrays', 'double findMedianSortedArrays(vector<int>& a, vector<int>& b)'),
    'double findMedianSortedArrays(vector<int>& a, vector<int>& b)',
  );
  assert.equal(sourceHasEntry(SOURCE, 'solve'), true);
  assert.equal(sourceHasEntry('int main(){return 0;}\n', 'solve'), false);
  assert.equal(sourceHasEntry('int solve(){return 0;}\nint main(){return 0;}\n', 'solve'), false);
  const squished =
    '#include <iostream>\nint main() { while (getline(cin, line)) { while (low <= high) { low++; } } return 0; }';
  const expanded = cleanSource(squished);
  assert.ok(expanded.split('\n').length >= 6);
  assert.equal(MODEL, 'gemini-4-argon');
  assert.equal(wantsMoreCases('add few more test cases from your side to do even more thorough testing'), true);
  assert.equal(wantsMoreCases('', 'more_cases'), true);
  assert.equal(wantsMoreCases('use dynamic programming instead'), false);
  assert.equal(
    entrySignature(
      'largestRectangleArea',
      'int largestRectangleArea(vector<int>& heights)}{"title":"Largest Rectangle in Histogram"}',
    ),
    'int largestRectangleArea(vector<int>& heights)',
  );
  const unescapedCase = sanitizeCaseItem({
    input: '10 3\\n1 5 3\\n4 8 7\\n6 9 1\\n',
    expected: '10\\n',
  });
  assert.equal(unescapedCase.input, '10 3\n1 5 3\n4 8 7\n6 9 1\n');
  assert.equal(unescapedCase.expected, '10\n');
  assert.equal(
    cleanSource('#include <bits/stdc++.h>\\nusing namespace std;\\nint main() { return 0; }\\n'),
    '#include <bits/stdc++.h>\nusing namespace std;\nint main() { return 0; }\n',
  );
  assert.equal(
    sourceHasEntry(
      'class RandomizedCollection { public: RandomizedCollection(){} bool insert(int v){return true;} };\nint main(){ RandomizedCollection rc; rc.insert(1); return 0; }\n',
      'RandomizedCollection',
    ),
    true,
  );
  assert.equal(
    cleanSource(
      '#include <bits/stdc++.h>\nusing namespace std;\n\nvoid solve() {\n  long long n, m;\n  if (!(cin >> n >> m)) return;\n  vector<long long> weights;\n  weights.reserve(m);\n}\n\nint main() {\n  ios_base::sync_with_stdio(false);\n  cin.tie(nullptr);\n  long long t = 1;\n  while (t--) {\n    solve();\n  }\n  return 0;\n}\n',
    ),
    '#include <bits/stdc++.h>\nusing namespace std;\n\nvoid solve() {\n  long long n, m;\n  cin >> n >> m;\n  vector<long long> weights;\n}\n\nint main() {\n  long long t = 1;\n  while (t--) {\n    solve();\n  }\n  return 0;\n}\n',
  );
});

test('retries on RECITATION finishReason with anti-recitation prompt', async () => {
  const bodies = [];
  const gen = createGemini({
    apiKey: KEY,
    model: MODEL,
    fetchImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      if (bodies.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'LRU Cache',
                      statement: 'Paraphrased LRU spec',
                      casesFromProblem: true,
                      cases: [{ input: '2 1\nget 1\n', expected: '-1\n' }],
                      plan: 'List + hash map',
                      functionName: 'LRUCache',
                      signature: 'class LRUCache {};',
                      format: 'cap q then ops',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    },
  });
  const out = await gen('identify', { text: 'lru' });
  assert.equal(out.title, 'LRU Cache');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].contents[0].parts[0].text, /Paraphrase/);
  assert.equal(bodies[0].generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
});

test('streams thought tokens and redacts the key', async () => {
  const thoughts = [];
  const gen = createGemini({
    apiKey: KEY,
    model: MODEL,
    onThought: (text, meta) => {
      if (meta && meta.reset) {
        thoughts.push(`RESET:${meta.label}`);
        return;
      }
      thoughts.push(text);
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          const chunks = [
            `data: {"candidates":[{"content":{"parts":[{"text":"use a map ${KEY}","thought":true}]}}]}\n\n`,
            'data: {"candidates":[{"content":{"parts":[{"text":" then a list","thought":true}]}}]}\n\n',
            'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"{\\"ok\\":true,\\"reason\\":\\"fine\\"}"}]}}]}\n\n',
          ];
          let index = 0;
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              const value = Buffer.from(chunks[index], 'utf8');
              index += 1;
              return { done: false, value };
            },
          };
        },
      },
    }),
  });
  const out = await gen('review', { statement: 'check', cases: [] });
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'fine');
  assert.deepEqual(thoughts, ['RESET:checking cases', 'use a map [redacted]', ' then a list']);
});

test('solved run writes the source and does not reveal the key', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          statement: `Add two numbers ${KEY}`,
          casesFromProblem: true,
          cases: [{ input: '1 2\n', expected: '3\n' }],
          plan: 'Add the two integers',
        },
      ],
      review: [{ ok: true, reason: '' }],
      solve: [{ source: SOURCE, approach: 'Read and add' }],
      retry: [],
      fix: [],
      makeCases: [],
      ask: [],
    },
    [passRun()],
  );
  const view = await agent.begin({ text: 'see the image' });
  assert.deepEqual(calls, ['identify', 'review', 'solve']);
  assert.equal(view.phase, 'solved');
  assert.equal(view.source, SOURCE);
  assert.equal(view.cases[0].status, 'pass');
  assert.equal(JSON.stringify(view).includes(KEY), false);
});

test('stops when the sample cases do not match the statement', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          statement: 'Print the sum',
          casesFromProblem: true,
          cases: [{ input: '1 1\n', expected: '9\n' }],
          plan: '',
        },
      ],
      review: [{ ok: false, reason: '1+1 is not 9' }],
      solve: [],
      retry: [],
      fix: [],
      makeCases: [],
      ask: [],
    },
    [],
  );
  const view = await agent.begin({ text: 'problem' });
  assert.equal(view.phase, 'blocked');
  assert.equal(view.source, null);
  assert.equal(calls.includes('solve'), false);
  assert.match(view.messages.map((item) => item.text).join('\n'), /do not follow/);
});

test('fixes a compile error and then passes', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          statement: 'Echo',
          casesFromProblem: false,
          cases: [],
          plan: 'Print the token',
        },
      ],
      makeCases: [{ cases: [{ input: 'hi\n', expected: 'hi\n' }] }],
      review: [],
      solve: [{ source: 'int solve(){return 0;}\nint main( {', approach: 'broken' }],
      fix: [{ source: SOURCE }],
      retry: [],
      ask: [],
    },
    [
      { status: 'compile_error', compile: { ok: false, stderr: 'expected }' }, cases: [] },
      passRun(),
    ],
  );
  const view = await agent.begin({ text: 'echo' });
  assert.equal(view.phase, 'solved');
  assert.ok(calls.includes('fix'));
});

test('a wrong answer retries once when the samples are valid', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          statement: 'Sum',
          casesFromProblem: true,
          cases: [{ input: '1 2\n', expected: '3\n' }],
          plan: 'Add',
        },
      ],
      review: [
        { ok: true, reason: '' },
        { ok: true, reason: '' },
      ],
      solve: [{ source: SOURCE, approach: 'first' }],
      retry: [{ source: `${SOURCE}// second\n`, approach: 'second' }],
      fix: [],
      makeCases: [],
      ask: [],
    },
    [
      { status: 'ran', compile: { ok: true, stderr: '' }, cases: [{ status: 'fail', actual: '0\n', reason: null }] },
      passRun(),
    ],
  );
  const view = await agent.begin({ text: 'sum' });
  assert.equal(view.phase, 'solved');
  assert.ok(calls.includes('retry'));
});

test('moves an algorithm out of main into solve before running', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          statement: 'Median of two arrays',
          casesFromProblem: true,
          cases: [{ input: 'nums1 = [1,3], nums2 = [2]\n', expected: '2.00000\n' }],
          plan: '',
          functionName: '',
          format: 'Print the median with five decimal places.',
        },
      ],
      review: [{ ok: true, reason: '' }],
      solve: [{ source: 'int main(){ while(1){} }\n', approach: 'search in main' }],
      fix: [{ source: SOURCE }],
      retry: [],
      makeCases: [],
      ask: [],
    },
    [passRun()],
  );
  const view = await agent.begin({ text: 'median' });
  assert.equal(view.phase, 'solved');
  assert.equal(view.source, SOURCE);
  assert.ok(calls.includes('fix'));
  assert.match(view.messages.map((item) => item.text).join('\n'), /solve/);
});

test('builds the main test wrapper first when harness is supported', async () => {
  const calls = [];
  const steps = {
    identify: [
      {
        title: 'Median of Two Sorted Arrays',
        statement: 'Return the median of two sorted arrays.',
        casesFromProblem: true,
        cases: [{ input: 'nums1 = [1,3], nums2 = [2]\n', expected: '2.00000\n' }],
        plan: 'Binary search partition on the smaller array.',
        functionName: 'findMedianSortedArrays',
        signature: 'double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2)',
        format: 'Print median with 5 decimal places.',
      },
    ],
    review: [{ ok: true, reason: '' }],
    harness: [
      {
        source:
          'double findMedianSortedArrays(int a){return 0.0;}\nint main(){return (int)findMedianSortedArrays(1);}\n',
      },
    ],
    solve: [
      {
        source:
          'double findMedianSortedArrays(int a){return 2.0;}\nint main(){return (int)findMedianSortedArrays(1);}\n',
        approach: 'Binary search partition in O(log(min(m, n))).',
      },
    ],
  };
  const generate = async (task) => {
    calls.push(task);
    return steps[task].shift();
  };
  generate.supportsHarness = true;
  const agent = createAgentControl({
    apiKey: KEY,
    generate,
    run: async () => ({
      status: 'ran',
      compile: { ok: true, stderr: '' },
      cases: [{ status: 'pass', actual: '2.00000\n', reason: null, timeMs: 8 }],
    }),
  });
  const view = await agent.begin({ text: 'median' });
  assert.deepEqual(calls, ['identify', 'review', 'harness', 'solve']);
  assert.equal(view.phase, 'solved');
  assert.equal(view.entry, 'findMedianSortedArrays');
  assert.equal(view.title, 'Median of Two Sorted Arrays');
});

test('adds edge test cases on user request and re-runs the test suite', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          title: 'Median of Two Sorted Arrays',
          statement: 'Return the median of two sorted arrays.',
          casesFromProblem: true,
          cases: [
            { input: 'nums1 = [1,3], nums2 = [2]\n', expected: '2.00000\n' },
            { input: 'nums1 = [1,2], nums2 = [3,4]\n', expected: '2.50000\n' },
          ],
          plan: 'Binary search partition.',
          functionName: 'findMedianSortedArrays',
          signature: 'double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2)',
          format: 'nums1 = [...], nums2 = [...] -> 5 decimal places',
        },
      ],
      review: [{ ok: true, reason: '' }],
      solve: [
        {
          source:
            'double findMedianSortedArrays(int a){return 2.0;}\nint main(){return (int)findMedianSortedArrays(1);}\n',
          approach: 'Binary search partition.',
        },
      ],
      makeCases: [
        {
          cases: [
            { input: 'nums1 = [], nums2 = [1]\n', expected: '1.00000\n' },
            { input: 'nums1 = [-5,-3], nums2 = [-2,0]\n', expected: '-2.50000\n' },
            { input: 'nums1 = [1,1,1], nums2 = [1,1,1]\n', expected: '1.00000\n' },
          ],
        },
      ],
      retry: [],
      fix: [],
      ask: [],
    },
    [
      {
        status: 'ran',
        compile: { ok: true, stderr: '' },
        cases: [
          { status: 'pass', actual: '2.00000\n', reason: null, timeMs: 6 },
          { status: 'pass', actual: '2.50000\n', reason: null, timeMs: 6 },
        ],
      },
      {
        status: 'ran',
        compile: { ok: true, stderr: '' },
        cases: [
          { status: 'pass', actual: '2.00000\n', reason: null, timeMs: 5 },
          { status: 'pass', actual: '2.50000\n', reason: null, timeMs: 5 },
          { status: 'pass', actual: '1.00000\n', reason: null, timeMs: 5 },
          { status: 'pass', actual: '-2.50000\n', reason: null, timeMs: 5 },
          { status: 'pass', actual: '1.00000\n', reason: null, timeMs: 5 },
        ],
      },
    ],
  );
  const first = await agent.begin({ text: 'median' });
  assert.equal(first.cases.length, 2);
  const expanded = await agent.guide({
    text: 'add few more test cases from your side to do even more thorough testing',
    cases: first.cases,
  });
  assert.ok(calls.includes('makeCases'));
  assert.equal(expanded.phase, 'solved');
  assert.equal(expanded.cases.length, 5);
  assert.equal(expanded.cases.every((c) => c.status === 'pass'), true);
});

test('combines multiple images at start and when follow-up screenshots are added', async () => {
  const seenImages = [];
  const jpeg1 = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64') };
  const jpeg2 = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x02]).toString('base64') };
  const jpeg3 = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x03]).toString('base64') };
  const steps = {
    identify: [
      {
        title: 'Two Sum',
        statement: 'Part 1: Given array nums and target.',
        casesFromProblem: true,
        cases: [{ input: 'nums = [2,7,11,15], target = 9\n', expected: '[0,1]\n' }],
        plan: 'Hash map lookup.',
        functionName: 'twoSum',
        signature: 'vector<int> twoSum(vector<int>& nums, int target)',
        format: 'nums = [...], target = k -> [i,j]',
      },
      {
        title: 'Two Sum',
        statement: 'Part 1 + Part 2: Given array nums and target, return indices. Constraints: 2 <= nums.length <= 10^4.',
        casesFromProblem: true,
        cases: [
          { input: 'nums = [2,7,11,15], target = 9\n', expected: '[0,1]\n' },
          { input: 'nums = [3,2,4], target = 6\n', expected: '[1,2]\n' },
        ],
        plan: 'One-pass hash map.',
        functionName: 'twoSum',
        signature: 'vector<int> twoSum(vector<int>& nums, int target)',
        format: 'nums = [...], target = k -> [i,j]',
      },
    ],
    review: [{ ok: true, reason: '' }],
    solve: [
      {
        source: 'int twoSum(int a){return a;}\nint main(){return twoSum(0);}\n',
        approach: 'Hash map.',
      },
    ],
    retry: [
      {
        source: 'int twoSum(int a){return a;}\nint main(){return twoSum(0);}\n',
        approach: 'Updated hash map with constraints.',
      },
    ],
  };
  const agent = createAgentControl({
    apiKey: KEY,
    generate: async (task, ctx) => {
      if (task === 'identify') seenImages.push((ctx.images || []).length);
      return steps[task].shift();
    },
    run: async (_src, cases) => ({
      status: 'ran',
      compile: { ok: true, stderr: '' },
      cases: cases.map((c) => ({ status: 'pass', actual: c.expected, reason: null, timeMs: 4 })),
    }),
  });
  const first = await agent.begin({ text: 'Part 1 & 2', images: [jpeg1, jpeg2] });
  assert.equal(first.phase, 'solved');
  assert.equal(first.cases.length, 1);
  const second = await agent.guide({ text: 'Here is the rest of the examples', images: [jpeg3], cases: first.cases });
  assert.equal(second.phase, 'solved');
  assert.equal(second.cases.length, 2);
  assert.deepEqual(seenImages, [2, 3]);
});

test('a second start stays on the run already in progress', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const agent = createAgentControl({
    apiKey: KEY,
    generate: async () => {
      await gate;
      const error = new Error('The problem read reply was not usable.');
      error.status = 502;
      throw error;
    },
    run: async () => passRun(),
  });
  const first = agent.begin({ text: 'problem' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(agent.begin({ text: 'again' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.view.phase, 'working');
    assert.match(error.view.activity, /Analyzing problem statement/);
    return true;
  });
  release();
  const done = await first;
  assert.equal(done.phase, 'needs_human');
  assert.match(done.messages.map((item) => item.text).join('\n'), /problem read reply was not usable/);
});

test('ask does not return source', async () => {
  const { agent } = harness(
    {
      identify: [],
      review: [],
      solve: [],
      retry: [],
      fix: [],
      makeCases: [],
      ask: [{ text: `look at ${KEY}` }],
    },
    [],
  );
  const answer = await agent.ask({ text: 'what does main do?', source: SOURCE });
  assert.equal(Object.hasOwn(answer, 'source'), false);
  assert.equal(answer.text.includes(KEY), false);
});

test('unconfigured agent refuses and the HTTP status hides the key', async () => {
  const local = createAgentControl({ apiKey: '', generate: async () => ({}), run: async () => passRun() });
  await assert.rejects(local.begin({ text: 'hi' }), (error) => error.status === 503);

  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      streamDeskSrtUrl: 'srt://127.0.0.1:9?streamid=publish:desk',
      captureRtspCam: 'rtsp://127.0.0.1:9/cam',
      bridgeToken: '',
      lookcamPassword: '',
      captureToken: '',
      geminiApiKey: '',
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(sessionSecret))}`;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ text: 'hi' }),
    });
    const body = await denied.json();
    assert.equal(denied.status, 503);
    assert.equal(JSON.stringify(body).includes(KEY), false);
    const open = await fetch(`http://127.0.0.1:${port}/api/agent`);
    assert.equal(open.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('removes hardcoded test-case checks and repairs miscalculated synthetic cases', async () => {
  const { agent, calls } = harness(
    {
      identify: [
        {
          title: 'Repeated String Construction',
          statement: 'Construct lexicographically smallest string of length n.',
          casesFromProblem: false,
          cases: [],
          plan: 'Compute ceil(count[c] / k) for each character.',
          functionName: 'solve',
          signature: 'void solve()',
          format: 'n on line 1, data on line 2',
        },
      ],
      makeCases: [
        {
          cases: [{ input: '5\nzzzzz\n', expected: 'aaaaz\n' }],
        },
      ],
      solve: [
        {
          source:
            '#include <bits/stdc++.h>\nusing namespace std;\nvoid solve() {\n  int n; string data; cin >> n >> data;\n  if (n == 5 && data == "zzzzz") { cout << "aaaaz\\n"; return; }\n  cout << "zzzzz\\n";\n}\nint main() { solve(); return 0; }\n',
          approach: 'Greedy frequency counts.',
        },
      ],
      fix: [
        {
          source:
            '#include <bits/stdc++.h>\nusing namespace std;\nvoid solve() {\n  cout << "zzzzz\\n";\n}\nint main() { solve(); return 0; }\n',
        },
      ],
      review: [
        {
          ok: false,
          reason: 'For n=5 and data=zzzzz, k=1 so the answer must be zzzzz, not aaaaz.',
          cases: [{ input: '5\nzzzzz\n', expected: 'zzzzz\n' }],
        },
      ],
      retry: [],
      ask: [],
    },
    [
      {
        status: 'ran',
        compile: { ok: true, stderr: '' },
        cases: [{ status: 'fail', actual: 'zzzzz\n', reason: null, timeMs: 5 }],
      },
      {
        status: 'ran',
        compile: { ok: true, stderr: '' },
        cases: [{ status: 'pass', actual: 'zzzzz\n', reason: null, timeMs: 5 }],
      },
    ],
  );
  const view = await agent.begin({ text: 'construct string' });
  assert.deepEqual(calls, ['identify', 'makeCases', 'solve', 'fix', 'review']);
  assert.equal(view.phase, 'solved');
  assert.equal(view.cases[0].expected, 'zzzzz\n');
  assert.equal(view.source.includes('aaaaz'), false);
});

