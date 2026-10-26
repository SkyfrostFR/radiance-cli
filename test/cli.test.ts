import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeServer, type FakeTool, startFakeServer } from './helpers/fake-server.js';
import { makeConfigHome, runCli } from './helpers/harness.js';
import { TOOL_ERROR_EXIT } from '../src/errors.js';

const TOKEN = 'rad_secret_token_0123456789';
const overview = { token_balance: 120, platform_accounts: { total: 3 }, plan: { name: 'Creator' } };

function tools(extra: FakeTool[] = []): FakeTool[] {
  return [
    {
      name: 'account-overview',
      title: 'Account overview',
      description: 'Summary of your account.',
      readOnly: true,
      handler: () => ({ text: JSON.stringify(overview) }),
    },
    {
      name: 'echo',
      title: 'Echo',
      readOnly: true,
      inputSchema: { properties: { a: {} } },
      handler: (args) => ({ text: JSON.stringify(args) }),
    },
    {
      name: 'start-translation',
      title: 'Start translation',
      description: 'Spends tokens.',
      handler: () => ({ text: '{"started":true}' }),
    },
    {
      name: 'fail',
      readOnly: true,
      handler: (args) => ({ text: `[${String(args.code)} · permanent] It failed. Next: do something.`, isError: true }),
    },
    {
      name: 'leak',
      readOnly: true,
      handler: () => ({ text: `[upstream_failed · retry] echoed ${TOKEN} back. Next: x.`, isError: true }),
    },
    ...extra,
  ];
}

let server: FakeServer;
let home: ReturnType<typeof makeConfigHome>;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_CONFIG_HOME: home.dir, RADIANCE_URL: server.url, RADIANCE_TOKEN: TOKEN, ...extra };
}

async function boot(options: Partial<Parameters<typeof startFakeServer>[0]> = {}): Promise<void> {
  server = await startFakeServer({ token: TOKEN, tools: tools(), ...options });
}

beforeEach(() => {
  home = makeConfigHome();
});

afterEach(async () => {
  await server?.close();
  home.cleanup();
});

describe('basics', () => {
  it('prints the version', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 on an unknown command and on a malformed --arg', async () => {
    await boot();
    expect((await runCli(['nope'], { env: env() })).code).toBe(2);
    const bad = await runCli(['call', 'echo', '--arg', 'novalue'], { env: env() });
    expect(bad.code).toBe(2);
    expect(server.postCount()).toBe(0);
  });

  it('refuses plain http to a non-local host', async () => {
    const r = await runCli(['whoami'], { env: env({ RADIANCE_URL: 'http://example.com/mcp' }) });
    expect(r.code).toBe(2);
  });
});

