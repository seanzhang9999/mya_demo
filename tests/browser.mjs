import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { createServer } from "../services/server.mjs";
import * as P from "../packages/protocol/core.mjs";
import { AgentSession } from "../packages/protocol/session.mjs";
const report = JSON.stringify({
  project_id: "project-alpha",
  report_date: "2026-09-15",
  milestone_id: "prototype",
  status: "in_progress",
  completion_percent: 60,
});
const dir = await mkdtemp(join(tmpdir(), "mya-browser-")),
  app = await createServer({ dir });
let browser;
try {
  const origin = await app.listen(0);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MYA_BROWSER_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  if (process.env.MYA_TEST_FONT_DIR) {
    const fonts = process.env.MYA_TEST_FONT_DIR;
    const css = (await readFile(resolve(fonts, "400.css"), "utf8")).replaceAll(
      "./files/",
      "/mobile/test-fonts/",
    );
    await ctx.route("**/mobile/test-fonts/*", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1);
      await route.fulfill({
        body: await readFile(resolve(fonts, "files", name)),
        contentType: "font/woff2",
      });
    });
    await ctx.route("**/mobile/style.css", async (route) => {
      await route.fulfill({
        body:
          (await readFile("dist/style.css", "utf8")) +
          "\n" +
          css +
          '\nbody{font-family:"Noto Sans SC",system-ui,sans-serif}',
        contentType: "text/css",
      });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const agent = new AgentSession(
    new P.Client(origin, app.info()),
    await P.makeAgent(),
  );
  const invite = await agent.startPair();
  await page.goto(invite.link);
  await page.getByRole("button", { name: "短码一致，确认配对" }).waitFor();
  const as = await agent.pairStatus();
  assert.ok((await page.locator(".pair-code").textContent()).includes(as.sas));
  await page.getByRole("button", { name: "短码一致，确认配对" }).click();
  await page
    .getByRole("button", { name: "模拟验证并绑定", exact: true })
    .click();
  await agent.confirmPair();
  await page.getByText("已绑定", { exact: true }).waitFor();
  await agent.pairStatus();
  const id = await agent.submit("项目进度 60%，内部成本 120000", {
    media: "text/markdown",
  });
  await page.getByRole("button", { name: /待审批/ }).click();
  await page.getByRole("button", { name: "查看请求与建议" }).first().click();
  await page.getByRole("button", { name: "要求修改", exact: true }).click();
  await page.getByRole("button", { name: "发送处理意见" }).click();
  await page.getByText("已要求修改 · 尚无执行成功回执").waitFor();
  await agent.poll();
  assert.equal(agent.state.requests[id].status, "changes_requested");
  const next = await agent.submit(report, { supersedes: id });
  await page.getByRole("button", { name: /待审批/ }).click();
  await page.getByRole("button", { name: "查看请求与建议" }).first().click();
  await page.getByRole("button", { name: "批准本次", exact: true }).click();
  await page
    .getByRole("button", { name: "模拟验证并批准", exact: true })
    .click();
  await page.getByRole("button", { name: "查看并编辑规则" }).waitFor();
  await agent.poll();
  assert.equal(agent.state.requests[next].status, "approved");
  await agent.execute(next);
  await page.getByText("已批准 · 已执行").waitFor();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/mobile-approval.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "查看并编辑规则" }).click();
  await page.getByRole("button", { name: "模拟验证并启用规则" }).click();
  await page.getByText("已启用", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "自动规则", exact: true }).click();
  await page.getByText("已启用", { exact: true }).waitFor();
  const auto = await agent.submit(report);
  await page.getByText("1 / 3", { exact: true }).waitFor();
  await agent.poll();
  assert.equal(
    P.peek(agent.state.requests[auto].grant).decision_mode,
    "policy_auto",
  );
  await agent.execute(auto);
  const exception = await agent.submit(report, { recipient: "supplier-b" });
  await page.getByRole("button", { name: /待审批/ }).click();
  await page.getByRole("button", { name: "查看请求与建议" }).waitFor();
  await agent.poll();
  assert.equal(agent.state.requests[exception].status, "pending");
  await page.getByRole("button", { name: "自动规则", exact: true }).click();
  await page.getByRole("button", { name: "暂停规则", exact: true }).click();
  await page.getByRole("button", { name: "模拟确认并停用" }).click();
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.screenshot({ path: "artifacts/mobile-rules.png", fullPage: true });
  await page.getByRole("button", { name: "审批记录", exact: true }).click();
  await page.getByRole("button", { name: "查看审批记录" }).first().waitFor();
  const w = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  assert.ok(w.scroll <= w.width, "mobile horizontal overflow");
  assert.deepEqual(errors, []);
  // A second isolated browser exercises the actual CLI process and PC confirmation page.
  const cliEnv = { ...process.env, MYA_HOME: join(dir, "cli-home") };
  const cli = async (args) =>
    JSON.parse(
      (
        await exec(process.execPath, ["packages/cli/mya.mjs", ...args], {
          env: cliEnv,
        })
      ).stdout,
    );
  await cli(["init", "--server", origin, "--trust-local"]);
  const processPair = spawn(
    process.execPath,
    ["packages/cli/mya.mjs", "pair", "--no-open"],
    { env: cliEnv },
  );
  const pairExited = new Promise((res, rej) =>
    processPair.on("exit", (code) =>
      code === 0 ? res() : rej(new Error("pair CLI exited " + code)),
    ),
  );
  const urls = await new Promise((res, rej) => {
    let text = "";
    const timer = setTimeout(() => {
      processPair.kill();
      rej(new Error("No CLI pairing URL"));
    }, 15000);
    processPair.stdout.on("data", (chunk) => {
      text += chunk;
      const a = text.match(/"local_confirmation_url": "([^"]+)"/),
        b = text.match(/"phone_invitation": "([^"]+)"/);
      if (a && b) {
        clearTimeout(timer);
        res({ local: a[1], phone: b[1] });
      }
    });
  });
  const second = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    mobile2 = await second.newPage(),
    pc = await browser.newPage();
  await pc.goto(urls.local);
  await mobile2.goto(urls.phone);
  await mobile2.getByRole("button", { name: "短码一致，确认配对" }).click();
  await mobile2
    .getByRole("button", { name: "模拟验证并绑定", exact: true })
    .click();
  await pc.getByRole("button", { name: "两端短码一致，确认绑定" }).click();
  await pairExited;
  await mobile2.getByText("已绑定", { exact: true }).waitFor();
  const actual = await cli(["request", "--file", "fixtures/request-safe.json"]);
  await mobile2.getByRole("button", { name: /待审批/ }).click();
  await mobile2.getByRole("button", { name: "查看请求与建议" }).click();
  await mobile2.getByRole("button", { name: "批准本次", exact: true }).click();
  await mobile2
    .getByRole("button", { name: "模拟验证并批准", exact: true })
    .click();
  const decision = await cli([
    "status",
    "--request",
    actual.request_id,
    "--wait",
    "20",
  ]);
  assert.equal(decision.status, "approved");
  const delivery = await cli(["execute", "--request", actual.request_id]);
  assert.equal(delivery.result, "delivered_to_demo_inbox");
  assert.equal((await cli(["doctor"])).status, "ok");
  await second.close();
  await pc.close();
  console.log(
    "Browser PASS: pair, modify, approve, receipt, policy activation, refresh persistence, auto approval, exception, pause, mobile layout; real CLI init/pair/request/status/execute/doctor.",
  );
} finally {
  if (browser) await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
