'use strict';

// ccrouter CLI: launch Claude Code through the router and manage the proxy.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const config = require('./config');
const router = require('./router');
const { VERSION, pidPath } = require('./server');

const SERVER_ENTRY = path.join(__dirname, 'server.js');

const USAGE = `\
ccrouter ${VERSION} — per-prompt model router for Claude Code

usage: ccrouter <command> [args]

  code [claude args...]   start proxy if needed, launch claude through it
  start                   start the proxy in the background
  stop                    stop the proxy
  status                  show proxy status and recent decisions
  test "<prompt>"         dry-run: show how a prompt would be routed (offline)
  tail                    follow the decision log live
  doctor                  run environment/health checks
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(message) {
  process.stderr.write('ccrouter: ' + message + '\n');
  process.exit(1);
}

function modelsStr(cfg) {
  const m = cfg.models;
  return `${m.low} | ${m.mid} | ${m.high}`;
}

function serverLogPath() {
  return path.join(config.stateDir(), 'server.log');
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function tailFile(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

// --------------------------------------------------------------------------
// proxy lifecycle
// --------------------------------------------------------------------------

function health(port, timeout = 500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/__ccrouter/health', timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readPid() {
  try { return parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10) || null; }
  catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

function isCcrouterProcess(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 5000 });
    return out.includes('server.js') && out.toLowerCase().includes('node');
  } catch {
    return false;
  }
}

async function ensureRunning(cfg) {
  const port = cfg.port;
  let info = await health(port);
  if (info) return info;

  const pid = readPid();
  if (pid && !pidAlive(pid)) {
    try { fs.unlinkSync(pidPath()); } catch { /* ignore */ }
  }
  if (await portBusy(port)) {
    die(`port ${port} is in use but does not answer the ccrouter health check.\n` +
      `  Something else is listening there — change "port" in ${config.userConfigPath()}`);
  }

  fs.mkdirSync(config.stateDir(), { recursive: true });
  const out = fs.openSync(serverLogPath(), 'a');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
    cwd: config.stateDir(),
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(100);
    info = await health(port);
    if (info) return info;
  }
  die('proxy did not become healthy within 3s. Last server log lines:\n' +
    tailFile(serverLogPath(), 10));
}

async function cmdStart(cfg) {
  const info = await ensureRunning(cfg);
  console.log(`proxy running (pid ${info.pid}) on 127.0.0.1:${cfg.port}  ` +
    `models=${modelsStr(cfg)}`);
  return 0;
}

async function cmdStop(cfg) {
  const info = await health(cfg.port);
  const pid = info ? info.pid : readPid();
  if (!pid || !pidAlive(pid)) {
    console.log('proxy not running');
    return 0;
  }
  if (!info && !isCcrouterProcess(pid)) {
    // Stale pidfile whose pid was recycled by an unrelated process — never
    // signal it.
    try { fs.unlinkSync(pidPath()); } catch { /* ignore */ }
    console.log('proxy not running (removed stale pidfile)');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30; i++) {
    if (!pidAlive(pid)) { console.log('proxy stopped'); return 0; }
    await sleep(100);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  console.log('proxy killed');
  return 0;
}

async function cmdStatus(cfg) {
  const info = await health(cfg.port);
  if (info) {
    console.log(`proxy: running (pid ${info.pid}) on 127.0.0.1:${cfg.port}`);
    console.log(`routing: '${cfg.sentinel}' -> ${modelsStr(cfg)}`);
    if (info.user_config_error) {
      console.log(`WARNING broken user config ignored: ${info.user_config_error}`);
    }
  } else {
    console.log('proxy: not running (start with: ccrouter start)');
  }
  console.log(`state dir: ${config.stateDir()}`);
  const log = path.join(config.stateDir(), 'decisions.jsonl');
  if (fs.existsSync(log)) {
    console.log('recent decisions:');
    for (const line of tailFile(log, 3).split('\n')) {
      const rendered = renderDecision(line);
      if (rendered) console.log('  ' + rendered);
    }
  }
  return 0;
}

// --------------------------------------------------------------------------
// code (the wrapper)
// --------------------------------------------------------------------------

async function cmdCode(cfg, args) {
  if (!which('claude')) die('`claude` not found on PATH');
  await ensureRunning(cfg);
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port}` };
  const argv = [];
  const hasModel = args.some((a) => a === '--model' || a.startsWith('--model='));
  if (!hasModel) argv.push('--model', cfg.sentinel);
  argv.push(...args);
  process.stderr.write(
    `[ccrouter] routing '${cfg.sentinel}' -> ${modelsStr(cfg)} ` +
    `via 127.0.0.1:${cfg.port}\n`);
  return new Promise((resolve) => {
    const child = spawn('claude', argv, { stdio: 'inherit', env });
    child.on('exit', (code, signal) => {
      if (signal) { process.kill(process.pid, signal); }
      else resolve(code == null ? 0 : code);
    });
    child.on('error', (e) => die('failed to launch claude: ' + e.message));
  });
}

// --------------------------------------------------------------------------
// test / tail / doctor
// --------------------------------------------------------------------------

