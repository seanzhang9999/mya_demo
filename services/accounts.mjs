import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as P from "../packages/protocol/core.mjs";
const derive = promisify(scrypt);
const digest = (x) => createHash("sha256").update(x).digest("hex");
const TTL = 12 * 60 * 60 * 1000;
const COOKIE = "mya_session";
const clean = (value, max = 80) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= max;
const publicKey = (k) =>
  k &&
  k.kty === "EC" &&
  k.crv === "P-256" &&
  typeof k.x === "string" &&
  typeof k.y === "string" &&
  !k.d;
const proofData = (data) =>
  Object.fromEntries(
    Object.entries(data).filter(
      ([k]) => !["password", "old_password", "new_password"].includes(k),
    ),
  );
export function createAccounts({
  get,
  put,
  all,
  del,
  tx,
  origin,
  revokeBinding,
}) {
  let hashing = 0;
  const limits = new Map();
  function limit(key, max, duration = 60000) {
    const now = P.now();
    for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    const v = limits.get(key) || { n: 0, until: now + duration };
    P.check(++v.n <= max, "ACCOUNT_RATE_LIMITED", 429);
    limits.set(key, v);
  }
  async function passwordHash(password, salt) {
    P.check(
      typeof password === "string" && password.length <= 128,
      "PASSWORD_INVALID",
    );
    P.check(hashing < 2, "AUTH_BUSY", 429);
    hashing++;
    try {
      return (
        await derive(password, salt, 32, {
          N: 32768,
          r: 8,
          p: 3,
          maxmem: 64 * 1024 * 1024,
        })
      ).toString("hex");
    } finally {
      hashing--;
    }
  }
  const keyDevice = (kid) => get("account_device_key", kid);
  const deviceFor = (kid) => {
    const x = keyDevice(kid);
    return x ? get("account_device", x.id) : null;
  };
  const cookie = (res, token = "", age = 43200) =>
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin().startsWith("https:") ? "; Secure" : ""}`,
    );
  function session(req, { active = true } = {}) {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    const s = raw ? get("account_session", digest(raw)) : null;
    P.check(s && s.expires_at > P.now(), "LOGIN_REQUIRED", 401);
    const d = get("account_device", s.device_id);
    P.check(
      d && d.account_id === s.account_id && d.status !== "revoked",
      "DEVICE_REVOKED",
      403,
    );
    if (active) P.check(d.status === "active", "DEVICE_PENDING", 403);
    return { s, d, a: get("account", s.account_id) };
  }
  function newSession(res, a, d) {
    const token = randomBytes(32).toString("base64url");
    put("account_session", digest(token), {
      account_id: a.id,
      device_id: d.id,
      expires_at: P.now() + TTL,
    });
    cookie(res, token);
  }
  async function assertSigner(req, kid) {
    const d = deviceFor(kid);
    if (!d) return; // Keep unclaimed legacy browsers compatible.
    const current = session(req);
    P.check(
      current.d.id === d.id && ["admin", "approver"].includes(d.role),
      "DEVICE_SIGNING_NOT_ALLOWED",
      403,
    );
  }
  async function guardRelation(relation) {
    const d = deviceFor(await P.thumb(relation.phone.user));
    P.check(
      !d || (d.status === "active" && ["admin", "approver"].includes(d.role)),
      "APPROVAL_DEVICE_DISABLED",
      403,
    );
  }
  function view(d) {
    return {
      id: d.id,
      name: d.name,
      kid: d.kid,
      status: d.status,
      role: d.role,
      created_at: d.created_at,
      last_login_at: d.last_login_at,
      revoked_at: d.revoked_at,
    };
  }
  async function catalog(accountId) {
    const devices = all("account_device").filter(
        (d) => d.account_id === accountId,
      ),
      index = new Map(devices.map((d) => [d.kid, d]));
    const list = [];
    for (const b of all("binding")) {
      const d = index.get(await P.thumb(b.relation.phone.user));
      if (!d) continue;
      list.push({
        binding_id: b.relation.binding_id,
        agent_name: b.relation.agent.name,
        agent_fingerprint: await P.thumb(b.relation.agent.sign),
        device_id: d.id,
        device_name: d.name,
        status: b.status,
        termination: b.termination || null,
        expires_at: b.relation.expires_at,
      });
    }
    return list;
  }
  async function overview(req) {
    const { a, d } = session(req, { active: false });
    return {
      account: { id: a.id, username: a.username },
      device: view(d),
      devices:
        d.status === "active"
          ? all("account_device")
              .filter((x) => x.account_id === a.id)
              .map(view)
          : [],
      bindings: d.status === "active" ? await catalog(a.id) : [],
    };
  }
  async function verify(path, body) {
    P.fields(body, ["data", "proof"]);
    const data = body.data;
    P.check(
      data && typeof data === "object" && publicKey(data.device_key),
      "INVALID_DEVICE_KEY",
    );
    const kid = await P.thumb(data.device_key),
      p = await P.verify(body.proof, data.device_key),
      c = get("account_challenge", p.challenge_id);
    P.check(
      c &&
        c.expires_at > P.now() &&
        !c.used &&
        c.path === path &&
        c.kid === kid,
      "ACCOUNT_CHALLENGE_INVALID",
      401,
    );
    P.validTime(p, 60000);
    P.check(
      p.type === "AccountDeviceProof" &&
        p.nonce === c.nonce &&
        p.path === path &&
        p.origin === origin() &&
        p.body_hash === (await P.hash(JSON.stringify(proofData(data)))),
      "ACCOUNT_PROOF_INVALID",
      401,
    );
    tx(() => {
      const fresh = get("account_challenge", c.id);
      P.check(fresh && !fresh.used, "ACCOUNT_CHALLENGE_REPLAY", 401);
      put("account_challenge", c.id, { ...fresh, used: true });
    });
    return { data, kid };
  }
  async function handle(path, body, req, res, ip) {
    if (!path.startsWith("/v1/account/")) return null;
    P.check(
      req.method === "POST" ||
        (req.method === "GET" && path === "/v1/account/me"),
      "METHOD_NOT_ALLOWED",
      405,
    );
    if (req.method === "POST")
      P.check(req.headers.origin === origin(), "ACCOUNT_ORIGIN_REQUIRED", 403);
    limit("all:" + ip, 120);
    if (path === "/v1/account/me") return await overview(req);
    if (path === "/v1/account/logout") {
      const raw = (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(COOKIE + "="))
        ?.slice(COOKIE.length + 1);
      if (raw) del("account_session", digest(raw));
      cookie(res, "", 0);
      return { status: "logged_out" };
    }
    if (path === "/v1/account/challenge") {
      limit("nonce:" + ip, 50);
      P.check(
        typeof body.path === "string" &&
          [
            "/v1/account/register",
            "/v1/account/login",
            "/v1/account/devices/approve",
            "/v1/account/devices/revoke",
            "/v1/account/password",
          ].includes(body.path) &&
          publicKey(body.device_key),
        "INVALID_ACCOUNT_CHALLENGE",
      );
      const c = {
        id: P.id(),
        nonce: P.id(),
        path: body.path,
        kid: await P.thumb(body.device_key),
        expires_at: P.now() + 60000,
        used: false,
      };
      put("account_challenge", c.id, c);
      return c;
    }
    const { data, kid } = await verify(path, body);
    if (path === "/v1/account/register" || path === "/v1/account/login") {
      const username =
        typeof data.username === "string"
          ? data.username.trim().toLowerCase()
          : "";
      P.check(/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username), "USERNAME_INVALID");
      P.check(clean(data.device_name), "DEVICE_NAME_REQUIRED");
      limit("auth:" + ip, 12, 15 * 60000);
      limit("user:" + username, 12, 15 * 60000);
      if (path.endsWith("/register")) {
        P.check(
          typeof data.password === "string" &&
            data.password.length >= 15 &&
            data.password.length <= 128,
          "PASSWORD_LENGTH",
        );
        const salt = randomBytes(16).toString("hex"),
          hash = await passwordHash(data.password, salt);
        const a = {
          id: P.id(),
          username,
          password: { salt, hash },
          created_at: P.now(),
        };
        const d = {
          id: P.id(),
          account_id: a.id,
          kid,
          key: data.device_key,
          name: data.device_name.trim(),
          role: "admin",
          status: "active",
          created_at: P.now(),
          last_login_at: P.now(),
        };
        tx(() => {
          P.check(
            !get("account_username", username),
            "ACCOUNT_UNAVAILABLE",
            409,
          );
          P.check(!keyDevice(kid), "DEVICE_ALREADY_REGISTERED", 409);
          put("account", a.id, a);
          put("account_username", username, { id: a.id });
          put("account_device", d.id, d);
          put("account_device_key", kid, { id: d.id });
        });
        newSession(res, a, d);
        return {
          status: "registered",
          account: { id: a.id, username },
          device: view(d),
        };
      }
      const ref = get("account_username", username),
        a = ref ? get("account", ref.id) : null;
      const hash = await passwordHash(
        data.password,
        a?.password.salt || "00000000000000000000000000000000",
      );
      P.check(
        a &&
          timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(a.password.hash, "hex"),
          ),
        "LOGIN_FAILED",
        401,
      );
      let d = deviceFor(kid);
      P.check(
        !d || d.account_id === a.id,
        "DEVICE_LINKED_TO_OTHER_ACCOUNT",
        403,
      );
      P.check(!d || d.status !== "revoked", "DEVICE_REVOKED", 403);
      tx(() => {
        P.check(
          get("account", a.id).password.hash === a.password.hash,
          "LOGIN_FAILED",
          401,
        );
        d = deviceFor(kid);
        if (!d) {
          P.check(
            all("account_device").filter((x) => x.account_id === a.id).length <
              30,
            "DEVICE_LIMIT",
          );
          d = {
            id: P.id(),
            account_id: a.id,
            kid,
            key: data.device_key,
            name: data.device_name.trim(),
            role: "viewer",
            status: "pending",
            created_at: P.now(),
          };
          put("account_device_key", kid, { id: d.id });
        }
        P.check(
          d.account_id === a.id && d.status !== "revoked",
          "DEVICE_REVOKED",
          403,
        );
        d = { ...d, last_login_at: P.now() };
        put("account_device", d.id, d);
      });
      newSession(res, a, d);
      return {
        status: d.status === "active" ? "logged_in" : "pending_device",
        device: view(d),
      };
    }
    const current = session(req);
    P.check(current.d.kid === kid, "SESSION_DEVICE_MISMATCH", 403);
    if (path === "/v1/account/password") {
      P.check(
        typeof data.new_password === "string" &&
          data.new_password.length >= 15 &&
          data.new_password.length <= 128,
        "PASSWORD_LENGTH",
      );
      limit("pw:" + current.a.id, 5, 15 * 60000);
      const h = await passwordHash(data.old_password, current.a.password.salt);
      P.check(
        timingSafeEqual(
          Buffer.from(h, "hex"),
          Buffer.from(current.a.password.hash, "hex"),
        ),
        "LOGIN_FAILED",
        401,
      );
      const salt = randomBytes(16).toString("hex"),
        hash = await passwordHash(data.new_password, salt);
      tx(() => {
        session(req);
        P.check(
          get("account", current.a.id).password.hash ===
            current.a.password.hash,
          "LOGIN_FAILED",
          401,
        );
        put("account", current.a.id, {
          ...current.a,
          password: { salt, hash },
        });
        for (const s of all("account_session"))
          if (s.account_id === current.a.id) del("account_session", s.id);
      });
      newSession(res, current.a, current.d);
      return { status: "password_changed" };
    }
    P.check(current.d.role === "admin", "DEVICE_ADMIN_REQUIRED", 403);
    const target = get("account_device", data.device_id);
    P.check(
      target && target.account_id === current.a.id,
      "UNKNOWN_DEVICE",
      404,
    );
    if (path === "/v1/account/devices/approve") {
      P.check(
        ["viewer", "approver", "admin"].includes(data.role),
        "INVALID_DEVICE_ROLE",
      );
      tx(() => {
        session(req);
        const fresh = get("account_device", target.id),
          admin = get("account_device", current.d.id);
        P.check(
          admin.status === "active" && admin.role === "admin",
          "DEVICE_ADMIN_REQUIRED",
          403,
        );
        P.check(fresh.status === "pending", "DEVICE_NOT_PENDING", 409);
        put("account_device", target.id, {
          ...fresh,
          status: "active",
          role: data.role,
          approved_by: current.d.id,
          approved_at: P.now(),
        });
        const id = P.id();
        put("account_audit", id, {
          id,
          type: "device_approved",
          account_id: current.a.id,
          actor_device_id: current.d.id,
          target_device_id: target.id,
          role: data.role,
          at: P.now(),
          signed_data: proofData(data),
          proof: body.proof,
        });
      });
      return { status: "device_approved" };
    }
    if (path === "/v1/account/devices/revoke") {
      P.check(
        typeof data.reason === "string" && data.reason.length <= 200,
        "REASON_REQUIRED",
      );
      P.check(target.id !== current.d.id, "CANNOT_REVOKE_CURRENT_DEVICE");
      const bindings = (await catalog(current.a.id)).filter(
        (b) => b.device_id === target.id && b.status === "active",
      );
      // Prepared signed events are applied together with device/session invalidation.
      const prepared = [];
      for (const b of bindings)
        prepared.push(
          await revokeBinding(
            b.binding_id,
            {
              type: "device_revoked",
              actor_role: "user",
              actor_key_id: kid,
              reason: data.reason,
              actor_proof: body.proof,
              source: "account_device",
            },
            true,
          ),
        );
      tx(() => {
        session(req);
        const admin = get("account_device", current.d.id),
          fresh = get("account_device", target.id);
        P.check(
          admin.status === "active" && admin.role === "admin",
          "DEVICE_ADMIN_REQUIRED",
          403,
        );
        P.check(fresh.status !== "revoked", "DEVICE_REVOKED", 409);
        put("account_device", target.id, {
          ...fresh,
          status: "revoked",
          revoked_at: P.now(),
          revoked_by: current.d.id,
        });
        for (const change of prepared) change();
        for (const s of all("account_session"))
          if (s.device_id === target.id) del("account_session", s.id);
        const id = P.id();
        put("account_audit", id, {
          id,
          type: "device_revoked",
          account_id: current.a.id,
          actor_device_id: current.d.id,
          target_device_id: target.id,
          at: P.now(),
          reason: data.reason,
          signed_data: proofData(data),
          proof: body.proof,
        });
      });
      return {
        status: "device_revoked",
        relationships_stopped: bindings.length,
      };
    }
    throw new P.Fault("ACCOUNT_ROUTE_NOT_FOUND", 404);
  }
  function cleanup() {
    for (const kind of ["account_challenge", "account_session"])
      for (const row of all(kind))
        if (row.expires_at < P.now()) del(kind, row.id);
  }
  return { handle, assertSigner, guardRelation, cleanup, deviceFor };
}
