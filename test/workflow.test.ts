import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeServer, type FakeTool, startFakeServer } from './helpers/fake-server.js';
import { makeConfigHome, runCli } from './helpers/harness.js';
import { type StorageServer, startStorage } from './helpers/storage-server.js';
import { safeFileName } from '../src/transfer.js';

const TOKEN = 'rad_workflow_token_0123456789';
const VIDEO = '11111111-1111-4111-8111-111111111111';
const TV_ES = '22222222-2222-4222-8222-222222222222';
const TV_EN = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT_2 = '55555555-5555-4555-8555-555555555555';
const BYTES = Buffer.from('not really a video, but real bytes '.repeat(500));

type Row = Record<string, unknown>;
const json = (value: unknown) => ({ text: JSON.stringify(value) });
const processing = (language: string, id: string, percent = 40): Row => ({
  id,
  target_language: language,
  status: 'processing',
  requested_mode: 'subtitles_only',
  error_message: null,
  progress: { phase: 'transcribing', percent, remainingSeconds: 150 },
});
const completed = (language: string, id: string): Row => ({
  id,
  target_language: language,
  status: 'completed',
  requested_mode: 'subtitles_only',
  error_message: null,
  progress: null,
});

let server: FakeServer;
let storage: StorageServer;
let home: ReturnType<typeof makeConfigHome>;
let videoFile: string;
let outDir: string;

/** Scripted answers of video-translation-status; the last one repeats. */
let statusScript: Row[][];
let confirmNotReady = 0;
let estimateNotReady = 0;
let downloadTitle = 'My Clip';

function tools(): FakeTool[] {
  return [
    { name: 'account-overview', readOnly: true, handler: () => json({ token_balance: 500 }) },
    {
      name: 'create-video-upload',
      handler: (args) => json({ upload_url: `${storage.url}/up/${String(args.filename)}`, upload_key: 'uploads/1/abc/original.mp4', method: 'PUT' }),
    },
    {
      name: 'confirm-video-upload',
      handler: () =>
        confirmNotReady-- > 0
          ? { text: '[not_ready · retry, retry after 30s] No object yet. Next: retry.', isError: true }
          : json({ success: true, video_id: VIDEO, title: 'original' }),
    },
    {
      name: 'start-translation',
      handler: (args) => {
        if (args.estimate_only) {
          if (estimateNotReady-- > 0) {
            return { text: '[not_ready · retry, retry after 30s] No duration yet. Next: wait.', isError: true };
          }
          return json({ estimate_only: true, languages: args.languages, cost_per_language: { es: 60, en: 60 }, total_cost: 120, token_balance: 500 });
        }
        return json({ success: true, languages_queued: args.languages, tokens_charged: 120, token_balance: 380 });
      },
    },
    {
      name: 'video-translation-status',
      readOnly: true,
      handler: () => {
        const rows = statusScript.length > 1 ? (statusScript.shift() as Row[]) : (statusScript[0] as Row[]);
        return json({ video: { id: VIDEO }, translated_videos: rows });
      },
    },
    {
      name: 'download-translated-video',
      readOnly: true,
      handler: (args) => {
        const id = String(args.translated_video_id);
        storage.files.set(`/get/${id}`, BYTES);
        return json({ translated_video_id: id, title: downloadTitle, target_language: id === TV_ES ? 'es' : 'en', filename: 'slug-es.mp4', download_url: `${storage.url}/get/${id}` });
      },
    },
    { name: 'schedule-publication', handler: () => json({ success: true, tokens_spent: 0 }) },
    { name: 'publish-to-more-accounts', handler: () => json({ success: true, tokens_spent: 10 }) },
  ];
}

const env = (): Record<string, string> => ({ XDG_CONFIG_HOME: home.dir, RADIANCE_URL: server.url, RADIANCE_TOKEN: TOKEN });
const calls = (name: string) => server.toolCalls.filter((call) => call.name === name);

