import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { RadianceApi } from './client.js';
import { resolveToken } from './config.js';
import { CliError } from './errors.js';
import { type Context, connectOptions, version } from './shared.js';

const NOT_LOGGED_IN = 'Not logged in to Radiance. Run `radiance login` in a terminal, or set RADIANCE_TOKEN in this MCP server\'s environment.';
const CALL_TIMEOUT_MS = 120_000;

export interface Bridge {
  server: Server;
  close: () => Promise<void>;
}

function textError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * A local MCP server that does nothing but relay: every request goes to the remote Radiance
 * server with the stored token, and the answer comes back untouched. No business logic here,
 * so the tools, schemas and annotations are always exactly the remote ones.
 *
 * Nothing in this module may write to stdout: when the transport is stdio, stdout carries only
 * JSON-RPC. Logs go through `ctx.out.err` (stderr).
 */
export function createBridge(ctx: Context): Bridge {
  const server = new Server(
    { name: 'radiance', version },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
      instructions: 'Radiance video translation and dubbing. Every tool is relayed to the Radiance server with your API token.',
    },
  );

  let api: RadianceApi | undefined;
  let warnedNoToken = false;

  /** Resolved lazily on each request, so `radiance login` after the bridge started takes effect. */
  const getApi = (): RadianceApi | undefined => {
    if (api) {
      return api;
    }
    const found = resolveToken(ctx.options.token, ctx.io.env);
    if (!found) {
      if (!warnedNoToken) {
        warnedNoToken = true;
        ctx.out.err('radiance mcp: no token found (RADIANCE_TOKEN or `radiance login`); tool calls will report it.');
      }
      return undefined;
    }
    api = new RadianceApi(connectOptions(ctx, found.token), (client: Client) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void server.sendToolListChanged().catch(() => undefined));
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void server.sendResourceListChanged().catch(() => undefined));
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => void server.sendPromptListChanged().catch(() => undefined));
    });
    return api;
  };

  /** Runs a remote request; protocol errors keep their code, transport/auth errors become internal errors. */
  const relay = async <T>(fn: (client: Client) => Promise<T>, whenNoToken: () => T): Promise<T> => {
    const remote = getApi();
    if (!remote) {
      return whenNoToken();
    }
    try {
      return await remote.run(fn);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(ErrorCode.InternalError, error instanceof CliError ? error.message : String(error));
    }
  };

  const noToken = (): never => {
    throw new McpError(ErrorCode.InvalidRequest, NOT_LOGGED_IN);
  };

  server.setRequestHandler(ListToolsRequestSchema, () =>
    relay(
      async (client) => {
        const tools = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return { tools };
      },
      () => ({ tools: [] }),
    ),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const remote = getApi();
    if (!remote) {
      return textError(NOT_LOGGED_IN);
    }
    try {
      return (await remote.run((client) => client.callTool(request.params, undefined, { timeout: CALL_TIMEOUT_MS }))) as CallToolResult;
    } catch (error) {
      // A failed call is a tool-level failure the model can read, not a broken protocol.
      return textError(error instanceof Error ? error.message : String(error));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    relay((client) => client.listResources(request.params), () => ({ resources: [] })),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
    relay((client) => client.listResourceTemplates(request.params), () => ({ resourceTemplates: [] })),
  );
  server.setRequestHandler(ReadResourceRequestSchema, (request) => relay((client) => client.readResource(request.params), noToken));
  server.setRequestHandler(ListPromptsRequestSchema, (request) => relay((client) => client.listPrompts(request.params), () => ({ prompts: [] })));
  server.setRequestHandler(GetPromptRequestSchema, (request) => relay((client) => client.getPrompt(request.params), noToken));

  return {
    server,
    close: async () => {
      await api?.close();
      await server.close().catch(() => undefined);
    },
  };
}

/** Serves the bridge on stdio (or a given transport) until the client goes away. */
export async function runBridge(ctx: Context, transport: Transport = new StdioServerTransport()): Promise<void> {
  const bridge = createBridge(ctx);
  const finished = new Promise<void>((resolve) => {
    bridge.server.onclose = resolve;
  });
  if (transport instanceof StdioServerTransport) {
    process.stdin.once('end', () => void bridge.close());
  }
  await bridge.server.connect(transport);
  ctx.out.err('radiance mcp: ready on stdio.');
  // Nothing is cached: every tools/list reads the live remote list, so a list_changed needs no refresh step.
  await finished;
  await bridge.close();
}
