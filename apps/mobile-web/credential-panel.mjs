const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function credentialPanel(report, request_id = null, binding_id = null) {
  return `<section class="card spaced"><h3>凭证钱包与逐项校验</h3>
    <p class="tiny muted">查看签发者、授权范围和实际验签结果；过期凭证仍可回看历史证据。</p>
    <button class="secondary" data-action="inspect" data-id="${esc(request_id)}" data-binding="${esc(binding_id)}">重新校验凭证</button>
    ${
      report
        ? `<p class="hint">本次校验：${esc(new Date(report.checked_at).toLocaleString("zh-CN"))} · 刷新校验可获取最新状态</p>
      <div class="credential-checks">${report.checks
        .map(
          (c) => `<p>
        <span class="tag ${c.status === "passed" ? "green" : "amber"}">${c.status === "passed" ? "通过" : c.status === "pending" ? "待签发" : c.code === "EXPIRED" ? "已过期" : "未通过"}</span>
        ${esc(c.label)}${c.status === "failed" ? `<br><span class="tiny muted">${esc(c.code)}</span>` : ""}</p>`,
        )
        .join("")}</div>
      <p class="hint">${esc(report.note)}</p>
      <details><summary>已验签的凭证内容</summary><pre>${esc(JSON.stringify(report.credentials, null, 2))}</pre></details>
      <details><summary>按挑战出示的校验记录（${report.presentations.length}）</summary><pre>${esc(JSON.stringify(report.presentations, null, 2))}</pre></details>`
        : `<p class="hint">点击后在本机验签，并查询服务器当前状态。</p>`
    }
    </section>`;
}
