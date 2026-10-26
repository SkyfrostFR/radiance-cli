import type { Io } from './io.js';

const RESET = '\u001b[0m';
const CODES = { bold: '\u001b[1m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m' } as const;
type Style = keyof typeof CODES;

/**
 * All writes go through here: it masks every known secret, and colours only on a terminal
 * when NO_COLOR is unset (https://no-color.org).
 */
export class Output {
  private readonly secrets = new Set<string>();

  constructor(
    private readonly io: Io,
    readonly json: boolean,
    readonly verbose: boolean,
  ) {}

  addSecret(secret: string): void {
    if (secret.length >= 4) {
      this.secrets.add(secret);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join('***');
    }
    return out.replace(/(Bearer\s+)[^\s"']+/gi, '$1***');
  }

  private colorOn(isTTY: boolean): boolean {
    return isTTY && (this.io.env.NO_COLOR === undefined || this.io.env.NO_COLOR === '');
  }

  out(text: string): void {
    this.io.stdout(this.redact(text) + '\n');
  }

  err(text: string): void {
    this.io.stderr(this.redact(text) + '\n');
  }

  /** Human-oriented status line: goes to stderr and is silent in --json mode. */
  info(text: string): void {
    if (!this.json) {
      this.err(text);
    }
  }

  trace(text: string): void {
    if (this.verbose) {
      this.err(this.paint('dim', `[verbose] ${text}`, true));
    }
  }

  style(style: Style, text: string): string {
    return this.paint(style, text, false);
  }

  private paint(style: Style, text: string, onStderr: boolean): string {
    return this.colorOn(onStderr ? this.io.stderrIsTTY : this.io.stdoutIsTTY) ? `${CODES[style]}${text}${RESET}` : text;
  }

  errorLabel(text: string): string {
    return this.colorOn(this.io.stderrIsTTY) ? `${CODES.red}${text}${RESET}` : text;
  }
}
