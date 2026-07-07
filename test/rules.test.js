'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const router = require('../src/router');

const NO_CONFIG = path.join('/nonexistent-ccrouter', 'config.json');

function cfg(overrides) {
  const c = config.loadConfig(NO_CONFIG);
  c.classifier.api_key = null;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(c[key], value);
      } else {
        c[key] = value;
      }
    }
  }
  return c;
}

function body(prompt = 'hello there friend, please help', model = 'auto', extra) {
  return Object.assign({ model, messages: [{ role: 'user', content: prompt }] }, extra || {});
}

function decide(b, opts = {}) {
  const c = opts.cfg || cfg();
  const rawLen = opts.rawLen != null ? opts.rawLen : JSON.stringify(b).length;
  return router.decide(opts.path || '/v1/messages', opts.headers || {}, b, rawLen, c);
}

// --- passthrough ---------------------------------------------------------

test('non-sentinel model is passthrough', async () => {
  assert.strictEqual(await decide(body(undefined, 'claude-sonnet-4-6')), null);
  assert.strictEqual(await decide(body(undefined, 'claude-haiku-4-5')), null);
});

test('non-messages path is passthrough', async () => {
  assert.strictEqual(await decide(body(), { path: '/v1/complete' }), null);
  assert.strictEqual(await decide(body(), { path: '/v1/models' }), null);
});

test('count_tokens is routed', async () => {
  const d = await decide(body('rename a to b'), { path: '/v1/messages/count_tokens' });
  assert.ok(d);
  assert.strictEqual(d.tier, 'low');
});

test('query string still routed', async () => {
  assert.ok(await decide(body(), { path: '/v1/messages?beta=true' }));
});

// --- preset rules --------------------------------------------------------

test('thinking enabled forces high', async () => {
  const d = await decide(body(undefined, 'auto', { thinking: { type: 'enabled', budget_tokens: 1024 } }));
  assert.deepStrictEqual([d.tier, d.rule], ['high', 'thinking']);
});

test('thinking adaptive does not force by default', async () => {
  const d = await decide(body('rename a.py to b.py', 'auto', { thinking: { type: 'adaptive' } }));
  assert.strictEqual(d.tier, 'low');
});

test('thinking any mode', async () => {
  const c = cfg({ rules: { thinking_forces_high: 'any' } });
  const d = await decide(body(undefined, 'auto', { thinking: { type: 'adaptive' } }), { cfg: c });
  assert.strictEqual(d.tier, 'high');
});

test('plan mode forces high', async () => {
  const b = {
    model: 'auto',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'rename this file' },
        { type: 'text', text: '<system-reminder>Plan mode is active.</system-reminder>' },
      ],
    }],
  };
  const d = await decide(b);
  assert.deepStrictEqual([d.tier, d.rule], ['high', 'plan_mode']);
});

test('plan mode in older turn is ignored', async () => {
  const b = {
    model: 'auto',
    messages: [
      { role: 'user', content: 'x <system-reminder>Plan mode is active</system-reminder>' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'rename utils.py to helpers.py please' },
    ],
  };
  const d = await decide(b);
  assert.strictEqual(d.tier, 'low');
});

test('subagent fixed when routing disabled', async () => {
  const c = cfg({ rules: { route_subagents: false } });
  const d = await decide(body(), { headers: { 'x-claude-code-agent-id': 'abc' }, cfg: c });
  assert.deepStrictEqual([d.tier, d.rule], ['mid', 'subagent_fixed']);
});

test('subagent routed normally by default', async () => {
  const d = await decide(body('rename a.py to b.py now'), { headers: { 'x-claude-code-agent-id': 'abc' } });
  assert.strictEqual(d.tier, 'low');
});

test('long context floor', async () => {
  const d = await decide(body('rename a.py to b.py now'), { rawLen: 600000 });
  assert.strictEqual(d.tier, 'mid');
  assert.ok(d.signals.includes('long_context_floor'));
});

test('long context does not lower high', async () => {
  const d = await decide(body('design and implement the sync engine end-to-end'), { rawLen: 600000 });
  assert.strictEqual(d.tier, 'high');
});

// --- param fixups --------------------------------------------------------

test('haiku strips effort and thinking', () => {
  const b = { model: 'claude-haiku-4-5', output_config: { effort: 'xhigh' }, thinking: { type: 'adaptive' } };
  const fixups = router.applyParamFixups(b, 'claude-haiku-4-5', cfg());
  assert.ok(!('output_config' in b));
  assert.ok(!('thinking' in b));
  assert.ok(fixups.includes('effort:xhigh->dropped'));
  assert.ok(fixups.includes('thinking:dropped'));
});

