import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => { text: string; isError?: boolean };
}

export interface FakeServerOptions {
  /** The only bearer token the server accepts. */
  token: string;
  tools: FakeTool[];
  /** Answer this many POSTs with HTTP 429 before behaving. */
  rateLimitHits?: number;
  retryAfter?: string;
}

export interface FakeServer {
  url: string;
  authorizations: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  postCount: () => number;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : JSON.parse(raw);
}

export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const authorizations: string[] = [];
  const toolCalls: FakeServer['toolCalls'] = [];
  let posts = 0;
  let rateLimitLeft = options.rateLimitHits ?? 0;

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      authorizations.push(String(req.headers.authorization ?? ''));
      if (req.method !== 'POST') {
        res.writeHead(req.method === 'DELETE' ? 200 : 405).end();
        return;
      }
      posts++;
      if (req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Unauthenticated.' }));
        return;
      }
      if (rateLimitLeft > 0) {
        rateLimitLeft--;
        res.writeHead(429, options.retryAfter ? { 'retry-after': options.retryAfter } : {}).end();
        return;
      }
      const body = await readBody(req);
      const server = new Server({ name: 'fake-radiance', version: '0.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: options.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description ?? '',
          inputSchema: { type: 'object' as const, ...(tool.inputSchema ?? {}) },
          annotations: tool.readOnly ? { readOnlyHint: true } : {},
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        const tool = options.tools.find((candidate) => candidate.name === request.params.name);
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        toolCalls.push({ name: request.params.name, args });
        if (!tool) {
          return { content: [{ type: 'text' as const, text: 'unknown' }], isError: true };
        }
        const out = tool.handler(args);
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError ?? false };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp/radiance`,
    authorizations,
    toolCalls,
    postCount: () => posts,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