beforeEach(async () => {
  home = makeConfigHome();
  storage = await startStorage();
  server = await startFakeServer({ token: TOKEN, tools: tools() });
  videoFile = join(home.dir, 'clip.mp4');
  writeFileSync(videoFile, BYTES);
  outDir = join(home.dir, 'out');
  statusScript = [[completed('es', TV_ES), completed('en', TV_EN)]];
  confirmNotReady = 0;
  estimateNotReady = 0;
  downloadTitle = 'My Clip';
});

afterEach(async () => {
  await server.close();
  await storage.close();
  home.cleanup();
});

describe('upload', () => {
  it('streams the file with a Content-Length, confirms, and prints the video_id', async () => {
    const r = await runCli(['upload', videoFile], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`video_id: ${VIDEO}`);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.body.equals(BYTES)).toBe(true);
    expect(storage.puts[0]?.headers['content-length']).toBe(String(BYTES.length));
    expect(storage.puts[0]?.headers['content-type']).toBe('video/mp4');
    expect(storage.puts[0]?.headers.authorization).toBeUndefined();
    expect(calls('create-video-upload')[0]?.args).toMatchObject({ filename: 'clip.mp4', content_type: 'video/mp4', size_bytes: BYTES.length });
  });

  it('retries a failed PUT once, then succeeds', async () => {
    storage.failPuts = 1;
    const r = await runCli(['upload', videoFile], { env: env() });
    expect(r.code).toBe(0);
    expect(storage.puts).toHaveLength(1);
    expect(r.sleeps).toContain(2000);
    expect(calls('confirm-video-upload')).toHaveLength(1);
  });

  it('gives up after two failed PUTs with exit 1 and never confirms', async () => {
    storage.failPuts = 2;
    const r = await runCli(['upload', videoFile], { env: env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('upload_failed');
    expect(calls('confirm-video-upload')).toHaveLength(0);
  });

  it('retries a not_ready confirmation', async () => {
    confirmNotReady = 1;
    const r = await runCli(['upload', videoFile], { env: env() });
    expect(r.code).toBe(0);
    expect(calls('confirm-video-upload')).toHaveLength(2);
  });

  it('refuses an unsupported or missing file before any network call', async () => {
    const txt = join(home.dir, 'notes.txt');
    writeFileSync(txt, 'x');
    expect((await runCli(['upload', txt], { env: env() })).code).toBe(2);
    expect((await runCli(['upload', join(home.dir, 'missing.mp4')], { env: env() })).code).toBe(2);
    expect(server.postCount()).toBe(0);
  });

  it('emits JSON progress lines and a final result with --json', async () => {
    const r = await runCli(['upload', videoFile, '--json'], { env: env() });
    const lines = r.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(0, -1).every((line) => line.event === 'progress')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ event: 'result', video_id: VIDEO });
    expect(lines.some((line) => line.step === 'upload' && line.percent === 100)).toBe(true);
  });
});

