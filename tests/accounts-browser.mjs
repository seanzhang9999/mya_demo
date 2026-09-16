import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../services/server.mjs";
import * as P from "../packages/protocol/core.mjs";
import { AgentSession } from "../packages/protocol/session.mjs";
const dir = await mkdtemp(join(tmpdir(), "mya-account-ui-")),
  app = await createServer({ dir }),
  origin = await app.listen(0);
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MYA_BROWSER_EXECUTABLE || undefined,
  });
  const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    mac = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await mobile.newPage(),
    q = await mac.newPage();
  const errors = [];
  for (const page of [p, q]) {
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(15000);
  }
  await p.goto(origin + "/mobile/");
  await p.locator('[data-tab="account"]').click();
  await p.locator('[data-action="account-register"]').click();
  await p.locator('[name="username"]').fill("ui-user");
  await p.locator('[name="password"]').fill("ui test password 2026!");
  await p.locator('[name="device_name"]').fill("测试手机");
  await p.locator("#confirm-modal").click();
  await p.getByRole("heading", { name: "当前设备" }).waitFor();
  // Pair a real local agent under the registered primary browser.
  const agent = new AgentSession(
    new P.Client(origin, app.info()),
    await P.makeAgent("UI test Agent"),
  );
  const invite = await agent.startPair();
  await p.goto(
    origin +
      "/mobile/#invite=" +
      invite.invite_id +
      "&agent=" +
      agent.identity.sign.kid +
      "&witness=" +
      (await P.thumb(app.info().witness)),
  );
  await p.locator('[data-action="confirm-pair"]').click();
  await p.locator("#confirm-modal").click();
  await agent.confirmPair();
  await p.locator('[data-tab="account"]').click();
  await p.locator('[data-action="account-refresh"]').click();
  await p.getByRole("heading", { name: "UI test Agent" }).waitFor();
  await q.goto(origin + "/mobile/");
  await q.locator('[data-tab="account"]').click();
  await q.locator('[data-action="account-login"]').click();
  await q.locator('[name="username"]').fill("ui-user");
  await q.locator('[name="password"]').fill("ui test password 2026!");
  await q.locator('[name="device_name"]').fill("测试 Mac");
  await q.locator("#confirm-modal").click();
  await q.getByText("等待管理设备确认", { exact: false }).waitFor();
  await p.locator('[data-action="account-refresh"]').click();
  await p
    .locator('[data-action="account-approve"][data-role="viewer"]')
    .click();
  await p.locator("#confirm-modal").click();
  await q.locator('[data-action="account-refresh"]').click();
  await q.getByRole("heading", { name: "UI test Agent" }).waitFor();
  assert.ok(
    await q
      .getByText("本设备仅查看此关系；请在原审批设备上操作", { exact: true })
      .count(),
  );
  await mkdir("artifacts", { recursive: true });
  await p.screenshot({ path: "artifacts/account-phone.png", fullPage: true });
  await q.screenshot({ path: "artifacts/account-mac.png", fullPage: true });
  assert.ok(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  const pendingDevice = p.locator('[data-action="account-revoke"]');
  await pendingDevice.click();
  await p.locator('[name="reason"]').fill("UI test stop");
  await p.locator("#confirm-modal").click();
  await q.locator('[data-action="account-refresh"]').click();
  await q.getByRole("heading", { name: "用户登录与审批设备" }).waitFor();
  await p.locator('[data-action="account-logout"]').click();
  await p.getByRole("heading", { name: "用户登录与审批设备" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Account UI PASS: register, signed pairing, login, pending enrollment, admin confirmation, shared metadata, viewer limit, device revocation, logout, mobile layout",
  );
} finally {
  if (browser) await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
