import { afterEach, describe, expect, it } from 'vitest';
import { bundledSkillDir } from '../src/skill.js';
import { type RemoteTool, type SkillFile, checkDrift, collectSkillFiles, fetchRemoteTools, modesOf } from '../src/skill-drift.js';
import { type FakeServer, type FakeTool, startFakeServer } from './helpers/fake-server.js';

const TOKEN = 'rad_drift_token_0123456789';
const MODES = ['subtitles_only', 'voice_over', 'dubbing_fish', 'dubbing_local', 'dubbing', 'dubbing_premium'];

/** The tools the skill is allowed to cite: the ones the CLI drives plus the read tools the skill points to. */
const SERVER_TOOLS = [
  'account-overview',
  'list-accounts',
  'list-videos',
  'create-video-upload',
  'confirm-video-upload',
  'video-translation-status',
  'download-translated-video',
  'schedule-publication',
  'publish-to-more-accounts',
];

function fakeTools(modes = MODES): FakeTool[] {
  return [
    ...SERVER_TOOLS.map((name) => ({ name, readOnly: true, handler: () => ({ text: '{}' }) })),
    {
      name: 'start-translation',
      inputSchema: { properties: { mode: { type: 'string', enum: modes } } },
      handler: () => ({ text: '{}' }),
    },
  ];
}

const remote = (names: string[], modes: string[] = []): RemoteTool[] => [
  ...names.map((name) => ({ name })),
  { name: 'start-translation', inputSchema: { properties: { mode: { enum: modes } } } },
];

const file = (content: string): SkillFile[] => [{ path: 'SKILL.md', content }];

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('skill drift against the fake server', () => {
  it('the bundled skill cites only tools and modes the server has', async () => {
    server = await startFakeServer({ token: TOKEN, tools: fakeTools() });
    const tools = await fetchRemoteTools(server.url, TOKEN);
    const files = collectSkillFiles(bundledSkillDir());
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'references/errors.md', 'references/modes.md', 'references/publishing.md']);

    const report = checkDrift(files, tools);
    expect(report.drift).toEqual([]);
    // A bare `dubbing` is indistinguishable from prose, so the checker only sees it after --mode.
    expect(report.undocumentedModes).toEqual(['dubbing']);
    expect(report.checkedTools).toBeGreaterThan(0);
    expect(report.checkedModes).toBeGreaterThan(0);
    expect(server.authorizations).toContain(`Bearer ${TOKEN}`);
  });

  it('reports a mode the server dropped and one it added', async () => {
    server = await startFakeServer({ token: TOKEN, tools: fakeTools([...MODES.filter((m) => m !== 'voice_over'), 'voice_clone']) });
    const report = checkDrift(collectSkillFiles(bundledSkillDir()), await fetchRemoteTools(server.url, TOKEN));
    expect(report.drift.some((d) => d.kind === 'mode' && d.name === 'voice_over')).toBe(true);
    expect(report.undocumentedModes).toContain('voice_clone');
  });

  it('fails to fetch with a refused token', async () => {
    server = await startFakeServer({ token: TOKEN, tools: fakeTools() });
    await expect(fetchRemoteTools(server.url, 'wrong')).rejects.toThrow();
  });
});

describe('checkDrift', () => {
  it('finds tools in backticks and in fenced radiance call/tools commands', () => {
    const content = ['Use `list-videos` and `gone-tool`.', '```sh', 'radiance call missing-tool --arg a=1', 'radiance tools list-videos', '```'].join('\n');
    const report = checkDrift(file(content), remote(['list-videos']));
    expect(report.drift).toEqual([
      { file: 'SKILL.md', kind: 'tool', name: 'gone-tool' },
      { file: 'SKILL.md', kind: 'tool', name: 'missing-tool' },
    ]);
  });

  it('finds modes in backticks and --mode, but not wizard-only lip-sync grades', () => {
    const content = ['`subtitles_only`, `dubbing_old` and `lip_sync_pro`.', '```', 'radiance translate x --to es --mode voice_gone', '```'].join('\n');
    const report = checkDrift(file(content), remote([], ['subtitles_only', 'dubbing']));
    expect(report.drift.map((d) => d.name)).toEqual(['dubbing_old', 'voice_gone']);
    expect(report.undocumentedModes).toEqual(['dubbing']);
  });

  it('ignores flags, placeholders, plain prose in fences, and lines marked drift:ignore', () => {
    const content = [
      '`--token-stdin`, `video_id`, `--mode <mode>`, `radiance-app.com`.',
      '`legacy-tool` was removed. <!-- drift:ignore -->',
      '```json',
      '{ "args": ["-y", "some-package"] }',
      '```',
    ].join('\n');
    expect(checkDrift(file(content), remote([])).drift).toEqual([]);
  });

  it('counts each reference once per file', () => {
    const report = checkDrift(file('`list-videos` `list-videos` `subtitles_only` `subtitles_only`'), remote(['list-videos'], ['subtitles_only']));
    expect(report).toMatchObject({ checkedTools: 1, checkedModes: 1, drift: [] });
  });

  it('reads modes from the start-translation schema only', () => {
    expect(modesOf(remote([], ['a', 'b']))).toEqual(['a', 'b']);
    expect(modesOf([{ name: 'start-translation' }])).toEqual([]);
    expect(modesOf([{ name: 'other', inputSchema: { properties: { mode: { enum: ['x'] } } } }])).toEqual([]);
  });
});
