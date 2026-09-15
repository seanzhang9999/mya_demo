// If a native PreToolUse hook blocks this command, this file must never be written.
import fs from 'node:fs/promises';
const dir = new URL('../artifacts/', import.meta.url);
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(new URL('hook-canary-executed.json', dir),
  JSON.stringify({ executed: true, at: new Date().toISOString(), pid: process.pid }), { mode: 0o600 });
console.log('CANARY_EXECUTED: native interception was NOT established for this invocation');
