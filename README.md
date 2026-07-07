# ccrouter

Per-prompt model routing for Claude Code. A tiny localhost proxy (Node.js,
zero dependencies) sits between Claude Code and the Anthropic API,
classifies each prompt, and routes it to the right model:

| Tier | Model               | Use case                                      |
|------|---------------------|------------------------------------------------|
| LOW  | `claude-haiku-4-5`  | quick questions, renames, formatting, typos     |
| MID  | `claude-sonnet-4-6` | everyday coding: write a function, fix a bug    |
| HIGH | `claude-opus-4-6`   | architecture, debugging, big refactors, perf/security |

Only requests using the `auto` model are routed. Anything you pick
explicitly (`/model opus`, pinned subagent models) passes through
untouched, and headers are always forwarded verbatim.

## Install

```sh
npm install -g @hemit99123/ccrouter
```

Then use `ccrouter code` instead of `claude`:

```sh
ccrouter code
```

This starts the proxy (if it isn't running) and launches Claude Code
through it. Plain `claude` still works exactly as before. Stop the proxy
with `ccrouter stop`.

## Useful commands

```sh
ccrouter tail                  # live feed of routing decisions
ccrouter status                # proxy state + recent decisions
ccrouter doctor                # environment / health check
ccrouter test "some prompt"    # dry-run classify a prompt, no proxy needed
```

## Configuration

Copy any part of the bundled `config.default.json` into
`~/.cc-model-router/config.json` to override models, the port, keyword
lists, or scoring weights — it deep-merges over the defaults. Restart the
proxy to apply changes (`ccrouter stop && ccrouter start`).

```jsonc
// ~/.cc-model-router/config.json — example: use Opus 4.8 for the HIGH tier
{ "models": { "high": "claude-opus-4-8" } }
```

## Privacy & safety

- Binds to `127.0.0.1` only.
- Only the `model` field (and model-specific effort/thinking params) is
  rewritten — prompts, messages, and headers are never touched.
- The decision log (`~/.cc-model-router/decisions.jsonl`) stores scores,
  not prompt text, by default.

## Development

```sh
npm test          # unit tests
npm run eval      # classifier accuracy gate
```

State lives in `~/.cc-model-router/`. `CCROUTER_HOME` overrides it.
