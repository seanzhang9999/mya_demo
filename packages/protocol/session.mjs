import * as P from "./core.mjs";
export class AgentSession {
  constructor(client, identity, state = {}, save = async () => {}) {
    this.client = client;
    this.identity = identity;
    this.state = { bindings: {}, requests: {}, ...state };
    this.save = () => save(this.state);
  }
  async startPair() {
    const t = P.now(),
      inv = {
        type: "PairInvitation",
        invite_id: P.id(),
        agent: P.agentPublic(this.identity),
        origin: this.client.origin,
        issued_at: t,
        expires_at: t + 300000,
        nonce: P.id(),
      };
    const invite = await P.sign(inv, this.identity.sign);
    const result = await this.client.raw("/v1/pairings", { invite });
    this.state.pair = { ...result, invite: inv };
    await this.save();
    return {
      ...result,
      link: `${this.client.origin}/mobile/#invite=${inv.invite_id}&agent=${this.identity.sign.kid}&witness=${await P.thumb(this.client.trust.witness)}`,
    };
  }
  async pairStatus() {
    P.check(this.state.pair, "NO_PAIRING");
    const p = await this.client.raw(
      "/v1/pairings/" + this.state.pair.invite_id,
    );
    await P.verify(p.invite_jws, this.identity.sign.publicKey);
    P.check(
      JSON.stringify(p.invite) === JSON.stringify(this.state.pair.invite),
      "INVITATION_CHANGED",
    );
    if (p.credentials) {
      const r = await P.verifyCredentials(p.credentials, this.client.trust);
      P.check(
        (await P.thumb(r.agent.sign)) === this.identity.sign.kid,
        "BINDING_MISMATCH",
      );
      this.state.bindings[r.binding_id] = {
        relation: r,
        credentials: p.credentials,
      };
      await this.save();
    }
    return {
      ...p,
      sas: p.join ? await P.sas(await P.relation(p.invite, p.join)) : null,
    };
  }
  async confirmPair() {
    const p = await this.pairStatus();
    P.check(p.join, "PHONE_NOT_JOINED");
    const r = await P.relation(p.invite, p.join);
    const ack = {
      type: "PairConfirmation",
      invite_id: p.id,
      relationship_payload_hash: await P.hash(JSON.stringify(r)),
      ...P.stamp(300000),
    };
    await this.client.raw(`/v1/pairings/${p.id}/confirm`, {
      role: "agent",
      signature: await P.sign(ack, this.identity.sign),
    });
    return this.pairStatus();
  }
  binding(id) {
    const b =
      this.state.bindings[id || Object.keys(this.state.bindings).at(-1)];
    P.check(b, "NO_BINDING");
    return b;
  }
  async submit(payload, opts = {}) {
    const b = this.binding(opts.binding_id),
      r = b.relation;
    await this.assertActive(r);
    const bundle = await P.requestBundle(this.identity, r, payload, opts);
    const q = P.peek(bundle.request_jws);
    const item = await P.seal(
      "approval.request",
      bundle,
      r,
      this.identity,
      true,
    );
    this.state.requests[q.request_id] = {
      bundle,
      binding_id: r.binding_id,
      status: "pending",
      outgoing: item,
    };
    await this.save();
    await this.client.auth(
      "/v1/relay/send",
      item,
      this.identity.sign,
      r.binding_id,
    );
    return q.request_id;
  }
  async assertActive(r) {
    const s = await this.client.auth(
        "/v1/bindings/status",
        {},
        this.identity.sign,
        r.binding_id,
      ),
      v = await P.verify(s.status, this.client.trust.witness);
    P.validTime(v, 30000);
    P.check(
      v.binding_id === r.binding_id && v.status === "active",
      "BINDING_REVOKED",
    );
  }
  async poll() {
    for (const b of Object.values(this.state.bindings)) {
      const r = b.relation;
      await this.assertActive(r);
      for (const x of Object.values(this.state.requests))
        if (
          x.binding_id === r.binding_id &&
          x.status === "pending" &&
          P.peek(x.bundle.request_jws).expires_at > P.now()
        )
          await this.client.auth(
            "/v1/relay/send",
            x.outgoing,
            this.identity.sign,
            r.binding_id,
          );
      const { messages } = await this.client.auth(
        "/v1/relay/poll",
        {},
        this.identity.sign,
        r.binding_id,
      );
      for (const item of messages) {
        const m = await P.openMessage(item, r, this.identity, false),
          rec = this.state.requests[m.body.request_id];
        if (
          rec &&
          rec.binding_id === r.binding_id &&
          rec.status === "pending"
        ) {
          if (m.kind === "approval.granted") {
            const g = P.peek(m.body.grant);
            await P.verify(
              m.body.grant,
              g.decision_mode === "policy_auto" ? r.phone.auto : r.phone.user,
            );
            const q = P.peek(rec.bundle.request_jws);
            P.check(
              g.request_id === q.request_id &&
                g.action_hash === q.action_hash &&
                g.context_hash === q.context_hash &&
                g.binding_id === r.binding_id,
              "GRANT_MISMATCH",
            );
            rec.status = "approved";
            rec.grant = m.body.grant;
            rec.delegation = m.body.delegation;
          } else if (
            ["approval.denied", "approval.changes_requested"].includes(m.kind)
          ) {
            rec.status = m.kind.split(".")[1];
            rec.feedback = m.body.reason;
          }
        }
        await this.save();
        await this.client.auth(
          "/v1/relay/ack",
          { message_id: item.message_id },
          this.identity.sign,
          r.binding_id,
        );
      }
    }
    return this.state.requests;
  }
  async execute(request_id) {
    const rec = this.state.requests[request_id];
    P.check(
      rec && ["approved", "succeeded", "unknown"].includes(rec.status),
      "NOT_APPROVED",
    );
    const r = this.binding(rec.binding_id).relation;
    await this.assertActive(r);
    if (rec.receipt)
      return {
        receipt: rec.receipt,
        data: await P.verify(rec.receipt, this.client.trust.resource),
      };
    const body = {
      request_jws: rec.bundle.request_jws,
      payload_b64: rec.bundle.payload_b64,
      grant: rec.grant,
    };
    if (rec.delegation) body.delegation = rec.delegation;
    rec.status = "unknown";
    await this.save();
    const result = await this.client.auth(
      "/v1/demo/reports",
      body,
      this.identity.sign,
      r.binding_id,
    );
    return this.acceptReceipt(rec, r, result.receipt);
  }
  async acceptReceipt(rec, r, jws) {
    const data = await P.verify(jws, this.client.trust.resource),
      q = P.peek(rec.bundle.request_jws);
    P.check(
      data.type === "ExecutionReceipt" &&
        data.binding_id === r.binding_id &&
        data.request_id === q.request_id &&
        data.action_hash === q.action_hash &&
        data.result === "delivered_to_demo_inbox",
      "RECEIPT_MISMATCH",
    );
    rec.receipt = jws;
    rec.status = "succeeded";
    rec.receipt_message = await P.seal(
      "execution.receipt",
      { request_id: q.request_id, receipt: jws },
      r,
      this.identity,
      true,
    );
    await this.save();
    await this.client.auth(
      "/v1/relay/send",
      rec.receipt_message,
      this.identity.sign,
      r.binding_id,
    );
    return { receipt: jws, data };
  }
  async query(request_id) {
    const rec = this.state.requests[request_id];
    P.check(rec, "UNKNOWN_REQUEST");
    const r = this.binding(rec.binding_id).relation;
    const result = await this.client.auth(
      "/v1/demo/executions/query",
      { request_id },
      this.identity.sign,
      r.binding_id,
    );
    return result.receipt
      ? this.acceptReceipt(rec, r, result.receipt)
      : { status: "unknown" };
  }
  async cancel(request_id) {
    const rec = this.state.requests[request_id];
    P.check(rec, "UNKNOWN_REQUEST");
    P.check(rec.status !== "succeeded", "ALREADY_EXECUTED");
    const r = this.binding(rec.binding_id).relation;
    await this.client.auth(
      "/v1/requests/cancel",
      { request_id },
      this.identity.sign,
      r.binding_id,
    );
    rec.status = "cancelled";
    await this.save();
    await this.client.auth(
      "/v1/relay/send",
      await P.seal(
        "approval.cancelled",
        { request_id },
        r,
        this.identity,
        true,
      ),
      this.identity.sign,
      r.binding_id,
    );
  }
}
export class PhoneSession {
  constructor(client, identity, state = {}, save = async () => {}) {
    this.client = client;
    this.identity = identity;
    this.state = {
      bindings: {},
      records: {},
      policies: {},
      outbox: [],
      ...state,
    };
    this.save = () => save(this.state);
  }
  async joinPair(invite_id, expectedAgent = null) {
    const p = await this.client.raw("/v1/pairings/" + invite_id);
    const signedInvite = await P.verify(p.invite_jws, p.invite.agent.sign);
    P.check(
      JSON.stringify(signedInvite) === JSON.stringify(p.invite),
      "INVITATION_CHANGED",
    );
    P.check(p.invite.origin === this.client.origin, "ORIGIN_MISMATCH");
    if (expectedAgent)
      P.check(
        (await P.thumb(p.invite.agent.sign)) === expectedAgent,
        "AGENT_KEY_MISMATCH",
      );
    const t = P.now(),
      join = {
        type: "PhoneJoin",
        invite_id,
        phone: P.phonePublic(this.identity),
        issued_at: t,
        expires_at: t + 300000,
        nonce: P.id(),
      };
    await this.client.raw(`/v1/pairings/${invite_id}/join`, {
      join: await P.sign(join, this.identity.phone),
    });
    this.state.pair = { invite: p.invite, join };
    await this.save();
    return this.pairStatus();
  }
  async pairStatus() {
    const pair = this.state.pair;
    P.check(pair, "NO_PAIRING");
    const p = await this.client.raw("/v1/pairings/" + pair.invite.invite_id);
    P.check(
      JSON.stringify(p.invite) === JSON.stringify(pair.invite) &&
        JSON.stringify(p.join) === JSON.stringify(pair.join),
      "TRANSCRIPT_MISMATCH",
    );
    const r = await P.relation(pair.invite, pair.join);
    if (p.credentials) {
      const verified = await P.verifyCredentials(
        p.credentials,
        this.client.trust,
      );
      P.check(
        JSON.stringify(verified) === JSON.stringify(r),
        "TRANSCRIPT_MISMATCH",
      );
      this.state.bindings[r.binding_id] = {
        relation: r,
        credentials: p.credentials,
        status: "active",
      };
      await this.save();
    }
    return { ...p, relation: r, sas: await P.sas(r) };
  }
  async confirmPair() {
    const p = await this.pairStatus();
    P.check(!p.credentials, "PAIRING_CONSUMED");
    await this.client.raw(`/v1/pairings/${p.id}/confirm`, {
      role: "phone",
      signature: await P.sign(p.relation, this.identity.user),
    });
    return this.pairStatus();
  }
  async assertActive(r) {
    const s = await this.client.auth(
        "/v1/bindings/status",
        {},
        this.identity.phone,
        r.binding_id,
      ),
      v = await P.verify(s.status, this.client.trust.witness);
    P.validTime(v, 30000);
    P.check(
      v.binding_id === r.binding_id && v.status === "active",
      "BINDING_REVOKED",
    );
  }
  async flush() {
    for (const msg of [...this.state.outbox]) {
      if (this.state.bindings[msg.binding_id]?.status === "revoked") {
        this.state.outbox = this.state.outbox.filter(
          (x) => x.item.message_id !== msg.item.message_id,
        );
        await this.save();
        continue;
      }
      await this.client.auth(
        "/v1/relay/send",
        msg.item,
        this.identity.phone,
        msg.binding_id,
      );
      this.state.outbox = this.state.outbox.filter(
        (x) => x.item.message_id !== msg.item.message_id,
      );
      await this.save();
    }
  }
  async respond(rec, kind, body) {
    const r = this.state.bindings[rec.q.binding_id].relation;
    const item = await P.seal(
      kind,
      { request_id: rec.q.request_id, ...body },
      r,
      this.identity,
      false,
    );
    this.state.outbox.push({ binding_id: r.binding_id, item });
    await this.save();
    await this.flush();
  }
  async poll() {
    await this.flush();
    for (const b of Object.values(this.state.bindings)) {
      if (b.status === "revoked") continue;
      const r = b.relation;
      try {
        await this.assertActive(r);
      } catch (e) {
        if (e.code === "BINDING_REVOKED") {
          b.status = "revoked";
          await this.save();
          continue;
        }
        throw e;
      }
      const { messages } = await this.client.auth(
        "/v1/relay/poll",
        {},
        this.identity.phone,
        r.binding_id,
      );
      for (const item of messages) {
        const m = await P.openMessage(item, r, this.identity, true);
        if (m.kind === "approval.request") {
          const hint = P.peek(m.body.request_jws);
          if (!this.state.records[hint.request_id]) {
            const { q, a, bytes } = await P.verifyRequest(m.body, r, {
              allowExpired: true,
            });
            const rec = {
              q,
              a,
              bundle: m.body,
              status: q.expires_at <= P.now() ? "expired" : "pending",
              execution: "not_started",
              analysis: P.analyze(a, bytes),
              events: [{ type: "requested", at: P.now() }],
            };
            this.state.records[q.request_id] = rec;
            await this.save();
          }
          const saved = this.state.records[hint.request_id];
          P.check(
            saved.bundle.request_jws === m.body.request_jws,
            "REQUEST_ID_CONFLICT",
          );
          if (saved.status === "pending" && saved.q.expires_at > P.now()) {
            const policies = Object.values(this.state.policies).filter(
              (p) =>
                p.status === "active" &&
                (p.uses.includes(hint.request_id) ||
                  p.uses.length < p.data.max_approvals) &&
                P.matches(
                  p.data,
                  saved.q,
                  saved.a,
                  P.unb64(saved.bundle.payload_b64),
                ),
            );
            if (policies.length === 1)
              await this.approve(
                saved.q.request_id,
                policies[0].data.delegation_id,
              );
          }
        } else if (m.kind === "execution.receipt") {
          const rec = this.state.records[m.body.request_id];
          if (rec) {
            const receipt = await P.verify(
              m.body.receipt,
              this.client.trust.resource,
            );
            P.check(
              receipt.binding_id === r.binding_id &&
                receipt.request_id === rec.q.request_id &&
                receipt.action_hash === rec.q.action_hash &&
                receipt.result === "delivered_to_demo_inbox",
              "RECEIPT_MISMATCH",
            );
            rec.receipt = m.body.receipt;
            rec.execution = "succeeded";
            rec.events.push({ type: "executed", at: receipt.executed_at });
          }
        } else if (m.kind === "approval.cancelled") {
          const rec = this.state.records[m.body.request_id];
          if (rec && rec.execution !== "succeeded") {
            rec.status = "cancelled";
            rec.events.push({ type: "cancelled", at: P.now() });
          }
        }
        await this.save();
        await this.client.auth(
          "/v1/relay/ack",
          { message_id: item.message_id },
          this.identity.phone,
          r.binding_id,
        );
      }
    }
    return this.state;
  }
  async approve(request_id, policy_id = null) {
    const rec = this.state.records[request_id];
    P.check(rec && rec.status === "pending", "NOT_PENDING");
    const r = this.state.bindings[rec.q.binding_id].relation;
    await this.assertActive(r);
    await P.verifyRequest(rec.bundle, r);
    let policy = null;
    if (policy_id) {
      policy = this.state.policies[policy_id];
      P.check(
        policy?.status === "active" &&
          P.matches(policy.data, rec.q, rec.a, P.unb64(rec.bundle.payload_b64)),
        "POLICY_SCOPE_MISMATCH",
      );
      if (!policy.uses.includes(request_id)) {
        P.check(
          policy.uses.length < policy.data.max_approvals,
          "POLICY_LIMIT_REACHED",
        );
        policy.uses.push(request_id);
        await this.save();
      }
    }
    const signed = await P.grant(this.identity, r, rec.q, {
      policy,
      analysis_id: rec.analysis.analysis_id,
    });
    rec.grant = signed;
    rec.status = "approved";
    rec.execution = "not_started";
    rec.mode = policy ? "policy_auto" : "human_confirmed_demo";
    rec.events.push({ type: rec.mode, at: P.now() });
    await this.respond(rec, "approval.granted", {
      grant: signed,
      delegation: policy?.jws || null,
    });
  }
  async decide(request_id, kind, reason) {
    P.check(["denied", "changes_requested"].includes(kind));
    const rec = this.state.records[request_id];
    P.check(rec?.status === "pending", "NOT_PENDING");
    rec.status = kind;
    rec.reason = reason;
    rec.events.push({ type: kind, at: P.now() });
    await this.respond(rec, "approval." + kind, { reason });
  }
  async createPolicy(request_id, opts) {
    const rec = this.state.records[request_id];
    P.check(rec?.status === "approved", "APPROVAL_REQUIRED");
    const r = this.state.bindings[rec.q.binding_id].relation;
    P.check(
      P.structuredReport(rec.a, P.unb64(rec.bundle.payload_b64)) &&
        rec.a.recipient_id === "supplier-a",
      "POLICY_TEMPLATE_REQUIRED",
    );
    await this.assertActive(r);
    const d = await P.delegation(this.identity, r, opts);
    const policy = {
      ...d,
      status: "pending_registration",
      uses: [],
      source_review_id: request_id,
    };
    this.state.policies[d.data.delegation_id] = policy;
    await this.save();
    return this.registerPolicy(d.data.delegation_id);
  }
  async registerPolicy(delegation_id) {
    const p = this.state.policies[delegation_id];
    P.check(p?.status === "pending_registration", "INVALID_POLICY_STATE");
    const r = this.state.bindings[p.data.binding_id].relation;
    const result = await this.client.auth(
      "/v1/delegations",
      { jws: p.jws },
      this.identity.phone,
      r.binding_id,
    );
    const ack = await P.verify(result.confirmation, this.client.trust.resource);
    P.check(
      ack.delegation_id === p.data.delegation_id &&
        ack.payload_hash === (await P.hash(p.jws)) &&
        ack.status === "active",
      "INVALID_REGISTRATION",
    );
    p.status = "active";
    p.confirmation = result.confirmation;
    await this.save();
    return p;
  }
  async pause(delegation_id) {
    const p = this.state.policies[delegation_id];
    P.check(p, "UNKNOWN_POLICY");
    p.status = "pending_pause";
    await this.save();
    await this.client.auth(
      "/v1/delegations/pause",
      { delegation_id },
      this.identity.user,
      p.data.binding_id,
    );
    p.status = "paused";
    await this.save();
  }
  async revoke(binding_id) {
    const b = this.state.bindings[binding_id];
    P.check(b, "UNKNOWN_BINDING");
    b.status = "revoked";
    await this.save();
    await this.client.auth(
      "/v1/bindings/revoke",
      {},
      this.identity.user,
      binding_id,
    );
  }
  async receipt(request_id) {
    const rec = this.state.records[request_id];
    P.check(rec, "UNKNOWN_REQUEST");
    const out = await this.client.auth(
      "/v1/demo/executions/query",
      { request_id },
      this.identity.phone,
      rec.q.binding_id,
    );
    if (out.receipt) {
      const v = await P.verify(out.receipt, this.client.trust.resource);
      P.check(
        v.request_id === request_id &&
          v.binding_id === rec.q.binding_id &&
          v.action_hash === rec.q.action_hash,
        "RECEIPT_MISMATCH",
      );
      rec.receipt = out.receipt;
      rec.execution = "succeeded";
      await this.save();
    }
    return out;
  }
}
