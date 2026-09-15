import * as P from "../../packages/protocol/core.mjs";
import { PhoneSession } from "../../packages/protocol/session.mjs";
import { get, set, loadState, saveState } from "./storage.mjs";
import jsQR from "jsqr";
const root = document.querySelector("#app"),
  modal = document.querySelector("#modal");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (t) =>
  new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const short = (s) => s?.slice(0, 10) || "—";
let tab = "inbox",
  selected = null,
  filter = "all",
  phone,
  client,
  busy = false,
  connected = false,
  last = "",
  pairView = null,
  stream = null;
const statuses = {
  pending: "等待您决定",
  approved: "已批准",
  changes_requested: "已要求修改",
  denied: "已拒绝",
  cancelled: "已取消",
  expired: "已过期",
};
function toast(s) {
  const el = document.querySelector("#toast");
  el.textContent = s;
  el.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.style.display = "none"), 4300);
}
async function lock(fn) {
  P.check(
    navigator.locks,
    "此浏览器不支持多标签锁，请使用当前 Chrome 或 Safari",
  );
  return navigator.locks.request("mya-phone-work", async () => {
    phone.state = {
      bindings: {},
      records: {},
      policies: {},
      outbox: [],
      ...(await loadState()),
    };
    const result = await fn();
    return result;
  });
}
async function run(fn) {
  // User actions queue behind polling instead of silently disappearing.
  busy = true;
  try {
    await lock(fn);
    connected = true;
  } catch (e) {
    toast(e.code || e.message);
    console.error(e.code || e.message);
  } finally {
    busy = false;
    render();
  }
}
function shell(body) {
  const pending = Object.values(phone.state.records).filter(
    (r) => r.status === "pending" && r.q.expires_at > P.now(),
  ).length;
  return `<main class="shell"><header class="top"><div class="brand"><span class="brandmark">m</span>MYA</div><span class="tag amber">演示环境 · 指纹确认模拟</span></header>${body}<p class="tiny muted spaced"><span class="status-dot"></span>${connected ? "连接正常" : "等待连接"} · 本地记录 · 页面需保持前台</p></main><nav class="dock">${[
    ["inbox", `待审批${pending ? " · " + pending : ""}`],
    ["history", "审批记录"],
    ["policies", "自动规则"],
    ["devices", "我的 Agent"],
  ]
    .map(
      ([k, v]) =>
        `<button data-tab="${k}" class="${tab === k ? "active" : ""}">${v}</button>`,
    )
    .join("")}</nav>`;
}
function intro() {
  return `<section class="hero"><div><div class="eyebrow">YOUR DECISION. YOUR RULES.</div><h1>工作交给 Agent，<br>决定留在您手里。</h1><p>绑定您的工作助手，在手机上审视请求、批准操作，并留下每一次决定的依据。</p></div></section><div class="grid"><section class="card intro"><div class="circle">⌘</div><h2>连接第一个 Agent</h2><p class="muted">在 PC 上运行 MYA 配对，在这里扫描二维码或输入配对码。</p><div class="actions"><button data-action="scan">扫一扫</button><button class="secondary" data-action="code">输入配对码</button></div><p class="hint">系统相机也可直接扫描 PC 上的邀请链接。</p></section><section class="card"><div class="eyebrow">HOW IT WORKS</div><h3>从一次确认，到持续受控</h3><div class="timeline"><p>核对双方短码，确认 Agent 身份</p><p>查看申请内容与辅助评估建议</p><p>批准本次，保存完整审批记录</p><p>单独设定规则，自动处理相同请求</p></div><div class="notice">指纹交互与分析内容可模拟；密钥签名、关系见证和执行验签真实运行。</div></section></div>`;
}
function pairing() {
  return `<section class="card"><div class="eyebrow">PAIR YOUR AGENT</div><h2>请核对两端短码</h2><p class="muted">确认 PC 与手机显示完全一致，再分别确认。</p><div class="pair-code">${esc(pairView.sas)}</div><div class="meta"><dt>工作助手</dt><dd>${esc(pairView.relation.agent.name)}</dd><dt>关系用途</dt><dd>提交审批请求，不自动获得执行权限</dd></div><div class="actions"><button data-action="confirm-pair" ${pairView.phone_signature ? "disabled" : ""}>${pairView.phone_signature ? "手机已确认，等待 PC" : "短码一致，确认配对"}</button><button class="secondary" data-action="refresh-pair">刷新状态</button></div><p class="hint">公钥指纹 ${esc(short(phone.identity.user.kid))} · 双端确认后签发见证</p></section>`;
}
function card(rec) {
  const expired = rec.status === "pending" && rec.q.expires_at < P.now();
  return `<article class="card" data-request="${esc(rec.q.request_id)}"><div class="row"><span class="tag ${rec.status === "pending" ? "amber" : "green"}">${expired ? "已过期" : statuses[rec.status]}</span><span class="tiny muted">${time(rec.q.issued_at)}</span></div><div class="row top-align spaced"><div><h2>向供应商发送项目报告</h2><p class="muted tiny">${esc(rec.a.recipient_id)} · ${esc(rec.a.project_id)}</p></div><div class="paper"><i></i><i></i><i></i></div></div><p class="tiny muted">${rec.mode === "policy_auto" ? "依据本地规则自动批准" : rec.execution === "succeeded" ? "已投递到演示收件箱" : "来自已绑定的 PC Agent"}</p><div class="actions"><button class="outline" data-action="detail" data-id="${esc(rec.q.request_id)}">${rec.status === "pending" && !expired ? "查看请求与建议" : "查看审批记录"}</button></div></article>`;
}
function details(rec) {
  const can = rec.status === "pending" && rec.q.expires_at > P.now(),
    structured = P.structuredReport(rec.a, P.unb64(rec.bundle.payload_b64));
  return `<button class="small secondary" data-action="back">← 返回</button><div class="hero spaced"><div><div class="eyebrow">APPROVAL DETAIL</div><h1>把这次决定，看清楚。</h1></div></div><div class="grid"><div><section class="card"><div class="row"><span class="tag green">关系与见证已验证</span><span class="tiny muted">${esc(short(rec.q.request_id))}</span></div><h2 class="spaced">向供应商发送项目报告</h2><dl class="meta"><dt>接收方</dt><dd>${esc(rec.a.recipient_id)}（演示收件箱）</dd><dt>项目</dt><dd>${esc(rec.a.project_id)}</dd><dt>文件</dt><dd>${esc(rec.a.payload.file_name)}</dd><dt>状态</dt><dd>${statuses[rec.status]} · ${rec.execution === "succeeded" ? "已执行" : "尚无执行成功回执"}</dd><dt>批准方式</dt><dd>${rec.mode === "policy_auto" ? "本地规则自动批准" : rec.mode ? "人工确认（指纹模拟）" : "尚未批准"}</dd></dl><details><summary>查看最终文件正文与摘要</summary><pre>${esc(P.dec.decode(P.unb64(rec.bundle.payload_b64)))}</pre><p class="tiny muted">SHA-256 ${esc(rec.a.payload.sha256)}</p></details><details><summary>查看用户目标与 Agent 说明</summary><pre>${esc(JSON.stringify(P.decode(rec.bundle.context_b64), null, 2))}</pre></details>${rec.q.supersedes_request_id ? `<p class="hint">修订自 ${esc(short(rec.q.supersedes_request_id))}</p>` : ""}</section><section class="card"><div class="row"><h3>审批时间线</h3><span class="tag">Review</span></div><div class="timeline">${rec.events.map((e) => `<p>${esc({ requested: "收到审批请求", human_confirmed_demo: "用户确认并签署（指纹模拟）", policy_auto: "按规则自动批准", executed: "演示投递完成", denied: "用户拒绝", changes_requested: "用户要求修改", cancelled: "请求取消" }[e.type] || e.type)} <span class="muted tiny">${time(e.at)}</span></p>`).join("")}</div>${rec.reason ? `<p class="notice">处理意见：${esc(rec.reason)}</p>` : ""}<div class="actions"><button class="secondary small" data-action="receipt" data-id="${esc(rec.q.request_id)}">查询执行结果</button><button class="secondary small" data-action="mark" data-id="${esc(rec.q.request_id)}">${rec.review_flag ? "已标记需复盘" : "标记需复盘"}</button></div></section></div><div><section class="card"><div class="row"><h3>审批伙伴的建议</h3><span class="tag amber">模拟分析＋规则检查</span></div><div class="summary"><h3>${rec.analysis.recommendation === "modify" ? "建议修改后批准" : "请您确认是否发送"}</h3><p>${esc(rec.analysis.summary)}</p></div><div class="evidence"><strong>${esc(P.COMPANY.title)} V1 · ${P.COMPANY.clause}</strong><p>${esc(P.COMPANY.text)}</p></div><ul class="tiny muted">${rec.analysis.facts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="hint">${esc(rec.analysis.unknowns[0])}</p>${can ? `<div class="actions"><button data-action="approve" data-id="${esc(rec.q.request_id)}">批准本次</button><button class="secondary" data-action="change" data-id="${esc(rec.q.request_id)}">要求修改</button></div><button class="danger small spaced" data-action="deny" data-id="${esc(rec.q.request_id)}">拒绝请求</button>` : ""}</section>${rec.status === "approved" && structured && rec.a.recipient_id === "supplier-a" ? `<section class="card accent"><div class="eyebrow">NEXT TIME, YOUR RULES</div><h3>此类请求，可以按规则处理</h3><p class="tiny">根据演示公司要求，您可以单独创建有限规则。以后符合条件自动批准，完成后提醒您。</p><div class="actions"><button data-action="policy" data-id="${esc(rec.q.request_id)}">查看并编辑规则</button></div><p class="hint">本次批准不会自动启用任何规则。</p></section>` : ""}<details><summary>查看授权与执行凭证</summary><pre>${esc(JSON.stringify({ request_id: rec.q.request_id, grant: rec.grant ? P.peek(rec.grant) : null, receipt: rec.receipt ? P.peek(rec.receipt) : null }, null, 2))}</pre></details></div></div>`;
}
function rules() {
  const list = Object.values(phone.state.policies);
  return `<section class="hero"><div><div class="eyebrow">POLICIES YOU CONTROL</div><h1>把经验，变成规则。</h1><p>每条规则由您单独确认；超出范围，回到人工审批。</p></div><span class="hero-number">${list.filter((p) => p.status === "active").length}</span></section>${list.length ? list.map((p) => `<section class="card"><div class="row"><h2>项目进度报告外发</h2><span class="tag ${p.status === "active" ? "green" : "amber"}">${esc({ active: "已启用", paused: "已暂停", pending_pause: "暂停待同步", pending_registration: "登记待同步" }[p.status])}</span></div><dl class="meta"><dt>接收方</dt><dd>supplier-a</dd><dt>范围</dt><dd>project-alpha · 固定结构化模板</dd><dt>有效至</dt><dd>${time(p.data.expires_at)}</dd><dt>例外处理</dt><dd>未知字段 / 收件人变化 → 人工审批</dd></dl><div class="statbox"><div><strong>${p.uses.length} / ${p.data.max_approvals}</strong><span>已自动批准 / 上限</span></div><div><strong>${p.uses.filter((id) => phone.state.records[id]?.execution === "succeeded").length}</strong><span>已执行</span></div></div><div class="actions">${p.status === "pending_registration" ? `<button data-action="register-policy" data-id="${p.data.delegation_id}">重试登记</button>` : ""}${p.status !== "paused" ? `<button class="secondary" data-action="pause" data-id="${p.data.delegation_id}">暂停规则</button>` : ""}<button class="outline" data-action="detail" data-id="${p.source_review_id}">回看形成依据</button></div><p class="hint">人工确认：模拟验证 · 执行后站内提醒 · 修改范围请暂停后重新创建</p></section>`).join("") : `<section class="card empty"><div class="empty-icon">≋</div><h3>还没有自动审批规则</h3><p>完成一次审批后，从记录中起草并确认。<br>历史上的“同意”不会成为默认授权。</p></section>`}`;
}
function devices() {
  return `<section class="hero"><div><div class="eyebrow">TRUSTED RELATIONSHIPS</div><h1>您认领的工作助手。</h1><p>配对建立审批联系，不直接授予执行权限。</p></div></section>${pairView && !pairView.credentials ? pairing() : ""}${Object.values(
    phone.state.bindings,
  )
    .map(
      (b) =>
        `<section class="card"><div class="row"><h2>${esc(b.relation.agent.name)}</h2><span class="tag green">${b.status === "active" ? "已绑定" : "已撤销/待同步"}</span></div><dl class="meta"><dt>关系 ID</dt><dd>${esc(b.relation.binding_id)}</dd><dt>有效至</dt><dd>${time(b.relation.expires_at)}</dd><dt>见证</dt><dd>签名已验证 · Demo 凭证</dd><dt>DID</dt><dd>接入预留；当前以公钥指纹验证</dd></dl><details><summary>关系凭证与见证详情</summary><pre>${esc(JSON.stringify({ relation: b.relation, witness: P.peek(b.credentials.witness) }, null, 2))}</pre></details><div class="actions"><button class="danger" data-action="revoke" data-id="${b.relation.binding_id}">${b.status === "active" ? "撤销关系" : "重新同步撤销"}</button></div></section>`,
    )
    .join(
      "",
    )}<div class="actions"><button data-action="scan">扫描新 Agent</button><button class="secondary" data-action="code">输入配对码</button></div><section class="card spaced"><h3>您的本地数据</h3><p class="tiny muted">密钥、规则和审批记录保存在当前浏览器。清理站点数据或更换浏览器后，需要重新配对。网页提供方仍能更新代码；本 Demo 不证明硬件级隔离。</p><button class="outline small spaced" data-action="export">导出审批记录（不含私钥）</button></section>`;
}
function render() {
  if (!phone) return;
  const records = Object.values(phone.state.records).sort(
    (a, b) => b.q.issued_at - a.q.issued_at,
  );
  let body;
  if (selected && phone.state.records[selected])
    body = details(phone.state.records[selected]);
  else if (tab === "devices") body = devices();
  else if (tab === "policies") body = rules();
  else if (!Object.keys(phone.state.bindings).length)
    body = (pairView ? pairing() : "") + intro();
  else {
    const list =
      tab === "inbox"
        ? records.filter(
            (r) => r.status === "pending" && r.q.expires_at > P.now(),
          )
        : records.filter(
            (r) =>
              filter === "all" ||
              (filter === "auto" ? r.mode === "policy_auto" : r.review_flag),
          );
    body = `<section class="hero"><div><div class="eyebrow">${tab === "inbox" ? "YOUR APPROVAL INBOX" : "DECISIONS WITH CONTEXT"}</div><h1>${tab === "inbox" ? "每个决定，都有依据。" : "每次审批，都能回看。"}</h1><p>${tab === "inbox" ? "先了解，再决定。工作助手正在等待您的意见。" : "保留请求、评估、修改、授权及执行结果。"}</p></div><span class="hero-number">${list.length}</span></section>${
      tab === "history"
        ? `<div class="subnav">${[
            ["all", "全部记录"],
            ["auto", "自动审批"],
            ["flag", "需复盘"],
          ]
            .map(
              ([k, v]) =>
                `<button class="${filter === k ? "active" : ""}" data-filter="${k}">${v}</button>`,
            )
            .join("")}</div>`
        : ""
    }<div class="grid"><div>${list.length ? list.map(card).join("") : '<section class="card empty"><div class="empty-icon">✓</div><h3>现在没有待处理的请求</h3><p>让 Codex 发起报告审批，请求会出现在这里。</p></section>'}</div><aside><section class="card accent"><div class="eyebrow">YOUR APPROVAL PARTNER</div><h3>一次批准，只针对这一次。</h3><p class="tiny muted">“按规则自动批准”需要您另行确认。任何时候，您都可以暂停规则或解除 Agent 关系。</p></section><section class="card"><h3>演示公司要求</h3><p class="tiny muted">${esc(P.COMPANY.text)}</p><p class="hint">预置演示制度 V1，尚未连接真实企业治理系统。</p></section></aside></div>`;
  }
  root.innerHTML = shell(body);
  last = JSON.stringify(phone.state);
}
function closeModal() {
  modal.innerHTML = "";
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
function dialog(title, body, confirm, label = "模拟验证并批准") {
  modal.innerHTML = `<div class="overlay"><section class="dialog"><h2>${esc(title)}</h2>${body}<div class="actions"><button id="confirm-modal">${esc(label)}</button><button class="secondary" id="cancel-modal">取消</button></div></section></div>`;
  document.querySelector("#cancel-modal").onclick = closeModal;
  document.querySelector("#confirm-modal").onclick = () => {
    const inputs = Object.fromEntries(
      [...modal.querySelectorAll("input,textarea")].map((i) => [
        i.name,
        i.value,
      ]),
    );
    closeModal();
    run(() => confirm(inputs));
  };
}
function verification(title, text, fn, label) {
  dialog(
    title,
    `<div class="circle">◎</div><p>${esc(text)}</p><p class="notice">指纹验证为模拟交互。点击后浏览器会真实签署当前请求，不代表系统生物识别。</p>`,
    fn,
    label,
  );
}
async function handleInvite(link) {
  const u = new URL(link, location.origin);
  P.check(u.origin === location.origin, "请打开正确的 MYA 服务页面");
  const f = new URLSearchParams(u.hash.slice(1));
  P.check(f.get("invite"), "INVALID_INVITATION");
  if (f.get("witness"))
    P.check(
      f.get("witness") === (await P.thumb(client.trust.witness)),
      "SERVER_TRUST_CHANGED",
    );
  pairView = await phone.joinPair(f.get("invite"), f.get("agent"));
  tab = "devices";
  selected = null;
}
root.addEventListener("click", (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.tab) {
    tab = el.dataset.tab;
    selected = null;
    render();
    return;
  }
  if (el.dataset.filter) {
    filter = el.dataset.filter;
    render();
    return;
  }
  const a = el.dataset.action,
    rid = el.dataset.id;
  if (a === "detail") {
    selected = rid;
    render();
    return;
  }
  if (a === "back") {
    selected = null;
    render();
    return;
  }
  if (a === "approve") {
    verification(
      "确认本次操作",
      `${phone.state.records[rid].a.payload.file_name} → ${phone.state.records[rid].a.recipient_id}，仅投递一次，授权最长 120 秒。`,
      () => phone.approve(rid),
    );
    return;
  }
  if (a === "confirm-pair") {
    verification(
      "确认绑定工作助手",
      `两端短码：${pairView.sas}。请确认一致。`,
      async () => {
        pairView = await phone.confirmPair();
        toast(pairView.credentials ? "配对完成" : "手机已确认，请在 PC 确认");
      },
      "模拟验证并绑定",
    );
    return;
  }
  if (a === "policy") {
    dialog(
      "设定自动审批规则",
      `<div class="notice">只允许当前 Agent 向 supplier-a 投递 project-alpha 的固定进度模板；未知字段转人工。执行后提醒您。</div><label>最多批准次数（1–3）<input name="uses" type="number" min="1" max="3" value="3"></label><label>有效分钟数（1–1440）<input name="minutes" type="number" min="1" max="1440" value="60"></label><p class="hint">模拟用户验证后真实签署有限委托。本次操作与先前批准独立。</p>`,
      async (v) => {
        await phone.createPolicy(rid, {
          uses: Number(v.uses),
          seconds: Number(v.minutes) * 60,
        });
        toast("规则已登记并启用");
        tab = "policies";
        selected = null;
      },
      "模拟验证并启用规则",
    );
    return;
  }
  if (a === "deny" || a === "change") {
    dialog(
      a === "deny" ? "拒绝本次申请" : "要求 Agent 修改",
      `<label>处理意见<textarea name="reason">${a === "change" ? "请移除内部成本及个人信息，改为 progress-report/1 固定模板后重新申请。" : "本次不予批准。"}</textarea></label>`,
      (v) =>
        phone.decide(
          rid,
          a === "deny" ? "denied" : "changes_requested",
          v.reason,
        ),
      "发送处理意见",
    );
    return;
  }
  if (a === "pause" || a === "revoke") {
    verification(
      a === "pause" ? "暂停自动规则" : "撤销 Agent 关系",
      "本地立即停用，并向服务同步。已完成的执行不受影响。",
      () => (a === "pause" ? phone.pause(rid) : phone.revoke(rid)),
      "模拟确认并停用",
    );
    return;
  }
  if (a === "code") {
    dialog(
      "输入配对码",
      `<label>PC 显示的 8 位配对码<input name="code" autocomplete="off" placeholder="例如 4A91D02B"></label>`,
      async (v) => {
        const p = await client.raw("/v1/pairings/lookup", {
          code: v.code.trim(),
        });
        pairView = await phone.joinPair(p.invite_id);
        tab = "devices";
      },
      "继续核对短码",
    );
    return;
  }
  if (a === "scan") {
    scan();
    return;
  }
  if (a === "export") {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exported_at: new Date().toISOString(),
            records: phone.state.records,
            policies: phone.state.policies,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mya-approval-review.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  run(async () => {
    if (a === "refresh-pair") pairView = await phone.pairStatus();
    if (a === "receipt") {
      await phone.receipt(rid);
      toast(
        phone.state.records[rid].execution === "succeeded"
          ? "执行回执已验证"
          : "尚无执行成功回执",
      );
    }
    if (a === "register-policy") await phone.registerPolicy(rid);
    if (a === "mark") {
      phone.state.records[rid].review_flag =
        !phone.state.records[rid].review_flag;
      await phone.save();
    }
  });
});
async function scan() {
  modal.innerHTML =
    '<div class="overlay"><section class="dialog"><h2>扫描 PC 配对二维码</h2><video id="camera" playsinline muted></video><p class="hint">相机画面仅在本机识别，不上传。</p><div class="actions"><button id="cancel-camera" class="secondary">关闭</button></div></section></div>';
  document.querySelector("#cancel-camera").onclick = closeModal;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    const video = document.querySelector("#camera");
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (!stream) return;
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: "dontInvert",
        });
        if (code) {
          closeModal();
          run(() => handleInvite(code.data));
          return;
        }
      }
      setTimeout(tick, 200);
    };
    tick();
  } catch (e) {
    closeModal();
    toast("无法使用相机，请允许相机权限或输入配对码。");
  }
}
async function tick() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    await lock(async () => {
      if (phone.state.pair && !pairView?.credentials) {
        pairView = await phone.pairStatus();
        if (pairView.credentials) toast("配对成功，您可以开始审批");
      }
      await phone.poll();
    });
    connected = true;
    if (JSON.stringify(phone.state) !== last) render();
  } catch (e) {
    connected = false;
    if (e.code !== "PAIRING_EXPIRED") console.warn(e.code || e.message);
  } finally {
    busy = false;
  }
}
try {
  P.check(
    window.isSecureContext && crypto.subtle,
    "需要 HTTPS 或本机 localhost",
  );
  P.check(
    navigator.locks,
    "请使用支持 Web Locks 的当前 Chrome / Safari 浏览器",
  );
  let identity, trust;
  await navigator.locks.request("mya-phone-init", async () => {
    identity = await get("identity");
    if (!identity) {
      identity = await P.makePhone();
      await set("identity", identity);
    }
    trust = await get("trust");
    client = new P.Client(location.origin, trust);
    const info = await client.info();
    if (!trust) {
      trust = { witness: info.witness, resource: info.resource };
      await set("trust", trust);
    }
    client.trust = trust;
    phone = new PhoneSession(client, identity, await loadState(), saveState);
  });
  connected = true;
  const fragment = location.hash;
  if (fragment) {
    history.replaceState(null, "", location.pathname);
    await run(() => handleInvite(location.origin + "/mobile/" + fragment));
  }
  render();
  tick();
  setInterval(tick, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeModal();
    else tick();
  });
} catch (e) {
  root.innerHTML = `<main class="shell"><section class="card"><h1>暂时无法启动</h1><p>${esc(e.code || e.message)}</p><p class="hint">请在 HTTPS 页面、普通浏览器模式打开；清除站点数据会删除本地身份和历史。</p></section></main>`;
}
