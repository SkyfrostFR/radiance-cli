import { Command, CommanderError } from 'commander';
import { resultText, withSession } from './client.js';
import { TOKENS_PAGE_URL, clearToken, configPath, saveToken } from './config.js';
import { CliError, ExitCode, type ExitCodeValue } from './errors.js';
import { type Io, processIo } from './io.js';
import { Output } from './output.js';
import { runBridge } from './mcp.js';
import { registerWorkflowCommands } from './workflow.js';
import {
  type Context,
  type GlobalOptions,
  IDENTITY_TOOL,
  buildCallArguments,
  callTool,
  confirmAction,
  connectOptions,
  isReadOnly,
  listAllTools,
  parseJsonObject,
  reportError,
  requireToken,
  toolFailure,
  version,
} from './shared.js';


async function login(ctx: Context, opts: { tokenStdin?: boolean }): Promise<void> {
  let token: string;
  if (opts.tokenStdin) {
    token = ((await ctx.io.readStdin()).split(/\r?\n/)[0] ?? '').trim();
  } else if (ctx.io.stdinIsTTY) {
    ctx.out.err(`Create an API token at ${TOKENS_PAGE_URL} (opening your browser).`);
    ctx.io.openUrl(TOKENS_PAGE_URL);
    token = (await ctx.io.promptSecret('Paste your token (hidden): ')).trim();
  } else {
    throw new CliError('usage', 'Not a terminal: pipe the token and pass --token-stdin.', ExitCode.Usage);
  }
  if (token === '') {
    throw new CliError('usage', 'No token provided.', ExitCode.Usage);
  }
  ctx.out.addSecret(token);

  const result = await withSession(connectOptions(ctx, token), (client) => callTool(client, IDENTITY_TOOL, {}));
  if (result.isError) {
    throw toolFailure(result); // a refused token is never saved
  }
  const path = saveToken(ctx.io.env, token);
  if (ctx.options.json) {
    ctx.out.out(JSON.stringify({ logged_in: true, config: path }, null, 2));
  } else {
    ctx.out.out(`Logged in. Token saved to ${path}`);
  }
}

function logout(ctx: Context): void {
  const removed = clearToken(ctx.io.env);
  if (ctx.options.json) {
    ctx.out.out(JSON.stringify({ logged_out: removed }, null, 2));
    return;
  }
  ctx.out.out(removed ? `Logged out. Removed ${configPath(ctx.io.env)}` : 'No saved token to remove.');
  if (ctx.io.env.RADIANCE_TOKEN) {
    ctx.out.err('RADIANCE_TOKEN is still set in your environment.');
  }
}

async function whoami(ctx: Context): Promise<void> {
  const token = requireToken(ctx);
  const result = await withSession(connectOptions(ctx, token), (client) => callTool(client, IDENTITY_TOOL, {}));
  if (result.isError) {
    throw toolFailure(result);
  }
  if (ctx.options.json) {
    ctx.out.out(JSON.stringify(result, null, 2));
    return;
  }
  let data: Record<string, unknown> = {};
  try {
    data = parseJsonObject(resultText(result), 'account-overview');
  } catch {
    ctx.out.out(resultText(result));
    return;
  }
  const accounts = data.platform_accounts as { total?: number } | undefined;
  const plan = data.plan as { name?: string } | null | undefined;
  if (typeof data.email === 'string') {
    ctx.out.out(`Email:              ${data.email}`);
  }
  ctx.out.out(`Token balance:      ${String(data.token_balance ?? 'unknown')}`);
  ctx.out.out(`Connected accounts: ${String(accounts?.total ?? 'unknown')}`);
  if (plan && typeof plan.name === 'string') {
    ctx.out.out(`Plan:               ${plan.name}`);
  }
}

async function tools(ctx: Context, name: string | undefined): Promise<void> {
  const token = requireToken(ctx);
  const list = await withSession(connectOptions(ctx, token), listAllTools);
  if (name !== undefined) {
    const tool = list.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new CliError('unknown_tool', `No tool named "${name}". Run \`radiance tools\` to list them.`, ExitCode.Usage);
    }
    if (ctx.options.json) {
      ctx.out.out(JSON.stringify(tool, null, 2));
      return;
    }
    ctx.out.out(`${ctx.out.style('bold', tool.name)}  (${isReadOnly(tool) ? 'read-only' : 'write'})`);
    ctx.out.out('');
    ctx.out.out(tool.description ?? '(no description)');
    ctx.out.out('');
    ctx.out.out('Input schema:');
    ctx.out.out(JSON.stringify(tool.inputSchema ?? {}, null, 2));
    return;
  }
  if (ctx.options.json) {
    ctx.out.out(JSON.stringify(list, null, 2));
    return;
  }
  const width = Math.max(4, ...list.map((tool) => tool.name.length));
  for (const tool of list) {
    const readOnly = isReadOnly(tool);
    const mode = ctx.out.style(readOnly ? 'green' : 'yellow', (readOnly ? 'read ' : 'write'));
    const title = tool.title ?? tool.annotations?.title ?? '';
    ctx.out.out(`${tool.name.padEnd(width)}  ${mode}  ${title}`.trimEnd());
  }
}

