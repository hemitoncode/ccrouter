#!/usr/bin/env node
'use strict';

// Classifier accuracy gate: runs the labeled prompt suite and prints a
// confusion matrix. Exits non-zero below the threshold (default 0.90).

const fs = require('fs');
const path = require('path');

const classifier = require('../src/classifier');
const config = require('../src/config');

const TIERS = ['low', 'mid', 'high'];

function parseArgs(argv) {
  const args = { threshold: 0.90, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold') args.threshold = Number(argv[++i]);
    else if (argv[i] === '--verbose') args.verbose = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = config.loadConfig(path.join('/nonexistent-ccrouter', 'config.json'));
  cfg.classifier.api_key = null; // heuristics only, always offline

  const cases = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));

  const matrix = {};
  for (const e of TIERS) { matrix[e] = { low: 0, mid: 0, high: 0 }; }
  const misses = [];

  for (const c of cases) {
    const [tier, score, signals] = classifier.classify(c.text, cfg);
    matrix[c.expect][tier] += 1;
    if (tier !== c.expect) misses.push({ c, tier, score, signals });
    else if (args.verbose) {
      console.log(`ok   ${tier.padEnd(4)} ${score >= 0 ? '+' : ''}${score}  ${c.text.slice(0, 70)}`);
    }
  }

  const correct = TIERS.reduce((n, t) => n + matrix[t][t], 0);
  const total = cases.length;
  const accuracy = correct / total;

  console.log('\nconfusion matrix (rows=expected, cols=predicted)');
  console.log(`${''.padStart(8)} ${TIERS.map((t) => t.padStart(6)).join('')}`);
  for (const e of TIERS) {
    console.log(`${e.padStart(8)} ${TIERS.map((a) => String(matrix[e][a]).padStart(6)).join('')}`);
  }
  console.log(`\naccuracy: ${correct}/${total} = ${(accuracy * 100).toFixed(1)}% ` +
    `(threshold ${(args.threshold * 100).toFixed(0)}%)`);

  if (misses.length) {
    console.log('\nmisses:');
    for (const { c, tier, score, signals } of misses) {
      console.log(`  expected ${c.expect.padEnd(4)} got ${tier.padEnd(4)} ` +
        `(${score >= 0 ? '+' : ''}${score}) ${c.text.slice(0, 70)}`);
      console.log(`           signals: ${signals.join(', ')}`);
    }
  }

  process.exit(accuracy >= args.threshold ? 0 : 1);
}

main();
