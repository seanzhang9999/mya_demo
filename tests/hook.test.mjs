import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/codex-approval-hook.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const event = command => ({ hook_event_name: 'PreToolUse', tool_input: { command } });
const command = `mya execute --request ${id} --presentation`;
const ids = ['relationship_signature','witness_signature','relationship_link','relationship_time',
  'request_integrity','grant_signature','grant_scope','grant_time','live_status','not_cancelled'];
const report = () => ({request_id:id, checks:ids.map(id=>({id,status:'passed'}))});
test('canary denies before any wallet access; unrelated commands are ignored', async()=>{
  const never=()=>{throw Error('must not run')};
  assert.equal((await evaluate(event('node scripts/mya-hook-canary.mjs'),never)).decision,'deny');
  assert.equal((await evaluate(event('git status'),never)).decision,'ignore');
});
test('missing, expired, revoked, mismatched or unavailable approvals deny',async()=>{
  for(const failed of ids) {
    const r=report();r.checks.find(c=>c.id===failed).status='failed';
    assert.equal((await evaluate(event(command),async()=>r)).decision,'deny',failed);
  }
  assert.equal((await evaluate(event(command),async()=>({request_id:id,checks:[]}))).decision,'deny');
  assert.equal((await evaluate(event(command),async()=>({...report(),request_id:'other'}))).decision,'deny');
  const paused=report();paused.checks.push({id:'policy_status',status:'failed'});
  assert.equal((await evaluate(event(command),async()=>paused)).decision,'deny');
  assert.equal((await evaluate(event(command),async()=>{throw Error('offline')})).decision,'deny');
});
test('fresh complete checks allow only the documented command shape',async()=>{
  assert.equal((await evaluate(event(command),async()=>report())).decision,'allow');
  assert.equal((await evaluate(event(command+'; echo extra'),async()=>report())).decision,'ignore');
});
