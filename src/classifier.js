'use strict';

// Lightweight prompt classifier: low / mid / high.
//
// Pure heuristics by default (zero latency, zero cost). An optional LLM
// tie-break runs only when the heuristic score lands near a cutoff AND the
// user has configured an API key — the proxy never reuses the session's
// OAuth token for calls it mints itself.

const https = require('https');
const http = require('http');

// Harness-injected wrappers that are not the user's own words.
const INJECTED_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'task-notification',
];
const INJECTED_RE = new RegExp(
  `<(${INJECTED_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'gi'
);

const TRACEBACK_RE =
  /traceback \(most recent call last\)|\berror:|\bexception\b|\bpanic:|\bat [\w./<>$-]+:\d+|^\s*file "/im;
const NUMBERED_RE = /^\s*\d+[.)]\s/gm;
const SEQUENCE_WORDS = [' then ', 'after that', 'finally', 'afterwards', 'step 1'];
const FILE_PATH_RE =
  /(?:^|[\s"'`(])[\w~./-]*\w\.(?:py|js|jsx|ts|tsx|go|rs|java|kt|cs|c|h|cc|cpp|hpp|rb|php|swift|scala|json|ya?ml|toml|ini|cfg|md|rst|txt|sh|zsh|bash|sql|css|scss|html|vue|svelte|lock|env)\b/;

const _termRe = new Map();
function matchTerm(term, textLower) {
  if (term.startsWith('\\b')) {
    let re = _termRe.get(term);
    if (!re) {
      re = new RegExp(term);
      _termRe.set(term, re);
    }
    return re.test(textLower);
  }
  return textLower.includes(term);
}

function stripInjected(text) {
  return text.replace(INJECTED_RE, '');
}

// Return [cleanText, rawText] for a user message. rawText keeps
// harness-injected blocks (needed for plan-mode detection); cleanText is
// what gets classified. tool_result blocks never count.
function extractUserText(message) {
  const content = message.content;
  const parts = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') {
        parts.push(block.text || '');
      }
    }
  }
  const raw = parts.join('\n');
  return [stripInjected(raw).trim(), raw];
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\w\s+-]/g, '').trim();
}

const FILLERS = new Set(['ok', 'okay', 'yes', 'yep', 'yeah', 'please', 'now',
  'then', 'just', 'sure', 'and', 'also', 'lets']);

function isContinuation(text, cfg) {
  const norm = normalize(text);
  if (!norm) return true;
  const continuations = new Set(cfg.keywords.continuations);
  if (continuations.has(norm)) return true;
  const words = norm.split(/\s+/);
  if (words.length <= 2) return true;
  if (words.length <= 4) {
    // "ok do it", "yes go ahead": filler words wrapped around a
    // continuation phrase still make a continuation.
    const stripped = words.filter((w) => !FILLERS.has(w)).join(' ');
    if (!stripped || continuations.has(stripped)) return true;
  }
  return false;
}

// Pick the text to classify: the last real user message, hopping past
// continuation-style follow-ups so a thread keeps its tier. Returns
// [text, hops, rawLastUserTexts] where rawLastUserTexts[0] is the raw text
// of the newest user message (for plan-mode detection).
function pickMessage(messages, cfg) {
  const real = []; // newest-first: [clean, raw]
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (!message || typeof message !== 'object' || message.role !== 'user') continue;
    const [clean, raw] = extractUserText(message);
    if (clean) {
      real.push([clean, raw]);
    } else if (raw && real.length === 0) {
      real.push(['', raw]);
    }
  }
  const raws = real.slice(0, 1).map(([, raw]) => raw);
  const candidates = real.filter(([clean]) => clean).map(([clean]) => clean);
  if (candidates.length === 0) return ['', 0, raws];

  let hops = 0;
  for (const text of candidates.slice(0, 6)) {
    if (!isContinuation(text, cfg)) return [text, hops, raws];
    hops += 1;
  }
  // Everything looked like a continuation; classify the newest anyway.
  return [candidates[0], 0, raws];
}

