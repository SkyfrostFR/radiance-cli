---
name: radiance
description: Translate, subtitle, dub and publish videos with Radiance (radiance-app.com) through the `radiance` CLI. Use when the user wants a video translated or dubbed, wants to check a translation's progress, download translated files, publish to their connected social accounts, or check their Radiance token balance.
---

# Radiance CLI

`radiance` is a thin command-line client of Radiance's MCP server. Every server tool can be called from it, and
one-command workflows cover the common path: upload, translate, wait, download, publish.

## Setup

Requires Node.js 20+.

```sh
npm i -g @radiance-app/cli        # or prefix every command with: npx @radiance-app/cli
radiance whoami                   # works? you are logged in; exit 4? log in first
```

Logging in needs an API token with the `mcp:use` ability, created by the user at
https://radiance-app.com/settings/api-tokens. Never invent or ask to paste a token into the chat log; let the
user run the login themselves, or use a token already in the environment:

```sh
echo "$TOKEN" | radiance login --token-stdin   # no terminal: verified with a real call, then saved (0600)
```

Token priority: `--token`, then `RADIANCE_TOKEN`, then the saved config. Prefer `RADIANCE_TOKEN` over `--token`
(visible in process lists).

## The one rule: estimate first, then `--yes`

Anything that may spend tokens or publish needs the user's agreement. Off a terminal (your case), a write without
`--yes` exits **3** and calls nothing. So:

1. Run with `--estimate` (translations) to get the exact price. Nothing is spent.
2. Show the user the price and what will happen, and get an explicit yes.
3. Only then re-run the same command with `--yes`.

Never pass `--yes` to a spending or publishing command the user has not approved in this conversation. Exit 3 is
not an error to work around: it means "ask the user".

## Typical workflows

Always add `--json` when you parse the output: one JSON line per step on stdout, a final `result` or `error` event.

**Translate a local file**

```sh
radiance translate clip.mp4 --to es,de --mode subtitles_only --estimate --json   # uploads, prints video_id + price
# user agrees
radiance translate <video_id> --to es,de --mode subtitles_only --yes --download ./out --json
```

Re-use the `video_id` from the estimate step: passing the file again would upload it a second time.

**Follow, download, resume**

```sh
radiance status <video_id>                          # languages, status, progress
radiance status <video_id> --wait --timeout 120     # poll until done or failed
radiance download <video_id> --lang es --download ./out
```

`--download` on `translate` implies `--wait`. If the wait times out (exit 1, `timeout`), the renders keep going:
resume with `status --wait`. Downloading never overwrites a file silently; ask before `--force`.

**Publish** (public, in the user's name: confirm title, language, account and date first)

```sh
radiance call list-accounts --json
radiance publish <video_id> --lang es --account <id> --at 2026-11-01T09:00:00Z --yes
```

See `references/publishing.md` for options and pitfalls.

**Balance and account**: `radiance whoami` (token balance, connected accounts, plan).

**Anything else**: discover and call the server's tools directly.

```sh
radiance tools                         # name, title, read or write
radiance tools start-translation       # description and input schema
radiance call list-videos --arg limit=5 --json
```

`--arg key=value` is repeatable (value parsed as JSON when valid); `--input '<json>'` or `--input -` (stdin)
gives the whole arguments object. Read tools run directly; write tools follow the estimate/`--yes` rule.

## Choosing a mode

`--mode` is required for `translate`. Short version, cheapest first:

| User asks for | Mode |
|---|---|
| subtitles, or nothing about a voice | `subtitles_only` |
| a voice, not necessarily theirs | `voice_over` |
| "in my voice", dubbing | `dubbing_fish`, `dubbing_local` or `dubbing` (ask, or show two estimates) |
| best quality, keep emotion | `dubbing_premium` (about 5x `dubbing`; explicit yes) |

The server is the authority on modes and prices: `radiance tools start-translation` lists today's modes, and
`--estimate` gives the price for this video. Lip-sync is web-app only. Details and what to tell the user:
`references/modes.md`.

Languages: up to 10 per call, 2-letter codes (`es`, `de`, `pt`). A language already done or in progress is skipped
and not charged again.

## Exit codes

Branch on these, and read the `error [code]: message` on stderr (or `error.code` in `--json`).

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected/network error, `timeout`, `file_exists`, `upload_failed` | Read the message; `status --wait` to resume a timeout |
| 2 | Bad usage (flag, JSON, unknown tool) | Fix the command; check `radiance tools <name>` |
| 3 | Confirmation required, nothing called | Ask the user, then `--yes` |
| 4 | Not authenticated / token refused | User logs in again |
| 5 | Insufficient tokens | Tell the user the amount missing; nothing was charged |
| 6 | Not found or not theirs | Check the id (`radiance call list-videos`) |
| 7 | Not ready / precondition failed | Wait (just uploaded) or read the reason |
| 8 | Rate limited (already retried once) | Wait a minute |
| 9 | Platform or account problem, or a failed render | User fixes the connection in the browser; failed renders are refunded |

Per-code guidance: `references/errors.md`.

## MCP bridge

If the agent host speaks MCP over stdio, `radiance mcp` exposes every Radiance tool directly, with the live tool
list and the remote's own errors:

```json
{ "mcpServers": { "radiance": { "command": "npx", "args": ["-y", "@radiance-app/cli", "mcp"],
  "env": { "RADIANCE_TOKEN": "your-token" } } } }
```

Through the bridge there is no `--yes`: the host's tool-approval prompt is the confirmation. The same rule
applies: estimate (`estimate_only`) first, spend only after the user agrees.

## What the CLI does not do

- It does not choose for the user: no automatic mode, language or account picking when the user did not say.
- It does not spend or publish without `--yes` (or a terminal prompt).
- No lip-sync, no editing of transcripts or subtitles, no account connection: those happen in the web app at
  https://radiance-app.com.
- No refunds or restores: a failed language is refunded automatically; a completed render the user dislikes is
  not; an upload expired after 90 days must be uploaded again.
- It does not cache anything or work offline: every command is a live call to the server.
- It never prints the token, and never stores a token the server refused.
