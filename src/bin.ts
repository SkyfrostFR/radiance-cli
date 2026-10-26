#!/usr/bin/env node
import { run } from './cli.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error [unexpected]: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
