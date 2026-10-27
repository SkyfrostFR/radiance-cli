# Publishing

`radiance publish` posts a finished version of a video to one or more of the user's connected accounts.

```sh
radiance call list-accounts --json            # account ids, platform, status, target languages
radiance publish <video_id> --lang es --account <id> --yes
radiance publish <video_id> --lang es --account <id> --at 2026-11-01T09:00:00Z --yes   # scheduled, UTC
radiance publish <video_id> --original --account <id1> --account <id2> --yes          # untranslated version
```

- Before running it, tell the user exactly what will go out (video title, language, account name and platform,
  now or the date) and get their yes. A publication is public and in their name.
- The language must be finished: check with `radiance status <video_id>` first.
- Options: `--caption`, `--hashtags a,b`, `--privacy <level>` (required for TikTok), `--ai-generated` /
  `--no-ai-generated` (on by default for a voiced version; the user may turn it off), and any other input of the
  tool with `--arg key=value` (see `radiance tools schedule-publication`).
- An account whose status is not active (expired, revoked) cannot publish: the user reconnects it in the browser
  at https://radiance-app.com. Do not retry.
- What the call cost, if anything, is printed after it.
- Some platforms refuse a post for their own reasons (format, account settings); the error says which. Pass the
  reason on rather than guessing.
