'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentControl, imageOk, parseModelJson } = require('./agent');
const { createApp } = require('./http');
const { createSessionToken, COOKIE_NAME } = require('./auth');

const KEY = 'k'.repeat(24);
const SOURCE = 'int main(){return 0;}\n';

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
  assert.equal(imageOk(null), true);
  assert.equal(imageOk({ mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }), true);
  assert.equal(imageOk({ mime: 'image/jpeg', data: Buffer.from('nope').toString('base64') }), false);
  assert.equal(imageOk({ mime: 'text/plain', data: Buffer.from([0xff, 0xd8]).toString('base64') }), false);
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
      solve: [{ source: 'int main( {', approach: 'broken' }],
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
