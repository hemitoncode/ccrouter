'use strict';

// Preset routing rules that run before the heuristic classifier.

const PLAN_MODE_MARKER = 'plan mode is active';

// Only Messages API bodies carry a model to rewrite.
function isRoutablePath(path) {
  const clean = path.split('?', 1)[0].replace(/\/+$/, '');
  return clean === '/v1/messages' || clean === '/v1/messages/count_tokens';
}

function isSentinel(body, cfg) {
  return body.model === cfg.sentinel;
}

// Extended thinking as a complexity signal. Claude Code may send
// `thinking: adaptive` routinely for capable models, so by default only the
// explicit legacy `enabled` (budgeted) form forces HIGH. Configurable:
// rules.thinking_forces_high = enabled_only|any|off.
function thinkingRule(body, cfg) {
  const mode = cfg.rules.thinking_forces_high || 'enabled_only';
  if (mode === 'off') return null;
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== 'object') return null;
  const ttype = thinking.type;
  if (mode === 'any' && (ttype === 'enabled' || ttype === 'adaptive')) return 'high';
  if (mode === 'enabled_only' && ttype === 'enabled') return 'high';
  return null;
}

// Plan mode = design work -> HIGH. Detected via the harness reminder inside
// the newest user turn only (older turns may predate a mode exit).
function planModeRule(rawLastUserTexts, cfg) {
  if (cfg.rules.plan_mode_high === false) return null;
  for (const raw of rawLastUserTexts) {
    if (raw.toLowerCase().includes(PLAN_MODE_MARKER)) return 'high';
  }
  return null;
}

// If subagent routing is disabled, pin subagent requests to MID (the sentinel
// is not a real model, so passthrough isn't an option).
function subagentFixedTier(headers, cfg) {
  const agentId = headers['x-claude-code-agent-id'];
  if (agentId && cfg.rules.route_subagents === false) return 'mid';
  return null;
}

function estimatedTokens(rawBodyLen) {
  return Math.floor(rawBodyLen / 4);
}

module.exports = {
  PLAN_MODE_MARKER,
  isRoutablePath,
  isSentinel,
  thinkingRule,
  planModeRule,
  subagentFixedTier,
  estimatedTokens,
};
