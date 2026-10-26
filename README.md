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
| `radiance mcp` | Local stdio MCP server relaying to Radiance (see below) |

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

### One-command workflows

```sh
radiance upload clip.mp4                                   # prints the video_id
radiance translate clip.mp4 --to es,en --mode subtitles_only --estimate   # price only, nothing spent
radiance translate clip.mp4 --to es,en --mode subtitles_only --yes --download ./out
radiance status <video_id> --wait
radiance download <video_id> --lang es --download ./out
radiance publish <video_id> --lang es --account <platform_account_id> --at 2026-11-01T09:00:00Z --yes
```

| Command | Notes |
|---|---|
| `upload <file>` | Checks the extension (mp4, mov, avi, webm) locally, calls `create-video-upload`, streams the bytes with one `PUT` (never the whole file in memory; a progress bar on a terminal), then `confirm-video-upload`. A failed `PUT` is retried once, then exit 1 without confirming. The size ceiling is enforced by the server and relayed as is. |
| `translate <file or video_id> --to es,en --mode <mode>` | Uploads a file first, asks the server for the price (`start-translation` with `estimate_only`), prints it, then asks your agreement (terminal prompt, or `--yes`; off a terminal without `--yes`: exit 3, nothing is spent, and the `video_id` is printed so you can re-run). `--estimate` stops at the price (exit 0; with a file it still uploads, the price needs the measured duration). Modes are the server's: a wrong one is refused by the server. `--subtitle-style`, `--title`, `--arg k=v` and `--input` are passed to the tool. |
| `--wait` (`translate`, `status`) | Polls `video-translation-status` every 5 s, growing to 30 s, printing phase, percent and minutes left. Stops when each language is completed or failed (a failed render that Radiance will retry on its own is still waited for). `--timeout <min>` (default 60) exits 1 when exceeded; the renders keep going. A failed language exits 9 and prints its reason. |
| `--download <dir>` (`translate`, `download`) | Implies `--wait` on `translate`. Saves `<title>-<lang>.<ext>` with every character forbidden in file names removed, through a `.part` file renamed at the end. An existing file is never overwritten silently: exit 1 unless `--force`. |
| `status <video_id>` | Languages, status, progress. |
| `download <video_id> [--lang es]` | Completed translations only (all of them without `--lang`); exit 7 if a requested language is not finished, 6 if it does not exist. Directory: `--download <dir>` (default `.`). |
| `publish <video_id> --account <id>... [--lang es or --original] [--at <ISO date>]` | One account and one translation use `schedule-publication`; several accounts, or the original, use `publish-to-more-accounts`. Also `--caption`, `--hashtags a,b`, `--privacy <level>` (required for TikTok), `--ai-generated` / `--no-ai-generated`, `--arg`. Needs your agreement like any write. The tokens the tool reports (`tokens_spent`, reposts) are printed after the call: the server announces them in its answer, there is no quote step for publishing. |

With `--json`, every step is one JSON line on stdout, so an agent can follow without parsing prose:

```json
{"event":"progress","step":"upload","bytes":52428800,"total":104857600,"percent":50}
{"event":"progress","step":"wait","message":"es: processing transcribing 40% ~3 min left","language":"es","status":"processing","progress":{"phase":"transcribing","percent":40,"remainingSeconds":150}}
{"event":"result","video_id":"...","files":["out/My Clip-es.mp4"]}
```

Steps: `upload`, `confirm`, `wait`, `estimate`, `translate`, `download`, `publish`. A failure is a final `{"event":"error","error":{"code","message","exit_code"}}` line. Exit code 1 also covers `file_exists`, `timeout` and `upload_failed`.

### Write tools need your agreement

A tool that is not annotated read-only may spend tokens or publish. On a terminal the CLI asks `[y/N]` before calling. Off a terminal it refuses with exit code 3 and calls nothing, unless you pass `--yes`.

## Use Radiance as a local MCP server (`radiance mcp`)

For MCP clients that only start local commands (stdio) or cannot send an `Authorization` header, `radiance mcp` runs a bridge: it relays `tools/list`, `tools/call`, `resources/*` and `prompts/*` to the remote Radiance server with your token, and answers with exactly what the remote answered (names, schemas, annotations, errors). Nothing is cached, so the tool list is always the live one, and `list_changed` notifications from the remote are forwarded. stdout carries JSON-RPC only; logs go to stderr.

Give it a token with `radiance login` once, or set `RADIANCE_TOKEN` in the client's configuration. Without a token the server still starts: `tools/list` is empty and every call returns "run `radiance login` or set `RADIANCE_TOKEN`". A token saved with `radiance login` while the bridge is running is picked up on the next request.

Copy-paste configuration (replace the token with one from <https://radiance-app.com/settings/api-tokens>):

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "radiance": {
      "command": "npx",
      "args": ["-y", "@radiance-app/cli", "mcp"],
      "env": { "RADIANCE_TOKEN": "your-token" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`): same `mcpServers` block as above.

**VS Code** (`.vscode/mcp.json`; note `servers`, and `type`):

```json
{
  "servers": {
    "radiance": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@radiance-app/cli", "mcp"],
      "env": { "RADIANCE_TOKEN": "your-token" }
    }
  }
}
```

**Cline** (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "radiance": {
      "command": "npx",
      "args": ["-y", "@radiance-app/cli", "mcp"],
      "env": { "RADIANCE_TOKEN": "your-token" },
      "disabled": false
    }
  }
}
```

Write tools (publishing, translation, uploads) are relayed as is: the confirmation is your MCP client's tool-approval prompt, not the CLI's `--yes`.

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
