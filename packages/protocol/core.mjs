import {
  CompactSign,
  compactVerify,
  CompactEncrypt,
  compactDecrypt,
  importJWK,
  exportJWK,
  calculateJwkThumbprint,
} from "jose";
export const VERSION = "mya-demo/0.1",
  AUD = "mya-demo-resource";
export const COMPANY = {
  id: "demo-external-sharing",
  version: 1,
  clause: "第 3 条",
  title: "演示公司《外发资料要求》",
  text: "项目合作方可接收常规进度报告；禁止外发成本和个人信息。固定模板可在用户明确委托范围内自动审批。",
  project: "project-alpha",
  recipients: ["supplier-a"],
  milestones: ["design", "prototype", "review"],
  statuses: ["planned", "in_progress", "completed"],
  maxUses: 3,
};
export const enc = new TextEncoder(),
  dec = new TextDecoder("utf-8", { fatal: true });
export const now = () => Date.now(),
  id = () => crypto.randomUUID();
export function stamp(duration, ceiling = Infinity) {
  const issued_at = now();
  return { issued_at, expires_at: Math.min(issued_at + duration, ceiling) };
}
export class Fault extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function check(ok, code = "INVALID_INPUT", status = 400) {
  if (!ok) throw new Fault(code, status);
}
export function b64(bytes) {
  let s = "";
  for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unb64(s) {
  check(
    typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s),
    "INVALID_ENCODING",
  );
  return Uint8Array.from(
    atob(s.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export const encode = (x) => b64(enc.encode(JSON.stringify(x)));
export async function hash(x) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof x === "string" ? enc.encode(x) : x,
      ),
    ),
  );
}
export function parse(text) {
  const result = JSON.parse(text);
  const tokens =
    text.match(
      /"(?:\\.|[^"\\])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    ) || [];
  const stack = [];
  for (const t of tokens) {
    if (t === "{") stack.push({ keys: new Set(), key: true });
    else if (t === "[") stack.push({});
    else if (t === "}" || t === "]") stack.pop();
    else if (t === "," && stack.at(-1)?.keys) stack.at(-1).key = true;
    else if (t === ":" && stack.at(-1)?.keys) stack.at(-1).key = false;
    else if (t[0] === '"' && stack.at(-1)?.keys && stack.at(-1).key) {
      const k = JSON.parse(t);
      check(!stack.at(-1).keys.has(k), "DUPLICATE_JSON_KEY");
      stack.at(-1).keys.add(k);
    }
  }
  return result;
}
export const decode = (s) => parse(dec.decode(unb64(s)));
export function fields(o, allowed, required = allowed) {
  check(o && typeof o === "object" && !Array.isArray(o));
  check(
    Object.keys(o).every((k) => allowed.includes(k)),
    "UNKNOWN_FIELD",
  );
  check(
    required.every((k) => Object.hasOwn(o, k)),
    "MISSING_FIELD",
  );
}
export function validTime(o, max = Infinity) {
  check(
    Number.isSafeInteger(o.issued_at) &&
      Number.isSafeInteger(o.expires_at) &&
      o.issued_at <= now() + 10000 &&
      o.expires_at > now() &&
      o.expires_at > o.issued_at &&
      o.expires_at - o.issued_at <= max,
    "EXPIRED",
  );
}
export async function key(encryption = false, extractable = false) {
  const algorithm = encryption
    ? { name: "ECDH", namedCurve: "P-256" }
    : { name: "ECDSA", namedCurve: "P-256" };
  const pair = await crypto.subtle.generateKey(
    algorithm,
    extractable,
    encryption ? ["deriveBits"] : ["sign", "verify"],
  );
  const pub = await exportJWK(pair.publicKey);
  delete pub.key_ops;
  delete pub.ext;
  return { privateKey: pair.privateKey, publicKey: pub, kid: await thumb(pub) };
}
export async function thumb(pub) {
  check(
    pub?.kty === "EC" && pub.crv === "P-256" && !pub.d,
    "INVALID_PUBLIC_KEY",
  );
  return calculateJwkThumbprint(pub);
}
export const importSign = (pub) => importJWK(pub, "ES256");
export async function sign(value, k) {
  return new CompactSign(enc.encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: "ES256", typ: "mya+jws", kid: k.kid })
    .sign(k.privateKey);
}
export async function verify(jws, pub) {
  check(typeof jws === "string" && jws.length < 800000, "INVALID_SIGNATURE");
  try {
    const r = await compactVerify(jws, await importSign(pub), {
      algorithms: ["ES256"],
    });
    check(
      r.protectedHeader.typ === "mya+jws" &&
        r.protectedHeader.kid === (await thumb(pub)),
      "KEY_MISMATCH",
    );
    return parse(dec.decode(r.payload));
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault("INVALID_SIGNATURE", 401);
  }
}
export function peek(jws) {
  check(typeof jws === "string");
  return decode(jws.split(".")[1]);
}
export async function encrypt(jws, pub) {
  return new CompactEncrypt(enc.encode(jws))
    .setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM" })
    .encrypt(await importJWK(pub, "ECDH-ES+A256KW"));
}
export async function decrypt(cipher, k) {
  const { plaintext } = await compactDecrypt(cipher, k.privateKey, {
    keyManagementAlgorithms: ["ECDH-ES+A256KW"],
    contentEncryptionAlgorithms: ["A256GCM"],
  });
  return dec.decode(plaintext);
}
export async function makeAgent(name = "我的 PC Codex", extractable = false) {
  return {
    name,
    sign: await key(false, extractable),
    encryption: await key(true, extractable),
  };
}
export async function makePhone(extractable = false) {
  return {
    name: "我的审批手机",
    user: await key(false, extractable),
    phone: await key(false, extractable),
    auto: await key(false, extractable),
    encryption: await key(true, extractable),
  };
}
export function agentPublic(a) {
  return {
    name: a.name,
    sign: a.sign.publicKey,
    encryption: a.encryption.publicKey,
  };
}
export function phonePublic(p) {
  return {
    user: p.user.publicKey,
    phone: p.phone.publicKey,
    auto: p.auto.publicKey,
    encryption: p.encryption.publicKey,
  };
}
export async function relation(inv, join) {
  return {
    type: "RelationshipCredential",
    protocol_version: VERSION,
    binding_id: inv.invite_id,
    binding_version: 1,
    agent: inv.agent,
    phone: join.phone,
    relay_origin: inv.origin,
    audience: AUD,
    relationship: "user_bound_work_agent",
    allowed_request_types: ["demo.report.send"],
    invite_hash: await hash(JSON.stringify(inv)),
    join_hash: await hash(JSON.stringify(join)),
    issued_at: inv.issued_at,
    expires_at: inv.issued_at + 30 * 86400000,
    user_verification: "simulated",
    environment: "demo",
  };
}
export async function sas(r) {
  const bytes = unb64(await hash(JSON.stringify(r))).slice(0, 5);
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = 0,
    n = 0,
    out = "";
  for (const b of bytes) {
    n = (n << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += chars[(n >>> bits) & 31];
    }
  }
  return out.slice(0, 4) + " " + out.slice(4);
}
export async function verifyCredentials(c, trust) {
  const r = peek(c.relationship);
  await verify(c.relationship, r.phone.user);
  const w = await verify(c.witness, trust.witness);
  check(
    w.type === "BindingWitnessCredential" &&
      w.relationship_hash === (await hash(c.relationship)) &&
      w.binding_id === r.binding_id,
    "INVALID_WITNESS",
  );
  validTime(r);
  validTime(w);
  return r;
}
export async function requestBundle(
  agent,
  binding,
  payload,
  {
    recipient = "supplier-a",
    project = "project-alpha",
    goal = "向项目合作方同步进度",
    explanation = "",
    task = "demo",
    supersedes = null,
    media = "application/json",
  } = {},
) {
  const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
  check(bytes.length <= 102400, "PAYLOAD_TOO_LARGE");
  const action = {
    schema_version: 1,
    action_type: "demo.report.send",
    audience: AUD,
    project_id: project,
    recipient_id: recipient,
    payload: {
      media_type: media,
      file_name:
        media === "application/json" ? "progress-report.json" : "report.md",
      size_bytes: bytes.length,
      sha256: await hash(bytes),
    },
  };
  const context = { user_goal: goal, agent_explanation: explanation };
  const r = {
    protocol_version: VERSION,
    request_id: id(),
    binding_id: binding.binding_id,
    binding_version: 1,
    agent_key_id: agent.sign.kid,
    task_ref: task,
    supersedes_request_id: supersedes,
    action_b64: encode(action),
    action_hash: await hash(unb64(encode(action))),
    context_hash: await hash(unb64(encode(context))),
    ...stamp(600000),
    nonce: id(),
  };
  return {
    request_jws: await sign(r, agent.sign),
    context_b64: encode(context),
    payload_b64: b64(bytes),
  };
}
export async function verifyRequest(
  bundle,
  r,
  { context = true, allowExpired = false } = {},
) {
  const q = await verify(bundle.request_jws, r.agent.sign);
  fields(q, [
    "protocol_version",
    "request_id",
    "binding_id",
    "binding_version",
    "agent_key_id",
    "task_ref",
    "supersedes_request_id",
    "action_b64",
    "action_hash",
    "context_hash",
    "issued_at",
    "expires_at",
    "nonce",
  ]);
  check(
    q.protocol_version === VERSION &&
      q.binding_id === r.binding_id &&
      q.binding_version === r.binding_version &&
      q.agent_key_id === (await thumb(r.agent.sign)),
    "BINDING_MISMATCH",
  );
  if (allowExpired) {
    check(
      Number.isSafeInteger(q.issued_at) &&
        Number.isSafeInteger(q.expires_at) &&
        q.issued_at <= now() + 10000 &&
        q.expires_at > q.issued_at &&
        q.expires_at - q.issued_at <= 600000,
      "INVALID_TIME",
    );
  } else validTime(q, 600000);
  check(q.action_hash === (await hash(unb64(q.action_b64))), "ACTION_MISMATCH");
  const a = decode(q.action_b64);
  fields(a, [
    "schema_version",
    "action_type",
    "audience",
    "project_id",
    "recipient_id",
    "payload",
  ]);
  fields(a.payload, ["media_type", "file_name", "size_bytes", "sha256"]);
  check(
    a.schema_version === 1 &&
      a.action_type === "demo.report.send" &&
      a.audience === AUD,
    "INVALID_ACTION",
  );
  check(
    ["supplier-a", "supplier-b"].includes(a.recipient_id) &&
      a.project_id === COMPANY.project,
    "INVALID_TARGET",
  );
  check(
    ["application/json", "text/markdown", "text/plain"].includes(
      a.payload.media_type,
    ),
    "UNSUPPORTED_MEDIA_TYPE",
  );
  const bytes = unb64(bundle.payload_b64);
  check(
    bytes.length <= 102400 &&
      bytes.length === a.payload.size_bytes &&
      (await hash(bytes)) === a.payload.sha256,
    "PAYLOAD_MISMATCH",
  );
  dec.decode(bytes);
  if (context)
    check(
      (await hash(unb64(bundle.context_b64))) === q.context_hash,
      "CONTEXT_MISMATCH",
    );
  return { q, a, bytes };
}
export function structuredReport(a, bytes) {
  try {
    check(
      a.payload.media_type === "application/json" &&
        a.payload.file_name === "progress-report.json",
    );
    const v = parse(dec.decode(bytes));
    fields(v, [
      "project_id",
      "report_date",
      "milestone_id",
      "status",
      "completion_percent",
    ]);
    check(
      v.project_id === COMPANY.project &&
        /^\d{4}-\d{2}-\d{2}$/.test(v.report_date) &&
        COMPANY.milestones.includes(v.milestone_id) &&
        COMPANY.statuses.includes(v.status) &&
        Number.isInteger(v.completion_percent) &&
        v.completion_percent >= 0 &&
        v.completion_percent <= 100,
    );
    return true;
  } catch {
    return false;
  }
}
export function analyze(a, bytes) {
  const structured = structuredReport(a, bytes),
    text = dec.decode(bytes),
    cost = /成本|cost|利润|身份证|手机号/i.test(text);
  return {
    analysis_id: id(),
    mode: "rules+mock",
    summary: cost
      ? "建议移除内部成本或个人信息，并改为规定的进度模板。"
      : structured
        ? "这份报告符合固定进度模板，可由您确认发送。"
        : "内容含自由文本，需您人工核对后再决定。",
    recommendation: cost ? "modify" : "review",
    facts: [
      `接收方：${a.recipient_id}`,
      `文件大小：${bytes.length} bytes`,
      structured ? "固定模板检查通过" : "不满足自动审批模板",
    ],
    evidence: { ...COMPANY },
    unknowns: [
      "模拟建议不等于真实模型分析；字段检查不能识别任意文件中的全部敏感信息。",
    ],
    created_at: now(),
  };
}
export async function delegation(phone, r, { uses = 3, seconds = 3600 } = {}) {
  check(
    Number.isInteger(uses) &&
      uses >= 1 &&
      uses <= 3 &&
      Number.isInteger(seconds) &&
      seconds >= 60 &&
      seconds <= 86400,
  );
  const d = {
    type: "ApprovalDelegation",
    protocol_version: VERSION,
    delegation_id: id(),
    policy_id: id(),
    version: 1,
    binding_id: r.binding_id,
    binding_version: r.binding_version,
    agent_key_id: await thumb(r.agent.sign),
    delegate_key_id: phone.auto.kid,
    audience: AUD,
    action_type: "demo.report.send",
    project_id: COMPANY.project,
    recipient_ids: ["supplier-a"],
    report_schema: "progress-report/1",
    max_payload_bytes: 102400,
    max_approvals: uses,
    company_rule_id: COMPANY.id,
    company_rule_version: 1,
    company_rule_hash: await hash(JSON.stringify(COMPANY)),
    ...stamp(seconds * 1000, r.expires_at),
    user_verification: "simulated",
    environment: "demo",
  };
  return { data: d, jws: await sign(d, phone.user) };
}
export async function validateDelegation(jws, r) {
  const d = await verify(jws, r.phone.user);
  fields(d, [
    "type",
    "protocol_version",
    "delegation_id",
    "policy_id",
    "version",
    "binding_id",
    "binding_version",
    "agent_key_id",
    "delegate_key_id",
    "audience",
    "action_type",
    "project_id",
    "recipient_ids",
    "report_schema",
    "max_payload_bytes",
    "max_approvals",
    "company_rule_id",
    "company_rule_version",
    "company_rule_hash",
    "issued_at",
    "expires_at",
    "user_verification",
    "environment",
  ]);
  validTime(d, 86400000);
  check(
    d.type === "ApprovalDelegation" &&
      d.protocol_version === VERSION &&
      d.binding_id === r.binding_id &&
      d.binding_version === 1 &&
      d.agent_key_id === (await thumb(r.agent.sign)) &&
      d.delegate_key_id === (await thumb(r.phone.auto)),
    "INVALID_DELEGATION",
  );
  check(
    d.audience === AUD &&
      d.action_type === "demo.report.send" &&
      d.project_id === COMPANY.project &&
      JSON.stringify(d.recipient_ids) === '["supplier-a"]' &&
      d.report_schema === "progress-report/1" &&
      d.max_payload_bytes === 102400 &&
      Number.isInteger(d.max_approvals) &&
      d.max_approvals >= 1 &&
      d.max_approvals <= 3 &&
      d.version === 1 &&
      d.company_rule_id === COMPANY.id &&
      d.company_rule_version === 1 &&
      d.company_rule_hash === (await hash(JSON.stringify(COMPANY))) &&
      d.expires_at <= r.expires_at &&
      d.user_verification === "simulated" &&
      d.environment === "demo",
    "POLICY_SCOPE_MISMATCH",
  );
  return d;
}
export function matches(d, q, a, bytes) {
  return (
    d.expires_at > now() &&
    d.binding_id === q.binding_id &&
    d.agent_key_id === q.agent_key_id &&
    d.recipient_ids.includes(a.recipient_id) &&
    d.project_id === a.project_id &&
    d.audience === a.audience &&
    d.max_payload_bytes >= bytes.length &&
    structuredReport(a, bytes)
  );
}
export async function grant(
  phone,
  r,
  q,
  { policy = null, analysis_id = null } = {},
) {
  const g = {
    type: "ApprovalGrant",
    grant_id: id(),
    request_id: q.request_id,
    binding_id: r.binding_id,
    binding_version: 1,
    agent_key_id: q.agent_key_id,
    audience: AUD,
    action_hash: q.action_hash,
    context_hash: q.context_hash,
    decision: "approve",
    decision_mode: policy ? "policy_auto" : "human_confirmed_demo",
    delegation_id: policy?.data.delegation_id || null,
    delegation_hash: policy ? await hash(policy.jws) : null,
    analysis_id,
    ...stamp(
      120000,
      Math.min(q.expires_at, policy?.data.expires_at || Infinity),
    ),
    user_verification: "simulated",
    environment: "demo",
  };
  return sign(g, policy ? phone.auto : phone.user);
}
export async function seal(kind, body, r, identity, toPhone) {
  const sender = toPhone ? identity.sign : identity.phone;
  const dest = toPhone ? r.phone.phone : r.agent.sign;
  const m = {
    message_id: id(),
    kind,
    binding_id: r.binding_id,
    sender: sender.kid,
    recipient: await thumb(dest),
    body,
    ...stamp(86400000),
  };
  return {
    message_id: m.message_id,
    to: m.recipient,
    ciphertext: await encrypt(
      await sign(m, sender),
      toPhone ? r.phone.encryption : r.agent.encryption,
    ),
  };
}
export async function openMessage(item, r, identity, onPhone) {
  const m = await verify(
    await decrypt(item.ciphertext, identity.encryption),
    onPhone ? r.agent.sign : r.phone.phone,
  );
  validTime(m, 86400000);
  check(
    m.binding_id === r.binding_id &&
      m.message_id === item.message_id &&
      m.recipient === (onPhone ? identity.phone.kid : identity.sign.kid),
    "MESSAGE_MISMATCH",
  );
  return m;
}
export class Client {
  constructor(origin, trust = null) {
    this.origin = origin.replace(/\/$/, "");
    this.trust = trust;
  }
  async raw(path, body) {
    const res = await fetch(this.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Fault(out.code || "NETWORK_ERROR", res.status);
    return out;
  }
  async info() {
    const info = await this.raw("/v1/server-info");
    if (this.trust)
      check(
        (await thumb(info.witness)) === (await thumb(this.trust.witness)) &&
          (await thumb(info.resource)) === (await thumb(this.trust.resource)),
        "SERVER_TRUST_CHANGED",
      );
    return info;
  }
  async auth(path, data, k, binding_id) {
    const c = await this.raw("/v1/auth/challenges", {
      binding_id,
      kid: k.kid,
      path,
    });
    const proof = await sign(
      {
        challenge_id: c.id,
        nonce: c.nonce,
        binding_id,
        kid: k.kid,
        method: "POST",
        path,
        audience: AUD,
        body_hash: await hash(JSON.stringify(data)),
        ...stamp(30000),
      },
      k,
    );
    return this.raw(path, { data, proof });
  }
}
