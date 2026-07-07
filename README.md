# ccrouter

Per-prompt model routing for Claude Code. A tiny localhost reverse proxy
(Node.js, **zero dependencies**) sits between Claude Code and
`api.anthropic.com`, classifies each prompt with preset rules plus a
lightweight heuristic classifier, and rewrites the request's `model` field:

| Tier | Default model       | Examples                                                        |
|------|---------------------|-----------------------------------------------------------------|
| LOW  | `claude-haiku-4-5`  | quick info questions, renames/moves/deletes, formatting, typos  |
| MID  | `claude-sonnet-4-6` | ordinary coding: write a function, fix a bug, add a test        |
| HIGH | `claude-opus-4-6`   | architecture/design, debugging & diagnosis, multi-file refactors, building whole features, perf/security |

Only requests whose model is the sentinel **`auto`** are routed. Anything
you pick explicitly (`/model opus`, pinned subagent models, Claude Code's
own Haiku utility calls) passes through byte-identical. Headers — including
your subscription's OAuth `Authorization` and `anthropic-beta` — are
forwarded verbatim and never logged.

## Install

Requires Node.js ≥ 18 and the `claude` CLI on your PATH.

```sh
npm install -g ccrouter
```

That puts a global `ccrouter` command on your PATH. Then, instead of
`claude`, run:

```sh
ccrouter code            # a normal Claude Code session, auto-routed per prompt
```

`ccrouter code` starts the proxy if it isn't already running, then launches
Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:4747` and
`--model auto`. All other arguments pass straight through
(`ccrouter code -p "hi"`, `ccrouter code --continue`, …). Nothing global in
Claude Code is modified — plain `claude` keeps working exactly as before,
and `ccrouter stop` shuts the proxy down.

### Install from source (or before publishing)

```sh
git clone https://github.com/hemitpatel/ccrouter && cd ccrouter
npm link                 # registers the global `ccrouter` command from your checkout
```

## Watching it work

```sh
ccrouter tail                          # live decision feed
ccrouter test "why does this deadlock?"  # offline dry-run of any prompt
ccrouter status                        # proxy state + recent decisions
ccrouter doctor                        # environment / health checks
```

`tail` output, one line per routed request:

```
19:42:07  LOW  claude-haiku-4-5    -5  heuristic  [low_verb:what is, short, question]
19:43:11  HIGH claude-opus-4-6     +6  heuristic  [debugging:why does, debugging:deadlock]
19:44:02  HIGH claude-opus-4-6     +6  continuation  [debugging:deadlock, ...]
```

## How routing decides

1. **Preset rules** (first match wins): explicit non-sentinel model →
   passthrough · legacy `thinking: enabled` → HIGH · plan mode active →
   HIGH · subagent requests classified on their own prompt.
2. **Message pick:** the last real user message; short follow-ups
   ("ok", "do it", "continue") inherit the thread's tier by classifying the
   previous real message — this also avoids cache-thrashing model flips
   mid-thread.
3. **Heuristic score:** LOW verbs, brevity and pure questions push down;
   architecture/debugging/perf/security/build vocabulary, tracebacks,
   multi-step structure, cross-file scope and length push up.
   `score ≤ −3 → LOW`, `≥ +4 → HIGH`, else MID.
4. **Long-context floor:** huge conversations (> ~120k est. tokens) never
   drop below MID.
5. **Param fixups:** Claude Code shapes effort/thinking for the model *you*
   selected — which behind the router is the sentinel. So after rewriting
   the model, the proxy adapts those params to the target model's
   capabilities (`model_params` in config): unsupported effort levels are
   capped or dropped (e.g. `xhigh → high` on Sonnet/Opus 4.6), and thinking
   plus its dependent `context_management` edits are stripped for Haiku.
   Every fixup is visible in the decision log.
6. **Fail-open:** any routing error → MID. If the upstream reports the
   routed model isn't available, the request is retried once at MID;
   unrelated errors surface untouched.

## Configuration

Every knob — models, sentinel, port, keyword lists, weights, cutoffs — is
config. Copy any subset of the bundled `config.default.json` into
`~/.cc-model-router/config.json`; it deep-merges over the defaults. A broken
or mistyped config is ignored (defaults are used) and flagged by
`ccrouter doctor`. Restart the proxy to apply
(`ccrouter stop && ccrouter start`).

```jsonc
// ~/.cc-model-router/config.json — example: use Opus 4.8 for the HIGH tier
{ "models": { "high": "claude-opus-4-8" } }
```

### Optional LLM tie-break

For prompts whose score lands near a cutoff, the router can ask Haiku for a
second opinion (~300ms). This requires an **API key** in
`~/.cc-model-router/config.json` under `classifier.api_key` — the proxy
never reuses your subscription's OAuth token for calls it makes itself.
Without a key (the default) routing is pure heuristics with zero added
latency.

## Privacy & safety

- Binds `127.0.0.1` only.
- Rewrites the `model` field of sentinel requests and adapts model-specific
  params (effort / thinking / dependent context-management edits) to the
  routed model — your prompts, messages, and headers are never touched
  (which also preserves prompt caching).
- Decision log (`~/.cc-model-router/decisions.jsonl`) stores signals and
  scores, not prompt text (set `log.redact: false` to include an 80-char
  head). Credentials are never written anywhere.

## Development

```sh
npm test                 # unit tests (node:test — incl. proxy vs mock upstream)
npm run eval             # classifier accuracy gate (≥90%)
```

State lives in `~/.cc-model-router/` (`config.json`, `decisions.jsonl`,
`server.log`, `server.pid`). `CCROUTER_HOME` overrides it (tests do this).

## Publishing to npm

```sh
npm pack --dry-run       # inspect exactly what will be published
npm publish              # (npm login first; if the name "ccrouter" is taken,
                         #  set a scoped name like "@yourname/ccrouter" in
                         #  package.json — the command stays `ccrouter`)
```
