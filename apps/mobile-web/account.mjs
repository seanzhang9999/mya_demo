import * as P from "../../packages/protocol/core.mjs";
import { get, set } from "./storage.mjs";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const roles = {
  admin: "设备管理",
  approver: "审批本设备关系",
  viewer: "只读查看",
};
const states = {
  active: "已启用",
  pending: "等待管理设备确认",
  revoked: "已停用",
};
const errors = {
  LOGIN_FAILED: "用户名或密码不正确",
  PASSWORD_LENGTH: "密码需要 15–128 个字符",
  USERNAME_INVALID: "用户名需为 3–48 位字母、数字、点、横线或下划线",
  DEVICE_NAME_REQUIRED: "请填写审批设备名称",
  ACCOUNT_UNAVAILABLE: "此用户名无法使用，请换一个",
  DEVICE_ALREADY_REGISTERED: "此浏览器已有账号设备身份，请登录原账号",
  DEVICE_LINKED_TO_OTHER_ACCOUNT:
    "当前浏览器密钥属于其他账号，请使用独立浏览器配置",
  DEVICE_REVOKED: "本设备已被停用，不能通过重新登录恢复审批权",
  ACCOUNT_RATE_LIMITED: "尝试次数过多，请稍后再试",
  AUTH_BUSY: "登录服务繁忙，请稍后重试",
  DEVICE_PENDING: "请先在已有管理设备上确认加入",
  DEVICE_ADMIN_REQUIRED: "需要设备管理权限",
  DEVICE_SIGNING_NOT_ALLOWED: "本设备没有审批权限",
  LOGIN_REQUIRED: "请登录后继续",
  CANNOT_REVOKE_CURRENT_DEVICE:
    "不能在这里停用当前管理设备，请用另一台管理设备操作",
};
export function accountUI({
  phone,
  dialog,
  verification,
  run,
  render,
  toast,
  selectAccount,
}) {
  let state = null,
    registered = false,
    lastRefresh = 0;
  async function raw(path, data) {
    const r = await fetch(path, {
      method: data === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(errors[out.code] || out.code);
    return out;
  }
  async function signed(path, values) {
    const key = phone().identity.user,
      data = { ...values, device_key: key.publicKey };
    const c = await raw("/v1/account/challenge", {
      path,
      device_key: key.publicKey,
    });
    const clean = Object.fromEntries(
      Object.entries(data).filter(
        ([k]) => !["password", "old_password", "new_password"].includes(k),
      ),
    );
    const proof = await P.sign(
      {
        type: "AccountDeviceProof",
        challenge_id: c.id,
        nonce: c.nonce,
        path,
        origin: location.origin,
        body_hash: await P.hash(JSON.stringify(clean)),
        ...P.stamp(60000, c.expires_at),
      },
      key,
    );
    return raw(path, { data, proof });
  }
  async function refresh(force = false) {
    if (!force && Date.now() - lastRefresh < 5000) return;
    lastRefresh = Date.now();
    registered = !!(await get("account-device-enrolled"));
    try {
      const next = await raw("/v1/account/me");
      if (next.device.kid !== phone().identity.user.kid) {
        state = null;
        registered = true;
        return;
      }
      const changed = JSON.stringify(next) !== JSON.stringify(state);
      state = next;
      registered = true;
      await set("account-device-enrolled", true);
      if (changed) render();
    } catch (e) {
      if (
        ["请登录后继续", "本设备已被停用，不能通过重新登录恢复审批权"].includes(
          e.message,
        )
      ) {
        const changed = state !== null;
        state = null;
        if (changed) render();
      } else throw e;
    }
  }
  const canSign = () =>
    !registered ||
    (state?.device.status === "active" &&
      ["admin", "approver"].includes(state.device.role));
  const hint = () =>
    state
      ? `${state.account.username} · ${state.device.name} · ${roles[state.device.role]}${state.device.status === "pending" ? " · 待确认" : ""}`
      : registered
        ? "账号已退出，请登录"
        : "本地模式 · 尚未关联用户账号";
  function screen() {
    if (!state)
      return `<section class="hero"><div><h1>用户登录与审批设备</h1><p>同一账号统一查看 Agent，每个浏览器保留独立审批密钥。</p></div></section><section class="card"><h2>${registered ? "登录原账号" : "先在原审批手机上创建账号"}</h2><p>创建账号会保留本浏览器已有的 Agent 绑定和密钥。其他设备登录后，需要这里确认加入。</p><div class="actions"><button data-action="account-login">用户名和密码登录</button>${registered ? "" : '<button class="secondary" data-action="account-register">创建账号</button>'}</div><p class="hint">密码不用于复制手机私钥。请保留至少一台管理设备；本 Demo 暂无邮箱找回或丢失全部设备后的自助恢复。</p><p class="tiny muted">本浏览器签名指纹：${esc(phone().identity.user.kid)}</p></section>${scenarios()}`;
    const d = state.device,
      admin = d.status === "active" && d.role === "admin";
    return `<section class="hero"><div><h1>账号与审批设备</h1><p>${esc(state.account.username)} · ${esc(d.name)}</p></div></section><section class="card"><div class="row"><h2>当前设备</h2><span class="tag">${states[d.status]} · ${roles[d.role]}</span></div><p class="tiny muted">设备编号 ${esc(d.id)}<br>公钥指纹 ${esc(d.kid)}</p>${d.status === "pending" ? '<p class="notice">请在原手机打开“账号与设备”，核对上面的设备编号及公钥指纹，批准这台设备加入。登录成功不代表已获得审批权。</p>' : ""}<div class="actions"><button class="secondary" data-action="account-refresh">刷新状态</button><button class="secondary" data-action="account-password">修改密码</button><button class="outline" data-action="account-logout">退出登录</button></div></section>${d.status === "active" ? `<section class="card spaced"><h2>审批设备管理</h2><p class="hint">“审批”仅覆盖在该设备上配对的关系。新设备不会继承其他设备的私钥。设备管理权可确认新设备和停用其他设备。</p>${state.devices.map((x) => `<div class="device-row"><div class="row"><h3>${esc(x.name)}${x.id === d.id ? "（当前）" : ""}</h3><span class="tag">${states[x.status]} · ${roles[x.role]}</span></div><p class="tiny muted">编号 ${esc(x.id)}<br>指纹 ${esc(x.kid)}</p>${admin && x.status === "pending" ? `<div class="actions"><button data-action="account-approve" data-id="${x.id}" data-role="viewer">允许只读查看</button><button class="secondary" data-action="account-approve" data-id="${x.id}" data-role="approver">允许审批本设备关系</button><button class="secondary" data-action="account-approve" data-id="${x.id}" data-role="admin">允许设备管理</button></div>` : ""}${admin && x.id !== d.id && x.status !== "revoked" ? `<button class="danger small" data-action="account-revoke" data-id="${x.id}">停用此设备</button>` : ""}</div>`).join("")}</section><section class="card spaced"><h2>账号下的 Agent 目录</h2><p class="hint">此目录在已启用设备间一致；详细审批正文仍保存在原审批设备。</p>${state.bindings.length ? state.bindings.map((b) => `<div class="device-row"><h3>${esc(b.agent_name)}</h3><p>${b.status === "active" ? "已绑定" : terminationName(b.termination)} · 审批设备：${esc(b.device_name)}</p><p class="tiny muted">关系 ${esc(b.binding_id)}<br>Agent 指纹 ${esc(b.agent_fingerprint)}</p><p class="hint">${b.device_id === d.id && canSign() ? "本设备可处理此关系的申请" : "本设备仅查看此关系；请在原审批设备上操作"}</p></div>`).join("") : "<p>暂无已关联的 Agent。原设备以自己的密钥登记后，其绑定会自动出现在目录。</p>"}</section>` : ""}${scenarios()}`;
  }
  function login(register = false) {
    dialog(
      register ? "创建用户账号" : "用户登录",
      `<label>用户名<input name="username" autocomplete="username" maxlength="48" placeholder="例如 sean" required></label><label>密码<input name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" maxlength="128" placeholder="${register ? "至少 15 个字符" : "输入账号密码"}" required></label><label>这台审批设备的名称<input name="device_name" maxlength="80" placeholder="例如 Sean 的手机 / Sean 的 Mac" required></label><p class="hint">${register ? "请首先在保留现有绑定的手机创建账号；此设备成为首台管理设备。" : "新设备需要原管理设备批准加入，不会自动获得原手机签名权。"}</p>`,
      async (v) => {
        await signed("/v1/account/" + (register ? "register" : "login"), v);
        await refresh(true);
        selectAccount();
        toast(register ? "账号已创建，原绑定已保留" : "已登录，请查看设备状态");
      },
      register ? "创建账号" : "登录",
    );
  }
  function action(el) {
    const a = el.dataset.action;
    if (!a?.startsWith("account-")) return false;
    if (a === "account-login") login();
    if (a === "account-register") login(true);
    if (a === "account-refresh") run(() => refresh(true));
    if (a === "account-logout")
      run(async () => {
        await raw("/v1/account/logout", {});
        state = null;
        selectAccount();
        render();
        toast("已退出登录；绑定和本地密钥保留");
      });
    if (a === "account-password")
      dialog(
        "修改账号密码",
        '<label>原密码<input name="old_password" type="password" autocomplete="current-password"></label><label>新密码<input name="new_password" type="password" autocomplete="new-password" placeholder="至少 15 个字符"></label><p class="hint">修改后其他登录会话将退出；设备登记和绑定不变。</p>',
        async (v) => {
          await signed("/v1/account/password", v);
          await refresh(true);
          toast("密码已更新，其他会话已退出");
        },
        "修改密码",
      );
    if (a === "account-approve") {
      const target = state.devices.find((d) => d.id === el.dataset.id);
      verification(
        "确认添加审批设备",
        `请与新设备页面核对：${target.name}；设备编号 ${target.id}；公钥指纹 ${target.kid}。授予：${roles[el.dataset.role]}。`,
        async () => {
          await signed("/v1/account/devices/approve", {
            device_id: target.id,
            role: el.dataset.role,
          });
          await refresh(true);
        },
        "确认并签署设备授权",
      );
    }
    if (a === "account-revoke") {
      const target = state.devices.find((d) => d.id === el.dataset.id);
      dialog(
        "停用审批设备",
        `<p>将停用 ${esc(target.name)} 的登录与审批能力，并终止由该设备配对的 Agent 关系。历史回执保留；恢复使用需要新的设备身份和重新配对。</p><label>原因<input name="reason" maxlength="200" placeholder="例如设备丢失或不再使用"></label>`,
        async (v) => {
          await signed("/v1/account/devices/revoke", {
            device_id: target.id,
            reason: v.reason,
          });
          await refresh(true);
          toast("设备已停用，关联关系已终止");
        },
        "确认停用设备",
      );
    }
    return true;
  }
  return { refresh, screen, action, canSign, hint, known: () => registered };
}
export const terminationName = (t) =>
  ({
    user_revoked: "用户已撤销",
    agent_withdrawn: "Agent 已退出",
    device_revoked: "审批设备已停用",
  })[t?.type] || "关系已终止";
function scenarios() {
  return `<section class="card spaced"><h2>不同撤销场景</h2><dl class="meta"><dt>用户撤销关系</dt><dd>手机用户签署决定，停止该 Agent 关系的后续使用。</dd><dt>Agent 退出</dt><dd>Agent 用自己的密钥退出，不代表用户在手机上撤销。</dd><dt>暂停自动规则</dt><dd>停止自动批准，保留绑定并继续人工审批。</dd><dt>停用审批设备</dt><dd>管理设备停用另一设备，结束其登录会话和配对关系。</dd><dt>退出登录</dt><dd>结束当前账号会话，保留设备登记、密钥与绑定。</dd><dt>清除浏览器数据</dt><dd>可能丢失密钥，并不会自动撤销服务器上的权限。</dd></dl><p class="hint">撤销不会回滚已完成的操作，也不会删除历史回执。离线操作要同步成功才代表服务端已停用。</p></section>`;
}
