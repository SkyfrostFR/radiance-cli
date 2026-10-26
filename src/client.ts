import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CliError, ExitCode } from './errors.js';
import type { Io } from './io.js';
import type { Output } from './output.js';

export interface ConnectOptions {
  url: string;
  token: string;
  version: string;
  io: Io;
  out: Output;
}

interface HttpFailure {
  status: number;
  retryAfterSeconds?: number;
}

const DEFAULT_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 120;

/** Raised when the server answered HTTP 429; carries how long to wait. */
export class RateLimitedError extends Error {
  constructor(readonly waitSeconds: number) {
    super('rate limited');
    this.name = 'RateLimitedError';
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, MAX_RETRY_SECONDS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), MAX_RETRY_SECONDS);
  }
  return undefined;
}

/**
 * Opens one MCP session, runs `fn`, closes it, and translates transport failures into
 * CliErrors (401 -> exit 4, 429 -> RateLimitedError, anything else -> exit 1).
 */
async function runOnce<T>(options: ConnectOptions, fn: (client: Client) => Promise<T>): Promise<T> {
  const { out } = options;
  let failure: HttpFailure | undefined;

  const tracingFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    out.trace(`> ${method} ${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url} (Authorization: Bearer ***)`);
    const response = await fetch(input, init);
    out.trace(`< ${response.status} ${response.statusText}`);
    if (response.status === 401 || response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      failure = retryAfterSeconds === undefined ? { status: response.status } : { status: response.status, retryAfterSeconds };
    }
    return response;
  };

  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    fetch: tracingFetch,
  });
  const client = new Client({ name: 'radiance-cli', version: options.version }, { capabilities: {} });

  try {
    await client.connect(transport);
    return await fn(client);
  } catch (error) {
    if (failure?.status === 401) {
      throw new CliError('unauthenticated', 'The Radiance token was refused. Run `radiance login` with a valid token.', ExitCode.Unauthenticated);
    }
    if (failure?.status === 429) {
      throw new RateLimitedError(failure.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS);
    }
    if (error instanceof CliError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError('network', `Could not reach Radiance: ${reason}`, ExitCode.Unexpected);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** One session, and on HTTP 429 one wait-and-retry before giving up with exit 8. */
export async function withSession<T>(options: ConnectOptions, fn: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await runOnce(options, fn);
  } catch (error) {
    if (!(error instanceof RateLimitedError)) {
      throw error;
    }
    options.out.info(`Rate limited by Radiance; retrying in ${error.waitSeconds}s...`);
    await options.io.sleep(error.waitSeconds * 1000);
  }
  try {
    return await runOnce(options, fn);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw new CliError('rate_limited', 'Radiance is rate limiting this token (60 requests per minute). Try again shortly.', ExitCode.RateLimited);
    }
    throw error;
  }
}

export interface ToolResultLike {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export function resultText(result: ToolResultLike): string {
  if (!Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .map((part: unknown) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * A long-lived session for multi-step workflows (upload, poll, publish): one connection
 * for the whole command so polling does not burn the 60 requests/minute budget on
 * handshakes. Each request gets the same 429 treatment as {@link withSession}: wait,
 * reconnect, retry once. A 429 means the server refused the request before acting on
 * it, so the retry cannot double-spend.
 */
export class RadianceApi {
  private client: Client | undefined;
  private failure: HttpFailure | undefined;

  constructor(
    private readonly options: ConnectOptions,
    private readonly onConnect?: (client: Client) => void,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    const { out } = this.options;
    const tracingFetch: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      out.trace(`> ${method} ${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url} (Authorization: Bearer ***)`);
      const response = await fetch(input, init);
      out.trace(`< ${response.status} ${response.statusText}`);
      if (response.status === 401 || response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
        this.failure = retryAfterSeconds === undefined ? { status: response.status } : { status: response.status, retryAfterSeconds };
      }
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.options.token}` } },
      fetch: tracingFetch,
    });
    const client = new Client({ name: 'radiance-cli', version: this.options.version }, { capabilities: {} });
    this.onConnect?.(client);
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    return client;
  }

  private async attempt<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    this.failure = undefined;
    try {
      return await fn(await this.connect());
    } catch (error) {
      const failure = this.lastFailure();
      if (failure?.status === 401) {
        throw new CliError('unauthenticated', 'The Radiance token was refused. Run `radiance login` with a valid token.', ExitCode.Unauthenticated);
      }
      if (failure?.status === 429) {
        throw new RateLimitedError(failure.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS);
      }
      if (error instanceof CliError || error instanceof McpError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError('network', `Could not reach Radiance: ${reason}`, ExitCode.Unexpected);
    }
  }

  private lastFailure(): HttpFailure | undefined {
    return this.failure;
  }

  async run<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await this.attempt(fn);
    } catch (error) {
      if (!(error instanceof RateLimitedError)) {
        throw error;
      }
      this.options.out.info(`Rate limited by Radiance; retrying in ${error.waitSeconds}s...`);
      await this.options.io.sleep(error.waitSeconds * 1000);
      await this.close();
    }
    try {
      return await this.attempt(fn);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw new CliError('rate_limited', 'Radiance is rate limiting this token (60 requests per minute). Try again shortly.', ExitCode.RateLimited);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}
