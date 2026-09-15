#!/usr/bin/env node
// Narrow integration guard, not a shell sandbox. See docs/CODEX_HOOK.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['relationship_signature', 'witness_signature', 'relationship_link',
  'relationship_time', 'request_integrity', 'grant_signature', 'grant_scope',
  'grant_time', 'live_status', 'not_cancelled'];

export async function evaluate(event, inspect) {
  if (event.hook_event_name !== 'PreToolUse') return { decision: 'ignore' };
  const command = event.tool_input?.command;
  if (typeof command !== 'string') return { decision: 'ignore' };
  // Canary is deliberately harmless even if the host has not loaded this hook.
  if (command.includes('scripts/mya-hook-canary.mjs'))
    return { decision: 'deny', code: 'MYA_HOOK_CANARY_BLOCKED' };
  // Supported, intentionally narrow command contract. Other shell syntax is NOT covered.
  const match = command.trim().match(/^(?:\/[^\s;|&]+\/)?mya execute --request ([a-f0-9-]{36}) --presentation$/);
  if (!match) return { decision: 'ignore' };
  const request_id = match[1];
  try {
    const report = await inspect(request_id);
    const checks = new Map(report.checks.map(c => [c.id, c.status]));
    const failed = [...new Set([...required.filter(id => checks.get(id) !== 'passed'),
      ...report.checks.filter(c => c.status !== 'passed').map(c => c.id)])];
    if (report.request_id !== request_id) failed.push('request_id');
    return failed.length
      ? { decision: 'deny', code: 'MYA_APPROVAL_REQUIRED', request_id, failed }
      : { decision: 'allow', code: 'MYA_APPROVAL_VERIFIED', request_id };
  } catch {
    return { decision: 'deny', code: 'MYA_VERIFICATION_UNAVAILABLE', request_id };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  let event;
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    event = JSON.parse(input);
    result = await evaluate(event, async request_id => {
      const out = await run(process.execPath, [path.join(repo, 'packages/cli/mya.mjs'),
        'inspect', '--request', request_id], { timeout: 25000, maxBuffer: 1024 * 1024 });
      return JSON.parse(out.stdout);
    });
  } catch { result = { decision: 'deny', code: 'MYA_HOOK_INPUT_ERROR' }; }
  if (result.decision !== 'ignore') {
    const log = path.join(repo, 'artifacts', 'hook-events.jsonl');
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.appendFile(log, JSON.stringify({ at: new Date().toISOString(),
      session_id: event?.session_id, tool_use_id: event?.tool_use_id, ...result }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: result.code + (result.request_id ? ` request=${result.request_id}` : '') +
        (result.failed ? ` checks=${result.failed.join(',')}` : '') } }));
  }
}
