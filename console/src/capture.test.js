'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureControl } = require('./capture');
const { createApp } = require('./http');
const { createSessionToken, COOKIE_NAME } = require('./auth');

test('capture session does not reveal the token and rejects a bad bearer', async () => {
  const captureToken = 'c'.repeat(32);
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
      captureToken,
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(sessionSecret))}`;
  try {
    assert.equal((await fetch(`${base}/api/capture/poll`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/capture/poll`, { headers: { authorization: 'Bearer not-the-token' } })).status,
      401,
    );
    const page = await fetch(`${base}/api/capture`, { headers: { cookie } });
    const body = await page.json();
    assert.equal(page.status, 200);
    assert.equal(body.agent, 'offline');
    assert.equal(JSON.stringify(body).includes(captureToken), false);
    const snap = await fetch(`${base}/api/capture/snap`, { method: 'POST', headers: { cookie } });
    assert.equal(snap.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing capture token refuses the agent', async () => {
  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      bridgeToken: '',
      lookcamPassword: '',
      captureToken: '',
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/capture/poll`, {
      headers: { authorization: `Bearer ${'c'.repeat(32)}` },
    });
    assert.equal(denied.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a second jpeg is rejected while a snapshot is in flight', async () => {
  const capture = createCaptureControl({ token: 'c'.repeat(16) });
  /** @type {{ snap?: boolean }} */
  let polled = {};
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      polled = payload;
    },
    on() {},
  };
  capture.poll(res, 5000);
  const pending = capture.requestSnap();
  assert.equal(polled.snap, true);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(capture.acceptJpeg(jpeg).status, 200);
  assert.equal(capture.acceptJpeg(jpeg).status, 409);
  const shot = await pending;
  assert.equal(shot.status, 200);
  assert.equal(shot.body[0], 0xff);
  assert.equal(JSON.stringify(shot).includes('c'.repeat(16)), false);
});

test('switching between camera and capture app enforces single active stream (mutual exclusion)', async () => {
  const captureToken = 'c'.repeat(32);
  const bridgeToken = 'b'.repeat(32);
  const sessionSecret = 's'.repeat(32);
  const app = createApp({
    config: {
      gatePassword: 'g'.repeat(16),
      sessionSecret,
      nodeEnv: 'development',
      trustProxy: false,
      streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
      streamDeskWhepUrl: 'http://127.0.0.1:9/desk/whep',
      streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
      streamDeskSrtUrl: 'srt://127.0.0.1:9?streamid=publish:desk',
      captureRtspCam: 'rtsp://127.0.0.1:9/cam',
      bridgeToken,
      lookcamPassword: 'device-secret',
      captureToken,
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    cookie: `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(sessionSecret))}`,
    'content-type': 'application/json',
  };
  const captureAuth = { authorization: `Bearer ${captureToken}`, 'content-type': 'application/json' };
  const bridgeAuth = { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' };

  try {
    // 1. Both agents check in via poll (standby mode: video is false for both)
    const capPoll1 = await fetch(`${base}/api/capture/poll?wait=1`, { headers: captureAuth });
    assert.equal(capPoll1.status, 200);
    const capBody1 = await capPoll1.json();
    assert.equal(capBody1.video, false);

    const camPoll1 = await fetch(`${base}/api/bridge/poll?wait=1`, { headers: bridgeAuth });
    assert.equal(camPoll1.status, 200);
    const camBody1 = await camPoll1.json();
    assert.equal(camBody1.video, false);

    // 2. Both show as online & available in /api/camera
    const status1 = await (await fetch(`${base}/api/camera`, { headers })).json();
    assert.equal(status1.bridge, 'online');
    assert.equal(status1.capture.agent, 'online');
    assert.equal(status1.video, 'off');
    assert.equal(status1.capture.video, 'off');

    // 3. Operator selects Capture App (desk) -> capture video becomes wanted, camera stays off
    const watchDesk = await fetch(`${base}/api/capture/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'viewer-desk-01' }),
    });
    assert.equal(watchDesk.status, 200);

    const capPoll2 = await (await fetch(`${base}/api/capture/poll?wait=1`, { headers: captureAuth })).json();
    assert.equal(capPoll2.video, true);

    const status2 = await (await fetch(`${base}/api/camera`, { headers })).json();
    assert.equal(status2.capture.video, 'wanted');
    assert.equal(status2.video, 'off');

    // 4. Operator switches to Camera (cam) -> capture video is immediately suspended (false), camera becomes wanted (true)
    const watchCam = await fetch(`${base}/api/camera/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'viewer-cam-01', stream: 2 }),
    });
    assert.equal(watchCam.status, 200);

    const capPoll3 = await (await fetch(`${base}/api/capture/poll?wait=1`, { headers: captureAuth })).json();
    assert.equal(capPoll3.video, false);

    const status3 = await (await fetch(`${base}/api/camera`, { headers })).json();
    assert.equal(status3.video, 'wanted');
    assert.equal(status3.capture.video, 'off');

    // 5. Operator switches back to Capture App (desk) -> camera video is immediately suspended (false), capture becomes wanted (true)
    const watchDeskAgain = await fetch(`${base}/api/capture/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'viewer-desk-01' }),
    });
    assert.equal(watchDeskAgain.status, 200);

    const status4 = await (await fetch(`${base}/api/camera`, { headers })).json();
    assert.equal(status4.video, 'off');
    assert.equal(status4.capture.video, 'wanted');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