async function call(ctx: Context, name: string, opts: { arg?: string[]; input?: string }): Promise<void> {
  const args = await buildCallArguments(ctx, opts.input, opts.arg ?? []);
  const token = requireToken(ctx);
  let confirmed = false;
  const result = await withSession(connectOptions(ctx, token), async (client) => {
    const tool = (await listAllTools(client)).find((candidate) => candidate.name === name);
    if (!tool) {
      throw new CliError('unknown_tool', `No tool named "${name}". Run \`radiance tools\` to list them.`, ExitCode.Usage);
    }
    if (!isReadOnly(tool) && !confirmed) {
      await confirmAction(ctx, tool.name, `Arguments: ${JSON.stringify(args)}`);
      confirmed = true;
    }
    return callTool(client, name, args);
  });
  if (result.isError) {
    throw toolFailure(result);
  }
  ctx.out.out(ctx.options.json ? JSON.stringify(result, null, 2) : resultText(result));
}

/** Runs the CLI and returns the exit code; never calls process.exit itself. */
export async function run(argv: readonly string[], io: Io = processIo()): Promise<ExitCodeValue> {
  let exit: ExitCodeValue = ExitCode.Success;
  const program = new Command();
  const collect = (value: string, previous: string[]): string[] => [...previous, value];

  program
    .name('radiance')
    .description('Command-line client for Radiance: call any Radiance tool from a terminal or an agent.')
    .version(version)
    .option('--token <token>', 'API token (visible in process lists; prefer RADIANCE_TOKEN or `radiance login`)')
    .option('--json', 'machine-readable JSON on stdout')
    .option('-y, --yes', 'confirm write tools without asking')
    .option('--verbose', 'trace HTTP requests on stderr (the token is masked)')
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.stdout(text), writeErr: (text) => io.stderr(text) });

  const action =
    <A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<void> => {
      const options = program.opts<GlobalOptions>();
      const out = new Output(io, Boolean(options.json), Boolean(options.verbose));
      const ctx: Context = { io, out, options };
      if (options.token) {
        out.addSecret(options.token);
      }
      try {
        await fn(ctx, ...args);
      } catch (error) {
        if (error instanceof CliError) {
          reportError(ctx, error);
          exit = error.exitCode;
        } else {
          reportError(ctx, new CliError('unexpected', error instanceof Error ? error.message : String(error), ExitCode.Unexpected));
          exit = ExitCode.Unexpected;
        }
      }
    };

  program
    .command('login')
    .description('save an API token (verified against Radiance before it is stored)')
    .option('--token-stdin', 'read the token from standard input (non-interactive)')
    .action(action((ctx, opts: { tokenStdin?: boolean }) => login(ctx, opts)));

  program
    .command('logout')
    .description('remove the locally saved token')
    .action(action((ctx) => logout(ctx)));

  program
    .command('whoami')
    .description('show your token balance and connected accounts')
    .action(action((ctx) => whoami(ctx)));

  program
    .command('tools [name]')
    .description('list tools, or show one tool with its input schema')
    .action(action((ctx, name: string | undefined) => tools(ctx, name)));

  program
    .command('call <tool>')
    .description('call a tool (write tools ask for confirmation, or need --yes off a terminal)')
    .option('-a, --arg <key=value>', 'tool argument; repeatable; the value is parsed as JSON, else kept as a string', collect, [] as string[])
    .option('-i, --input <json|->', 'tool arguments as a JSON object, or - to read it from stdin')
    .action(action((ctx, name: string, opts: { arg?: string[]; input?: string }) => call(ctx, name, opts)));

  program
    .command('mcp')
    .description('run a local MCP server on stdio that relays every tool to Radiance (for Claude Desktop, Cursor, Cline, ...)')
    .action(action((ctx) => runBridge(ctx)));

  registerWorkflowCommands(program, action);

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.Usage;
    }
    throw error;
  }
  return exit;
}
