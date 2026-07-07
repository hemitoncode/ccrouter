'use strict';

// Localhost reverse proxy implementing the routing.
//
// Claude Code (launched by `ccrouter code`) points ANTHROPIC_BASE_URL here.
// For POST /v1/messages[/count_tokens] bodies whose model equals the sentinel,
// the model field is rewritten per the routing decision and params are adapted
// to the target model; everything else is forwarded byte-identical. Headers
// (including Authorization and anthropic-beta) pass through verbatim in both
// directions, minus hop-by-hop headers. Responses stream back unbuffered so
// SSE stays incremental.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const config = require('./config');
const decisions = require('./decisions');
const router = require('./router');

const VERSION = require('../package.json').version;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const REQUEST_EXCLUDE = new Set([...HOP_BY_HOP, 'host', 'content-length', 'expect']);
const RESPONSE_EXCLUDE = new Set([...HOP_BY_HOP, 'content-length']);

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function upstreamRequest(method, reqPath, reqHeaders, body, cfg) {
  return new Promise((resolve, reject) => {
    const useHttps = (cfg.upstream_scheme || 'https') === 'https';
    const [host, portStr] = cfg.upstream_host.split(':');
    const lib = useHttps ? https : http;
    const headers = {};
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (!REQUEST_EXCLUDE.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = cfg.upstream_host;
    if (body && body.length) headers['content-length'] = Buffer.byteLength(body);
    const req = lib.request({
      host,
      port: portStr ? Number(portStr) : (useHttps ? 443 : 80),
      method,
      path: reqPath,
      headers,
      timeout: 600000,
    }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

function modelUnavailable(errBuf) {
  const lower = errBuf.toString('utf8').toLowerCase();
  if (lower.includes('not_found_error')) return true;
  return lower.includes('model') && [
    'not found', 'does not exist', 'not available', 'no access',
    'permission', 'not a recognized',
  ].some((p) => lower.includes(p));
}

function filterHeaders(source) {
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (!RESPONSE_EXCLUDE.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// Stream upstream -> client, flushing each chunk immediately (keeps SSE live).
// A mid-stream upstream failure truncates the connection instead of writing a
// second status line / error into the chunked body.
function streamResponse(res, upstream) {
  res.writeHead(upstream.statusCode, filterHeaders(upstream.headers));
  const killClient = () => { if (!res.destroyed) res.destroy(); };
  upstream.on('error', killClient);
  upstream.on('aborted', killClient);
  res.on('close', () => {
    if (!upstream.complete && !upstream.destroyed) upstream.destroy();
  });
  upstream.pipe(res);
}

function sendBuffered(res, status, upstreamHeaders, body) {
  const headers = filterHeaders(upstreamHeaders);
  headers['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

function sendErrorJson(res, status, message) {
  const payload = Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: 'cc-model-router: ' + message },
  }));
  try {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': payload.length,
    });
    res.end(payload);
  } catch {
    try { res.destroy(); } catch { /* client already gone */ }
  }
}

function sendHealth(res, cfg) {
  const payload = Buffer.from(JSON.stringify({
    ok: true,
    version: VERSION,
    pid: process.pid,
    sentinel: cfg.sentinel,
    models: cfg.models,
    user_config: cfg._user_config_loaded || null,
    user_config_error: cfg._user_config_error || null,
  }));
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': payload.length,
  });
  res.end(payload);
}

async function handleRequest(req, res, cfg) {
  const method = req.method;
  if (method === 'HEAD') { // Claude Code probes the gateway with HEAD / at startup
    res.writeHead(200, { 'content-length': '0' });
    res.end();
    return;
  }
  const urlPath = req.url;
  if (method === 'GET' && urlPath.split('?', 1)[0] === '/__ccrouter/health') {
    return sendHealth(res, cfg);
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch {
    return sendErrorJson(res, 400, 'error reading request body');
  }

  const headers = req.headers; // Node lowercases incoming header names
  let bodyDict = null;
  if (method === 'POST' && rawBody.length) {
    try { bodyDict = JSON.parse(rawBody.toString('utf8')); } catch { bodyDict = null; }
  }

  let decision = null;
  if (bodyDict && typeof bodyDict === 'object' && !Array.isArray(bodyDict)) {
    decision = await router.decide(urlPath, headers, bodyDict, rawBody.length, cfg);
  }

  let outBody = rawBody;
  if (decision) {
    bodyDict.model = decision.model;
    const fixups = router.applyParamFixups(bodyDict, decision.model, cfg);
    decision.signals.push(...fixups.map((f) => 'fixup:' + f));
    outBody = Buffer.from(JSON.stringify(bodyDict));
    decisions.record(decision, headers, urlPath, cfg);
  }

  let upstream;
  try {
    upstream = await upstreamRequest(method, urlPath, headers, outBody, cfg);
  } catch (e) {
    return sendErrorJson(res, 502, 'upstream request failed: ' + e.message);
  }

  // A routed model the subscription doesn't serve -> one retry at MID.
  if (decision && decision.tier !== 'mid' && cfg.rules.retry_downgrade &&
      (upstream.statusCode === 400 || upstream.statusCode === 404)) {
    let errBuf;
    try {
      errBuf = await readBody(upstream);
    } catch (e) {
      return sendErrorJson(res, 502, 'upstream read failed: ' + e.message);
    }
    if (modelUnavailable(errBuf)) {
      bodyDict.model = cfg.models.mid;
      const fixups = router.applyParamFixups(bodyDict, cfg.models.mid, cfg);
      outBody = Buffer.from(JSON.stringify(bodyDict));
      decisions.record(
        new router.Decision('mid', cfg.models.mid, 'downgrade_retry', {
          signals: [`from:${decision.model}`, ...fixups.map((f) => 'fixup:' + f)],
        }), headers, urlPath, cfg);
      try {
        upstream = await upstreamRequest(method, urlPath, headers, outBody, cfg);
      } catch (e) {
        return sendErrorJson(res, 502, 'upstream request failed: ' + e.message);
      }
    } else {
      return sendBuffered(res, upstream.statusCode, upstream.headers, errBuf);
    }
  }

  streamResponse(res, upstream);
}

function makeServer(cfg) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch((e) => {
      sendErrorJson(res, 500, 'handler error: ' + (e && e.message));
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch { /* ignore */ }
  });
  server.cfg = cfg;
  return server;
}

function pidPath() {
  return path.join(config.stateDir(), 'server.pid');
}

function writePidfile() {
  fs.mkdirSync(config.stateDir(), { recursive: true });
  fs.writeFileSync(pidPath(), String(process.pid));
  process.on('exit', () => {
    try {
      if (fs.readFileSync(pidPath(), 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(pidPath());
      }
    } catch { /* already gone */ }
  });
}

function main(argv) {
  let port = null;
  const args = argv || process.argv.slice(2);
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) port = Number(args[idx + 1]);

  const cfg = config.loadConfig();
  if (port == null) port = cfg.port;

  const server = makeServer(cfg);
  server.listen(port, '127.0.0.1', () => {
    writePidfile();
    process.stderr.write(
      `cc-model-router ${VERSION} listening on 127.0.0.1:${port} -> ` +
      `${cfg.upstream_scheme || 'https'}://${cfg.upstream_host} ` +
      `(sentinel='${cfg.sentinel}' low=${cfg.models.low} ` +
      `mid=${cfg.models.mid} high=${cfg.models.high})\n`);
    if (cfg._user_config_error) {
      process.stderr.write(
        `WARNING ignoring broken user config: ${cfg._user_config_error}\n`);
    }
  });
  server.on('error', (e) => {
    process.stderr.write(`cc-model-router: failed to bind port ${port}: ${e.message}\n`);
    process.exit(1);
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

module.exports = {
  VERSION,
  makeServer,
  pidPath,
  main,
  // exported for tests
  modelUnavailable,
};

if (require.main === module) {
  main();
}
