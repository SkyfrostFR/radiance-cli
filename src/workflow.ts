import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Command } from 'commander';
import { RadianceApi, resultText } from './client.js';
import { CliError, ExitCode } from './errors.js';
import {
  type Context,
  buildCallArguments,
  callTool,
  confirmAction,
  connectOptions,
  parseJsonObject,
  requireToken,
  toolFailure,
} from './shared.js';
import { type LocalVideo, downloadFile, inspectVideoFile, putFile, safeFileName, targetPath } from './transfer.js';

type Json = Record<string, unknown>;
type ActionFactory = <A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<void> | void) => (...args: A) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_START_MS = 5_000;
const POLL_MAX_MS = 30_000;
const UPLOAD_RETRY_MS = 2_000;
const NOT_READY_RETRIES = 8;
const NOT_READY_WAIT_MS = 5_000;

// ---------------------------------------------------------------- reporting

/**
 * Human progress goes to stderr; with --json every step is one JSON line on stdout
 * (`{"event":"progress",...}`, and a final `{"event":"result",...}`), so an agent can follow
 * along without parsing prose.
 */
class Reporter {
  private lastPercent = -1;

  constructor(private readonly ctx: Context) {}

  step(step: string, message: string, data: Json = {}): void {
    if (this.ctx.options.json) {
      this.ctx.out.out(JSON.stringify({ event: 'progress', step, message, ...data }));
    } else {
      this.endBar();
      this.ctx.out.err(message);
    }
  }

  /** A byte counter: a live bar on a terminal, throttled JSON lines with --json, silence otherwise. */
  bar(step: string, label: string, current: number, total: number | undefined): void {
    const percent = total ? Math.floor((current / total) * 100) : -1;
    if (this.ctx.options.json) {
      if (percent >= this.lastPercent + 10 || (total !== undefined && current === total)) {
        this.lastPercent = percent;
        this.ctx.out.out(JSON.stringify({ event: 'progress', step, bytes: current, total: total ?? null, percent: percent < 0 ? null : percent }));
      }
      return;
    }
    if (this.ctx.io.stderrIsTTY && percent !== this.lastPercent) {
      this.lastPercent = percent;
      const width = 24;
      const filled = percent < 0 ? 0 : Math.round((percent / 100) * width);
      this.ctx.io.stderr(`\r${label} [${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${percent < 0 ? '' : `${percent}%`}   `);
    }
  }

  endBar(): void {
    if (this.lastPercent >= 0 && !this.ctx.options.json && this.ctx.io.stderrIsTTY) {
      this.ctx.io.stderr('\n');
    }
    this.lastPercent = -1;
  }

  result(data: Json, humanLines: string[]): void {
    this.endBar();
    if (this.ctx.options.json) {
      this.ctx.out.out(JSON.stringify({ event: 'result', ...data }));
    } else {
      for (const line of humanLines) {
        this.ctx.out.out(line);
      }
    }
  }
}

// ---------------------------------------------------------------- tool helpers

async function toolJson(api: RadianceApi, name: string, args: Json): Promise<Json> {
  const result = await api.run((client) => callTool(client, name, args));
  if (result.isError) {
    throw toolFailure(result);
  }
  const text = resultText(result);
  try {
    return parseJsonObject(text, `${name} answer`);
  } catch {
    throw new CliError('bad_response', `${name} did not answer with a JSON object.`, ExitCode.Unexpected);
  }
}

/** Metadata extraction runs right after an upload: `not_ready` means "ask again in a few seconds". */
async function untilReady<T>(ctx: Context, rep: Reporter, what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'not_ready' || attempt >= NOT_READY_RETRIES) {
        throw error;
      }
      rep.step('wait', `${what}: not ready yet, retrying in ${NOT_READY_WAIT_MS / 1000}s...`);
      await ctx.io.sleep(NOT_READY_WAIT_MS);
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value !== '');
}