test('opus 4.6 caps xhigh to high', () => {
  const b = { model: 'claude-opus-4-6', output_config: { effort: 'xhigh' }, thinking: { type: 'adaptive' } };
  const fixups = router.applyParamFixups(b, 'claude-opus-4-6', cfg());
  assert.strictEqual(b.output_config.effort, 'high');
  assert.deepStrictEqual(b.thinking, { type: 'adaptive' });
  assert.ok(fixups.includes('effort:xhigh->high'));
});

test('supported effort untouched', () => {
  const b = { model: 'claude-sonnet-4-6', output_config: { effort: 'low' } };
  const fixups = router.applyParamFixups(b, 'claude-sonnet-4-6', cfg());
  assert.strictEqual(b.output_config.effort, 'low');
  assert.deepStrictEqual(fixups, []);
});

test('opus 4.8 keeps xhigh', () => {
  const b = { model: 'claude-opus-4-8', output_config: { effort: 'xhigh' } };
  const fixups = router.applyParamFixups(b, 'claude-opus-4-8', cfg());
  assert.strictEqual(b.output_config.effort, 'xhigh');
  assert.deepStrictEqual(fixups, []);
});

test('unknown model untouched', () => {
  const b = { model: 'claude-future-9', output_config: { effort: 'xhigh' } };
  const fixups = router.applyParamFixups(b, 'claude-future-9', cfg());
  assert.strictEqual(b.output_config.effort, 'xhigh');
  assert.deepStrictEqual(fixups, []);
});

test('thinking strip cascades to clear_thinking edit', () => {
  const b = {
    model: 'claude-haiku-4-5',
    thinking: { type: 'adaptive' },
    context_management: { edits: [
      { type: 'clear_thinking_20251015' },
      { type: 'clear_tool_uses_20250919' },
    ] },
  };
  const fixups = router.applyParamFixups(b, 'claude-haiku-4-5', cfg());
  assert.ok(fixups.includes('clear_thinking_edit:dropped'));
  assert.deepStrictEqual(b.context_management.edits, [{ type: 'clear_tool_uses_20250919' }]);
});

test('thinking strip drops empty context_management', () => {
  const b = {
    model: 'claude-haiku-4-5',
    thinking: { type: 'adaptive' },
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
  };
  router.applyParamFixups(b, 'claude-haiku-4-5', cfg());
  assert.ok(!('context_management' in b));
});

test('other output_config keys survive', () => {
  const b = { model: 'claude-haiku-4-5', output_config: { effort: 'xhigh', format: { type: 'json_schema' } } };
  router.applyParamFixups(b, 'claude-haiku-4-5', cfg());
  assert.deepStrictEqual(b.output_config, { format: { type: 'json_schema' } });
});

// --- config robustness ---------------------------------------------------

function loadTemp(content) {
  const file = path.join(os.tmpdir(), `ccrouter-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, content);
  try { return config.loadConfig(file); } finally { fs.unlinkSync(file); }
}

test('non-object user config falls back to defaults', () => {
  const c = loadTemp('[]');
  assert.ok(c._user_config_error);
  assert.strictEqual(c.models.mid, 'claude-sonnet-4-6');
});

test('wrong-typed models falls back to defaults', () => {
  const c = loadTemp('{"models": "opus"}');
  assert.ok(c._user_config_error);
  assert.strictEqual(typeof c.models, 'object');
});

test('valid override merges', () => {
  const c = loadTemp('{"models": {"high": "claude-opus-4-8"}}');
  assert.ok(!c._user_config_error);
  assert.strictEqual(c.models.high, 'claude-opus-4-8');
  assert.strictEqual(c.models.low, 'claude-haiku-4-5');
});

// --- robustness ----------------------------------------------------------

test('messages null', async () => {
  const d = await decide({ model: 'auto', messages: null });
  assert.strictEqual(d.tier, 'mid');
});

test('messages wrong type', async () => {
  const d = await decide({ model: 'auto', messages: 'garbage' });
  assert.strictEqual(d.tier, 'mid');
});

test('decision model mapping', async () => {
  const c = cfg();
  let d = await decide(body('what is git?'), { cfg: c });
  assert.strictEqual(d.model, c.models.low);
  d = await decide(body('design a plugin system architecture end-to-end'), { cfg: c });
  assert.strictEqual(d.model, c.models.high);
});
