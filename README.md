# cc-model-router

Per-prompt model routing for Claude Code. A tiny localhost reverse proxy
(Python 3 stdlib, zero dependencies) sits between Claude Code and
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

## Quick start

```sh
# from this repo
bin/ccrouter code            # ← use this instead of `claude`
```

`ccrouter code` starts the proxy if needed, then launches Claude Code with
`ANTHROPIC_BASE_URL=http://127.0.0.1:4747` and `--model auto`. All other
arguments pass straight through (`bin/ccrouter code -p "hi"`,
`bin/ccrouter code --continue`, …).

Optional alias:

```sh
alias ccc='~/orca/projects/cc-model-router/bin/ccrouter code'
```

Nothing global is modified — plain `claude` keeps working exactly as
before. Uninstalling is `bin/ccrouter stop` plus not using the wrapper.

## Watching it work

```sh
bin/ccrouter tail                          # live decision feed
bin/ccrouter test "why does this deadlock?"  # offline dry-run of any prompt
bin/ccrouter status                        # proxy state + recent decisions
bin/ccrouter doctor                        # environment / health checks
```

`tail` output, one line per routed request:

```
19:42:07  LOW  claude-haiku-4-5   -5  heuristic  [low_verb:what is, short, question]
19:43:11  HIGH claude-opus-4-6    +4  heuristic  [debugging:deadlock, debugging:why does]
19:44:02  HIGH claude-opus-4-6    +4  continuation  [debugging:deadlock, ...]
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
5. **Fail-open:** any routing error → MID. If the upstream rejects a routed
   model (400/404 naming the model), the request is retried once at MID.

Every knob — models, sentinel, port, keyword lists, weights, cutoffs — is
config. Copy any subset of `config.default.json` into
`~/.cc-model-router/config.json`; it deep-merges over the defaults.
Restart the proxy (`bin/ccrouter stop && bin/ccrouter start`) to apply.

```jsonc
// ~/.cc-model-router/config.json — example override
{ "models": { "high": "claude-opus-4-8" } }
```

### Optional LLM tie-break

For prompts whose score lands near a cutoff, the router can ask Haiku for a
second opinion (~300ms, ~$0.0001). This requires an **API key** in
`~/.cc-model-router/config.json` under `classifier.api_key` — the proxy
never reuses your subscription's OAuth token for calls it makes itself.
Without a key (the default) routing is pure heuristics with zero added
latency.

## Privacy & safety

- Binds `127.0.0.1` only.
- Modifies only the `model` field of sentinel requests — system prompts,
  messages, and headers are untouched (which also preserves prompt caching).
- Decision log (`~/.cc-model-router/decisions.jsonl`) stores signals and
  scores, not prompt text (set `log.redact: false` to include an 80-char
  head). Credentials are never written anywhere.

## Development

```sh
python3 -m unittest discover tests   # unit tests (incl. proxy vs mock upstream)
python3 eval/run.py                  # classifier accuracy gate (≥90%)
```

State lives in `~/.cc-model-router/` (`config.json`, `decisions.jsonl`,
`server.log`, `server.pid`). `CCROUTER_HOME` overrides it (tests do this).