describe('translate', () => {
  it('runs the whole journey: upload, estimate, start, wait with backoff, download', async () => {
    statusScript = [[processing('es', TV_ES, 20), processing('en', TV_EN, 20)], [processing('es', TV_ES, 80), completed('en', TV_EN)], [completed('es', TV_ES), completed('en', TV_EN)]];
    const r = await runCli(['translate', videoFile, '--to', 'es,en', '--mode', 'subtitles_only', '--yes', '--download', outDir], { env: env() });
    expect(r.code).toBe(0);
    expect(calls('start-translation').map((call) => call.args.estimate_only ?? false)).toEqual([true, false]);
    expect(calls('start-translation')[1]?.args).toMatchObject({ video_id: VIDEO, languages: ['es', 'en'], mode: 'subtitles_only' });
    expect(r.sleeps).toEqual([5000, 7500]);
    expect(r.stderr).toContain('transcribing 20% ~3 min left');
    expect(readdirSync(outDir).sort()).toEqual(['My Clip-en.mp4', 'My Clip-es.mp4']);
    expect(readFileSync(join(outDir, 'My Clip-es.mp4')).equals(BYTES)).toBe(true);
    expect(r.stdout).toContain('Saved:');
  });

  it('stops at the quote with --estimate: exit 0, nothing spent', async () => {
    const r = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'subtitles_only', '--estimate'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Estimate: 120 tokens');
    expect(calls('start-translation')).toHaveLength(1);
    expect(calls('create-video-upload')).toHaveLength(0);
  });

  it('refuses without --yes off a terminal: exit 3, only the estimate was requested', async () => {
    const r = await runCli(['translate', videoFile, '--to', 'es', '--mode', 'subtitles_only'], { env: env() });
    expect(r.code).toBe(3);
    expect(calls('start-translation').every((call) => call.args.estimate_only === true)).toBe(true);
    expect(r.stderr).toContain(VIDEO);
  });

  it('asks on a terminal and respects a refusal', async () => {
    const no = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'subtitles_only'], { env: env(), tty: true, confirm: false });
    expect(no.code).toBe(3);
    expect(calls('start-translation')).toHaveLength(1);
    const yes = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'subtitles_only'], { env: env(), tty: true, confirm: true });
    expect(yes.code).toBe(0);
    expect(calls('start-translation')).toHaveLength(3);
  });

  it('exits 9 with the reason when a language fails, still downloading the others', async () => {
    statusScript = [[{ ...completed('es', TV_ES), status: 'failed', error_message: 'voice_unavailable — retry_or_switch_mode' }, completed('en', TV_EN)]];
    const r = await runCli(['translate', VIDEO, '--to', 'es,en', '--mode', 'dubbing', '--yes', '--download', outDir], { env: env() });
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('voice_unavailable');
    expect(readdirSync(outDir)).toEqual(['My Clip-en.mp4']);
  });

  it('keeps waiting on a failed render that Radiance will retry on its own', async () => {
    const retrying = { ...completed('es', TV_ES), status: 'failed', next_retry_at: new Date(Date.now() + 3_600_000).toISOString(), error_message: 'x' };
    statusScript = [[retrying], [completed('es', TV_ES)]];
    const r = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'dubbing', '--yes', '--wait'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([5000]);
  });

  it('times out with exit 1, backing off from 5 s to 30 s', async () => {
    statusScript = [[processing('es', TV_ES)]];
    const r = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'dubbing', '--yes', '--wait', '--timeout', '2'], { env: env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('timeout');
    expect(r.sleeps.slice(0, 4)).toEqual([5000, 7500, 11250, 16875]);
    expect(Math.max(...r.sleeps)).toBe(30000);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(120_000);
  });

  it('waits out a not_ready estimate right after an upload', async () => {
    estimateNotReady = 2;
    const r = await runCli(['translate', videoFile, '--to', 'es', '--mode', 'subtitles_only', '--estimate'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([5000, 5000]);
  });

  it('passes --arg through, and rejects bad input before any call', async () => {
    await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'subtitles_only', '--estimate', '--arg', 'foo=1'], { env: env() });
    expect(calls('start-translation')[0]?.args).toMatchObject({ foo: 1 });
    const before = server.postCount();
    expect((await runCli(['translate', 'nope.mp4', '--to', 'es', '--mode', 'x'], { env: env() })).code).toBe(2);
    expect((await runCli(['translate', VIDEO, '--mode', 'x'], { env: env() })).code).toBe(2);
    expect((await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'x', '--timeout', '0'], { env: env() })).code).toBe(2);
    expect(server.postCount()).toBe(before);
  });

  it('streams JSON lines only on stdout with --json, ending on a result', async () => {
    statusScript = [[processing('es', TV_ES)], [completed('es', TV_ES)]];
    const r = await runCli(['translate', VIDEO, '--to', 'es', '--mode', 'subtitles_only', '--yes', '--wait', '--json', '--download', outDir], { env: env() });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const steps = lines.filter((line) => line.event === 'progress').map((line) => line.step);
    expect(steps).toEqual(expect.arrayContaining(['estimate', 'translate', 'wait', 'download']));
    expect(lines.at(-1)).toMatchObject({ event: 'result', video_id: VIDEO });
    expect(r.stderr).toBe('');
  });
});

