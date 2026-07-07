'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const classifier = require('../src/classifier');
const config = require('../src/config');

const NO_CONFIG = path.join('/nonexistent-ccrouter', 'config.json');

function cfg() {
  const c = config.loadConfig(NO_CONFIG);
  c.classifier.api_key = null;
  return c;
}

function checkTier(text, expected) {
  const [tier, score, signals] = classifier.classify(text, cfg());
  assert.strictEqual(tier, expected,
    `${JSON.stringify(text)} -> ${tier} (score ${score}, signals ${signals}), ` +
    `expected ${expected}`);
}

test('LOW prompts', () => {
  checkTier('rename utils.py to helpers.py and update the imports', 'low');
  checkTier('what does curl -u do?', 'low');
  checkTier('delete the dist folder', 'low');
  checkTier('explain briefly what this repo does', 'low');
});

test('MID prompts', () => {
  checkTier('write a unit test for parse_config', 'mid');
  checkTier('fix the off-by-one in paginate()', 'mid');
  checkTier('write a function that deduplicates a list while preserving order', 'mid');
  checkTier('add pagination to the /users endpoint', 'mid');
});

test('HIGH prompts', () => {
  checkTier('why does the app deadlock when two workers write to the queue?', 'high');
  checkTier('design a caching layer for our API client, then implement it end-to-end with tests', 'high');
  checkTier('refactor auth across the codebase to use the new session store', 'high');
});

test('empty prompt defaults to MID', () => {
  const [tier, , signals] = classifier.classify('   ', cfg());
  assert.strictEqual(tier, 'mid');
  assert.ok(signals.includes('empty'));
});

test('strips injected reminders and command output', () => {
  const text =
    '<system-reminder>Plan mode is active.</system-reminder>' +
    'real question here' +
    '<local-command-stdout>noise</local-command-stdout>';
  assert.strictEqual(classifier.stripInjected(text), 'real question here');
});

test('continuation hops to previous real message', () => {
  const messages = [
    { role: 'user', content: 'design a distributed cache system' },
    { role: 'assistant', content: 'plan...' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'user', content: 'ok do it' },
  ];
  const [text, hops] = classifier.pickMessage(messages, cfg());
  assert.strictEqual(text, 'design a distributed cache system');
  assert.strictEqual(hops, 1);
  const [tier] = classifier.classify(text, cfg());
  assert.strictEqual(tier, 'high');
});

test('all-continuations falls back to newest', () => {
  const messages = [
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: '?' },
    { role: 'user', content: 'yes' },
  ];
  const [text, hops] = classifier.pickMessage(messages, cfg());
  assert.strictEqual(text, 'yes');
  assert.strictEqual(hops, 0);
});

test('no messages', () => {
  const [text] = classifier.pickMessage([], cfg());
  assert.strictEqual(text, '');
});

test('skips injected-only turns', () => {
  const messages = [
    { role: 'user', content: 'why is the build failing intermittently?' },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>meta</system-reminder>' }] },
  ];
  const [text] = classifier.pickMessage(messages, cfg());
  assert.strictEqual(text, 'why is the build failing intermittently?');
});

test('continuation detection: known phrases', () => {
  const c = cfg();
  for (const phrase of ['yes', 'ok', 'go ahead', 'do it', 'sounds good', '1']) {
    assert.ok(classifier.isContinuation(phrase, c), phrase);
  }
});

test('continuation detection: two words or less', () => {
  assert.ok(classifier.isContinuation('fix it', cfg()));
});

test('continuation detection: real prompts are not continuations', () => {
  const c = cfg();
  assert.ok(!classifier.isContinuation('rename utils.py to helpers.py', c));
  assert.ok(!classifier.isContinuation('what does curl -u do?', c));
});
