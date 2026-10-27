#!/usr/bin/env node
// Release-time check: every tool and mode the skill cites exists on a real Radiance server.
//   npm run build && RADIANCE_TOKEN=... npm run check:skill
// RADIANCE_URL defaults to production. Exit 0 = no drift, 1 = drift, 2 = misconfigured/unreachable.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkDrift, collectSkillFiles, fetchRemoteTools } from '../dist/skill-drift.js';

const url = process.env.RADIANCE_URL || 'https://radiance-app.com/mcp/radiance';
const token = process.env.RADIANCE_TOKEN;
if (!token) {
  console.error('Set RADIANCE_TOKEN (a token with the mcp:use ability).');
  process.exit(2);
}

const skillDir = resolve(fileURLToPath(import.meta.url), '..', '..', 'skills', 'radiance');
const files = collectSkillFiles(skillDir);
if (files.length === 0) {
  console.error(`No skill found in ${skillDir}.`);
  process.exit(2);
}

let tools;
try {
  tools = await fetchRemoteTools(url, token);
} catch (error) {
  console.error(`Could not read tools/list from ${url}: ${error instanceof Error ? error.message.replaceAll(token, '***') : 'unknown error'}`);
  process.exit(2);
}

const report = checkDrift(files, tools);
console.log(`${tools.length} tools on the server; skill cites ${report.checkedTools} tool reference(s) and ${report.checkedModes} mode reference(s).`);
for (const item of report.drift) {
  console.error(`DRIFT ${item.file}: ${item.kind} "${item.name}" does not exist on the server`);
}
if (report.undocumentedModes.length > 0) {
  console.log(`Note: modes the skill never mentions: ${report.undocumentedModes.join(', ')}`);
}
process.exit(report.drift.length > 0 ? 1 : 0);