describe('status and download', () => {
  it('shows the state, and --wait polls until done', async () => {
    statusScript = [[processing('es', TV_ES, 10)], [completed('es', TV_ES)]];
    const once = await runCli(['status', VIDEO], { env: env() });
    expect(once.code).toBe(0);
    expect(once.stdout).toContain('es: processing transcribing 10%');
    const waited = await runCli(['status', VIDEO, '--wait'], { env: env() });
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain('es: completed');
  });

  it('status --wait exits 9 on a failed language', async () => {
    statusScript = [[{ ...completed('es', TV_ES), status: 'failed', error_message: 'provider_unavailable — retry_later' }]];
    const r = await runCli(['status', VIDEO, '--wait'], { env: env() });
    expect(r.code).toBe(9);
    expect(r.stderr).toContain('provider_unavailable');
  });

  it('downloads one language, and refuses a language that is not finished', async () => {
    const ok = await runCli(['download', VIDEO, '--lang', 'es', '--download', outDir], { env: env() });
    expect(ok.code).toBe(0);
    expect(readdirSync(outDir)).toEqual(['My Clip-es.mp4']);
    statusScript = [[processing('es', TV_ES)]];
    expect((await runCli(['download', VIDEO, '--lang', 'es', '--download', outDir], { env: env() })).code).toBe(7);
    expect((await runCli(['download', VIDEO, '--lang', 'fr', '--download', outDir], { env: env() })).code).toBe(6);
  });

  it('never overwrites silently; --force does', async () => {
    mkdirSync(outDir);
    const existing = join(outDir, 'My Clip-es.mp4');
    writeFileSync(existing, 'precious');
    const refused = await runCli(['download', VIDEO, '--lang', 'es', '--download', outDir], { env: env() });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(readFileSync(existing, 'utf8')).toBe('precious');
    const forced = await runCli(['download', VIDEO, '--lang', 'es', '--download', outDir, '--force'], { env: env() });
    expect(forced.code).toBe(0);
    expect(readFileSync(existing).equals(BYTES)).toBe(true);
    expect(existsSync(`${existing}.part`)).toBe(false);
  });

  it('keeps a hostile title inside the target directory', async () => {
    downloadTitle = '../../etc/pass:wd?*"<>|';
    const r = await runCli(['download', VIDEO, '--lang', 'es', '--download', outDir], { env: env() });
    expect(r.code).toBe(0);
    const [name] = readdirSync(outDir);
    expect(name).toBeDefined();
    expect(name).not.toMatch(/[/\\:?*"<>|]/);
    expect(existsSync(join(home.dir, 'etc'))).toBe(false);
  });
});

describe('safeFileName', () => {
  it.each([
    ['My Clip', 'es', 'mp4', 'My Clip-es.mp4'],
    ['../../evil', 'es', 'mp4', 'evil-es.mp4'],
    ['a/b\\c:d*e?f"g<h>i|j', 'fr', 'mp4', 'a b c d e f g h i j-fr.mp4'],
    ['...', 'es', 'mp4', 'video-es.mp4'],
    ['CON', 'es', 'mp4', 'video-es.mp4'],
    ['name. ', 'ES', 'MP4', 'name-es.mp4'],
    ['x', 'e/s', 'm/p4', 'x-es.mp4'],
    ['', 'es', '', 'video-es.mp4'],
  ])('%j + %s -> %s', (title, language, extension, expected) => {
    expect(safeFileName(title, language, extension)).toBe(expected);
  });

  it('caps very long titles', () => {
    expect(safeFileName('é'.repeat(500), 'es', 'mp4').length).toBeLessThan(120);
  });
});

describe('publish', () => {
  beforeEach(() => {
    statusScript = [[completed('es', TV_ES), { ...completed('en', TV_EN), status: 'processing' }]];
  });

  it('uses schedule-publication for one account and one translation, with a normalised --at', async () => {
    const r = await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es', '--at', '2030-01-02T03:04:05Z', '--caption', 'hi', '--hashtags', '#a,b', '--privacy', 'PUBLIC_TO_EVERYONE', '--no-ai-generated', '--yes'], { env: env() });
    expect(r.code).toBe(0);
    expect(calls('schedule-publication')[0]?.args).toEqual({
      translated_video_id: TV_ES,
      platform_account_id: ACCOUNT,
      scheduled_at: '2030-01-02T03:04:05.000Z',
      caption: 'hi',
      hashtags: ['a', 'b'],
      privacy_level: 'PUBLIC_TO_EVERYONE',
      ai_generated_content: false,
    });
    expect(r.stdout).toContain('Scheduled for 2030-01-02T03:04:05.000Z');
    expect(r.stdout).toContain('Tokens spent: 0');
  });

  it('uses publish-to-more-accounts for several accounts or the original, and shows the cost', async () => {
    const many = await runCli(['publish', VIDEO, '--account', ACCOUNT, '--account', `${ACCOUNT_2}`, '--lang', 'es', '--yes'], { env: env() });
    expect(many.code).toBe(0);
    expect(calls('publish-to-more-accounts')[0]?.args).toEqual({ video_id: VIDEO, version: TV_ES, platform_account_ids: [ACCOUNT, ACCOUNT_2] });
    expect(many.stdout).toContain('Tokens spent: 10');
    const original = await runCli(['publish', VIDEO, '--account', ACCOUNT, '--original', '--yes'], { env: env() });
    expect(original.code).toBe(0);
    expect(calls('publish-to-more-accounts')[1]?.args).toMatchObject({ version: 'original' });
  });

  it('needs agreement: exit 3 without --yes off a terminal, nothing published', async () => {
    const r = await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es'], { env: env() });
    expect(r.code).toBe(3);
    expect(calls('schedule-publication')).toHaveLength(0);
    const tty = await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es'], { env: env(), tty: true, confirm: false });
    expect(tty.code).toBe(3);
    expect(calls('schedule-publication')).toHaveLength(0);
  });

  it('rejects ambiguous or invalid input with exit 2, and a missing translation with exit 7', async () => {
    statusScript = [[completed('es', TV_ES), completed('en', TV_EN)]];
    expect((await runCli(['publish', VIDEO, '--account', ACCOUNT, '--yes'], { env: env() })).code).toBe(2);
    expect((await runCli(['publish', VIDEO, '--lang', 'es', '--yes'], { env: env() })).code).toBe(2);
    expect((await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es', '--at', 'tomorrow-ish', '--yes'], { env: env() })).code).toBe(2);
    expect((await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es', '--original', '--yes'], { env: env() })).code).toBe(2);
    expect((await runCli(['publish', VIDEO, '--account', ACCOUNT, '--lang', 'de', '--yes'], { env: env() })).code).toBe(7);
  });
});

describe('token hygiene in workflows', () => {
  it('never prints the token, even with --verbose across upload, wait and publish', async () => {
    for (const args of [
      ['translate', videoFile, '--to', 'es', '--mode', 'subtitles_only', '--yes', '--wait', '--verbose'],
      ['publish', VIDEO, '--account', ACCOUNT, '--lang', 'es', '--yes', '--verbose', '--json'],
    ]) {
      const r = await runCli(args, { env: env() });
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
      expect(r.stderr + r.stdout).toContain(args.includes('--json') ? '"event"' : '[verbose]');
    }
  });
});
