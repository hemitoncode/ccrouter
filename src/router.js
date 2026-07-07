'use strict';

// Decision pipeline: preset rules -> message pick -> heuristic -> model.

const classifier = require('./classifier');
const config = require('./config');
const rules = require('./rules');

class Decision {
  constructor(tier, model, rule, opts = {}) {
    this.tier = tier;
    this.model = model;
    this.rule = rule;
    this.score = opts.score || 0;
    this.signals = opts.signals || [];
    this.hops = opts.hops || 0;
    this.pickedText = opts.pickedText || '';
    this.ms = opts.ms || 0;
  }

  asDict() {
    return {
      tier: this.tier,
      model: this.model,
      rule: this.rule,
      score: this.score,
      signals: this.signals,
      hops: this.hops,
    };
  }
}

// Return a Decision for sentinel requests, or null for passthrough. Never
// throws: any internal error fails open to the MID tier (the sentinel is not
// a real model, so a routed request must get *some* rewrite).
async function decide(path, headers, body, rawBodyLen, cfg) {
  const started = Date.now();
  if (!rules.isRoutablePath(path) || body === null || typeof body !== 'object' ||
      Array.isArray(body)) {
    return null;
  }
  if (!rules.isSentinel(body, cfg)) return null;

  let decision;
  try {
    decision = await decideTier(headers, body, rawBodyLen, cfg);
  } catch (err) {
    decision = new Decision('mid', cfg.models.mid, 'fail_open', {
      signals: [`error:${err && err.name ? err.name : 'Error'}`],
    });
  }
  decision.ms = Math.round((Date.now() - started) * 100) / 100;
  return decision;
}

async function decideTier(headers, body, rawBodyLen, cfg) {
  const models = cfg.models;

  const fixed = rules.subagentFixedTier(headers, cfg);
  if (fixed) return new Decision(fixed, models[fixed], 'subagent_fixed');

  let tier = rules.thinkingRule(body, cfg);
  if (tier) return new Decision(tier, models[tier], 'thinking');

  const [text, hops, rawLast] = classifier.pickMessage(body.messages, cfg);

  tier = rules.planModeRule(rawLast, cfg);
  if (tier) {
    return new Decision(tier, models[tier], 'plan_mode', { hops, pickedText: text });
  }

  let score, signals;
  [tier, score, signals] = await classifier.classifyAsync(text, cfg);
  let rule = hops === 0 ? 'heuristic' : 'continuation';
  if (signals.some((s) => s.startsWith('llm:'))) rule = 'llm_tiebreak';

  // Very large contexts deserve at least the MID model.
  if (rules.estimatedTokens(rawBodyLen) > cfg.rules.long_context_tokens) {
    const floored = config.maxTier(tier, 'mid');
    if (floored !== tier) {
      signals.push('long_context_floor');
      tier = floored;
    }
  }

  return new Decision(tier, models[tier], rule, {
    score, signals, hops, pickedText: text,
  });
}

// Adapt request params to the routed model's capabilities.
//
// Claude Code shapes params (effort level, thinking) for the model the *user*
// selected — behind the router that's the sentinel, so the session settings
// pass through unchecked. Fix what the target model would 400 on: unsupported
// effort levels are capped/stripped, thinking is stripped for models without
// it (plus dependent context-management edits). Unknown models are untouched.
function applyParamFixups(body, model, cfg) {
  const fixups = [];
  try {
    const params = (cfg.model_params || {})[model];
    if (!params) return fixups;

    const outputConfig = body.output_config;
    if (outputConfig && typeof outputConfig === 'object' && 'effort' in outputConfig) {
      const effort = outputConfig.effort;
      const allowed = params.allowed_efforts || [];
      if (!allowed.includes(effort)) {
        if (allowed.length && params.effort_fallback) {
          outputConfig.effort = params.effort_fallback;
          fixups.push(`effort:${effort}->${outputConfig.effort}`);
        } else {
          delete outputConfig.effort;
          fixups.push(`effort:${effort}->dropped`);
        }
        if (Object.keys(outputConfig).length === 0) delete body.output_config;
      }
    }

    if (params.allow_thinking === false && 'thinking' in body) {
      delete body.thinking;
      fixups.push('thinking:dropped');
      // Cascade: context-management strategies that require thinking
      // (clear_thinking_*) 400 once thinking is gone.
      const cm = body.context_management;
      if (cm && typeof cm === 'object' && Array.isArray(cm.edits)) {
        const kept = cm.edits.filter(
          (edit) => !(edit && typeof edit === 'object' &&
            String(edit.type || '').startsWith('clear_thinking')));
        if (kept.length !== cm.edits.length) {
          fixups.push('clear_thinking_edit:dropped');
          if (kept.length) cm.edits = kept;
          else delete body.context_management;
        }
      }
    }
  } catch {
    return fixups;
  }
  return fixups;
}

module.exports = { Decision, decide, applyParamFixups };
