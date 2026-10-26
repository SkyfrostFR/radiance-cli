# Radiance CLI

Command-line client for [Radiance](https://radiance-app.com), the video translation and dubbing platform. It is a thin client of Radiance's MCP server (`POST https://radiance-app.com/mcp/radiance`): every tool the server exposes can be called from a terminal, a script or an AI agent, without configuring an MCP client.

## Install

Requires Node.js 20 or later.

```sh
npx @radiance-app/cli --version     # one-off
npm i -g @radiance-app/cli          # installs the `radiance` binary
```

## Log in

Create an API token at <https://radiance-app.com/settings/api-tokens> (it needs the `mcp:use` ability), then:

```sh
radiance login                              # terminal: opens the page, masked prompt
echo "$TOKEN" | radiance login --token-stdin  # no terminal (CI, agents)
```

The token is verified with a real call (`account-overview`) before it is saved; a refused token is never stored. It goes to `$XDG_CONFIG_HOME/radiance/config.json` (default `~/.config/radiance/config.json`), file mode `0600` in a `0700` directory.

Token priority: `--token`, then `RADIANCE_TOKEN`, then the config file. (`--token` is visible in process lists: prefer the variable or `login`.)

## Commands

| Command | What it does |
|---|---|
| `radiance login [--token-stdin]` | Verify and save a token |
| `radiance logout` | Delete the saved token |
| `radiance whoami` | Token balance and connected accounts |
| `radiance tools` | List tools: name, title, `read` or `write` |
| `radiance tools <name>` | Description and input schema of one tool |
| `radiance call <tool> [--arg k=v]... [--input <json\|->]` | Call a tool |

Global flags (accepted before or after the command): `--token <token>`, `--json`, `-y/--yes`, `--verbose`, `-V/--version`.

### Calling a tool

```sh
radiance call list-videos --arg limit=5
radiance call start-translation --arg video_id=... --arg target_language=fr --yes
radiance call echo --input '{"a":1}'
echo '{"a":1}' | radiance call echo --input -
```

- `--arg key=value` is repeatable. The value is parsed as JSON when valid (`3`, `true`, `[1,2]`), otherwise kept as a string.
- `--input <json>` gives the whole arguments object; `--input -` reads it from stdin. `--arg` entries override keys from `--input`.
- `--json` (global) switches the **output** to machine-readable JSON: the raw MCP result on success, `{"isError":true,"error":{"code","message","exit_code"},"result":...}` on a tool error. Nothing else is written to stdout in that mode.

> Deviation from the story text: the story used `--json '<obj>'` for call input, which collides with the global `--json` output flag. Input is `--input` here; `--json` only ever means output.

### Write tools need your agreement

A tool that is not annotated read-only may spend tokens or publish. On a terminal the CLI asks `[y/N]` before calling. Off a terminal it refuses with exit code 3 and calls nothing, unless you pass `--yes`.

## Exit codes

| Code | Meaning | Tool error codes |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected or network error | unknown codes |
| 2 | Incorrect usage (bad flag, bad JSON, unknown tool) | |
| 3 | Confirmation required (nothing was called) | |
| 4 | Not authenticated or token refused (HTTP 401) | `unauthenticated` |
| 5 | Insufficient tokens | `insufficient_tokens` |
| 6 | Not found, or not yours | `not_found`, `not_owned` |
| 7 | Not ready, or precondition not met | `not_ready`, `precondition_failed` |
| 8 | Rate limited | `rate_limited` |
| 9 | Platform or account problem | `account_inactive`, `permission_not_granted`, `unsupported_platform`, `messaging_window_closed`, `upstream_failed` |

The tool's error code is always printed on stderr (`error [not_found]: ...`) and included in the `--json` output. On HTTP 429 the CLI waits for `Retry-After` (a few seconds if absent) and retries once before exiting 8 (the server allows 60 requests per minute per user).

## Environment

| Variable | Purpose |
|---|---|
| `RADIANCE_TOKEN` | API token |
| `RADIANCE_URL` | Server URL, default `https://radiance-app.com/mcp/radiance`. Must be https (http only for localhost) |
| `XDG_CONFIG_HOME` | Where `radiance/config.json` lives |
| `NO_COLOR` | Disable colours (they are only used on a terminal anyway) |

## Security

- The token never appears in any output, error message or `--verbose` trace: every write is masked and `Authorization` is shown as `Bearer ***`.
- The token is only sent over https (or to localhost).
- Anyone who can read `~/.config/radiance/config.json` can act as you: the file is `0600`. Revoke tokens at Settings -> API tokens.
- Tools run with the quota and checks of your account, exactly as in the Radiance app.

## Development

```sh
npm ci
npm run typecheck   # strict `tsc --noEmit`; this is the project's lint
npm test            # Vitest against an in-memory fake MCP server on 127.0.0.1
npm run build       # tsc to dist/, then `node --check`
```

There is deliberately no ESLint or formatter dependency: runtime dependencies are `@modelcontextprotocol/sdk` and `commander`, dev dependencies `vitest`, `typescript` and `@types/node`. "Lint" is strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, ...) plus `node --check` on the built binary.

## Notes

- `account-overview` does not return an e-mail address, so `whoami` shows balance, connected accounts and plan only (it prints the e-mail if the server ever adds one).

## License

MIT
