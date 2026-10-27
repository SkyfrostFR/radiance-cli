import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, ExitCode } from './errors.js';
import { type Context, version } from './shared.js';

export const MANIFEST = '.radiance-skill.json';

/** The skill shipped inside the package (dist/ and src/ both sit one level under the package root). */
export function bundledSkillDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'radiance');
}

interface Manifest {
  version: string;
  files: Record<string, string>;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Relative paths (posix separators) of every regular file under `dir`, sorted. */
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

function readManifest(target: string): Manifest | undefined {
  const path = join(target, MANIFEST);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    const files = Object.entries(parsed.files ?? {});
    // A manifest is data from disk: refuse any path that would leave the skill directory.
    const safe = files.every(([name, hash]) => typeof hash === 'string' && !isAbsolute(name) && !normalize(name).startsWith('..'));
    return safe ? { version: String(parsed.version), files: parsed.files } : undefined;
  } catch {
    return undefined;
  }
}

/** Managed files that were edited or deleted since the install that wrote the manifest. */
function modifiedFiles(target: string, manifest: Manifest): string[] {
  return Object.entries(manifest.files)
    .filter(([name, hash]) => {
      const path = join(target, name);
      return !existsSync(path) || sha256(readFileSync(path)) !== hash;
    })
    .map(([name]) => name);
}

export interface InstallOptions {
  claude?: boolean;
  codex?: boolean;
  path?: string;
  force?: boolean;
}

export function skillTarget(ctx: Context, opts: InstallOptions): string {
  const chosen = [opts.claude, opts.codex, opts.path !== undefined].filter(Boolean).length;
  if (chosen > 1) {
    throw new CliError('usage', 'Choose one of --claude, --codex or --path <dir>.', ExitCode.Usage);
  }
  const home = ctx.io.env.HOME && ctx.io.env.HOME !== '' ? ctx.io.env.HOME : homedir();
  if (opts.path !== undefined) {
    return join(resolve(opts.path), 'radiance');
  }
  return join(home, opts.codex ? '.codex' : '.claude', 'skills', 'radiance');
}

export function installSkill(ctx: Context, opts: InstallOptions, source = bundledSkillDir()): void {
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new CliError('skill_missing', `The package does not contain a skill to install (${source}).`, ExitCode.Unexpected);
  }
  const target = skillTarget(ctx, opts);
  const manifest = readManifest(target);
  let upgraded = false;

  if (existsSync(target) && !opts.force) {
    if (!manifest) {
      throw new CliError(
        'skill_exists',
        `${target} already exists and was not installed by radiance. Use --force to overwrite its files, or pick another place with --path.`,
        ExitCode.Usage,
      );
    }
    const modified = modifiedFiles(target, manifest);
    if (modified.length > 0) {
      throw new CliError(
        'skill_modified',
        `${target} has local changes (${modified.join(', ')}). Nothing was overwritten. Use --force to replace them.`,
        ExitCode.Usage,
      );
    }
  }
  upgraded = manifest !== undefined;

  const files = listFiles(source).filter((name) => name !== MANIFEST);
  const hashes: Record<string, string> = {};
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const name of files) {
    const bytes = readFileSync(join(source, name));
    const destination = join(target, name);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, bytes, { mode: 0o644 });
    chmodSync(destination, 0o644);
    hashes[name] = sha256(bytes);
  }
  // A file the previous install shipped and this one no longer does goes away (it was unmodified or --force).
  for (const name of Object.keys(manifest?.files ?? {})) {
    if (!(name in hashes)) {
      rmSync(join(target, name), { force: true });
    }
  }
  writeFileSync(join(target, MANIFEST), JSON.stringify({ version, files: hashes } satisfies Manifest, null, 2) + '\n', { mode: 0o644 });

  if (ctx.options.json) {
    ctx.out.out(JSON.stringify({ installed: true, upgraded, path: target, version, files: files.length }));
  } else {
    ctx.out.out(`${upgraded ? 'Upgraded' : 'Installed'} the radiance skill (${files.length} file${files.length === 1 ? '' : 's'}) in ${target}`);
  }
}