async function cmdTest(cfg, args) {
  if (!args.length) die('usage: ccrouter test "<prompt>"');
  const prompt = args.join(' ');
  const body = {
    model: cfg.sentinel,
    messages: [{ role: 'user', content: prompt }],
  };
  const rawLen = JSON.stringify(body).length;
  const decision = await router.decide('/v1/messages', {}, body, rawLen, cfg);
  console.log(`prompt : ${prompt.length <= 100 ? prompt : prompt.slice(0, 97) + '...'}`);
  console.log(`tier   : ${decision.tier.toUpperCase()}`);
  console.log(`model  : ${decision.model}`);
  console.log(`score  : ${decision.score >= 0 ? '+' : ''}${decision.score}`);
  console.log(`rule   : ${decision.rule}`);
  console.log(`signals: ${decision.signals.join(', ') || '-'}`);
  return 0;
}

function renderDecision(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const ts = (entry.ts || '').slice(-8);
  const agent = entry.agent ? ' agent' : '';
  const prompt = entry.prompt ? ' | ' + entry.prompt : '';
  const score = entry.score >= 0 ? `+${entry.score}` : `${entry.score}`;
  return `${ts}  ${(entry.tier || '?').toUpperCase().padEnd(4)} ` +
    `${(entry.model || '?').padEnd(22)} ${score}  ${entry.rule || '?'}${agent}  ` +
    `[${(entry.signals || []).slice(0, 4).join(', ')}]${prompt}`;
}

async function cmdTail(cfg) {
  const log = path.join(config.stateDir(), 'decisions.jsonl');
  fs.mkdirSync(config.stateDir(), { recursive: true });
  if (!fs.existsSync(log)) fs.writeFileSync(log, '');
  console.log(`following ${log} (Ctrl-C to quit)`);
  for (const line of tailFile(log, 10).split('\n')) {
    const rendered = renderDecision(line);
    if (rendered) console.log(rendered);
  }
  let pos = fs.statSync(log).size;
  let carry = '';
  return new Promise(() => {
    setInterval(() => {
      let size;
      try { size = fs.statSync(log).size; } catch { return; }
      if (size < pos) { pos = 0; carry = ''; } // truncated/rotated
      if (size === pos) return;
      const fd = fs.openSync(log, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      carry += buf.toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const rendered = renderDecision(line);
        if (rendered) console.log(rendered);
      }
    }, 250);
  });
}

function upstreamReachable(cfg) {
  return new Promise((resolve) => {
    const useHttps = (cfg.upstream_scheme || 'https') === 'https';
    const [host, portStr] = cfg.upstream_host.split(':');
    const lib = useHttps ? https : http;
    const req = lib.request({
      host,
      port: portStr ? Number(portStr) : (useHttps ? 443 : 80),
      method: 'HEAD',
      path: '/',
      timeout: 5000,
    }, (res) => { res.resume(); resolve(null); });
    req.on('error', (e) => resolve(e.message));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });
}

async function cmdDoctor(cfg) {
  let failures = 0;
  const check = (name, ok, hint) => {
    const mark = ok ? '[32m✓[0m' : '[31m✗[0m';
    console.log(`${mark} ${name}`);
    if (!ok) { failures += 1; if (hint) console.log(`    -> ${hint}`); }
  };

  const major = Number(process.versions.node.split('.')[0]);
  check(`node ${process.versions.node}`, major >= 18, 'needs node 18+');
  check('claude on PATH', which('claude') !== null, 'install Claude Code first');
  check('config loads', !cfg._user_config_error, cfg._user_config_error || '');
  if (cfg._user_config_loaded) console.log(`    user config: ${cfg._user_config_loaded}`);

  const info = await health(cfg.port);
  if (info) {
    check(`proxy healthy on port ${cfg.port} (pid ${info.pid})`, true);
  } else {
    const busy = await portBusy(cfg.port);
    check(`proxy not running; port ${cfg.port} ${busy ? 'IN USE' : 'free'}`,
      !busy, 'another process owns the port — change "port" in config');
  }

  const err = await upstreamReachable(cfg);
  check(`upstream ${cfg.upstream_host} reachable (TLS ok)`, err === null, err);

  console.log(`routing: '${cfg.sentinel}' -> ${modelsStr(cfg)}`);
  if (cfg.models.high === 'claude-opus-4-6') {
    console.log('note: if HIGH-tier requests 404 on your plan, the proxy retries at MID\n' +
      `      and you can set models.high to "claude-opus-4-8" in ${config.userConfigPath()}`);
  }
  return failures ? 1 : 0;
}

// --------------------------------------------------------------------------

async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (!args.length || ['-h', '--help', 'help'].includes(args[0])) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = args[0];
  const rest = args.slice(1);
  const cfg = config.loadConfig();
  switch (command) {
    case 'code': return cmdCode(cfg, rest);
    case 'start': return cmdStart(cfg);
    case 'stop': return cmdStop(cfg);
    case 'status': return cmdStatus(cfg);
    case 'test': return cmdTest(cfg, rest);
    case 'tail': return cmdTail(cfg);
    case 'doctor': return cmdDoctor(cfg);
    default:
      die(`unknown command '${command}'\n\n${USAGE}`);
  }
}

module.exports = {
  main,
  health,
  ensureRunning,
  which,
  renderDecision,
};
