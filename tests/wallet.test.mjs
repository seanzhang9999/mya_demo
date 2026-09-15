import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../services/server.mjs";
import * as P from "../packages/protocol/core.mjs";
import { AgentSession, PhoneSession } from "../packages/protocol/session.mjs";
import {
  makePresentation,
  PRESENT_PATH,
} from "../packages/protocol/wallet.mjs";
const report = JSON.stringify({
  project_id: "project-alpha",
  report_date: "2026-09-15",
  milestone_id: "prototype",
  status: "in_progress",
  completion_percent: 60,
});
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "mya-wallet-"));
  let app = await createServer({ dir });
  const origin = await app.listen(0),
    port = app.server.address().port,
    trust = app.info();
  const agent = new AgentSession(
    new P.Client(origin, trust),
    await P.makeAgent(),
  );
  const phone = new PhoneSession(
    new P.Client(origin, trust),
    await P.makePhone(),
  );
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const inv = await agent.startPair();
  await phone.joinPair(inv.invite_id);
  await phone.confirmPair();
  await agent.confirmPair();
  await phone.pairStatus();
  const approve = async () => {
    const id = await agent.submit(report);
    await phone.poll();
    if (phone.state.records[id].status === "pending") await phone.approve(id);
    await agent.poll();
    return id;
  };
  const auth = (path, data) =>
    agent.client.auth(
      path,
      data,
      agent.identity.sign,
      agent.binding().relation.binding_id,
    );
  const body = async (id) =>
    makePresentation(
      agent.client,
      agent.identity,
      agent.binding(),
      agent.state.requests[id],
      await agent.challenge(id),
    );
  return {
    agent,
    phone,
    approve,
    auth,
    body,
    count: () => app.db.prepare("SELECT COUNT(*) n FROM executions").get().n,
    restart: async () => {
      await app.close();
      app = await createServer({ dir, origin });
      await app.listen(port);
    },
  };
}
test("wallet challenge, credential display, restart, execute and historical expiry", async (t) => {
  const c = await setup(t),
    id = await c.approve();
  const v = await c.agent.present(id);
  assert.equal(v.result, "verified");
  assert.equal(c.count(), 0);
  await c.restart();
  const out = await c.agent.execute(id, { presentation: true });
  assert.equal(out.data.transaction_id, v.transaction_id);
  assert.equal(c.count(), 1);
  await c.phone.poll();
  const audit = await c.phone.inspect(id);
  assert.ok(
    audit.checks.every((x) => x.status === "passed"),
    JSON.stringify(audit.checks),
  );
  assert.equal(audit.presentations[0].verification_id, v.verification_id);
  assert.equal(audit.credentials.grant.type, "ApprovalGrant");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 180000;
    const old = await c.agent.inspect(id);
    assert.equal(old.checks.find((x) => x.id === "grant_time").code, "EXPIRED");
    assert.equal(
      old.checks.find((x) => x.id === "grant_at_execution").status,
      "passed",
    );
    assert.equal(
      old.checks.find((x) => x.id === "grant_signature").status,
      "passed",
    );
  } finally {
    Date.now = realNow;
  }
});
test("presentation rejects changed credentials, wrong holder and transaction fields", async (t) => {
  const c = await setup(t),
    id = await c.approve(),
    body = await c.body(id);
  const send = (data) => c.auth(PRESENT_PATH, data);
  for (const field of [
    "nonce",
    "transaction_id",
    "audience",
    "response_uri",
    "action_hash",
    "context_hash",
    "request_id",
    "credentials_hash",
  ]) {
    const p = P.peek(body.presentation);
    p[field] += "-changed";
    await assert.rejects(
      send({ ...body, presentation: await P.sign(p, c.agent.identity.sign) }),
      /PRESENTATION_MISMATCH/,
    );
  }
  const stranger = await P.key();
  await assert.rejects(
    send({
      ...body,
      presentation: await P.sign(P.peek(body.presentation), stranger),
    }),
    /INVALID_SIGNATURE/,
  );
  const grant = body.credentials.grant;
  await assert.rejects(
    send({
      ...body,
      credentials: {
        ...body.credentials,
        grant: grant.slice(0, -8) + "xxxxxxxx",
      },
    }),
    /PRESENTATION_MISMATCH/,
  );
  const results = await Promise.allSettled([send(body), send(body)]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    results.find((x) => x.status === "rejected").reason.message,
    /CHALLENGE_REPLAY/,
  );
  assert.equal(c.count(), 0);
});
test("wallet refuses an untrusted challenge before making a network presentation", async (t) => {
  const c = await setup(t),
    id = await c.approve(),
    signed = await c.agent.challenge(id);
  const challenge = P.peek(signed);
  challenge.response_uri = "https://attacker.invalid/collect";
  const stranger = await P.key();
  let calls = 0;
  const fake = {
    ...c.agent.client,
    auth: async () => {
      calls++;
    },
  };
  await assert.rejects(
    makePresentation(
      fake,
      c.agent.identity,
      c.agent.binding(),
      c.agent.state.requests[id],
      await P.sign(challenge, stranger),
    ),
    /INVALID_SIGNATURE/,
  );
  // Even a correctly signed instruction cannot introduce an unconfigured endpoint.
  fake.trust = { ...fake.trust, resource: stranger.publicKey };
  await assert.rejects(
    makePresentation(
      fake,
      c.agent.identity,
      c.agent.binding(),
      c.agent.state.requests[id],
      await P.sign(challenge, stranger),
    ),
    /UNTRUSTED_PRESENTATION_REQUEST/,
  );
  assert.equal(calls, 0);
});
test("verification does not bypass later cancellation or binding revocation", async (t) => {
  const c = await setup(t),
    id = await c.approve();
  const v = await c.agent.present(id);
  await c.agent.cancel(id);
  await assert.rejects(
    c.auth("/v1/demo/reports/execute-verified", {
      transaction_id: v.transaction_id,
    }),
    /REQUEST_CANCELLED/,
  );
  const second = await c.approve();
  const v2 = await c.agent.present(second);
  await c.phone.revoke(c.agent.binding().relation.binding_id);
  await assert.rejects(
    c.auth("/v1/demo/reports/execute-verified", {
      transaction_id: v2.transaction_id,
    }),
    /BINDING_REVOKED/,
  );
  assert.equal(c.count(), 0);
});
test("automatic credentials cannot bypass a policy paused after presentation", async (t) => {
  const c = await setup(t),
    first = await c.approve();
  const policy = await c.phone.createPolicy(first, { uses: 1, seconds: 3600 });
  const id = await c.approve();
  await c.agent.present(id);
  await c.phone.pause(policy.data.delegation_id);
  await assert.rejects(
    c.agent.execute(id, { presentation: true }),
    /POLICY_INACTIVE/,
  );
  assert.equal(c.count(), 0);
});
test("expired holder proof or grant fails and cannot cause execution", async (t) => {
  const c = await setup(t),
    id = await c.approve(),
    body = await c.body(id);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 40000;
    await assert.rejects(c.auth(PRESENT_PATH, body), /EXPIRED/);
    Date.now = () => realNow() + 180000;
    await assert.rejects(c.agent.present(id), /EXPIRED/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(c.count(), 0);
});