function minutes(seconds: unknown): string {
  return typeof seconds === 'number' && seconds >= 0 ? `~${Math.max(1, Math.ceil(seconds / 60))} min left` : '';
}

async function withApi(ctx: Context, fn: (api: RadianceApi, rep: Reporter) => Promise<void>): Promise<void> {
  const api = new RadianceApi(connectOptions(ctx, requireToken(ctx)));
  try {
    await fn(api, new Reporter(ctx));
  } finally {
    await api.close();
  }
}

// ---------------------------------------------------------------- upload

async function uploadVideo(ctx: Context, api: RadianceApi, rep: Reporter, file: LocalVideo, title?: string): Promise<Json> {
  const created = await toolJson(api, 'create-video-upload', {
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.size,
  });
  const url = str(created.upload_url);
  const key = str(created.upload_key);
  if (url === '' || key === '') {
    throw new CliError('bad_response', 'create-video-upload did not return an upload URL.', ExitCode.Unexpected);
  }
  rep.step('upload', `Uploading ${file.filename} (${file.size} bytes)...`, { file: file.filename, bytes: file.size });

  let lastError = '';
  let uploaded = false;
  for (let attempt = 0; attempt < 2 && !uploaded; attempt++) {
    if (attempt > 0) {
      rep.step('upload', `Upload failed (${lastError}); retrying once...`, { retry: true });
      await ctx.io.sleep(UPLOAD_RETRY_MS);
    }
    try {
      await putFile(file, url, (sent) => rep.bar('upload', 'Uploading', sent, file.size));
      uploaded = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!uploaded) {
    throw new CliError('upload_failed', `The upload failed twice (${lastError}). The video was not confirmed; nothing was created.`, ExitCode.Unexpected);
  }
  rep.endBar();

  const confirmArgs: Json = { upload_key: key, ...(title ? { title } : {}) };
  const confirmed = await untilReady(ctx, rep, 'confirm-video-upload', () => toolJson(api, 'confirm-video-upload', confirmArgs));
  rep.step('confirm', `Uploaded: video_id ${str(confirmed.video_id)}`, { video_id: confirmed.video_id });
  return confirmed;
}

// ---------------------------------------------------------------- status / wait

interface Row {
  id: string;
  language: string;
  status: string;
  mode: string;
  error: string | null;
  raw: Json;
}

function rowsOf(status: Json): Row[] {
  const items = Array.isArray(status.translated_videos) ? (status.translated_videos as Json[]) : [];
  return items.map((raw) => ({
    id: str(raw.id),
    language: str(raw.target_language).toLowerCase(),
    status: str(raw.status),
    mode: str(raw.requested_mode),
    error: typeof raw.error_message === 'string' && raw.error_message !== '' ? raw.error_message : null,
    raw,
  }));
}

function classify(ctx: Context, row: Row): 'done' | 'failed' | 'running' {
  if (row.status === 'completed') {
    return 'done';
  }
  if (row.status === 'cancelled') {
    return 'failed';
  }
  if (row.status === 'failed') {
    // Radiance retries a failed render on its own while next_retry_at is in the future.
    const next = typeof row.raw.next_retry_at === 'string' ? Date.parse(row.raw.next_retry_at) : NaN;
    return Number.isFinite(next) && next > ctx.io.now() ? 'running' : 'failed';
  }
  return 'running';
}

function describe(row: Row): string {
  const progress = row.raw.progress as { phase?: string | null; percent?: number; remainingSeconds?: number | null } | null | undefined;
  if (progress) {
    const parts = [progress.phase ?? '', typeof progress.percent === 'number' ? `${progress.percent}%` : '', minutes(progress.remainingSeconds)];
    return `${row.language}: ${row.status} ${parts.filter(Boolean).join(' ')}`.trim();
  }
  return `${row.language}: ${row.status}${row.error ? ` (${row.error})` : ''}`;
}

async function waitForTranslations(
  ctx: Context,
  api: RadianceApi,
  rep: Reporter,
  videoId: string,
  languages: string[],
  timeoutMinutes: number,
): Promise<{ rows: Row[]; status: Json }> {
  const deadline = ctx.io.now() + timeoutMinutes * 60_000;
  let delay = POLL_START_MS;
  for (;;) {
    const status = await toolJson(api, 'video-translation-status', { video_id: videoId });
    const all = rowsOf(status);
    const rows = languages.length > 0 ? all.filter((row) => languages.includes(row.language)) : all;
    for (const row of rows) {
      rep.step('wait', describe(row), { video_id: videoId, language: row.language, status: row.status, progress: row.raw.progress ?? null });
    }
    const missing = languages.filter((language) => !rows.some((row) => row.language === language));
    if (missing.length === 0 && rows.every((row) => classify(ctx, row) !== 'running')) {
      return { rows, status };
    }
    if (ctx.io.now() >= deadline) {
      throw new CliError(
        'timeout',
        `Gave up after ${timeoutMinutes} min; the renders keep going on Radiance. Resume with \`radiance status ${videoId} --wait\`.`,
        ExitCode.Unexpected,
      );
    }
    await ctx.io.sleep(delay);
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
  }
}

function failureOf(ctx: Context, rows: Row[]): CliError | undefined {
  const failed = rows.filter((row) => classify(ctx, row) === 'failed');
  if (failed.length === 0) {
    return undefined;
  }
  const detail = failed.map((row) => `${row.language}: ${row.error ?? row.status}`).join('; ');
  return new CliError('translation_failed', `${failed.length} language(s) did not complete: ${detail}`, ExitCode.Platform);
}

// ---------------------------------------------------------------- download

async function downloadRows(ctx: Context, api: RadianceApi, rep: Reporter, rows: Row[], directory: string, force: boolean): Promise<string[]> {
  const files: string[] = [];
  for (const row of rows.filter((candidate) => candidate.status === 'completed')) {
    const link = await untilReady(ctx, rep, 'download-translated-video', () => toolJson(api, 'download-translated-video', { translated_video_id: row.id }));
    const suggested = str(link.filename);
    const name = safeFileName(str(link.title) || suggested.replace(/\.[^.]*$/, ''), str(link.target_language) || row.language, extname(suggested).slice(1));
    const path = targetPath(directory, name, force);
    rep.step('download', `Downloading ${name}...`, { language: row.language, file: path });
    try {
      await downloadFile(str(link.download_url), path, (received, total) => rep.bar('download', 'Downloading', received, total));
    } catch (error) {
      throw new CliError('download_failed', `Could not download ${name}: ${error instanceof Error ? error.message : String(error)}`, ExitCode.Unexpected);
    }
    rep.endBar();
    files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------- commands

interface TranslateOptions {
  to: string;
  mode: string;
  estimate?: boolean;
  wait?: boolean;
  download?: string;
  force?: boolean;
  timeout: string;
  subtitleStyle?: string;
  title?: string;
  arg?: string[];
  input?: string;
}

function parseTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError('usage', '--timeout must be a positive number of minutes.', ExitCode.Usage);
  }
  return value;
}

async function translate(ctx: Context, target: string, opts: TranslateOptions): Promise<void> {
  const languages = list([opts.to]).map((language) => language.toLowerCase());
  if (languages.length === 0) {
    throw new CliError('usage', '--to needs at least one language code, e.g. --to es,en.', ExitCode.Usage);
  }
  const timeout = parseTimeout(opts.timeout);
  const extra = await buildCallArguments(ctx, opts.input, opts.arg ?? []);
  const isFile = existsSync(target) && statSync(target).isFile();
  if (!isFile && !UUID.test(target)) {
    throw new CliError('usage', `"${target}" is neither an existing file nor a video_id.`, ExitCode.Usage);
  }
  const file = isFile ? await inspectVideoFile(target) : undefined;
  const wantWait = Boolean(opts.wait || opts.download !== undefined);

  await withApi(ctx, async (api, rep) => {
    let videoId = target;
    if (file) {
      videoId = str((await uploadVideo(ctx, api, rep, file, opts.title)).video_id);
    }
    const args: Json = {
      ...extra,
      ...(opts.subtitleStyle ? { subtitle_style: opts.subtitleStyle } : {}),
      video_id: videoId,
      languages,
      mode: opts.mode,
    };

    const estimate = await untilReady(ctx, rep, 'start-translation', () => toolJson(api, 'start-translation', { ...args, estimate_only: true }));
    const perLanguage = estimate.cost_per_language as Record<string, number> | undefined;
    const detail = perLanguage ? ` (${Object.entries(perLanguage).map(([language, cost]) => `${language}: ${cost}`).join(', ')})` : '';
    rep.step('estimate', `Estimate: ${String(estimate.total_cost)} tokens for ${list(estimate.languages as string[] | undefined).join(', ')}${detail}; balance ${String(estimate.token_balance)}.`, {
      video_id: videoId,
      estimate,
    });
    if (opts.estimate) {
      rep.result({ video_id: videoId, estimate }, [`video_id: ${videoId}`, `Total: ${String(estimate.total_cost)} tokens (nothing was spent)`]);
      return;
    }

    try {
      await confirmAction(ctx, 'start-translation', `Spend ${String(estimate.total_cost)} tokens to translate ${videoId} into ${languages.join(', ')} (${opts.mode}).`);
    } catch (error) {
      if (error instanceof CliError && error.code === 'confirmation_required' && !ctx.options.json) {
        ctx.out.err(`video_id: ${videoId} (use it to re-run with --yes; nothing was spent)`);
      }
      throw error;
    }
    const started = await toolJson(api, 'start-translation', args);
    rep.step('translate', `Queued ${list(started.languages_queued as string[] | undefined).join(', ')}; ${String(started.tokens_charged)} tokens charged.`, { video_id: videoId, started });

    let files: string[] = [];
    let rows: Row[] = [];
    let failure: CliError | undefined;
    if (wantWait) {
      ({ rows } = await waitForTranslations(ctx, api, rep, videoId, languages, timeout));
      failure = failureOf(ctx, rows);
      if (opts.download !== undefined) {
        files = await downloadRows(ctx, api, rep, rows, opts.download, Boolean(opts.force));
      }
    }
    rep.result({ video_id: videoId, started, translations: rows.map((row) => row.raw), files }, [
      `video_id: ${videoId}`,
      `Tokens charged: ${String(started.tokens_charged)}`,
      ...rows.map(describe),
      ...files.map((file) => `Saved: ${file}`),
    ]);
    if (failure) {
      throw failure;
    }
  });
}

async function status(ctx: Context, videoId: string, opts: { wait?: boolean; timeout: string }): Promise<void> {
  const timeout = parseTimeout(opts.timeout);
  await withApi(ctx, async (api, rep) => {
    let current: Json;
    let rows: Row[];
    if (opts.wait) {
      ({ rows, status: current } = await waitForTranslations(ctx, api, rep, videoId, [], timeout));
    } else {
      current = await toolJson(api, 'video-translation-status', { video_id: videoId });
      rows = rowsOf(current);
    }
    rep.result({ video_id: videoId, ...current }, rows.length > 0 ? rows.map(describe) : ['No translations yet.']);
    const failure = opts.wait ? failureOf(ctx, rows) : undefined;
    if (failure) {
      throw failure;
    }
  });
}

async function download(ctx: Context, videoId: string, opts: { lang?: string[]; download?: string; force?: boolean }): Promise<void> {
  const wanted = list(opts.lang).map((language) => language.toLowerCase());
  await withApi(ctx, async (api, rep) => {
    const rows = rowsOf(await toolJson(api, 'video-translation-status', { video_id: videoId })).filter(
      (row) => wanted.length === 0 || wanted.includes(row.language),
    );
    const missing = wanted.filter((language) => !rows.some((row) => row.language === language));
    if (missing.length > 0) {
      throw new CliError('not_found', `No translation in ${missing.join(', ')} on this video.`, ExitCode.NotFound);
    }
    const pending = rows.filter((row) => row.status !== 'completed');
    if (pending.length > 0 && wanted.length > 0) {
      throw new CliError('not_ready', `Not finished yet: ${pending.map(describe).join('; ')}.`, ExitCode.NotReady);
    }
    if (!rows.some((row) => row.status === 'completed')) {
      throw new CliError('not_ready', 'No completed translation to download yet.', ExitCode.NotReady);
    }
    const files = await downloadRows(ctx, api, rep, rows, opts.download ?? '.', Boolean(opts.force));
    rep.result({ video_id: videoId, files }, files.map((file) => `Saved: ${file}`));
  });
}

interface PublishOptions {
  account?: string[];
  lang?: string;
  original?: boolean;
  at?: string;
  caption?: string;
  hashtags?: string;
  privacy?: string;
  aiGenerated?: boolean;
  arg?: string[];
  input?: string;
}

async function publish(ctx: Context, videoId: string, opts: PublishOptions): Promise<void> {
  const accounts = list(opts.account);
  if (accounts.length === 0) {
    throw new CliError('usage', '--account <platform_account_id> is required (see `radiance call list-accounts`).', ExitCode.Usage);
  }
  if (opts.original && opts.lang) {
    throw new CliError('usage', 'Use either --lang or --original, not both.', ExitCode.Usage);
  }
  let scheduledAt: string | undefined;
  if (opts.at !== undefined) {
    const when = new Date(opts.at);
    if (Number.isNaN(when.getTime())) {
      throw new CliError('usage', `--at expects an ISO date such as 2026-11-01T09:00:00Z, got "${opts.at}".`, ExitCode.Usage);
    }
    scheduledAt = when.toISOString();
  }
  const extra = await buildCallArguments(ctx, opts.input, opts.arg ?? []);
  const shared: Json = {
    ...extra,
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
    ...(opts.hashtags !== undefined ? { hashtags: list([opts.hashtags]).map((tag) => tag.replace(/^#/, '')) } : {}),
    ...(opts.privacy ? { privacy_level: opts.privacy } : {}),
    ...(opts.aiGenerated !== undefined ? { ai_generated_content: opts.aiGenerated } : {}),
  };

  await withApi(ctx, async (api, rep) => {
    let version = 'original';
    let label = 'the original';
    if (!opts.original) {
      const rows = rowsOf(await toolJson(api, 'video-translation-status', { video_id: videoId }));
      const done = rows.filter((row) => row.status === 'completed');
      const chosen = opts.lang ? done.find((row) => row.language === opts.lang?.toLowerCase()) : done.length === 1 ? done[0] : undefined;
      if (!chosen) {
        const known = done.map((row) => row.language).join(', ') || 'none';
        throw new CliError(
          opts.lang ? 'precondition_failed' : 'usage',
          opts.lang ? `No completed ${opts.lang} translation (completed: ${known}).` : `Pass --lang (completed: ${known}) or --original.`,
          opts.lang ? ExitCode.NotReady : ExitCode.Usage,
        );
      }
      version = chosen.id;
      label = `the ${chosen.language} version`;
    }

    const tool = version !== 'original' && accounts.length === 1 ? 'schedule-publication' : 'publish-to-more-accounts';
    const args: Json =
      tool === 'schedule-publication'
        ? { ...shared, translated_video_id: version, platform_account_id: accounts[0] }
        : { ...shared, video_id: videoId, version, platform_account_ids: accounts };

    await confirmAction(
      ctx,
      tool,
      `Publish ${label} of ${videoId} to ${accounts.length} account(s)${scheduledAt ? ` at ${scheduledAt}` : ' now'}. The post goes live on the platform.`,
    );
    rep.step('publish', `Publishing via ${tool}...`, { tool, version });
    const published = await toolJson(api, tool, args);
    const cost = typeof published.tokens_spent === 'number' ? published.tokens_spent : undefined;
    rep.result({ tool, ...published }, [
      scheduledAt ? `Scheduled for ${scheduledAt}.` : 'Published.',
      ...(cost !== undefined ? [`Tokens spent: ${cost}`] : []),
      JSON.stringify(published, null, 2),
    ]);
  });
}

export function registerWorkflowCommands(program: Command, action: ActionFactory): void {
  const collect = (value: string, previous: string[]): string[] => [...previous, value];

  program
    .command('upload <file>')
    .description('upload a video file (streamed) and print its video_id')
    .option('--title <title>', 'video title (default: the stored file name)')
    .action(
      action((ctx, file: string, opts: { title?: string }) =>
        withApi(ctx, async (api, rep) => {
          const local = await inspectVideoFile(file);
          const confirmed = await uploadVideo(ctx, api, rep, local, opts.title);
          rep.result({ ...confirmed }, [`video_id: ${str(confirmed.video_id)}`]);
        }),
      ),
    );

  program
    .command('translate <file|video_id>')
    .description('upload if needed, show the price, ask for your agreement, translate (optionally wait and download)')
    .requiredOption('--to <languages>', 'target languages, comma separated (es,en)')
    .requiredOption('--mode <mode>', 'render mode (see `radiance tools start-translation`)')
    .option('--estimate', 'stop at the price; nothing is spent')
    .option('--wait', 'wait until every language is completed or failed')
    .option('--download <dir>', 'download the finished files into <dir> (implies --wait)')
    .option('--force', 'overwrite existing files when downloading')
    .option('--timeout <minutes>', 'give up waiting after this many minutes', '60')
    .option('--subtitle-style <style>', 'subtitle style, passed to the tool as subtitle_style')
    .option('--title <title>', 'title for an uploaded file')
    .option('-a, --arg <key=value>', 'extra tool argument; repeatable', collect, [] as string[])
    .option('-i, --input <json|->', 'extra tool arguments as a JSON object, or - for stdin')
    .action(action((ctx, target: string, opts: TranslateOptions) => translate(ctx, target, opts)));

  program
    .command('status <video_id>')
    .description('show the translation state of a video')
    .option('--wait', 'poll until every language is completed or failed')
    .option('--timeout <minutes>', 'give up waiting after this many minutes', '60')
    .action(action((ctx, videoId: string, opts: { wait?: boolean; timeout: string }) => status(ctx, videoId, opts)));

  program
    .command('download <video_id>')
    .description('download completed translations (all, or --lang)')
    .option('-l, --lang <codes>', 'language(s), comma separated or repeated', collect, [] as string[])
    .option('--download <dir>', 'target directory', '.')
    .option('--force', 'overwrite existing files')
    .action(action((ctx, videoId: string, opts: { lang?: string[]; download?: string; force?: boolean }) => download(ctx, videoId, opts)));

  program
    .command('publish <video_id>')
    .description('publish or schedule a version of a video to connected accounts (needs agreement)')
    .option('--account <id>', 'platform account id; repeatable', collect, [] as string[])
    .option('-l, --lang <code>', 'which translation to publish')
    .option('--original', 'publish the untranslated original')
    .option('--at <date>', 'ISO date/time to schedule; default: now')
    .option('--caption <text>', 'post caption')
    .option('--hashtags <list>', 'comma-separated hashtags')
    .option('--privacy <level>', 'privacy level (required for TikTok)')
    .option('--ai-generated', 'declare AI-generated content')
    .option('--no-ai-generated', 'publish without the AI-content declaration')
    .option('-a, --arg <key=value>', 'extra tool argument; repeatable', collect, [] as string[])
    .option('-i, --input <json|->', 'extra tool arguments as a JSON object, or - for stdin')
    .action(action((ctx, videoId: string, opts: PublishOptions) => publish(ctx, videoId, opts)));
}
