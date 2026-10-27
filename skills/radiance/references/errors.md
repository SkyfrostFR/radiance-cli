# Errors

Every tool error carries a stable code, printed on stderr as `error [code]: message` and in `--json` output as
`error.code`. The exit code groups them:

| Exit | Codes |
|---|---|
| 4 | `unauthenticated` |
| 5 | `insufficient_tokens` |
| 6 | `not_found`, `not_owned` |
| 7 | `not_ready`, `precondition_failed` |
| 8 | `rate_limited` |
| 9 | `account_inactive`, `permission_not_granted`, `unsupported_platform`, `messaging_window_closed`, `upstream_failed` |

Read the message: it names the cause and often the next step.

- `not_ready` right after an upload: the duration is still being measured. The CLI already retries for about 40
  seconds; if it still fails, wait a minute.
- `precondition_failed` with `source_expired`: the original upload was erased after 90 days without use. Finished
  translations stay available and publishable; translating again needs the file uploaded again. There is no
  restore.
- `precondition_failed` "already exists": every requested language is done or in progress. Nothing was charged.
- `insufficient_tokens`: the message gives the amount missing. Nothing was charged.
- `permission_not_granted` / `account_inactive`: the user must fix the connection in the browser.
- `upstream_failed`: a platform or engine failed. Tokens of a failed render come back automatically.
- Exit 1 with `timeout`: the wait expired, the renders continue; `radiance status <video_id> --wait` resumes.
- Exit 1 with `file_exists`: a file of that name is already in the download folder; ask before `--force`.
