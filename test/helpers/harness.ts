import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import type { Io } from '../../src/io.js';

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  tty?: boolean;
  secret?: string;
  confirm?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
  opened: string[];
  prompts: string[];
}

export function makeConfigHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'radiance-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result: RunResult = { code: -1, stdout: '', stderr: '', sleeps: [], opened: [], prompts: [] };
  const tty = options.tty ?? false;
  let clock = 1_000_000;
  const io: Io = {
    env: options.env ?? {},
    stdout: (text) => void (result.stdout += text),
    stderr: (text) => void (result.stderr += text),
    stdoutIsTTY: false,
    stderrIsTTY: tty,
    stdinIsTTY: tty,
    readStdin: async () => options.stdin ?? '',
    promptSecret: async (label) => {
      result.prompts.push(label);
      return options.secret ?? '';
    },
    confirm: async (question) => {
      result.prompts.push(question);
      return options.confirm ?? false;
    },
    openUrl: (url) => void result.opened.push(url),
    sleep: async (ms) => {
      result.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  result.code = await run(args, io);
  return result;
}
