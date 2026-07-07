'use strict';

// Append-only JSONL decision log. Prompt text is redacted by default;
// credentials are never written.

const fs = require('fs');
const path = require('path');

const config = require('./config');

function logPath() {
  return path.join(config.stateDir(), 'decisions.jsonl');
}

function shortId(value) {
  if (!value) return null;
  return String(value).slice(-8);
}

function record(decision, headers, reqPath, cfg, extra) {
  try {
    const entry = {
      ts: new Date().toISOString().slice(0, 19),
      sid: shortId(headers['x-claude-code-session-id']),
      agent: shortId(headers['x-claude-code-agent-id']),
      path: reqPath.split('?', 1)[0],
      tier: decision.tier,
      model: decision.model,
      rule: decision.rule,
      score: decision.score,
      signals: decision.signals,
      hops: decision.hops,
      ms: decision.ms,
    };
    if (!(cfg.log && cfg.log.redact === false)) {
      // redacted (default): omit prompt text entirely
    } else {
      const head = (cfg.log && cfg.log.prompt_head_chars) || 80;
      entry.prompt = (decision.pickedText || '').slice(0, head);
    }
    if (extra) Object.assign(entry, extra);

    fs.mkdirSync(config.stateDir(), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch {
    // logging must never break proxying
  }
}

module.exports = { logPath, record };
