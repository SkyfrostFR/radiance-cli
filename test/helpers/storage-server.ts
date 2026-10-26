import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StorageServer {
  url: string;
  puts: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[];
  /** Fail this many PUTs with HTTP 500 before accepting. */
  failPuts: number;
  files: Map<string, Buffer>;
  close: () => Promise<void>;
}

/** Stands in for object storage: accepts presigned PUTs and serves presigned GETs. */
export async function startStorage(): Promise<StorageServer> {
  const state: StorageServer = {
    url: '',
    puts: [],
    failPuts: 0,
    files: new Map(),
    close: async () => undefined,
  };
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '/';
      if (req.method === 'PUT') {
        if (state.failPuts > 0) {
          state.failPuts--;
          res.writeHead(500).end();
          return;
        }
        state.puts.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200).end();
        return;
      }
      const file = state.files.get(path);
      if (req.method === 'GET' && file) {
        res.writeHead(200, { 'content-length': file.length, 'content-type': 'video/mp4' }).end(file);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return state;
}
