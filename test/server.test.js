'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const { makeServer } = require('../src/server');

const HIGH_PROMPT = 'design and implement a payment service end-to-end';
const LOW_PROMPT = 'rename a.py to b.py now';
const NO_CONFIG = path.join('/nonexistent-ccrouter', 'config.json');

let mock;          // mock upstream server
let mockState;     // shared mutable state driving mock behavior
let proxy;         // the router proxy under test
let cfg;
let proxyPort;
let tmpDir;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrouter-srv-'));
  process.env.CCROUTER_HOME = tmpDir;

  mockState = { requests: [], mode: 'json' };
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      mockState.requests.push({
        path: req.url,
        headers: req.headers,
        body: bodyBuf,
      });
      const mode = mockState.mode;
      if (mode === 'die_mid_body') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '1000' });
        res.write('partial-data');
        setImmediate(() => res.socket.destroy());
        return;
      }
      if (mode === '400_effort') {
        return reply(res, 400, JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error',
            message: "This model does not support effort level 'xhigh'." },
        }));
      }
      if (mode === '404_then_ok' && mockState.requests.length === 1) {
        return reply(res, 404, JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'model: claude-opus-4-6 not found' },
        }));
      }
      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: a\ndata: {}\n\n');
        mockState.gate.then(() => {
          res.write('event: b\ndata: {}\n\n');
          res.end();
        });
        return;
      }
      reply(res, 200, JSON.stringify({ ok: true }));
    });
  });
  await listen(mock);

  cfg = config.loadConfig(NO_CONFIG);
  cfg.upstream_scheme = 'http';
  cfg.upstream_host = `127.0.0.1:${mock.address().port}`;
  cfg.classifier.api_key = null;

  proxy = makeServer(cfg);
  await listen(proxy);
  proxyPort = proxy.address().port;
});

after(async () => {
  await close(proxy);
  await close(mock);
  delete process.env.CCROUTER_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockState.requests = [];
  mockState.mode = 'json';
});

function reply(res, status, payload) {
  const buf = Buffer.from(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function sentinelBody(prompt) {
  return { model: 'auto', messages: [{ role: 'user', content: prompt }] };
}

function requestRes(opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.raw != null ? opts.raw
      : (opts.body != null ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0));
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: opts.method || 'POST',
      path: opts.path || '/v1/messages',
      headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
    }, resolve);
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

