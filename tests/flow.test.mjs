import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../services/server.mjs";
import * as P from "../packages/protocol/core.mjs";
import { AgentSession, PhoneSession } from "../packages/protocol/session.mjs";
export const report = JSON.stringify({
  project_id: "project-alpha",
  report_date: "2026-09-15",
  milestone_id: "prototype",
  status: "in_progress",
  completion_percent: 60,
});
async function setup(t, acceptDemo = true) {
  const dir = await mkdtemp(join(tmpdir(), "mya-test-"));
  const app = await createServer({ dir, acceptDemo });
  const origin = await app.listen(0);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const trust = app.info(),
    a = await P.makeAgent(),
    p = await P.makePhone();
  const agent = new AgentSession(new P.Client(origin, trust), a),
    phone = new PhoneSession(new P.Client(origin, trust), p);
  const inv = await agent.startPair();
  const ps = await phone.joinPair(inv.invite_id, a.sign.kid);
  const as = await agent.pairStatus();
  assert.equal(ps.sas, as.sas);
  await phone.confirmPair();
  await agent.confirmPair();
  await phone.pairStatus();
  return { app, origin, agent, phone, r: agent.binding().relation };
}
async function approved(c) {
  const id = await c.agent.submit(report);
  await c.phone.poll();
  await c.phone.approve(id);
  await c.agent.poll();
  return id;
}
test("strict parsing, non-exportable keys, real JWS/JWE and tampering", async () => {
  assert.throws(() => P.parse('{"a":1,"a":2}'), /DUPLICATE/);
  const p = await P.makePhone();
  assert.equal(p.user.privateKey.extractable, false);
  const s = await P.sign({ n: 3 }, p.user);
  assert.deepEqual(
    await P.verify(
      await P.decrypt(await P.encrypt(s, p.encryption.publicKey), p.encryption),
      p.user.publicKey,
    ),
    { n: 3 },
  );
  await assert.rejects(
    P.verify(s.slice(0, -8) + "xxxxxxxx", p.user.publicKey),
    /INVALID_SIGNATURE/,
  );
});
test("pair → modify → manual approval → verified receipt → review", async (t) => {
  const c = await setup(t);
  const first = await c.agent.submit("内部成本 120000", {
    media: "text/markdown",
  });
  await c.phone.poll();
  assert.equal(c.phone.state.records[first].analysis.recommendation, "modify");
  await c.phone.decide(first, "changes_requested", "移除成本");
  await c.agent.poll();
  assert.equal(c.agent.state.requests[first].status, "changes_requested");
  await assert.rejects(c.agent.execute(first), /NOT_APPROVED/);
  const second = await c.agent.submit(report, { supersedes: first });
  await c.phone.poll();
  await c.phone.approve(second);
  await c.agent.poll();
  const out = await c.agent.execute(second);
  assert.equal(out.data.result, "delivered_to_demo_inbox");
  await c.phone.poll();
  assert.equal(c.phone.state.records[second].execution, "succeeded");
  assert.equal(c.phone.state.records[second].q.supersedes_request_id, first);
  assert.equal(
    P.peek(c.phone.state.records[second].grant).user_verification,
    "simulated",
  );
});
test("no grant, altered target and payload rejected; concurrent replay has one effect", async (t) => {
  const c = await setup(t),
    id = await approved(c),
    rec = c.agent.state.requests[id],
    auth = (data) =>
      c.agent.client.auth(
        "/v1/demo/reports",
        data,
        c.agent.identity.sign,
        c.r.binding_id,
      );
  await assert.rejects(
    auth({
      request_jws: rec.bundle.request_jws,
      payload_b64: rec.bundle.payload_b64,
    }),
    /MISSING_FIELD/,
  );
  await assert.rejects(
    auth({
      request_jws: rec.bundle.request_jws,
      payload_b64: P.b64(P.enc.encode("changed")),
      grant: rec.grant,
    }),
    /PAYLOAD_MISMATCH/,
  );
  const q = P.peek(rec.bundle.request_jws),
    a = P.decode(q.action_b64);
  a.recipient_id = "supplier-b";
  q.action_b64 = P.encode(a);
  q.action_hash = await P.hash(P.unb64(q.action_b64));
  await assert.rejects(
    auth({
      request_jws: await P.sign(q, c.agent.identity.sign),
      payload_b64: rec.bundle.payload_b64,
      grant: rec.grant,
    }),
    /GRANT_MISMATCH/,
  );
  const body = {
    request_jws: rec.bundle.request_jws,
    payload_b64: rec.bundle.payload_b64,
    grant: rec.grant,
  };
  const results = await Promise.all([auth(body), auth(body)]);
  assert.equal(
    P.peek(results[0].receipt).execution_id,
    P.peek(results[1].receipt).execution_id,
  );
  assert.equal(
    c.app.db.prepare("SELECT COUNT(*) AS n FROM executions").get().n,
    1,
  );
});
test("explicit delegation → automatic approval; target exception; pause blocks issued grant", async (t) => {
  const c = await setup(t);
  const first = await approved(c);
  await c.agent.execute(first);
  await c.phone.poll();
  const policy = await c.phone.createPolicy(first, { uses: 3, seconds: 3600 });
  const second = await c.agent.submit(report);
  await c.phone.poll();
  assert.equal(c.phone.state.records[second].mode, "policy_auto");
  await c.agent.poll();
  await c.agent.execute(second);
  const other = await c.agent.submit(report, { recipient: "supplier-b" });
  await c.phone.poll();
  assert.equal(c.phone.state.records[other].status, "pending");
  const third = await c.agent.submit(report);
  await c.phone.poll();
  await c.agent.poll();
  await c.phone.pause(policy.data.delegation_id);
  await assert.rejects(c.agent.execute(third), /POLICY_INACTIVE/);
});
test("policy quota and strict payload schema independently enforced by resource", async (t) => {
  const c = await setup(t),
    first = await approved(c),
    policy = await c.phone.createPolicy(first, { uses: 1, seconds: 3600 });
  const second = await c.agent.submit(report);
  await c.phone.poll();
  await c.agent.poll();
  await c.agent.execute(second);
  const third = await c.agent.submit(report);
  await c.phone.poll();
  assert.equal(c.phone.state.records[third].status, "pending");
  const rec = c.agent.state.requests[third],
    q = P.peek(rec.bundle.request_jws);
  const forged = await P.grant(c.phone.identity, c.r, q, { policy });
  await assert.rejects(
    c.agent.client.auth(
      "/v1/demo/reports",
      {
        request_jws: rec.bundle.request_jws,
        payload_b64: rec.bundle.payload_b64,
        grant: forged,
        delegation: policy.jws,
      },
      c.agent.identity.sign,
      c.r.binding_id,
    ),
    /POLICY_LIMIT_REACHED/,
  );
  const unsafe = JSON.parse(report);
  unsafe.internal_cost = 100;
  const bad = await c.agent.submit(JSON.stringify(unsafe));
  await c.phone.poll();
  assert.equal(c.phone.state.records[bad].status, "pending");
});
test("cancel, revoke and untrusted keys fail closed", async (t) => {
  const c = await setup(t),
    id = await approved(c);
  await c.agent.cancel(id);
  const rec = c.agent.state.requests[id];
  await assert.rejects(
    c.agent.client.auth(
      "/v1/demo/reports",
      {
        request_jws: rec.bundle.request_jws,
        payload_b64: rec.bundle.payload_b64,
        grant: rec.grant,
      },
      c.agent.identity.sign,
      c.r.binding_id,
    ),
    /REQUEST_CANCELLED/,
  );
  const stranger = await P.key();
  await assert.rejects(
    c.agent.client.auth("/v1/relay/poll", {}, stranger, c.r.binding_id),
    /INVALID_AUTH/,
  );
  await c.phone.revoke(c.r.binding_id);
  await assert.rejects(c.agent.submit(report), /BINDING_REVOKED/);
});
test("non-demo resource refuses simulated assurance", async (t) => {
  const c = await setup(t, false),
    id = await approved(c);
  await assert.rejects(c.agent.execute(id), /DEMO_ASSURANCE_DISABLED/);
});
test("resource persists keys, bindings, consumed grants and receipt across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mya-restart-"));
  let app = await createServer({ dir });
  let origin = await app.listen(0);
  const port = app.server.address().port;
  const a = new AgentSession(
      new P.Client(origin, app.info()),
      await P.makeAgent(),
    ),
    p = new PhoneSession(new P.Client(origin, app.info()), await P.makePhone());
  const inv = await a.startPair();
  await p.joinPair(inv.invite_id);
  await p.confirmPair();
  await a.confirmPair();
  await p.pairStatus();
  const id = await a.submit(report);
  await p.poll();
  await p.approve(id);
  await a.poll();
  const done = await a.execute(id);
  await app.close();
  app = await createServer({ dir, origin });
  await app.listen(port);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await a.client.info();
  const q = await a.query(id);
  assert.equal(q.data.execution_id, done.data.execution_id);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM executions").get().n, 1);
});

