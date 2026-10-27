# Translation modes

`--mode` takes one of these ids, cheapest first. The server is the authority: `radiance tools start-translation`
lists the modes it accepts today, and `--estimate` gives the exact price for this video before anything is spent.
Prices are in tokens per minute of video per language, as of October 2026; quote the estimate, not this table.

| Mode | What the viewer gets | Tokens/min/language |
|---|---|---|
| `subtitles_only` | The original audio, with translated subtitles burned in. | 6 |
| `voice_over` | A synthetic voice from a catalogue reads the translation over the video. Not the speaker's own voice. | 45 |
| `dubbing_fish` | The speaker's voice, cloned, speaks the translation; background music and room sound are kept. | 50 |
| `dubbing_local` | The same promise (cloned voice, background kept), rendered on Radiance's own GPU servers. | 60 |
| `dubbing` | AI dubbing in the speaker's cloned voice. | 100 |
| `dubbing_premium` | Premium Translation: the speaker's emotion and delivery carried into the new language, paced against the video. Audio only, the mouth is not re-animated. Needs an account that has paid once. | 485 |

## How to pick

- The user said "subtitles", or did not mention a voice: `subtitles_only`.
- "Dub it", "in my voice": one of the cloned-voice modes. If the user has no preference, ask, and show the
  estimates of two candidates side by side rather than picking the dearest.
- "Best quality", "keep my emotion": `dubbing_premium`, after the estimate and an explicit yes; it costs about
  five times `dubbing`.
- Lip-sync (mouth re-animated) is not available from the CLI: it is chosen in the web app.

## Things to tell the user when relevant

- Each mode renders on exactly one engine. If that engine is down, the language fails and its tokens come back
  in full; Radiance never switches to another mode on its own. The user may retry later or choose another mode
  at that mode's own price.
- A failed render is often retried automatically (after 1 and 10 minutes): `status --wait` keeps waiting while a
  retry is scheduled. Do not tell the user to retry by hand during that time.
- Tokens are charged when the translation starts. A language that fails is refunded in full; a completed render
  the user simply dislikes is not refunded.
- A language already translated or in progress for the video is skipped and not charged again.
- Up to 10 languages per call, as 2-letter codes (`es`, `de`, `pt`...). A language that is the video's own is
  refused.