function buffer(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('aborted', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function request(opts) {
  const res = await requestRes(opts);
  const data = await buffer(res);
  return { status: res.statusCode, data };
}

const upstream = () => mockState.requests;

test('sentinel rewrite and header fidelity', async () => {
  const { status } = await request({
    body: sentinelBody(HIGH_PROMPT),
    headers: {
      authorization: 'Bearer secret-token-xyz',
      'anthropic-beta': 'oauth-2025-04-20,fine-grained',
      'x-claude-code-session-id': 'sess-1234abcd',
    },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(upstream().length, 1);
  const req = upstream()[0];
  const sent = JSON.parse(req.body);
  assert.strictEqual(sent.model, cfg.models.high);
  assert.strictEqual(sent.messages[0].content, HIGH_PROMPT);
  assert.strictEqual(req.headers.authorization, 'Bearer secret-token-xyz');
  assert.strictEqual(req.headers['anthropic-beta'], 'oauth-2025-04-20,fine-grained');
  assert.strictEqual(req.headers.host, cfg.upstream_host);

  const log = fs.readFileSync(path.join(tmpDir, 'decisions.jsonl'), 'utf8');
  assert.ok(log.includes('"tier":"high"'));
  assert.ok(!log.includes('secret-token-xyz'));
  assert.ok(!log.includes(HIGH_PROMPT));
});

test('non-sentinel passthrough is byte-identical', async () => {
  const raw = Buffer.from('{"model": "claude-sonnet-4-6",   "messages": []}');
  const { status } = await request({ raw });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(upstream()[0].body, raw);
});

test('unparseable body forwarded untouched', async () => {
  const raw = Buffer.from('{"model": "auto", "messages": [truncated');
  const { status } = await request({ raw });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(upstream()[0].body, raw);
});

test('count_tokens rewritten', async () => {
  const { status } = await request({ path: '/v1/messages/count_tokens', body: sentinelBody(LOW_PROMPT) });
  assert.strictEqual(status, 200);
  assert.strictEqual(JSON.parse(upstream()[0].body).model, cfg.models.low);
});

test('effort fixup applied for routed model', async () => {
  const b = sentinelBody(LOW_PROMPT);
  b.output_config = { effort: 'xhigh' };
  b.thinking = { type: 'adaptive' };
  const { status } = await request({ body: b });
  assert.strictEqual(status, 200);
  const sent = JSON.parse(upstream()[0].body);
  assert.strictEqual(sent.model, cfg.models.low);
  assert.ok(!('output_config' in sent));
  assert.ok(!('thinking' in sent));
});

test('SSE streams incrementally', async () => {
  mockState.mode = 'sse';
  let openGate;
  mockState.gate = new Promise((r) => { openGate = r; });

  const res = await requestRes({ body: sentinelBody('hello there my friend') });
  assert.strictEqual(res.statusCode, 200);

  // Read until the first event arrives; the second must NOT be present yet.
  let received = Buffer.alloc(0);
  await new Promise((resolve) => {
    res.on('data', (c) => {
      received = Buffer.concat([received, c]);
      if (received.includes('event: a')) resolve();
    });
  });
  assert.ok(!received.includes('event: b'), 'second event arrived early — not incremental');

  openGate();
  received = Buffer.concat([received, await buffer(res)]);
  assert.ok(received.includes('event: b'));
});

test('downgrade retry on model 404', async () => {
  mockState.mode = '404_then_ok';
  const { status, data } = await request({ body: sentinelBody(HIGH_PROMPT) });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(JSON.parse(data), { ok: true });
  assert.strictEqual(upstream().length, 2);
  assert.strictEqual(JSON.parse(upstream()[0].body).model, cfg.models.high);
  assert.strictEqual(JSON.parse(upstream()[1].body).model, cfg.models.mid);
});

test('param 400 is not retried', async () => {
  mockState.mode = '400_effort';
  const { status, data } = await request({ body: sentinelBody(HIGH_PROMPT) });
  assert.strictEqual(status, 400);
  assert.ok(data.includes('does not support effort'));
  assert.strictEqual(upstream().length, 1);
});

test('unrouted 404 is not retried', async () => {
  mockState.mode = '404_then_ok';
  const raw = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
  const { status, data } = await request({ raw });
  assert.strictEqual(status, 404);
  assert.ok(data.includes('not_found_error'));
  assert.strictEqual(upstream().length, 1);
});

test('mid-stream upstream death aborts cleanly (no injected 502, no hang)', async () => {
  mockState.mode = 'die_mid_body';
  const res = await requestRes({ body: sentinelBody('hello there my friend') });
  assert.strictEqual(res.statusCode, 200);
  const data = await buffer(res); // would hang forever on the silent-hang bug
  assert.ok(data.includes('partial-data'));
  assert.ok(!data.includes('502'));
  assert.ok(!data.includes('Bad Gateway'));
  assert.ok(!data.includes('HTTP/1.1'));
});

test('header lookup is case-insensitive (capture works)', async () => {
  const { status } = await request({
    body: sentinelBody(LOW_PROMPT),
    headers: {
      'X-Claude-Code-Agent-Id': 'Agent-Cap-12345678',
      'X-Claude-Code-Session-Id': 'Sess-Cap-87654321',
    },
  });
  assert.strictEqual(status, 200);
  const lines = fs.readFileSync(path.join(tmpDir, 'decisions.jsonl'), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(entry.agent, '12345678');
  assert.strictEqual(entry.sid, '87654321');
});

test('health endpoint', async () => {
  const { status, data } = await request({ path: '/__ccrouter/health', method: 'GET' });
  assert.strictEqual(status, 200);
  const info = JSON.parse(data);
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.sentinel, 'auto');
});

test('HEAD probe', async () => {
  const { status, data } = await request({ path: '/', method: 'HEAD' });
  assert.strictEqual(status, 200);
  assert.strictEqual(data.length, 0);
});

test('dead upstream returns 502', async () => {
  const deadCfg = Object.assign({}, cfg, { upstream_host: '127.0.0.1:1' });
  const dead = makeServer(deadCfg);
  await listen(dead);
  try {
    const port = dead.address().port;
    const { status, data } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      }, async (res) => resolve({ status: res.statusCode, data: await buffer(res) }));
      req.on('error', reject);
      req.write(JSON.stringify(sentinelBody('hi there friend')));
      req.end();
    });
    assert.strictEqual(status, 502);
    assert.ok(data.includes('cc-model-router'));
  } finally {
    await close(dead);
  }
});
