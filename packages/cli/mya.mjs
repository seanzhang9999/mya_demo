#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { exportJWK, importJWK } from "jose";
import * as P from "../protocol/core.mjs";
import { AgentSession } from "../protocol/session.mjs";
const args = process.argv.slice(2),
  command = args[0] || "help",
  options = {};
for (let i = 1; i < args.length; i++)
  if (args[i].startsWith("--"))
    options[args[i].slice(2)] =
      args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
const dir = resolve(process.env.MYA_HOME || resolve(homedir(), ".mya-demo"));
const file = resolve(dir, "agent.json");
const output = (o) => console.log(JSON.stringify(o, null, 2));
const atomic = async (obj) => {
  const tmp = file + "." + P.id();
  await writeFile(tmp, JSON.stringify(obj), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
};
async function restore(raw) {
  const load = async (jwk, encryption = false) => {
    const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    return {
      publicKey,
      kid: await P.thumb(publicKey),
      privateKey: await importJWK(jwk, encryption ? "ECDH-ES+A256KW" : "ES256"),
    };
  };
  return {
    name: raw.name,
    sign: await load(raw.sign),
    encryption: await load(raw.encryption, true),
  };
}
async function localPair(session, pair) {
  const token = P.id();
  let finished = false,
    localOrigin;
  const qr = await QRCode.toDataURL(pair.link, { width: 330 });
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      P.check(u.searchParams.get("token") === token, "INVALID_TOKEN", 403);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (u.pathname === "/status") {
        const s = await session.pairStatus();
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            sas: s.sas,
            paired: !!s.credentials,
            agent_confirmed: !!s.agent_confirmation,
          }),
        );
        return;
      }
      if (u.pathname === "/confirm") {
        P.check(
          req.method === "POST" && req.headers.origin === localOrigin,
          "ORIGIN_REJECTED",
          403,
        );
        const s = await session.confirmPair();
        res.end(JSON.stringify({ ok: true }));
        if (s.credentials) finished = true;
        return;
      }
      if (u.pathname === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>MYA · 配对确认</title><style>body{font:16px system-ui;background:#f4f7f4;color:#193d32;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:420px;padding:30px;background:white;border-radius:20px;text-align:center}img{max-width:100%}button{background:#126e5e;color:white;padding:15px;border:0;border-radius:10px;cursor:pointer}button:disabled{opacity:.5}#sas{font-size:30px;letter-spacing:5px}small{color:#6a7e71}a{color:#126e5e}</style><main><h1>连接您的审批手机</h1><p>手机扫码，或在网页内输入配对码</p><img src="${qr}"><h2>${pair.code}</h2><p><a href="${pair.link}" target="_blank" rel="noreferrer">打开手机邀请页面</a></p><small>请核对以下短码与手机完全一致</small><h2 id="sas">等待手机加入…</h2><button id="confirm" disabled>两端短码一致，确认绑定</button><p id="status"></p><small>这是本 PC 的本地确认页。Agent 不应代您确认。</small></main><script>const token=${JSON.stringify(token)};async function refresh(){let r=await fetch('/status?token='+token);let s=await r.json();document.querySelector('#sas').textContent=s.sas||'等待手机加入…';document.querySelector('#confirm').disabled=!s.sas||s.agent_confirmed;document.querySelector('#status').textContent=s.paired?'配对成功，可以关闭页面':s.agent_confirmed?'PC 已确认，等待手机确认':'';if(!s.paired)setTimeout(refresh,1500)}document.querySelector('#confirm').onclick=async()=>{await fetch('/confirm?token='+token,{method:'POST'});refresh()};refresh();</script>`,
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (e) {
      res.statusCode = e.status || 400;
      res.end(JSON.stringify({ code: e.code || "ERROR" }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  const url = localOrigin + "/?token=" + token;
  output({
    status: "waiting_user",
    pairing_code: pair.code,
    local_confirmation_url: url,
    phone_invitation: pair.link,
    expires_in_seconds: 300,
  });
  if (!options["no-open"]) {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const argv =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
    const proc = spawn(cmd, argv, { stdio: "ignore", detached: true });
    proc.on("error", () => {});
    proc.unref();
  }
  try {
    const until = P.now() + 300000;
    while (P.now() < until) {
      const p = await session.pairStatus();
      if (p.credentials) {
        finished = true;
        output({ status: "paired", binding_id: p.id });
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    P.check(finished, "PAIRING_EXPIRED");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
async function main() {
  if (command === "help") {
    output({
      usage: [
        "mya init --server https://host --trust-witness FINGERPRINT",
        "mya init --server http://127.0.0.1:8787 --trust-local",
        "mya pair [--no-open]",
        "mya bindings",
        "mya request --file input.json",
        "mya status --request ID --wait 20",
        "mya execute --request ID",
        "mya receipt --request ID",
        "mya cancel --request ID",
        "mya revoke --binding ID",
        "mya history",
        "mya doctor",
      ],
      note: "所有发送仅写入演示收件箱；指纹模拟，签名真实。",
    });
    return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = resolve(dir, "command.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new P.Fault(
      "CLI_BUSY: another command is running; after a crash remove command.lock only when no MYA process remains",
      409,
    );
  }
  try {
    if (command === "init") {
      try {
        await stat(file);
        throw new P.Fault("ALREADY_INITIALIZED");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      P.check(typeof options.server === "string", "SERVER_REQUIRED");
      const url = new URL(options.server);
      P.check(
        url.protocol === "https:" ||
          (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
            url.protocol === "http:"),
        "HTTPS_REQUIRED",
      );
      const client = new P.Client(url.origin),
        info = await client.info();
      const fp = await P.thumb(info.witness);
      P.check(
        options["trust-witness"] === fp ||
          (options["trust-local"] &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
        `TRUST_REQUIRED: verify server witness fingerprint ${fp} and use --trust-witness`,
      );
      const a = await P.makeAgent(options.name || "我的 PC Codex", true);
      await atomic({
        origin: url.origin,
        trust: { witness: info.witness, resource: info.resource },
        identity: {
          name: a.name,
          sign: await exportJWK(a.sign.privateKey),
          encryption: await exportJWK(a.encryption.privateKey),
        },
        state: {},
      });
      output({
        status: "initialized",
        server: url.origin,
        witness_fingerprint: fp,
      });
      return;
    }
    let config;
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new P.Fault("NOT_INITIALIZED: run mya init");
    }
    if (process.platform !== "win32")
      P.check(
        ((await stat(file)).mode & 0o077) === 0,
        "INSECURE_KEY_FILE_PERMISSIONS",
      );
    const identity = await restore(config.identity),
      client = new P.Client(config.origin, config.trust);
    await client.info();
    const session = new AgentSession(
      client,
      identity,
      config.state,
      async (state) => {
        config.state = state;
        await atomic(config);
      },
    );
    if (command === "pair")
      return localPair(session, await session.startPair());
    if (command === "doctor") {
      output({
        status: "ok",
        node: process.version,
        server: config.origin,
        private_file_permissions:
          process.platform === "win32" ? "user ACL must be checked" : "0600",
        bound_agents: Object.keys(session.state.bindings).length,
      });
      return;
    }
    if (command === "bindings") {
      output(
        Object.values(session.state.bindings).map((b) => ({
          binding_id: b.relation.binding_id,
          expires_at: b.relation.expires_at,
        })),
      );
      return;
    }
    if (command === "request") {
      P.check(typeof options.file === "string", "INPUT_FILE_REQUIRED");
      const input = P.parse(await readFile(resolve(options.file), "utf8"));
      P.fields(
        input,
        [
          "payload_path",
          "recipient_id",
          "project_id",
          "binding_id",
          "user_goal",
          "agent_explanation",
          "task_ref",
          "supersedes_request_id",
          "media_type",
        ],
        ["payload_path"],
      );
      const bytes = await readFile(
        resolve(dirname(resolve(options.file)), input.payload_path),
      );
      const rid = await session.submit(bytes, {
        recipient: input.recipient_id,
        project: input.project_id,
        binding_id: input.binding_id,
        goal: input.user_goal,
        explanation: input.agent_explanation,
        task: input.task_ref,
        supersedes: input.supersedes_request_id,
        media: input.media_type,
      });
      output({ request_id: rid, status: "pending" });
      return;
    }
    if (command === "status") {
      const limit = Math.min(20, Math.max(0, Number(options.wait) || 0)),
        until = P.now() + limit * 1000;
      do {
        await session.poll();
        const r = session.state.requests[options.request];
        P.check(r, "UNKNOWN_REQUEST");
        if (r.status !== "pending" || P.now() >= until) {
          const expired = P.peek(r.bundle.request_jws).expires_at <= P.now();
          output({
            request_id: options.request,
            status: expired && r.status === "pending" ? "expired" : r.status,
            feedback: r.feedback || null,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      } while (true);
    }
    if (command === "execute") {
      const { data } = await session.execute(options.request);
      output({ status: "succeeded", ...data });
      return;
    }
    if (command === "receipt") {
      const result = await session.query(options.request);
      output(result.data || result);
      return;
    }
    if (command === "cancel") {
      await session.cancel(options.request);
      output({ status: "cancelled" });
      return;
    }
    if (command === "history") {
      output(
        Object.entries(session.state.requests).map(([id, r]) => ({
          request_id: id,
          status: r.status,
          action: P.decode(P.peek(r.bundle.request_jws).action_b64),
        })),
      );
      return;
    }
    if (command === "revoke") {
      const b = session.binding(options.binding);
      await client.auth(
        "/v1/bindings/revoke",
        {},
        identity.sign,
        b.relation.binding_id,
      );
      output({ status: "revoked" });
      return;
    }
    throw new P.Fault("UNKNOWN_COMMAND");
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    output({ status: "error", code: e.code || e.message });
    process.exitCode =
      e.status === 409 ? 6 : /SIGNATURE|TRUST/.test(e.code || "") ? 5 : 2;
  });
