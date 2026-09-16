import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../services/server.mjs";
import * as P from "../packages/protocol/core.mjs";
import { AgentSession, PhoneSession } from "../packages/protocol/session.mjs";
const PASSWORD = "a test only password 2026!";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "mya-accounts-"));
  const app = await createServer({ dir });
  const origin = await app.listen(0);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  function browser(identity) {
    let cookie = "";
    async function raw(path, data, withOrigin = true) {
      const r = await fetch(origin + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...(withOrigin ? { Origin: origin } : {}),
          Cookie: cookie,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      const out = await r.json();
      if (!r.ok) throw new P.Fault(out.code, r.status);
      return out;
    }
    async function envelope(path, values) {
      const data = { ...values, device_key: identity.user.publicKey };
      const c = await raw("/v1/account/challenge", {
        path,
        device_key: data.device_key,
      });
      const clean = Object.fromEntries(
        Object.entries(data).filter(
          ([k]) => !["password", "old_password", "new_password"].includes(k),
        ),
      );
      return {
        data,
        proof: await P.sign(
          {
            type: "AccountDeviceProof",
            challenge_id: c.id,
            nonce: c.nonce,
            path,
            origin,
            body_hash: await P.hash(JSON.stringify(clean)),
            ...P.stamp(60000, c.expires_at),
          },
          identity.user,
        ),
      };
    }
    const signed = async (path, v) => raw(path, await envelope(path, v));
    const client = new P.Client(origin, app.info());
    client.raw = raw;
    const phone = new PhoneSession(client, identity);
    return { raw, signed, envelope, identity, phone, client };
  }
  async function pair(b) {
    const agent = new AgentSession(
      new P.Client(origin, app.info()),
      await P.makeAgent(),
    );
    const inv = await agent.startPair();
    await b.phone.joinPair(inv.invite_id, agent.identity.sign.kid);
    await b.phone.confirmPair();
    await agent.confirmPair();
    await b.phone.pairStatus();
    return agent;
  }
  return { app, origin, browser, pair };
}
const credentials = (name = "testuser", device_name = "Primary phone") => ({
  username: name,
  password: PASSWORD,
  device_name,
});
test("password login preserves legacy bindings; pending/viewer cannot acquire signing rights; new-device consent and proof replay", async (t) => {
  const c = await setup(t),
    primary = c.browser(await P.makePhone()),
    secondary = c.browser(await P.makePhone());
  const agent = await c.pair(primary),
    bid = agent.binding().relation.binding_id;
  await primary.signed("/v1/account/register", credentials());
  const me = await primary.raw("/v1/account/me");
  assert.equal(me.bindings[0].binding_id, bid);
  assert.equal(me.device.role, "admin");
  const account = JSON.parse(
    c.app.db.prepare("SELECT data FROM kv WHERE kind='account'").get().data,
  );
  assert.notEqual(account.password.hash, PASSWORD);
  assert.equal(account.password.hash.length, 64);
  await assert.rejects(
    secondary.signed("/v1/account/login", {
      ...credentials(),
      password: "wrong password value",
    }),
    /LOGIN_FAILED/,
  );
  const login = await secondary.signed(
    "/v1/account/login",
    credentials("testuser", "Mac browser"),
  );
  assert.equal(login.status, "pending_device");
  assert.equal((await secondary.raw("/v1/account/me")).bindings.length, 0);
  await assert.rejects(
    secondary.signed("/v1/account/devices/approve", {
      device_id: login.device.id,
      role: "admin",
    }),
    /DEVICE_PENDING/,
  );
  const packet = await primary.envelope("/v1/account/devices/approve", {
    device_id: login.device.id,
    role: "viewer",
  });
  await primary.raw("/v1/account/devices/approve", packet);
  await assert.rejects(
    primary.raw("/v1/account/devices/approve", packet),
    /ACCOUNT_CHALLENGE/,
  );
  const view = await secondary.raw("/v1/account/me");
  assert.equal(view.bindings[0].binding_id, bid);
  await assert.rejects(c.pair(secondary), /DEVICE_SIGNING_NOT_ALLOWED/);
  await assert.rejects(
    secondary.signed("/v1/account/devices/revoke", {
      device_id: me.device.id,
      reason: "x",
    }),
    /DEVICE_ADMIN_REQUIRED/,
  );
  await assert.rejects(
    primary.raw("/v1/account/logout", {}, false),
    /ACCOUNT_ORIGIN_REQUIRED/,
  );
  await primary.raw("/v1/account/logout", {});
  await assert.rejects(
    primary.phone.assertActive(agent.binding().relation),
    /LOGIN_REQUIRED/,
  );
  await primary.signed("/v1/account/login", credentials());
  await primary.phone.assertActive(agent.binding().relation);
});
test("device revocation ends own relationships, cancels sessions and blocks prepared execution without affecting primary", async (t) => {
  const c = await setup(t),
    primary = c.browser(await P.makePhone()),
    other = c.browser(await P.makePhone());
  await primary.signed("/v1/account/register", credentials());
  const original = await c.pair(primary);
  const pending = await other.signed(
    "/v1/account/login",
    credentials("testuser", "Second phone"),
  );
  await primary.signed("/v1/account/devices/approve", {
    device_id: pending.device.id,
    role: "approver",
  });
  const agent = await c.pair(other);
  const report = JSON.stringify({
    project_id: "project-alpha",
    report_date: "2026-09-15",
    milestone_id: "prototype",
    status: "in_progress",
    completion_percent: 60,
  });
  const id = await agent.submit(report);
  await other.phone.poll();
  await other.phone.approve(id);
  await agent.poll();
  const result = await primary.signed("/v1/account/devices/revoke", {
    device_id: pending.device.id,
    reason: "lost device",
  });
  assert.equal(result.relationships_stopped, 1);
  await assert.rejects(
    other.raw("/v1/account/me"),
    /LOGIN_REQUIRED|DEVICE_REVOKED/,
  );
  await assert.rejects(
    other.signed("/v1/account/login", credentials("testuser", "Second phone")),
    /DEVICE_REVOKED/,
  );
  await assert.rejects(agent.execute(id), /BINDING_REVOKED/);
  await primary.phone.assertActive(original.binding().relation);
  const status = await agent.client.auth(
    "/v1/bindings/status",
    {},
    agent.identity.sign,
    agent.binding().relation.binding_id,
  );
  const v = await P.verify(status.status, c.app.info().witness);
  assert.equal(v.termination.type, "device_revoked");
  assert.equal(
    (await P.verify(v.termination.event, c.app.info().witness))
      .termination_type,
    "device_revoked",
  );
});
test("user revocation and agent withdrawal retain distinct signed actor evidence", async (t) => {
  const c = await setup(t),
    p = c.browser(await P.makePhone());
  const a = await c.pair(p),
    b = await c.pair(p);
  const out = await a.client.auth(
    "/v1/bindings/revoke",
    { reason: "uninstall" },
    a.identity.sign,
    a.binding().relation.binding_id,
  );
  assert.equal(out.termination.type, "agent_withdrawn");
  assert.equal(out.termination.actor_role, "agent");
  await p.phone.revoke(b.binding().relation.binding_id);
  const v = await b.client.auth(
    "/v1/bindings/status",
    {},
    b.identity.sign,
    b.binding().relation.binding_id,
  );
  assert.equal(
    (await P.verify(v.status, c.app.info().witness)).termination.type,
    "user_revoked",
  );
  const events = c.app.db
    .prepare("SELECT data FROM kv WHERE kind='relationship_event'")
    .all();
  assert.equal(events.length, 2);
  for (const row of events) assert.ok(JSON.parse(row.data).actor_proof);
});
test("account isolation, device-key substitution, pending-session limits and password rotation", async (t) => {
  const c = await setup(t),
    a = c.browser(await P.makePhone()),
    b = c.browser(await P.makePhone()),
    other = c.browser(await P.makePhone());
  await a.signed("/v1/account/register", credentials("alice"));
  await b.signed("/v1/account/register", credentials("bob"));
  const bm = await b.raw("/v1/account/me");
  await assert.rejects(
    a.signed("/v1/account/devices/revoke", {
      device_id: bm.device.id,
      reason: "x",
    }),
    /UNKNOWN_DEVICE/,
  );
  const packet = await a.envelope("/v1/account/password", {
    old_password: PASSWORD,
    new_password: "replacement password 2026!",
  });
  packet.data.device_key = b.identity.user.publicKey;
  await assert.rejects(
    a.raw("/v1/account/password", packet),
    /SIGNATURE|CHALLENGE/,
  );
  const pending = await other.signed(
    "/v1/account/login",
    credentials("alice", "another device"),
  );
  await a.signed("/v1/account/devices/approve", {
    device_id: pending.device.id,
    role: "viewer",
  });
  await a.signed("/v1/account/password", {
    old_password: PASSWORD,
    new_password: "replacement password 2026!",
  });
  await assert.rejects(other.raw("/v1/account/me"), /LOGIN_REQUIRED/);
  await assert.rejects(
    other.signed("/v1/account/login", credentials("alice", "another device")),
    /LOGIN_FAILED/,
  );
  assert.equal((await a.raw("/v1/account/me")).account.username, "alice");
});
