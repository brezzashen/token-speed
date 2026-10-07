# Token Speed

A small local dashboard that measures model output speed (token/s) from the
conversation records that Claude Code and Codex already write on your machine.
It never calls a model provider and never sends conversation text anywhere.

To let a coding agent install it for you, paste the prompt in [AGENT_SETUP.md](AGENT_SETUP.md).

## Run

Requires Node 22.18+ and Bun for the browser build.

```sh
npm install
npm run build
npm start            # http://127.0.0.1:8047
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOKEN_SPEED_PROFILES` | `claude:claude:~/.claude,codex:codex:~/.codex` | Comma-separated `name:agent:home` profiles; `agent` is `claude` or `codex`. |
| `TOKEN_HOST` | `127.0.0.1` | Listen address. |
| `TOKEN_PORT` | `8047` | Listen port. |

The default profile homes follow `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when they are set.
Several accounts can be watched at once, for example
`TOKEN_SPEED_PROFILES=work:claude:~/.claude-work,home:codex:~/.codex-home`.

## Endpoints

- `GET /` serves the dashboard.
- `GET /api/speed` returns the aggregate readings.
- `GET /health` reports the last collection time.

## How speed is calculated

`task-watch.ts` finds conversations updated within 24 hours.
It tails new records every 2 seconds and discovers new files every 16 seconds.

`task-output.ts` turns records into private generation segments:

- **Codex text**: visible `AgentMessage` text is tokenized with `o200k_base`.
  The segment uses the explicit item start and end times.
- **Codex reasoning**: the token count is the response's `usage.reasoning_output_tokens`.
  The time is the union of the timed `Reasoning` items in the same turn.
  Hidden reasoning text is never used to estimate a token count.
- **Claude**: one segment per response. Tokens are `usage.output_tokens`.
  Time runs from the leading thinking block start (record time minus `thinkingDurationMs`)
  to the response's last block record. Claude Code stretches thinking time over text
  generation, so thinking and text cannot be timed apart. Responses without a timed
  leading thinking block are excluded.
- Tool wait time and user-to-reply time are not counted.
- Missing counts or timing make a segment unavailable, never zero.
- Codex sessions are limited to the signed-in ChatGPT account when `auth.json` names one.

`dialog-speed.ts` keeps accounts, models and modes (Standard / Fast) separate.
It computes overlapping 1, 3, 5 and 24-hour windows from the same capture time:

```
speed = sum(eligible segment tokens) / sum(eligible segment durations)
```

It never averages individual token/s values. A segment must start and finish inside
its window; cross-boundary segments are excluded. Segments shorter than 250 ms are excluded.
Concurrent conversations each contribute their own durations.

Mode comes from recorded service-tier settings. A requested mode is configuration,
not proof of the served tier. Unknown modes stay unknown.

## Privacy

The API returns only aggregates: model, account name, mode, token totals, durations,
rates and counts. It contains no conversation text, file paths, message IDs or
conversation IDs. The server binds to `127.0.0.1` by default; put it behind your
own reverse proxy and access control before exposing it.

## Test

```sh
npm test
```

The tests cover weighted averaging, window boundaries, expiry, account and mode
isolation, reasoning arithmetic, deduplication, missing timing, UTF-8 split reads,
stale rendering and privacy of the public output.

## License

MIT
