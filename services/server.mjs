import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { importJWK, exportJWK } from "jose";
import * as P from "../packages/protocol/core.mjs";
import { verifyAuthorization } from "../packages/protocol/authorization.mjs";
import {
  PRESENT_PATH,
  presentationChecks,
  verifyChallenge,
} from "../packages/protocol/wallet.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function createServer({
  dir = resolve(ROOT, ".data"),
  origin = null,
  acceptDemo = true,
} = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const keyfile = resolve(dir, "server-keys.json");
  let keys;
  try {
    keys = JSON.parse(await readFile(keyfile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const w = await P.key(false, true),
      r = await P.key(false, true);
    keys = {
      witness: await exportJWK(w.privateKey),
      resource: await exportJWK(r.privateKey),
    };
    await writeFile(keyfile, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  }
  const load = async (jwk) => {
    const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    return {
      privateKey: await importJWK(jwk, "ES256"),
      publicKey: pub,
      kid: await P.thumb(pub),
    };
  };
  const witness = await load(keys.witness),
    resource = await load(keys.resource);
  const db = new DatabaseSync(resolve(dir, "mya.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS executions (request_id TEXT PRIMARY KEY, grant_id TEXT UNIQUE, binding_id TEXT, action_hash TEXT, data TEXT NOT NULL);",
  );
  const get = (k, i) => {
    const x = db.prepare("SELECT data FROM kv WHERE kind=? AND id=?").get(k, i);
    return x ? JSON.parse(x.data) : null;
  };
  const put = (k, i, v) =>
    db
      .prepare(
        "INSERT INTO kv VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(k, i, JSON.stringify(v));
  const all = (k) =>
    db
      .prepare("SELECT id,data FROM kv WHERE kind=?")
      .all(k)
      .map((x) => ({ id: x.id, ...JSON.parse(x.data) }));
  const del = (k, i) =>
    db.prepare("DELETE FROM kv WHERE kind=? AND id=?").run(k, i);
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const bind = (id) => {
    const b = get("binding", id);
    P.check(b, "UNKNOWN_BINDING", 404);
    return b;
  };
  const active = (b) =>
    P.check(
      b.status === "active" && b.relation.expires_at > P.now(),
      "BINDING_REVOKED",
      403,
    );
  const rates = new Map();
  let actualOrigin = origin;
  const rate = (ip, limit = 500) => {
    let x = rates.get(ip);
    if (!x || P.now() - x.at > 60000) {
      if (rates.size > 10000) rates.clear();
      x = { at: P.now(), n: 0 };
      rates.set(ip, x);
    }
    P.check(++x.n <= limit, "RATE_LIMITED", 429);
  };
  const info = () => ({
    protocol_version: P.VERSION,
    origin: actualOrigin,
    witness: witness.publicKey,
    resource: resource.publicKey,
    company: P.COMPANY,
    environment: "demo",
    accept_demo_assurance: acceptDemo,
    capabilities: ["credential-inspection", "challenge-presentation/1"],
  });
  async function authenticate(path, body) {
    P.fields(body, ["data", "proof"]);
    const p = P.peek(body.proof),
      c = get("challenge", p.challenge_id);
    P.check(
      c && c.expires_at > P.now() && !c.used && c.path === path,
      "INVALID_CHALLENGE",
      401,
    );
    const b = bind(c.binding_id);
    const publics = {
      agent: b.relation.agent.sign,
      phone: b.relation.phone.phone,
      user: b.relation.phone.user,
    };
    let role;
    for (const [r, k] of Object.entries(publics))
      if ((await P.thumb(k)) === c.kid) role = r;
    P.check(role, "INVALID_ROLE", 403);
    await P.verify(body.proof, publics[role]);
    P.fields(p, [
      "challenge_id",
      "nonce",
      "binding_id",
      "kid",
      "method",
      "path",
      "audience",
      "body_hash",
      "issued_at",
      "expires_at",
    ]);
    P.validTime(p, 30000);
    P.check(
      p.nonce === c.nonce &&
        p.binding_id === c.binding_id &&
        p.kid === c.kid &&
        p.method === "POST" &&
        p.path === path &&
        p.audience === P.AUD &&
        p.body_hash === (await P.hash(JSON.stringify(body.data))),
      "PROOF_MISMATCH",
      401,
    );
    tx(() => {
      const latest = get("challenge", p.challenge_id);
      P.check(
        !latest.used && latest.expires_at > P.now(),
        "CHALLENGE_REPLAY",
        401,
      );
      put("challenge", p.challenge_id, { ...latest, used: true });
    });
    return { b, role, data: body.data };
  }
  async function complete(pair) {
    if (!pair.phone_signature || !pair.agent_confirmation) return pair;
    const rel = await P.relation(pair.invite, pair.join);
    const signed = await P.verify(pair.phone_signature, rel.phone.user);
    P.check(
      JSON.stringify(signed) === JSON.stringify(rel),
      "TRANSCRIPT_MISMATCH",
    );
    const ack = await P.verify(pair.agent_confirmation, rel.agent.sign);
    P.check(
      ack.type === "PairConfirmation" &&
        ack.relationship_payload_hash === (await P.hash(JSON.stringify(rel))) &&
        ack.invite_id === rel.binding_id,
      "TRANSCRIPT_MISMATCH",
    );
    P.validTime(ack, 300000);
    const wc = {
      type: "BindingWitnessCredential",
      binding_id: rel.binding_id,
      relationship_hash: await P.hash(pair.phone_signature),
      agent_confirmation_hash: await P.hash(pair.agent_confirmation),
      checks: [
        "user_signature_valid",
        "agent_key_possession_valid",
        "transcripts_match",
        "invitation_consumed",
      ],
      issued_at: P.now(),
      expires_at: rel.expires_at,
    };
    const credentials = {
      relationship: pair.phone_signature,
      witness: await P.sign(wc, witness),
    };
    return tx(() => {
      const latest = get("pair", pair.id);
      if (latest.credentials) return latest;
      P.check(latest.invite.expires_at > P.now(), "PAIRING_EXPIRED");
      const result = { ...pair, credentials };
      put("pair", pair.id, result);
      put("binding", rel.binding_id, {
        relation: rel,
        credentials,
        status: "active",
      });
      return result;
    });
  }
  async function api(path, body, method, ip) {
    if (path === "/healthz") return { ok: true, protocol_version: P.VERSION };
    if (path === "/v1/server-info") return info();
    if (path === "/v1/pairings" && method === "POST") {
      P.fields(body, ["invite"]);
      const inv = P.peek(body.invite);
      P.fields(inv, [
        "type",
        "invite_id",
        "agent",
        "origin",
        "issued_at",
        "expires_at",
        "nonce",
      ]);
      P.fields(inv.agent, ["name", "sign", "encryption"]);
      P.check(
        inv.type === "PairInvitation" &&
          typeof inv.invite_id === "string" &&
          inv.invite_id.length >= 32 &&
          inv.origin === actualOrigin,
        "INVALID_INVITATION",
      );
      await P.verify(body.invite, inv.agent.sign);
      await P.thumb(inv.agent.encryption);
      P.validTime(inv, 300000);
      P.check(!get("pair", inv.invite_id), "PAIRING_EXISTS", 409);
      const code = P.id().replaceAll("-", "").slice(0, 8).toUpperCase();
      const pair = {
        id: inv.invite_id,
        invite: inv,
        invite_jws: body.invite,
        code,
        join: null,
      };
      put("pair", pair.id, pair);
      return { invite_id: pair.id, code };
    }
    if (path === "/v1/pairings/lookup" && method === "POST") {
      P.fields(body, ["code"]);
      rate(ip + ":lookup", 10);
      const pair = all("pair").find(
        (p) =>
          p.code === String(body.code).toUpperCase() &&
          p.invite.expires_at > P.now() &&
          !p.credentials,
      );
      P.check(pair, "PAIRING_NOT_FOUND", 404);
      return { invite_id: pair.id };
    }
    const match = path.match(
      /^\/v1\/pairings\/([a-zA-Z0-9-]+)(?:\/(join|confirm))?$/,
    );
    if (match) {
      let pair = get("pair", match[1]);
      P.check(pair, "PAIRING_NOT_FOUND", 404);
      if (!match[2]) {
        P.check(
          pair.invite.expires_at > P.now() || pair.credentials,
          "PAIRING_EXPIRED",
        );
        return pair;
      }
      P.check(
        pair.invite.expires_at > P.now() && !pair.credentials,
        "PAIRING_EXPIRED",
      );
      if (match[2] === "join") {
        P.fields(body, ["join"]);
        const j = P.peek(body.join);
        P.fields(j, [
          "type",
          "invite_id",
          "phone",
          "issued_at",
          "expires_at",
          "nonce",
        ]);
        P.fields(j.phone, ["user", "phone", "auto", "encryption"]);
        P.check(
          j.type === "PhoneJoin" && j.invite_id === pair.id,
          "INVALID_JOIN",
        );
        await P.verify(body.join, j.phone.phone);
        for (const k of Object.values(j.phone)) await P.thumb(k);
        P.validTime(j, 300000);
        tx(() => {
          pair = get("pair", pair.id);
          P.check(
            !pair.join || JSON.stringify(pair.join) === JSON.stringify(j),
            "PAIRING_ALREADY_JOINED",
            409,
          );
          put("pair", pair.id, { ...pair, join: j });
        });
        return { ok: true };
      }
      P.fields(body, ["role", "signature"]);
      P.check(pair.join, "PHONE_NOT_JOINED");
      const rel = await P.relation(pair.invite, pair.join);
      if (body.role === "phone") {
        const signed = await P.verify(body.signature, rel.phone.user);
        P.check(
          JSON.stringify(signed) === JSON.stringify(rel),
          "TRANSCRIPT_MISMATCH",
        );
        pair.phone_signature = body.signature;
      } else {
        P.check(body.role === "agent");
        const ack = await P.verify(body.signature, rel.agent.sign);
        P.check(
          ack.type === "PairConfirmation" &&
            ack.invite_id === pair.id &&
            ack.relationship_payload_hash ===
              (await P.hash(JSON.stringify(rel))),
          "TRANSCRIPT_MISMATCH",
        );
        P.validTime(ack, 300000);
        pair.agent_confirmation = body.signature;
      }
      pair = tx(() => {
        const current = get("pair", pair.id);
        P.check(!current.credentials, "PAIRING_CONSUMED");
        const next = {
          ...current,
          ...(body.role === "phone"
            ? { phone_signature: body.signature }
            : { agent_confirmation: body.signature }),
        };
        put("pair", pair.id, next);
        return next;
      });
      return complete(pair);
    }
    if (path === "/v1/auth/challenges") {
      P.fields(body, ["binding_id", "kid", "path"]);
      const b = bind(body.binding_id);
      const kids = await Promise.all(
        [
          b.relation.agent.sign,
          b.relation.phone.phone,
          b.relation.phone.user,
        ].map(P.thumb),
      );
      P.check(
        kids.includes(body.kid) &&
          typeof body.path === "string" &&
          body.path.startsWith("/v1/"),
        "INVALID_AUTH",
      );
      const c = {
        id: P.id(),
        nonce: P.id(),
        binding_id: body.binding_id,
        kid: body.kid,
        path: body.path,
        expires_at: P.now() + 30000,
        used: false,
      };
      put("challenge", c.id, c);
      return c;
    }
    const authenticated = await authenticate(path, body);
    const { b, role } = authenticated,
      bid = b.relation.binding_id;
    let data = authenticated.data,
      verifiedTransaction = null;
    if (path === "/v1/wallet/status") {
      P.fields(data, ["request_id", "delegation_id"]);
      const policy = data.delegation_id
        ? get("delegation", data.delegation_id)
        : null;
      P.check(!policy || policy.data.binding_id === bid, "UNKNOWN_DELEGATION");
      const presentations = all("presentation")
        .filter(
          (x) =>
            x.binding_id === bid &&
            x.request_id === data.request_id &&
            x.result,
        )
        .map((x) => x.result);
      return {
        status: await P.sign(
          {
            type: "WalletStatus",
            binding_id: bid,
            request_id: data.request_id,
            binding_status: b.status,
            cancelled: !!get("cancel", bid + ":" + data.request_id),
            delegation_status: policy?.status || null,
            presentations,
            ...P.stamp(30000),
          },
          resource,
        ),
      };
    }
    if (path === "/v1/bindings/status")
      return {
        status: await P.sign(
          {
            type: "BindingStatus",
            binding_id: bid,
            status: b.status,
            ...P.stamp(30000),
          },
          witness,
        ),
      };
    if (path === "/v1/bindings/revoke") {
      P.check(["user", "agent"].includes(role), "INVALID_ROLE", 403);
      put("binding", bid, { ...b, status: "revoked" });
      return { status: "revoked" };
    }
    if (path === "/v1/demo/executions/query") {
      P.fields(data, ["request_id"]);
      const row = db
        .prepare(
          "SELECT data FROM executions WHERE request_id=? AND binding_id=?",
        )
        .get(data.request_id, bid);
      return row
        ? { receipt: await P.sign(JSON.parse(row.data).receipt, resource) }
        : { receipt: null };
    }
    active(b);
    const currentAuthorization = (q, g, d, delegation) => {
      active(bind(bid));
      P.validTime(q, 600000);
      P.validTime(g, 120000);
      P.check(!get("cancel", bid + ":" + q.request_id), "REQUEST_CANCELLED");
      if (d) {
        P.validTime(d, 86400000);
        const current = get("delegation", d.delegation_id);
        P.check(
          current?.status === "active" && current.jws === delegation,
          "POLICY_INACTIVE",
        );
        P.check(current.executions < d.max_approvals, "POLICY_LIMIT_REACHED");
      }
    };
    if (path === "/v1/demo/reports/prepare") {
      P.check(role === "agent", "INVALID_ROLE");
      P.fields(data, ["request_jws", "payload_b64"]);
      const { q } = await P.verifyRequest(data, b.relation, { context: false });
      P.check(!get("cancel", bid + ":" + q.request_id), "REQUEST_CANCELLED");
      P.check(
        all("presentation").filter(
          (x) => x.binding_id === bid && x.expires_at > P.now(),
        ).length < 20,
        "CHALLENGE_LIMIT",
        429,
      );
      const lifetime = P.stamp(120000);
      const c = {
        type: "PresentationChallenge",
        transaction_id: P.id(),
        nonce: P.id(),
        binding_id: bid,
        agent_key_id: q.agent_key_id,
        request_id: q.request_id,
        action_hash: q.action_hash,
        context_hash: q.context_hash,
        audience: actualOrigin,
        response_uri: actualOrigin + PRESENT_PATH,
        issued_at: lifetime.issued_at,
        expires_at: Math.min(q.expires_at, lifetime.expires_at),
      };
      const challenge = await P.sign(c, resource);
      put("presentation", c.transaction_id, {
        ...c,
        challenge,
        bundle: data,
        used: false,
      });
      return { challenge };
    }
    if (path === PRESENT_PATH) {
      P.check(role === "agent", "INVALID_ROLE");
      P.check(acceptDemo, "DEMO_ASSURANCE_DISABLED", 403);
      P.fields(data, ["challenge", "credentials", "presentation"]);
      P.fields(
        data.credentials,
        ["relationship", "witness", "grant", "delegation"],
        ["relationship", "witness", "grant"],
      );
      const hint = P.peek(data.challenge),
        stored = get("presentation", hint.transaction_id);
      P.check(
        stored &&
          stored.binding_id === bid &&
          stored.challenge === data.challenge,
        "INVALID_CHALLENGE",
      );
      const q = P.peek(stored.bundle.request_jws);
      const c = await verifyChallenge(
        data.challenge,
        { origin: actualOrigin, trust: { resource: resource.publicKey } },
        b,
        q,
        await P.thumb(b.relation.agent.sign),
      );
      P.check(!stored.used, "CHALLENGE_REPLAY");
      const rel = await P.verifyCredentials(data.credentials, {
        witness: witness.publicKey,
      });
      P.check(
        JSON.stringify(rel) === JSON.stringify(b.relation) &&
          data.credentials.relationship === b.credentials.relationship &&
          data.credentials.witness === b.credentials.witness,
        "CREDENTIAL_MISMATCH",
      );
      const p = await P.verify(data.presentation, b.relation.agent.sign);
      P.fields(p, [
        "type",
        "transaction_id",
        "nonce",
        "binding_id",
        "request_id",
        "action_hash",
        "context_hash",
        "audience",
        "response_uri",
        "credentials_hash",
        "issued_at",
        "expires_at",
      ]);
      P.validTime(p, 30000);
      for (const field of [
        "transaction_id",
        "nonce",
        "binding_id",
        "request_id",
        "action_hash",
        "context_hash",
        "audience",
        "response_uri",
      ])
        P.check(p[field] === c[field], "PRESENTATION_MISMATCH");
      P.check(
        p.type === "CredentialPresentation" &&
          p.expires_at <= c.expires_at &&
          p.credentials_hash ===
            (await P.hash(JSON.stringify(data.credentials))),
        "PRESENTATION_MISMATCH",
      );
      const auth = {
        ...stored.bundle,
        grant: data.credentials.grant,
        ...(data.credentials.delegation
          ? { delegation: data.credentials.delegation }
          : {}),
      };
      const { g, d } = await verifyAuthorization(auth, b.relation);
      P.check(p.expires_at <= g.expires_at, "PRESENTATION_MISMATCH");
      const result = {
        type: "CredentialVerificationResult",
        verification_id: P.id(),
        transaction_id: c.transaction_id,
        binding_id: bid,
        request_id: q.request_id,
        action_hash: q.action_hash,
        context_hash: q.context_hash,
        audience: actualOrigin,
        credentials_hash: p.credentials_hash,
        presentation_hash: await P.hash(data.presentation),
        result: "verified",
        checks: presentationChecks,
        issued_at: P.now(),
        expires_at: Math.min(
          c.expires_at,
          g.expires_at,
          d?.expires_at || Infinity,
        ),
      };
      const signed = await P.sign(result, resource);
      tx(() => {
        const latest = get("presentation", c.transaction_id);
        P.check(latest && !latest.used, "CHALLENGE_REPLAY");
        P.validTime(c, 120000);
        P.validTime(p, 30000);
        currentAuthorization(q, g, d, auth.delegation);
        put("presentation", c.transaction_id, {
          ...latest,
          used: true,
          auth,
          result,
          result_jws: signed,
        });
      });
      return { verification: signed };
    }
    if (path === "/v1/demo/reports/execute-verified") {
      P.fields(data, ["transaction_id"]);
      verifiedTransaction = get("presentation", data.transaction_id);
      P.check(
        verifiedTransaction?.binding_id === bid && verifiedTransaction.result,
        "PRESENTATION_REQUIRED",
      );
      P.validTime(verifiedTransaction.result, 120000);
      data = verifiedTransaction.auth;
    }
    if (path === "/v1/relay/send") {
      P.fields(data, ["message_id", "to", "ciphertext"]);
      P.check(role !== "user", "INVALID_ROLE");
      const to =
        role === "agent"
          ? await P.thumb(b.relation.phone.phone)
          : await P.thumb(b.relation.agent.sign);
      P.check(
        data.to === to &&
          typeof data.ciphertext === "string" &&
          data.ciphertext.length < 700000,
        "INVALID_MESSAGE",
      );
      const prev = get("message", data.message_id);
      if (prev) {
        P.check(
          prev.ciphertext === data.ciphertext && prev.binding_id === bid,
          "MESSAGE_CONFLICT",
          409,
        );
        return { ok: true };
      }
      P.check(
        all("message").filter((m) => m.binding_id === bid).length < 100,
        "QUEUE_FULL",
        429,
      );
      put("message", data.message_id, {
        ...data,
        binding_id: bid,
        expires_at: P.now() + 86400000,
      });
      return { ok: true };
    }
    if (path === "/v1/relay/poll") {
      P.check(role !== "user", "INVALID_ROLE");
      const own =
        role === "agent"
          ? await P.thumb(b.relation.agent.sign)
          : await P.thumb(b.relation.phone.phone);
      return {
        messages: all("message")
          .filter(
            (m) =>
              m.binding_id === bid && m.to === own && m.expires_at > P.now(),
          )
          .slice(0, 30),
      };
    }
    if (path === "/v1/relay/ack") {
      P.fields(data, ["message_id"]);
      const m = get("message", data.message_id),
        own =
          role === "agent"
            ? await P.thumb(b.relation.agent.sign)
            : await P.thumb(b.relation.phone.phone);
      P.check(
        role !== "user" && (!m || (m.binding_id === bid && m.to === own)),
        "INVALID_ROLE",
      );
      if (m) del("message", data.message_id);
      return { ok: true };
    }
    if (path === "/v1/requests/cancel") {
      P.fields(data, ["request_id"]);
      P.check(["agent", "user"].includes(role), "INVALID_ROLE");
      put("cancel", bid + ":" + data.request_id, { at: P.now() });
      return { status: "cancelled" };
    }
    if (path === "/v1/delegations") {
      P.fields(data, ["jws"]);
      P.check(role === "phone", "INVALID_ROLE");
      P.check(acceptDemo, "DEMO_ASSURANCE_DISABLED", 403);
      const d = await P.validateDelegation(data.jws, b.relation);
      const prev = get("delegation", d.delegation_id);
      if (prev) P.check(prev.jws === data.jws, "DELEGATION_CONFLICT");
      else
        put("delegation", d.delegation_id, {
          data: d,
          jws: data.jws,
          status: "active",
          executions: 0,
        });
      return {
        confirmation: await P.sign(
          {
            type: "DelegationRegistration",
            delegation_id: d.delegation_id,
            payload_hash: await P.hash(data.jws),
            status: prev?.status || "active",
            issued_at: P.now(),
            expires_at: d.expires_at,
          },
          resource,
        ),
      };
    }
    if (path === "/v1/delegations/pause") {
      P.fields(data, ["delegation_id"]);
      P.check(role === "user", "INVALID_ROLE");
      const d = get("delegation", data.delegation_id);
      P.check(d?.data.binding_id === bid, "UNKNOWN_DELEGATION", 404);
      put("delegation", data.delegation_id, { ...d, status: "paused" });
      return { status: "paused" };
    }
    if (
      path === "/v1/demo/reports" ||
      path === "/v1/demo/reports/execute-verified"
    ) {
      P.fields(
        data,
        ["request_jws", "payload_b64", "grant", "delegation"],
        ["request_jws", "payload_b64", "grant"],
      );
      P.check(role === "agent", "INVALID_ROLE");
      P.check(acceptDemo, "DEMO_ASSURANCE_DISABLED", 403);
      const { q, a, bytes, g, d, auto } = await verifyAuthorization(
        data,
        b.relation,
      );
      const receipt = tx(() => {
        if (verifiedTransaction)
          P.validTime(verifiedTransaction.result, 120000);
        active(bind(bid));
        P.validTime(q, 600000);
        P.validTime(g, 120000);
        if (auto) P.validTime(d, 86400000);
        P.check(!get("cancel", bid + ":" + q.request_id), "REQUEST_CANCELLED");
        const old = db
          .prepare(
            "SELECT data FROM executions WHERE request_id=? OR grant_id=?",
          )
          .get(q.request_id, g.grant_id);
        if (old) {
          const previous = JSON.parse(old.data);
          P.check(
            previous.receipt.binding_id === bid &&
              previous.receipt.request_id === q.request_id &&
              previous.receipt.grant_id === g.grant_id &&
              previous.receipt.action_hash === q.action_hash,
            "EXECUTION_CONFLICT",
            409,
          );
          return previous.receipt;
        }
        if (auto) {
          const current = get("delegation", d.delegation_id);
          P.check(
            current?.status === "active" && current.jws === data.delegation,
            "POLICY_INACTIVE",
          );
          P.check(current.executions < d.max_approvals, "POLICY_LIMIT_REACHED");
          put("delegation", d.delegation_id, {
            ...current,
            executions: current.executions + 1,
          });
        }
        const rc = {
          type: "ExecutionReceipt",
          execution_id: P.id(),
          request_id: q.request_id,
          grant_id: g.grant_id,
          binding_id: bid,
          action_hash: q.action_hash,
          payload_hash: a.payload.sha256,
          recipient_id: a.recipient_id,
          result: "delivered_to_demo_inbox",
          executed_at: P.now(),
          audience: P.AUD,
          ...(verifiedTransaction
            ? {
                transaction_id: verifiedTransaction.transaction_id,
                verification_id: verifiedTransaction.result.verification_id,
              }
            : {}),
        };
        db.prepare("INSERT INTO executions VALUES(?,?,?,?,?)").run(
          q.request_id,
          g.grant_id,
          bid,
          q.action_hash,
          JSON.stringify({
            receipt: rc,
            payload_b64: data.payload_b64,
            grant: data.grant,
            delegation: data.delegation || null,
          }),
        );
        return rc;
      });
      return { receipt: await P.sign(receipt, resource) };
    }
    throw new P.Fault("NOT_FOUND", 404);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      rate(req.socket.remoteAddress || "unknown");
      if (req.headers.origin)
        P.check(req.headers.origin === actualOrigin, "ORIGIN_REJECTED", 403);
      if (!path.startsWith("/v1/") && path !== "/healthz") {
        const names = {
          "/": "index.html",
          "/mobile/": "index.html",
          "/mobile/app.js": "app.js",
          "/mobile/style.css": "style.css",
        };
        P.check(req.method === "GET" && names[path], "NOT_FOUND", 404);
        const file = names[path],
          bytes = await readFile(resolve(ROOT, "dist", file));
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html; charset=utf-8",
        );
        res.end(bytes);
        return;
      }
      P.check(["GET", "POST"].includes(req.method), "METHOD_NOT_ALLOWED", 405);
      let body;
      if (req.method === "POST") {
        P.check(
          (req.headers["content-type"] || "").startsWith("application/json"),
          "CONTENT_TYPE",
          415,
        );
        let size = 0,
          chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          P.check(size <= 1000000, "BODY_TOO_LARGE", 413);
          chunks.push(chunk);
        }
        body = P.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const output = await api(
        path,
        body,
        req.method,
        req.socket.remoteAddress || "unknown",
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(output));
    } catch (e) {
      const code =
        e instanceof P.Fault
          ? e.code
          : e instanceof SyntaxError
            ? "INVALID_JSON"
            : "INTERNAL_ERROR";
      if (code === "INTERNAL_ERROR")
        console.error("request failed", e.name, e.message);
      res.statusCode = e.status || 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ code, retryable: false, correlation_id: P.id() }),
      );
    }
  });
  const timer = setInterval(() => {
    for (const k of ["challenge", "message"])
      for (const x of all(k)) if (x.expires_at < P.now()) del(k, x.id);
    for (const p of all("pair"))
      if (p.invite.expires_at + 86400000 < P.now()) del("pair", p.id);
  }, 60000);
  timer.unref();
  return {
    server,
    db,
    info,
    async listen(port = 8787, host = "127.0.0.1") {
      await new Promise((r) => server.listen(port, host, r));
      if (!actualOrigin)
        actualOrigin = `http://127.0.0.1:${server.address().port}`;
      return actualOrigin;
    },
    async close() {
      clearInterval(timer);
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createServer({
    dir: process.env.MYA_DATA_DIR,
    origin: process.env.PUBLIC_ORIGIN || null,
    acceptDemo: process.env.ACCEPT_DEMO_ASSURANCE === "true",
  });
  const origin = await app.listen(
    Number(process.env.PORT || 8787),
    process.env.LISTEN_HOST || "127.0.0.1",
  );
  console.log(`MYA ${origin}/mobile/`);
  console.log(
    `Trust witness fingerprint: ${await P.thumb(app.info().witness)}`,
  );
  console.log("Demo grants accepted:", app.info().accept_demo_assurance);
  process.on("SIGTERM", () => app.close().then(() => process.exit(0)));
}