describe('whoami / tools', () => {
  it('shows balance and accounts', async () => {
    await boot();
    const r = await runCli(['whoami'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('120');
    expect(r.stdout).toContain('Connected accounts: 3');
  });

  it('whoami --json gives the raw result and only JSON on stdout', async () => {
    await boot();
    const r = await runCli(['whoami', '--json'], { env: env() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).content[0].text).toContain('token_balance');
  });

  it('lists tools with read/write and shows one tool schema', async () => {
    await boot();
    const list = await runCli(['tools'], { env: env() });
    expect(list.stdout).toMatch(/echo\s+read\s+Echo/);
    expect(list.stdout).toMatch(/start-translation\s+write\s+Start translation/);
    const one = await runCli(['tools', 'start-translation'], { env: env() });
    expect(one.stdout).toContain('Spends tokens.');
    expect(one.stdout).toContain('Input schema');
    const asJson = await runCli(['tools', '--json'], { env: env() });
    expect(JSON.parse(asJson.stdout)).toHaveLength(tools().length);
    expect((await runCli(['tools', 'missing'], { env: env() })).code).toBe(2);
  });
});

describe('call', () => {
  it('parses --arg values as JSON with a string fallback, repeatable', async () => {
    await boot();
    const r = await runCli(['call', 'echo', '--arg', 'n=3', '--arg', 'ok=true', '--arg', 'name=hello', '--arg', 'list=[1,2]'], { env: env() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ n: 3, ok: true, name: 'hello', list: [1, 2] });
  });

  it('accepts --input as JSON, - for stdin, and --arg overrides it', async () => {
    await boot();
    const inline = await runCli(['call', 'echo', '--input', '{"a":1,"b":2}', '--arg', 'b=9'], { env: env() });
    expect(JSON.parse(inline.stdout)).toEqual({ a: 1, b: 9 });
    const piped = await runCli(['call', 'echo', '--input', '-'], { env: env(), stdin: '{"x":"y"}' });
    expect(JSON.parse(piped.stdout)).toEqual({ x: 'y' });
    expect((await runCli(['call', 'echo', '--input', '[1]'], { env: env() })).code).toBe(2);
    expect((await runCli(['call', 'echo', '--input', '{oops'], { env: env() })).code).toBe(2);
  });

  it('global --json prints the raw result, and global flags work after the subcommand', async () => {
    await boot();
    const r = await runCli(['call', 'echo', '--arg', 'a=1', '--json'], { env: env() });
    expect(JSON.parse(r.stdout)).toMatchObject({ content: [{ type: 'text', text: '{"a":1}' }] });
  });

  it('exits 2 on an unknown tool without calling anything', async () => {
    await boot();
    const r = await runCli(['call', 'nope'], { env: env() });
    expect(r.code).toBe(2);
    expect(server.toolCalls).toHaveLength(0);
  });

  it.each(Object.entries(TOOL_ERROR_EXIT))('maps tool error %s to exit %i and prints the code on stderr', async (code, exit) => {
    await boot();
    const r = await runCli(['call', 'fail', '--arg', `code=${code}`], { env: env() });
    expect(r.code).toBe(exit);
    expect(r.stderr).toContain(code);
    expect(r.stdout).toBe('');

    const asJson = await runCli(['call', 'fail', '--arg', `code=${code}`, '--json'], { env: env() });
    expect(asJson.code).toBe(exit);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ isError: true, error: { code, exit_code: exit } });
    expect(asJson.stderr).toContain(code);
  });

  it('exits 1 for an unrecognised tool error code', async () => {
    await boot();
    const r = await runCli(['call', 'fail', '--arg', 'code=brand_new'], { env: env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('brand_new');
  });
});

describe('HTTP failures', () => {
  it('exits 4 on 401 for any command', async () => {
    await boot();
    const r = await runCli(['whoami'], { env: env({ RADIANCE_TOKEN: 'rad_wrong_token_value' }) });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('unauthenticated');
  });

  it('exits 4 without any token', async () => {
    await boot();
    const r = await runCli(['whoami'], { env: env({ RADIANCE_TOKEN: '' }) });
    expect(r.code).toBe(4);
    expect(server.postCount()).toBe(0);
  });

  it('waits for Retry-After on 429 then retries once successfully', async () => {
    await boot({ rateLimitHits: 1, retryAfter: '7' });
    const r = await runCli(['whoami'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([7000]);
  });

  it('uses a short default wait without Retry-After, and exits 8 after a second 429', async () => {
    await boot({ rateLimitHits: 2 });
    const r = await runCli(['whoami'], { env: env() });
    expect(r.code).toBe(8);
    expect(r.sleeps).toHaveLength(1);
    expect(r.sleeps[0]).toBeGreaterThan(0);
    expect(r.stderr).toContain('rate_limited');
  });

  it('exits 1 when the server is unreachable', async () => {
    await boot();
    const url = server.url;
    await server.close();
    const r = await runCli(['whoami'], { env: env({ RADIANCE_URL: url }) });
    expect(r.code).toBe(1);
    server = await startFakeServer({ token: TOKEN, tools: [] });
  });
});

describe('write confirmation', () => {
  it('exits 3 off a terminal without --yes, and never calls the tool', async () => {
    await boot();
    const r = await runCli(['call', 'start-translation'], { env: env() });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('--yes');
    expect(server.toolCalls).toHaveLength(0);
  });

  it('calls with --yes', async () => {
    await boot();
    const r = await runCli(['call', 'start-translation', '--yes'], { env: env() });
    expect(r.code).toBe(0);
    expect(server.toolCalls.map((c) => c.name)).toEqual(['start-translation']);
  });

  it('asks on a terminal: yes runs it, no exits 3', async () => {
    await boot();
    const yes = await runCli(['call', 'start-translation'], { env: env(), tty: true, confirm: true });
    expect(yes.code).toBe(0);
    expect(yes.prompts[0]).toContain('start-translation');
    const no = await runCli(['call', 'start-translation'], { env: env(), tty: true, confirm: false });
    expect(no.code).toBe(3);
    expect(server.toolCalls).toHaveLength(1);
  });

  it('never asks for read-only tools', async () => {
    await boot();
    const r = await runCli(['call', 'echo'], { env: env(), tty: true });
    expect(r.code).toBe(0);
    expect(r.prompts).toEqual([]);
  });
});

describe('token handling', () => {
  it('follows the priority --token, RADIANCE_TOKEN, config file', async () => {
    await boot();
    mkdirSync(join(home.dir, 'radiance'), { recursive: true });
    writeFileSync(join(home.dir, 'radiance', 'config.json'), JSON.stringify({ token: 'file_token_value' }));

    await runCli(['whoami', '--token', 'flag_token_value'], { env: env() });
    await runCli(['whoami'], { env: env() });
    await runCli(['whoami'], { env: env({ RADIANCE_TOKEN: '' }) });

    const seen = new Set(server.authorizations.filter((a) => a !== ''));
    expect(seen).toEqual(new Set(['Bearer flag_token_value', `Bearer ${TOKEN}`, 'Bearer file_token_value']));
    expect(server.authorizations[0]).toBe('Bearer flag_token_value');
    const firstEnv = server.authorizations.findIndex((a) => a === `Bearer ${TOKEN}`);
    const firstFile = server.authorizations.findIndex((a) => a === 'Bearer file_token_value');
    expect(firstEnv).toBeGreaterThan(0);
    expect(firstFile).toBeGreaterThan(firstEnv);
  });

  it('never prints the token, even with --verbose, errors and echoing servers', async () => {
    await boot();
    const scenarios: string[][] = [
      ['whoami', '--verbose'],
      ['call', 'leak', '--verbose'],
      ['call', 'leak', '--json', '--verbose'],
      ['tools', '--verbose'],
      ['whoami', '--token', 'flag_token_value_abc', '--verbose'],
    ];
    for (const args of scenarios) {
      const r = await runCli(args, { env: env() });
      for (const secret of [TOKEN, 'flag_token_value_abc']) {
        expect(r.stdout).not.toContain(secret);
        expect(r.stderr).not.toContain(secret);
      }
    }
    const verbose = await runCli(['whoami', '--verbose'], { env: env() });
    expect(verbose.stderr).toContain('[verbose]');
    expect(verbose.stderr).toContain('Bearer ***');
    const wrong = await runCli(['whoami', '--verbose'], { env: env({ RADIANCE_TOKEN: 'rad_wrong_token_value' }) });
    expect(wrong.stderr + wrong.stdout).not.toContain('rad_wrong_token_value');
  });
});

describe('login / logout', () => {
  const configFile = () => join(home.dir, 'radiance', 'config.json');

  it('stores a verified token with mode 0600 in a 0700 directory', async () => {
    await boot();
    const r = await runCli(['login', '--token-stdin'], { env: env({ RADIANCE_TOKEN: '' }), stdin: `${TOKEN}\n` });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({ token: TOKEN });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.dir, 'radiance')).mode & 0o777).toBe(0o700);
    expect(r.stdout).not.toContain(TOKEN);

    const who = await runCli(['whoami'], { env: env({ RADIANCE_TOKEN: '' }) });
    expect(who.code).toBe(0);
  });

  it('tightens the mode of a pre-existing loose file', async () => {
    await boot();
    mkdirSync(join(home.dir, 'radiance'), { recursive: true });
    writeFileSync(configFile(), '{}', { mode: 0o644 });
    await runCli(['login', '--token-stdin'], { env: env({ RADIANCE_TOKEN: '' }), stdin: TOKEN });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  });

  it('never saves a refused token', async () => {
    await boot();
    const r = await runCli(['login', '--token-stdin'], { env: env({ RADIANCE_TOKEN: '' }), stdin: 'rad_wrong_token_value\n' });
    expect(r.code).toBe(4);
    expect(existsSync(configFile())).toBe(false);
    expect(r.stderr + r.stdout).not.toContain('rad_wrong_token_value');
  });

  it('prompts with masked input on a terminal and opens the tokens page', async () => {
    await boot();
    const r = await runCli(['login'], { env: env({ RADIANCE_TOKEN: '' }), tty: true, secret: `${TOKEN}\n` });
    expect(r.code).toBe(0);
    expect(r.opened).toEqual(['https://radiance-app.com/settings/api-tokens']);
    expect(r.stderr).toContain('https://radiance-app.com/settings/api-tokens');
    expect(existsSync(configFile())).toBe(true);
  });

  it('exits 2 off a terminal without --token-stdin, and for an empty token', async () => {
    await boot();
    expect((await runCli(['login'], { env: env() })).code).toBe(2);
    expect((await runCli(['login', '--token-stdin'], { env: env(), stdin: '\n' })).code).toBe(2);
    expect(existsSync(configFile())).toBe(false);
  });

  it('logout removes the saved token', async () => {
    await boot();
    await runCli(['login', '--token-stdin'], { env: env({ RADIANCE_TOKEN: '' }), stdin: TOKEN });
    const r = await runCli(['logout'], { env: env({ RADIANCE_TOKEN: '' }) });
    expect(r.code).toBe(0);
    expect(existsSync(configFile())).toBe(false);
    expect((await runCli(['whoami'], { env: env({ RADIANCE_TOKEN: '' }) })).code).toBe(4);
  });
});

describe('output hygiene', () => {
  it('emits no ANSI colour when not a terminal or when NO_COLOR is set', async () => {
    await boot();
    const r = await runCli(['tools'], { env: env() });
    expect(r.stdout).not.toContain('\u001b[');
    const tty = await runCli(['call', 'fail', '--arg', 'code=not_found'], { env: env({ NO_COLOR: '1' }), tty: true });
    expect(tty.stderr).not.toContain('\u001b[');
  });
});
