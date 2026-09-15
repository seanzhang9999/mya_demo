import * as P from "./core.mjs";
import { verifyAuthorization } from "./authorization.mjs";

export const PRESENT_PATH = "/v1/wallet/present";
export const presentationChecks = [
  "relationship_and_witness",
  "holder_signature",
  "transaction_and_nonce",
  "verifier_and_endpoint",
  "credential_digest",
  "request_and_action",
  "approval_signature_and_scope",
  "current_validity",
  "binding_and_policy_status",
];

export function authorizationBody(rec) {
  P.check(rec?.grant, "NOT_APPROVED");
  return {
    request_jws: rec.bundle.request_jws,
    payload_b64: rec.bundle.payload_b64,
    grant: rec.grant,
    ...(rec.delegation ? { delegation: rec.delegation } : {}),
  };
}

export async function verifyChallenge(jws, client, binding, q, kid) {
  const c = await P.verify(jws, client.trust.resource);
  P.fields(c, [
    "type",
    "transaction_id",
    "nonce",
    "binding_id",
    "agent_key_id",
    "request_id",
    "action_hash",
    "context_hash",
    "audience",
    "response_uri",
    "issued_at",
    "expires_at",
  ]);
  P.validTime(c, 120000);
  P.check(
    c.type === "PresentationChallenge" &&
      c.binding_id === binding.relation.binding_id &&
      c.agent_key_id === kid &&
      c.request_id === q.request_id &&
      c.action_hash === q.action_hash &&
      c.context_hash === q.context_hash &&
      c.audience === client.origin &&
      c.response_uri === client.origin + PRESENT_PATH,
    "UNTRUSTED_PRESENTATION_REQUEST",
  );
  return c;
}

export async function makePresentation(
  client,
  identity,
  binding,
  rec,
  challenge,
) {
  const q = P.peek(rec.bundle.request_jws);
  const c = await verifyChallenge(
    challenge,
    client,
    binding,
    q,
    identity.sign.kid,
  );
  await P.verifyCredentials(binding.credentials, client.trust);
  const { g } = await verifyAuthorization(
    authorizationBody(rec),
    binding.relation,
  );
  const credentials = {
    ...binding.credentials,
    grant: rec.grant,
    ...(rec.delegation ? { delegation: rec.delegation } : {}),
  };
  const lifetime = P.stamp(30000);
  const presentation = await P.sign(
    {
      type: "CredentialPresentation",
      transaction_id: c.transaction_id,
      nonce: c.nonce,
      binding_id: c.binding_id,
      request_id: c.request_id,
      action_hash: c.action_hash,
      context_hash: c.context_hash,
      audience: c.audience,
      response_uri: c.response_uri,
      credentials_hash: await P.hash(JSON.stringify(credentials)),
      issued_at: lifetime.issued_at,
      expires_at: Math.min(c.expires_at, g.expires_at, lifetime.expires_at),
    },
    identity.sign,
  );
  return { challenge, credentials, presentation };
}

export async function verifyResult(jws, client, q, transaction_id) {
  const v = await P.verify(jws, client.trust.resource);
  P.validTime(v, 120000);
  P.check(
    v.type === "CredentialVerificationResult" &&
      v.result === "verified" &&
      v.transaction_id === transaction_id &&
      v.request_id === q.request_id &&
      v.binding_id === q.binding_id &&
      v.action_hash === q.action_hash &&
      v.context_hash === q.context_hash &&
      v.audience === client.origin,
    "VERIFICATION_RESULT_MISMATCH",
  );
  return v;
}

