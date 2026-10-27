import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../src/io.js';
import { Output } from '../src/output.js';
import type { Context } from '../src/shared.js';
import { MANIFEST, bundledSkillDir, installSkill, listFiles } from '../src/skill.js';
import { makeConfigHome, runCli } from './helpers/harness.js';

let home: ReturnType<typeof makeConfigHome>;

beforeEach(() => {
  home = makeConfigHome();
});

afterEach(() => {
  home.cleanup();
});

const env = (): Record<string, string> => ({ HOME: home.dir, XDG_CONFIG_HOME: home.dir });
const claudeTarget = (): string => join(home.dir, '.claude', 'skills', 'radiance');

function manifest(target: string): { version: string; files: Record<string, string> } {
  return JSON.parse(readFileSync(join(target, MANIFEST), 'utf8')) as { version: string; files: Record<string, string> };
}

/** A context for calling installSkill directly, with a custom source directory. */
function context(stdout: string[], json = false): Context {
  const io = { env: env(), stdout: (text: string) => void stdout.push(text) } as unknown as Io;
  return { io, out: new Output(io, json, false), options: { json } } as unknown as Context;
}

function writeSource(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

describe('bundled skill', () => {
  it('ships a SKILL.md with frontmatter and its references', () => {
    const files = listFiles(bundledSkillDir());
    expect(files).toContain('SKILL.md');
    expect(files).toContain('references/errors.md');
    const skill = readFileSync(join(bundledSkillDir(), 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: radiance\ndescription: .+\n---\n/);
    expect(skill).not.toMatch(/placeholder/i);
    expect(skill.split('\n').length).toBeLessThanOrEqual(200);
  });
});

describe('skill install', () => {
  it('installs into ~/.claude/skills/radiance by default, with a manifest of hashes', async () => {
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Installed the radiance skill`);
    expect(r.stdout).toContain(claudeTarget());
    const bundled = listFiles(bundledSkillDir());
    expect(listFiles(claudeTarget()).filter((name) => name !== MANIFEST)).toEqual(bundled);
    expect(readFileSync(join(claudeTarget(), 'SKILL.md'))).toEqual(readFileSync(join(bundledSkillDir(), 'SKILL.md')));
    expect(Object.keys(manifest(claudeTarget()).files).sort()).toEqual(bundled);
    expect(statSync(join(claudeTarget(), 'SKILL.md')).mode & 0o777).toBe(0o644);
  });

  it('installs into ~/.codex or --path <dir>/radiance', async () => {
    expect((await runCli(['skill', 'install', '--codex'], { env: env() })).code).toBe(0);
    expect(existsSync(join(home.dir, '.codex', 'skills', 'radiance', 'SKILL.md'))).toBe(true);
    const custom = join(home.dir, 'agents');
    expect((await runCli(['skill', 'install', '--path', custom], { env: env() })).code).toBe(0);
    expect(existsSync(join(custom, 'radiance', 'SKILL.md'))).toBe(true);
  });

  it('refuses more than one destination', async () => {
    const r = await runCli(['skill', 'install', '--claude', '--codex'], { env: env() });
    expect(r.code).toBe(2);
    expect(existsSync(claudeTarget())).toBe(false);
  });

  it('prints one JSON object with --json', async () => {
    const r = await runCli(['skill', 'install', '--json'], { env: env() });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ installed: true, upgraded: false, path: claudeTarget() });
    expect(out.files).toBe(listFiles(bundledSkillDir()).length);
  });

  it('re-running over an unmodified install upgrades it', async () => {
    await runCli(['skill', 'install'], { env: env() });
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Upgraded the radiance skill');
  });

  it('never overwrites local edits without --force', async () => {
    await runCli(['skill', 'install'], { env: env() });
    const skill = join(claudeTarget(), 'SKILL.md');
    writeFileSync(skill, 'my notes');
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('SKILL.md');
    expect(readFileSync(skill, 'utf8')).toBe('my notes');

    const forced = await runCli(['skill', 'install', '--force'], { env: env() });
    expect(forced.code).toBe(0);
    expect(readFileSync(skill)).toEqual(readFileSync(join(bundledSkillDir(), 'SKILL.md')));
  });

  it('treats a deleted managed file as a local change', async () => {
    await runCli(['skill', 'install'], { env: env() });
    rmSync(join(claudeTarget(), 'references', 'modes.md'));
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('references/modes.md');
  });

  it('refuses a directory it did not install, unless --force', async () => {
    mkdirSync(claudeTarget(), { recursive: true });
    writeFileSync(join(claudeTarget(), 'SKILL.md'), 'someone else');
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(2);
    expect(readFileSync(join(claudeTarget(), 'SKILL.md'), 'utf8')).toBe('someone else');
    expect((await runCli(['skill', 'install', '--force'], { env: env() })).code).toBe(0);
    expect(existsSync(join(claudeTarget(), MANIFEST))).toBe(true);
  });

  it('ignores a manifest whose paths leave the skill directory', async () => {
    mkdirSync(claudeTarget(), { recursive: true });
    writeFileSync(join(claudeTarget(), MANIFEST), JSON.stringify({ version: '0', files: { '../../escape': 'x' } }));
    const r = await runCli(['skill', 'install'], { env: env() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not installed by radiance');
  });
});

describe('skill upgrade', () => {
  it('replaces changed files and removes files the new version no longer ships', () => {
    const v1 = join(home.dir, 'v1');
    const v2 = join(home.dir, 'v2');
    writeSource(v1, { 'SKILL.md': 'v1', 'references/old.md': 'old', 'references/kept.md': 'kept' });
    writeSource(v2, { 'SKILL.md': 'v2', 'references/kept.md': 'kept', 'references/new.md': 'new' });

    const stdout: string[] = [];
    installSkill(context(stdout), {}, v1);
    expect(stdout.join('')).toContain('Installed the radiance skill (3 files)');
    installSkill(context(stdout), {}, v2);
    expect(stdout.join('')).toContain('Upgraded the radiance skill (3 files)');

    expect(readFileSync(join(claudeTarget(), 'SKILL.md'), 'utf8')).toBe('v2');
    expect(existsSync(join(claudeTarget(), 'references', 'old.md'))).toBe(false);
    expect(readFileSync(join(claudeTarget(), 'references', 'new.md'), 'utf8')).toBe('new');
    expect(Object.keys(manifest(claudeTarget()).files).sort()).toEqual(['SKILL.md', 'references/kept.md', 'references/new.md']);
  });

  it('keeps files the user added next to the skill', () => {
    const v1 = join(home.dir, 'v1');
    writeSource(v1, { 'SKILL.md': 'v1' });
    installSkill(context([]), {}, v1);
    writeFileSync(join(claudeTarget(), 'mine.md'), 'mine');
    installSkill(context([]), {}, v1);
    expect(readFileSync(join(claudeTarget(), 'mine.md'), 'utf8')).toBe('mine');
  });

  it('fails cleanly when the package has no skill', () => {
    expect(() => installSkill(context([]), {}, join(home.dir, 'empty'))).toThrow(/does not contain a skill/);
    expect(existsSync(claudeTarget())).toBe(false);
  });
});
