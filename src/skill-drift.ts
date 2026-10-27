import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SkillFile {
  path: string;
  content: string;
}

export interface RemoteTool {
  name: string;
  inputSchema?: unknown;
}

export interface Drift {
  file: string;
  kind: 'tool' | 'mode';
  name: string;
}

export interface DriftReport {
  drift: Drift[];
  /** Modes the server offers that the skill never mentions: informational, not a failure. */
  undocumentedModes: string[];
  checkedTools: number;
  checkedModes: number;
}

/** Lip-sync grades exist but are wizard-only: the skill may say so without the tool listing them. */
const WIZARD_ONLY_MODES = new Set(['lip_sync', 'lip_sync_premium', 'lip_sync_pro']);
const TOOL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const MODE_FAMILY = /^(?:subtitles|voice|dubbing|lip)_[a-z_]+$/;
const IGNORE = '<!-- drift:ignore -->';

/** The skill and its references: `SKILL.md` plus every `.md` under `references/`. */
export function collectSkillFiles(dir: string): SkillFile[] {
  const files: SkillFile[] = [];
  const skill = join(dir, 'SKILL.md');
  if (existsSync(skill)) {
    files.push({ path: 'SKILL.md', content: readFileSync(skill, 'utf8') });
  }
  const references = join(dir, 'references');
  if (existsSync(references)) {
    for (const name of readdirSync(references).sort()) {
      if (name.endsWith('.md')) {
        files.push({ path: `references/${name}`, content: readFileSync(join(references, name), 'utf8') });
      }
    }
  }
  return files;
}

export function modesOf(tools: RemoteTool[]): string[] {
  const schema = tools.find((tool) => tool.name === 'start-translation')?.inputSchema as
    | { properties?: { mode?: { enum?: unknown } } }
    | undefined;
  const modes = schema?.properties?.mode?.enum;
  return Array.isArray(modes) ? modes.filter((mode): mode is string => typeof mode === 'string') : [];
}

interface Reference {
  kind: 'tool' | 'mode';
  name: string;
}

function referencesIn(content: string): Reference[] {
  const found: Reference[] = [];
  const fromCommand = (text: string): void => {
    for (const match of text.matchAll(/\bradiance\s+(?:call|tools)\s+([a-z][a-z0-9-]*)/g)) {
      found.push({ kind: 'tool', name: match[1] as string });
    }
    for (const match of text.matchAll(/--mode[ =]([a-z_]+)/g)) {
      found.push({ kind: 'mode', name: match[1] as string });
    }
  };
  let inFence = false;
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (line.includes(IGNORE)) {
      continue;
    }
    if (inFence) {
      fromCommand(line);
      continue;
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = (match[1] as string).trim();
      if (TOOL_NAME.test(token)) {
        found.push({ kind: 'tool', name: token });
      } else if (MODE_FAMILY.test(token) && !WIZARD_ONLY_MODES.has(token)) {
        found.push({ kind: 'mode', name: token });
      }
      fromCommand(token);
    }
  }
  return found;
}

/** Every tool and mode the skill cites must exist on the server the skill describes. */
export function checkDrift(files: SkillFile[], tools: RemoteTool[]): DriftReport {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const modes = new Set(modesOf(tools));
  const drift: Drift[] = [];
  const mentionedModes = new Set<string>();
  let checkedTools = 0;
  let checkedModes = 0;
  const seen = new Set<string>();

  for (const file of files) {
    for (const ref of referencesIn(file.content)) {
      if (ref.kind === 'mode') {
        mentionedModes.add(ref.name);
      }
      const key = `${file.path}|${ref.kind}|${ref.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (ref.kind === 'tool') {
        checkedTools++;
        if (!toolNames.has(ref.name)) {
          drift.push({ file: file.path, kind: 'tool', name: ref.name });
        }
      } else {
        checkedModes++;
        if (!modes.has(ref.name)) {
          drift.push({ file: file.path, kind: 'mode', name: ref.name });
        }
      }
    }
  }
  const undocumentedModes = [...modes].filter((mode) => !mentionedModes.has(mode));
  return { drift, undocumentedModes, checkedTools, checkedModes };
}

/** `tools/list` of a Radiance server, with a bearer token. */
export async function fetchRemoteTools(url: string, token: string): Promise<RemoteTool[]> {
  const client = new Client({ name: 'radiance-cli-skill-drift', version: '0.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}