// This is a fresh inspection, never an authorization token. Failed checks remain visible.
export async function inspectWallet(
  session,
  request_id = null,
  binding_id = null,
  isPhone = false,
) {
  const rec = request_id
    ? (isPhone ? session.state.records : session.state.requests)[request_id]
    : null;
  if (request_id) P.check(rec, "UNKNOWN_REQUEST");
  const bid =
    rec?.binding_id ||
    rec?.q?.binding_id ||
    binding_id ||
    Object.keys(session.state.bindings).at(-1);
  const b = session.state.bindings[bid];
  P.check(b, "NO_BINDING");
  const { client, identity } = session,
    r = b.relation;
  const report = {
    checked_at: P.now(),
    binding_id: bid,
    request_id,
    checks: [],
    credentials: {},
    presentations: [],
  };
  const check = async (id, label, fn) => {
    try {
      const result = await fn();
      report.checks.push({ id, label, status: "passed" });
      return result;
    } catch (e) {
      report.checks.push({
        id,
        label,
        status: "failed",
        code: e.code || "INVALID",
      });
      return null;
    }
  };
  const relation = await check(
    "relationship_signature",
    "关系凭证：手机用户签名",
    () => P.verify(b.credentials.relationship, r.phone.user),
  );
  const witness = await check(
    "witness_signature",
    "配对见证：受信服务签名",
    () => P.verify(b.credentials.witness, client.trust.witness),
  );
  if (relation) report.credentials.relationship = relation;
  if (witness) report.credentials.witness = witness;
  await check(
    "relationship_link",
    "关系与见证：绑定 ID、摘要及本地关系一致",
    async () => {
      P.check(
        relation?.type === "RelationshipCredential" &&
          witness?.type === "BindingWitnessCredential" &&
          JSON.stringify(relation) === JSON.stringify(r) &&
          witness.binding_id === bid &&
          witness.relationship_hash ===
            (await P.hash(b.credentials.relationship)),
        "INVALID_WITNESS",
      );
    },
  );
  await check("relationship_time", "关系与见证：当前有效期", () => {
    P.check(relation && witness, "MISSING_CREDENTIAL");
    P.validTime(relation);
    P.validTime(witness);
  });
  let g = null;
  if (rec) {
    await check(
      "request_integrity",
      "请求：Agent 签名、操作摘要与文件内容",
      () => P.verifyRequest(rec.bundle, r, { allowExpired: true }),
    );
    if (rec.grant) {
      g = await check("grant_signature", "授权凭证：用户或受托密钥签名", () =>
        P.verify(
          rec.grant,
          P.peek(rec.grant).decision_mode === "policy_auto"
            ? r.phone.auto
            : r.phone.user,
        ),
      );
      if (g) report.credentials.grant = g;
      // Phone records created before this version resolve their delegation from the policy wallet.
      const delegation =
        rec.delegation || session.state.policies?.[g?.delegation_id]?.jws;
      await check(
        "grant_scope",
        "授权范围：请求、文件、接收方及审批上下文",
        () =>
          verifyAuthorization(authorizationBody({ ...rec, delegation }), r, {
            allowExpired: true,
          }),
      );
      await check("grant_time", "授权凭证：当前有效期（最长 120 秒）", () => {
        P.check(g, "MISSING_CREDENTIAL");
        P.validTime(g, 120000);
      });
      if (delegation)
        report.credentials.delegation = await check(
          "delegation_signature",
          "自动审批委托：用户签名",
          () => P.verify(delegation, r.phone.user),
        );
    } else
      report.checks.push({
        id: "grant_signature",
        label: "授权凭证：等待用户签发",
        status: "pending",
      });
    if (rec.receipt) {
      const receipt = await check(
        "receipt_signature",
        "执行回执：资源服务签名",
        () => P.verify(rec.receipt, client.trust.resource),
      );
      if (receipt) report.credentials.receipt = receipt;
      await check("receipt_link", "回执：对应本次授权及实际文件", async () => {
        const q = P.peek(rec.bundle.request_jws);
        P.check(
          receipt?.type === "ExecutionReceipt" &&
            receipt.result === "delivered_to_demo_inbox" &&
            receipt.audience === P.AUD &&
            receipt.binding_id === bid &&
            receipt.request_id === request_id &&
            receipt.action_hash === q.action_hash &&
            receipt.grant_id === g?.grant_id &&
            receipt.payload_hash ===
              (await P.hash(P.unb64(rec.bundle.payload_b64))),
          "RECEIPT_MISMATCH",
        );
      });
      await check("grant_at_execution", "历史执行时：授权处于有效期内", () => {
        P.check(
          g &&
            receipt &&
            receipt.executed_at >= g.issued_at &&
            receipt.executed_at < g.expires_at,
          "INVALID_EXECUTION_TIME",
        );
      });
    }
  }
  const live = await check(
    "live_status",
    "在线状态：服务签名及当前关系状态",
    async () => {
      const out = await client.auth(
        "/v1/wallet/status",
        { request_id, delegation_id: g?.delegation_id || null },
        isPhone ? identity.phone : identity.sign,
        bid,
      );
      const s = await P.verify(out.status, client.trust.resource);
      P.validTime(s, 30000);
      P.check(
        s.type === "WalletStatus" &&
          s.binding_id === bid &&
          s.request_id === request_id,
        "STATUS_MISMATCH",
      );
      report.live = s;
      P.check(
        s.binding_status === "active" && r.expires_at > P.now(),
        "BINDING_REVOKED",
      );
      return s;
    },
  );
  if (live && rec) {
    await check("not_cancelled", "在线状态：请求未取消", () =>
      P.check(!live.cancelled, "REQUEST_CANCELLED"),
    );
    if (g?.delegation_id)
      await check("policy_status", "在线状态：自动审批委托仍启用", () =>
        P.check(live.delegation_status === "active", "POLICY_INACTIVE"),
      );
    report.presentations = live.presentations;
  }
  report.note =
    "逐项校验用于查看证据，不授予执行权限。历史授权过期不影响已验证的既有执行回执。";
  return report;
}