test("expired grant is rejected; expired queued request is recorded without blocking the next request", async (t) => {
  const c = await setup(t),
    rid = await approved(c),
    rec = c.agent.state.requests[rid];
  const g = P.peek(rec.grant);
  g.issued_at = P.now() - 20000;
  g.expires_at = P.now() - 1000;
  await assert.rejects(
    c.agent.client.auth(
      "/v1/demo/reports",
      {
        request_jws: rec.bundle.request_jws,
        payload_b64: rec.bundle.payload_b64,
        grant: await P.sign(g, c.phone.identity.user),
      },
      c.agent.identity.sign,
      c.r.binding_id,
    ),
    /EXPIRED/,
  );
  const bundle = await P.requestBundle(c.agent.identity, c.r, report);
  const q = P.peek(bundle.request_jws);
  q.issued_at = P.now() - 610000;
  q.expires_at = P.now() - 10000;
  bundle.request_jws = await P.sign(q, c.agent.identity.sign);
  const message = await P.seal(
    "approval.request",
    bundle,
    c.r,
    c.agent.identity,
    true,
  );
  await c.agent.client.auth(
    "/v1/relay/send",
    message,
    c.agent.identity.sign,
    c.r.binding_id,
  );
  await c.phone.poll();
  assert.equal(c.phone.state.records[q.request_id].status, "expired");
  const fresh = await c.agent.submit(report);
  await c.phone.poll();
  assert.equal(c.phone.state.records[fresh].status, "pending");
});
