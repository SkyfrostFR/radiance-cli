import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://radiance-app.com/mcp/radiance';
export const TOKENS_PAGE_URL = 'https://radiance-app.com/settings/api-tokens';

export type Env = Readonly<Record<string, string | undefined>>;

export function configPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'radiance', 'config.json');
}

export function readStoredToken(env: Env): string | undefined {
  const path = configPath(env);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'token' in parsed && typeof parsed.token === 'string') {
      return parsed.token.trim() || undefined;
    }
  } catch {
    // A corrupt file is treated as "not logged in"; `radiance login` rewrites it.
  }
  return undefined;
}

export function saveToken(env: Env, token: string): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies on creation: tighten a pre-existing file too.
  chmodSync(path, 0o600);
  return path;
}

export function clearToken(env: Env): boolean {
  const path = configPath(env);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}

export type TokenSource = 'flag' | 'env' | 'file';

/** Priority: --token, then RADIANCE_TOKEN, then the config file. */
export function resolveToken(flag: string | undefined, env: Env): { token: string; source: TokenSource } | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) {
    return { token: fromFlag, source: 'flag' };
  }
  const fromEnv = env.RADIANCE_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: 'env' };
  }
  const fromFile = readStoredToken(env);
  return fromFile ? { token: fromFile, source: 'file' } : undefined;
}

export function resolveUrl(env: Env): string {
  const url = env.RADIANCE_URL?.trim();
  return url ? url : DEFAULT_URL;
}
