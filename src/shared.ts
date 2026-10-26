import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createRequire } from 'node:module';
import { type ConnectOptions, type ToolResultLike, resultText } from './client.js';
import { resolveToken, resolveUrl } from './config.js';
import { CliError, ExitCode, parseToolError } from './errors.js';
import type { Io } from './io.js';
import type { Output } from './output.js';

const require = createRequire(import.meta.url);
export const { version } = require('../package.json') as { version: string };

export interface GlobalOptions {
  token?: string;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

export interface Context {
  io: Io;
  out: Output;
  options: GlobalOptions;
}

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean };
}

export const IDENTITY_TOOL = 'account-overview';

export function isReadOnly(tool: ToolInfo): boolean {
  return tool.annotations?.readOnlyHint === true;
}

export function connectOptions(ctx: Context, token: string): ConnectOptions {
  const url = resolveUrl(ctx.io.env);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('usage', `RADIANCE_URL is not a valid URL: ${url}`, ExitCode.Usage);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new CliError('usage', 'RADIANCE_URL must be https (plain http is only allowed for localhost).', ExitCode.Usage);
  }
  ctx.out.addSecret(token);
  return { url, token, version, io: ctx.io, out: ctx.out };
}

export function requireToken(ctx: Context): string {
  const found = resolveToken(ctx.options.token, ctx.io.env);
  if (!found) {
    throw new CliError('unauthenticated', 'Not logged in. Run `radiance login`, or set RADIANCE_TOKEN.', ExitCode.Unauthenticated);
  }
  ctx.out.addSecret(found.token);
  ctx.out.trace(`token source: ${found.source}`);
  return found.token;
}

export async function listAllTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as ToolInfo[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResultLike> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResultLike;
}

/** Turns an `isError` tool result into a CliError carrying the tool's own code. */
export function toolFailure(result: ToolResultLike): CliError {
  const parsed = parseToolError(resultText(result));
  return new CliError(parsed.code, parsed.message, parsed.exitCode, result);
}

export function reportError(ctx: Context, error: CliError): void {
  ctx.out.err(`${ctx.out.errorLabel('error')} [${error.code}]: ${error.message}`);
  if (ctx.options.json) {
    const payload: Record<string, unknown> = { event: 'error', error: { code: error.code, message: error.message, exit_code: error.exitCode } };
    if (error.details !== undefined) {
      payload.isError = true;
      payload.result = error.details;
    }
    ctx.out.out(JSON.stringify(payload));
  }
}


export function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError('usage', `${label} is not valid JSON.`, ExitCode.Usage);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('usage', `${label} must be a JSON object.`, ExitCode.Usage);
  }
  return value as Record<string, unknown>;
}

export function parseArgPair(pair: string): [string, unknown] {
  const index = pair.indexOf('=');
  if (index < 1) {
    throw new CliError('usage', `--arg expects key=value, got "${pair}".`, ExitCode.Usage);
  }
  const key = pair.slice(0, index);
  const raw = pair.slice(index + 1);
  try {
    return [key, JSON.parse(raw)];
  } catch {
    return [key, raw];
  }
}

export async function confirmAction(ctx: Context, name: string, summary: string): Promise<void> {
  if (ctx.options.yes) {
    return;
  }
  const interactive = ctx.io.stdinIsTTY && ctx.io.stderrIsTTY;
  if (!interactive) {
    throw new CliError(
      'confirmation_required',
      `"${name}" writes data or may spend tokens. Re-run with --yes to confirm; nothing was called.`,
      ExitCode.ConfirmationRequired,
    );
  }
  ctx.out.err(`"${name}" writes data or may spend tokens.`);
  ctx.out.err(summary);
  if (!(await ctx.io.confirm(`Run ${name}?`))) {
    throw new CliError('confirmation_required', 'Cancelled; nothing was called.', ExitCode.ConfirmationRequired);
  }
}

export async function buildCallArguments(ctx: Context, input: string | undefined, pairs: string[]): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  if (input !== undefined) {
    const raw = input === '-' ? await ctx.io.readStdin() : input;
    Object.assign(args, parseJsonObject(raw, input === '-' ? 'Standard input' : '--input'));
  }
  for (const pair of pairs) {
    const [key, value] = parseArgPair(pair);
    args[key] = value;
  }
  return args;
}