// Heuristic score. Negative -> trivial, positive -> complex.
function scoreText(text, cfg) {
  const weights = cfg.weights;
  const thresholds = cfg.thresholds;
  const keywords = cfg.keywords;
  const signals = [];
  let score = 0;
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // --- HIGH signals ---
  let highPoints = 0;
  const seenTerms = new Set();
  for (const [category, terms] of Object.entries(keywords.high_terms)) {
    for (const term of terms) {
      if (seenTerms.has(term)) continue;
      if (matchTerm(term, lower)) {
        seenTerms.add(term);
        highPoints += weights.high_term;
        signals.push(`${category}:${term.replace(/\\b/g, '')}`);
      }
    }
  }
  highPoints = Math.min(highPoints, weights.high_term_cap);
  score += highPoints;

  if (TRACEBACK_RE.test(text)) {
    score += weights.traceback;
    signals.push('traceback');
  }
  const numbered = text.match(NUMBERED_RE) || [];
  const sequenceHits = SEQUENCE_WORDS.reduce(
    (n, s) => n + lower.split(s).length - 1, 0);
  if (numbered.length >= 2 || sequenceHits >= 2) {
    score += weights.multistep;
    signals.push('multistep');
  }
  for (const phrase of keywords.scope_phrases) {
    if (lower.includes(phrase)) {
      score += weights.scope;
      signals.push(`scope:${phrase}`);
      break;
    }
  }
  if (wordCount >= thresholds.very_long_words) {
    score += weights.very_long_prompt;
    signals.push('very_long');
  } else if (wordCount >= thresholds.long_words) {
    score += weights.long_prompt;
    signals.push('long');
  }
  if (text.includes('```')) {
    score += weights.code_fence;
    signals.push('code_fence');
  }
  if (FILE_PATH_RE.test(text)) {
    score += weights.file_path;
    signals.push('file_path');
  }

  const hasHighSignal = highPoints > 0 || signals.includes('traceback');

  // --- LOW signals ---
  const firstWords = words.slice(0, 3).map(normalize);
  const lowVerb = keywords.low_verbs_start.find((v) => firstWords.includes(v));
  const lowPhrase = keywords.low_phrases.find((p) => lower.includes(p));
  if (lowVerb || lowPhrase) {
    score += weights.low_verb;
    signals.push(`low_verb:${lowVerb || lowPhrase}`);
  }

  // Brevity/question penalties only matter for plain prompts; a short
  // "why does X deadlock?" is still hard.
  if (!hasHighSignal) {
    if (wordCount <= thresholds.len_short_words) {
      score += weights.len_short;
      signals.push('short');
    } else if (wordCount <= thresholds.len_medium_words) {
      score += weights.len_medium;
      signals.push('medium_len');
    }
    if (text.trimEnd().endsWith('?') && !text.includes('```') &&
        !FILE_PATH_RE.test(text)) {
      score += weights.question;
      signals.push('question');
    }
  }

  return [score, signals];
}

function tierForScore(score, cfg) {
  if (score <= cfg.cutoffs.low) return 'low';
  if (score >= cfg.cutoffs.high) return 'high';
  return 'mid';
}

function inAmbiguityBand(score, cfg) {
  const band = cfg.band != null ? cfg.band : 1;
  return Math.abs(score - cfg.cutoffs.low) <= band ||
    Math.abs(score - cfg.cutoffs.high) <= band;
}

// Synchronous classify (heuristics only). The optional LLM tie-break is
// async and lives in classifyAsync; the proxy stays synchronous in the hot
// path and only awaits when a key is configured and the score is ambiguous.
function classify(text, cfg) {
  if (!text.trim()) return ['mid', 0, ['empty']];
  const [score, signals] = scoreText(text, cfg);
  const tier = tierForScore(score, cfg);
  return [tier, score, signals];
}

const LLM_SYSTEM =
  'You classify prompts sent to a coding assistant. Reply with exactly one ' +
  'word:\nLOW - trivial: quick factual/informational questions, renames, ' +
  'moves, deletes, formatting, tiny repeatable edits.\nMID - a normal, ' +
  'self-contained coding task.\nHIGH - complex: architecture/design, ' +
  'debugging or diagnosing failures, multi-file refactors, building whole ' +
  'features/systems, performance or security work.';

// Ask a small model for the label. Uses the user's configured API key only —
// never the session's OAuth credentials. Fails soft (resolves null).
function llmTiebreak(text, cfg) {
  return new Promise((resolve) => {
    const ccfg = cfg.classifier;
    const payload = JSON.stringify({
      model: ccfg.model || 'claude-haiku-4-5',
      max_tokens: 4,
      system: LLM_SYSTEM,
      messages: [{ role: 'user', content: text.slice(0, 2000) }],
    });
    const useHttps = (cfg.upstream_scheme || 'https') === 'https';
    const [host, portStr] = cfg.upstream_host.split(':');
    const lib = useHttps ? https : http;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const req = lib.request({
      host,
      port: portStr ? Number(portStr) : (useHttps ? 443 : 80),
      method: 'POST',
      path: '/v1/messages',
      timeout: Math.round((ccfg.timeout_s || 2.5) * 1000),
      headers: {
        'x-api-key': ccfg.api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return finish(null);
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const label = (data.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text || '')
            .join('')
            .trim()
            .toUpperCase();
          finish({ LOW: 'low', MID: 'mid', HIGH: 'high' }[label] || null);
        } catch {
          finish(null);
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.write(payload);
    req.end();
  });
}

async function classifyAsync(text, cfg) {
  const [tier, score, signals] = classify(text, cfg);
  if (inAmbiguityBand(score, cfg) && cfg.classifier && cfg.classifier.api_key) {
    const llmTier = await llmTiebreak(text, cfg);
    if (llmTier) {
      signals.push(`llm:${llmTier}`);
      return [llmTier, score, signals];
    }
  }
  return [tier, score, signals];
}

module.exports = {
  stripInjected,
  extractUserText,
  isContinuation,
  pickMessage,
  scoreText,
  tierForScore,
  inAmbiguityBand,
  classify,
  classifyAsync,
  llmTiebreak,
};
