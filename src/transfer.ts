import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { CliError, ExitCode } from './errors.js';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
};

export interface LocalVideo {
  path: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Checks a local file before any network call: it exists, is a file, has a supported type. */
export async function inspectVideoFile(path: string): Promise<LocalVideo> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    throw new CliError('usage', `Not a file: ${path}`, ExitCode.Usage);
  }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (!contentType) {
    throw new CliError('usage', `Unsupported file type "${extname(path)}". Supported: ${Object.keys(CONTENT_TYPES).join(', ')}.`, ExitCode.Usage);
  }
  if (info.size === 0) {
    throw new CliError('usage', `File is empty: ${path}`, ExitCode.Usage);
  }
  return { path, filename: basename(path), contentType, size: info.size };
}

/**
 * Streams a file to a presigned URL with a single PUT. Never buffers the file: the body is a
 * web stream over a file stream, with an explicit Content-Length because object storage
 * refuses chunked uploads. No Authorization header: the signature is in the URL.
 */
export async function putFile(video: LocalVideo, url: string, onProgress: (sent: number) => void): Promise<void> {
  let sent = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      sent += chunk.length;
      onProgress(sent);
      done(null, chunk);
    },
  });
  const source = createReadStream(video.path);
  source.on('error', (error) => counter.destroy(error));
  source.pipe(counter);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': video.contentType, 'content-length': String(video.size) },
    body: Readable.toWeb(counter) as WebReadableStream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`storage answered HTTP ${response.status}`);
  }
}

const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** `<title>-<lang>.<ext>`, safe on Linux, macOS and Windows. */
export function safeFileName(title: string, language: string, extension: string): string {
  let base = title.normalize('NFC').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[.\s]+/, '').replace(/[. ]+$/, '');
  base = Array.from(base).slice(0, 100).join('').trim();
  if (base === '' || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) {
    base = 'video';
  }
  const lang = language.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'xx';
  const ext = extension.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  return `${base}-${lang}.${ext}`;
}

export function targetPath(directory: string, fileName: string, force: boolean): string {
  const path = join(resolve(directory), fileName);
  if (existsSync(path) && !force) {
    throw new CliError('file_exists', `${path} already exists. Use --force to overwrite it.`, ExitCode.Unexpected);
  }
  return path;
}

/** Streams a download to `<path>.part`, then renames: a failed transfer never leaves a truncated file. */
export async function downloadFile(url: string, path: string, onProgress: (received: number, total: number | undefined) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`storage answered HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  await mkdir(resolve(path, '..'), { recursive: true });
  const partial = `${path}.part`;
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      onProgress(received, total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), counter, createWriteStream(partial));
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
