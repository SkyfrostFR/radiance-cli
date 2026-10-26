import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeServer, type FakeTool, startFakeServer } from './helpers/fake-server.js';
import { makeConfigHome } from './helpers/harness.js';
import { createBridge } from '../src/mcp.js';
import { Output } from '../src/output.js';
import type { Io } from '../src/io.js';
import type { Context } from '../src/shared.js';

const TOKEN = 'rad_bridge_token_0123456789';
const root = resolve(import.meta.dirname, '..');

const tools: FakeTool[] = [
  { name: 'account-overview', title: 'Account overview', readOnly: true, handler: () => ({ text: '{"token_balance":42}' }) },
  { name: 'echo', title: 'Echo', readOnly: true, inputSchema: { properties: { a: { type: 'number' } } }, handler: (args) => ({ text: JSON.stringify(args) }) },
  { name: 'spend', title: 'Spend', handler: () => ({ text: '[insufficient_tokens · needs_human] Not enough tokens. Next: top up.', isError: true }) },
];

let server: FakeServer;
let home: ReturnType<typeof makeConfigHome>;
let stderr: string;

function context(env: Record<string, string>): Context {
  const io: Io = {
    env,
    stdout: () => {
      throw new Error('the bridge must never write to stdout');
    },
    stderr: (text) => void (stderr += text),
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdinIsTTY: false,
    readStdin: async () => '',
    promptSecret: async () => '',
    confirm: async () => false,
    openUrl: () => undefined,
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  return { io, out: new Output(io, false, true), options: {} };
}

async function connect(env: Record<string, string>): Promise<{ client: Client; close: () => Promise<void> }> {
  const bridge = createBridge(context(env));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await bridge.close();
    },
  };
}

beforeEach(async () => {
  stderr = '';
  home = makeConfigHome();
  server = await startFakeServer({ token: TOKEN, tools });
});

afterEach(async () => {
  await server.close();
  home.cleanup();
});

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  XDG_CONFIG_HOME: home.dir,
  RADIANCE_URL: server.url,
  RADIANCE_TOKEN: TOKEN,
  ...extra,
});

describe('bridge (in memory)', () => {
  it('exposes exactly the remote tools: names, titles, schemas, annotations', async () => {
    const { client, close } = await connect(env());
    const local = (await client.listTools()).tools;
    expect(local.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(local.find((tool) => tool.name === 'echo')).toMatchObject({
      title: 'Echo',
      inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
      annotations: { readOnlyHint: true },
    });
    expect(local.find((tool) => tool.name === 'spend')?.annotations?.readOnlyHint).not.toBe(true);
    await close();
  });

  it('relays a call with the stored token', async () => {
    const { client, close } = await connect(env());
    const result = await client.callTool({ name: 'echo', arguments: { a: 7 } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: '{"a":7}' }]);
    expect(server.toolCalls).toEqual([{ name: 'echo', args: { a: 7 } }]);
    expect(new Set(server.authorizations.filter(Boolean))).toEqual(new Set([`Bearer ${TOKEN}`]));
    await close();
  });

  it('propagates a tool error untouched', async () => {
    const { client, close } = await connect(env());
    const result = await client.callTool({ name: 'spend', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('insufficient_tokens');
    await close();
  });

  it('starts without a token: lists nothing, answers every call with how to log in, then picks up a later login', async () => {
    const { client, close } = await connect(env({ RADIANCE_TOKEN: '' }));
    expect((await client.listTools()).tools).toEqual([]);
    const refused = await client.callTool({ name: 'echo', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('radiance login');
    expect(JSON.stringify(refused.content)).toContain('RADIANCE_TOKEN');
    await expect(client.readResource({ uri: 'file:///x' })).rejects.toThrow(/radiance login/);
    expect(server.postCount()).toBe(0);

    mkdirSync(join(home.dir, 'radiance'), { recursive: true });
    writeFileSync(join(home.dir, 'radiance', 'config.json'), JSON.stringify({ token: TOKEN }));
    const ok = await client.callTool({ name: 'echo', arguments: { a: 1 } });
    expect(ok.isError).toBeFalsy();
    await close();
  });

  it('reports a refused token as a readable tool error without leaking it', async () => {
    const wrong = 'rad_wrong_bridge_token_999';
    const { client, close } = await connect(env({ RADIANCE_TOKEN: wrong }));
    const result = await client.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('refused');
    expect(JSON.stringify(result.content)).not.toContain(wrong);
    expect(stderr).not.toContain(wrong);
    await close();
  });

  it('keeps the token out of the stderr trace', async () => {
    const { client, close } = await connect(env());
    await client.listTools();
    expect(stderr).toContain('[verbose]');
    expect(stderr).not.toContain(TOKEN);
    await close();
  });

  it("surfaces the remote's protocol error for a capability it lacks", async () => {
    const { client, close } = await connect(env());
    // The fake remote only declares tools, so the relay surfaces its protocol error.
    await expect(client.listResources()).rejects.toThrow();
    await close();
  });
});

describe('radiance mcp over real stdio', () => {
  beforeAll(() => {
    execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json', '--outDir', '.test-dist'], { cwd: root });
  });

  function spawnBridge(extraEnv: Record<string, string>) {
    return spawn(process.execPath, [join(root, '.test-dist', 'bin.js'), 'mcp', '--verbose'], {
      env: { PATH: process.env.PATH ?? '', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  it('writes nothing but JSON-RPC on stdout, relays a call, and exits when stdin closes', async () => {
    const child = spawnBridge(env());
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.on('exit', done));

    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 5 } } });

    const deadline = Date.now() + 15_000;
    while (!out.includes('"id":3') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    child.stdin.end();
    expect(await exited).toBe(0);

    const lines = out.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe('2.0');
    }
    const call = lines.map((line) => JSON.parse(line) as { id?: number; result?: { content?: { text: string }[] } }).find((m) => m.id === 3);
    expect(call?.result?.content?.[0]?.text).toBe('{"a":5}');
    expect(out).not.toContain(TOKEN);
    expect(err).toContain('ready on stdio');
    expect(err).not.toContain(TOKEN);
  }, 30_000);

  it('starts without a token and says how to log in on the first call', async () => {
    const child = spawnBridge(env({ RADIANCE_TOKEN: '' }));
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.on('exit', done));
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    const deadline = Date.now() + 15_000;
    while (!out.includes('"id":2') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(out).toContain('radiance login');
  }, 30_000);
});
