import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Everything the commands touch outside the process, so tests can replace it. */
export interface Io {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  /** Masked input; the typed characters are never echoed. */
  promptSecret: (label: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  openUrl: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function processIo(): Io {
  return {
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    promptSecret: (label) => {
      process.stderr.write(label);
      const muted = new Writable({ write: (_chunk, _enc, done) => done() });
      const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
      return new Promise((resolve) => {
        rl.question('', (answer) => {
          rl.close();
          process.stderr.write('\n');
          resolve(answer);
        });
      });
    },
    confirm: (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      return new Promise((resolve) => {
        rl.question(`${question} [y/N] `, (answer) => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      });
    },
    openUrl: (url) => {
      const [command, args]: [string, string[]] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', url]]
            : ['xdg-open', [url]];
      try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
      } catch {
        // The URL is printed as well; opening a browser is a convenience.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
