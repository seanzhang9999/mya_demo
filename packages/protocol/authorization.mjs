import * as P from "./core.mjs";

// Shared by both execution paths and the wallet verifier.
export async function verifyAuthorization(
  data,
  relation,
  { allowExpired = false } = {},
) {
  const { q, a, bytes } = await P.verifyRequest(data, relation, {
    context: false,
    allowExpired,
  });
  const hint = P.peek(data.grant),
    auto = hint.decision_mode === "policy_auto";
  const g = await P.verify(
    data.grant,
    auto ? relation.phone.auto : relation.phone.user,
  );
  P.fields(g, [
    "type",
    "grant_id",
    "request_id",
    "binding_id",
    "binding_version",
    "agent_key_id",
    "audience",
    "action_hash",
    "context_hash",
    "decision",
    "decision_mode",
    "delegation_id",
    "delegation_hash",
    "analysis_id",
    "issued_at",
    "expires_at",
    "user_verification",
    "environment",
  ]);
  if (!allowExpired) P.validTime(g, 120000);
  P.check(
    g.type === "ApprovalGrant" &&
      g.decision === "approve" &&
      ["policy_auto", "human_confirmed_demo"].includes(g.decision_mode) &&
      g.binding_id === relation.binding_id &&
      g.binding_version === 1 &&
      g.request_id === q.request_id &&
      g.agent_key_id === q.agent_key_id &&
      g.audience === P.AUD &&
      g.action_hash === q.action_hash &&
      g.context_hash === q.context_hash &&
      g.expires_at <= q.expires_at &&
      g.user_verification === "simulated" &&
      g.environment === "demo",
    "GRANT_MISMATCH",
  );
  let d;
  if (auto) {
    d = await P.validateDelegation(data.delegation, relation);
    P.check(
      d.delegation_id === g.delegation_id &&
        (await P.hash(data.delegation)) === g.delegation_hash &&
        P.matches(d, q, a, bytes) &&
        g.expires_at <= d.expires_at,
      "POLICY_SCOPE_MISMATCH",
    );
  } else P.check(!g.delegation_id && !g.delegation_hash, "GRANT_MISMATCH");

  return { q, a, bytes, g, d, auto };
}
