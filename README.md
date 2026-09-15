# MYA Demo · 我的审批伙伴

**Codex 在 PC 干活，手机保留决定权。** Web 首版提供扫码配对、关系凭证与见证、审批辅助、批准/修改/拒绝、执行回执、Review 历史和有限自动审批。

凭证钱包更新：手机逐项查看真实验签结果，PC 按业务服务器返回的签名挑战出示凭证，并在执行端再次验证授权。参见 [钱包与测试指南](docs/CREDENTIAL_WALLET.md)。

指纹交互与分析建议明确模拟；**密钥、JWS/JWE、关系签署、见证和资源端授权检查真实运行**。所有报告只进入演示收件箱，不发送真实邮件或支付。

## 快速运行

需要 Node.js **24.x** 与 npm。服务使用 Node 内置 SQLite，不依赖 Docker、Redis 或外部数据库。

```bash
git clone https://github.com/seanzhang9999/mya_demo.git
cd mya_demo
npm ci
npm run build
ACCEPT_DEMO_ASSURANCE=true npm start
```

PowerShell 启动：

```powershell
$env:ACCEPT_DEMO_ASSURANCE="true"
npm start
```

本机打开 `http://127.0.0.1:8787/mobile/`。**手机访问必须部署到具有有效证书的 HTTPS 域名**；手机上的 localhost 指向手机，不是 PC。详见 [部署说明](docs/DEPLOYMENT.md)。

另一个终端初始化 PC 身份：

```bash
node packages/cli/mya.mjs init --server http://127.0.0.1:8787 --trust-local
node packages/cli/mya.mjs pair
```

`pair` 打开 PC 本地二维码/确认页。手机可以系统相机扫码，或先打开手机页再点“扫一扫”/“输入配对码”。**用户核对短码，在两端分别确认。** 配对进程最多等 5 分钟；保持该终端运行。

公网服务初始化用 `--trust-witness <服务启动时显示的公钥指纹>`，从可信服务器终端核对，不自动接受陌生服务。

## 完整演示

```bash
# 1. 提交含成本附表的合成报告；记下 request_id
node packages/cli/mya.mjs request --file fixtures/request-cost.json

# 2. 手机选择“要求修改”，PC 查看意见
node packages/cli/mya.mjs status --request <ID> --wait 20

# 3. 提交固定模板的干净报告，在手机批准
node packages/cli/mya.mjs request --file fixtures/request-safe.json
node packages/cli/mya.mjs status --request <新ID> --wait 20
node packages/cli/mya.mjs execute --request <新ID>
```

如需把新申请关联到原申请，在 input JSON 增加 `supersedes_request_id`。最终文件在提交时冻结，执行不会再读取可变的原始文件。

手机收到回执后，查看审批记录 → **查看并编辑规则** → 单独模拟确认启用。再次提交 `request-safe.json`，会按规则自动批准；提交 `request-other-recipient.json`，会回到人工审批。

网络不确定时先查执行结果，避免重复业务请求：

```bash
node packages/cli/mya.mjs receipt --request <ID>
```

## 在 Codex 中使用

仓库已包含 `.agents/skills/mya-approval/SKILL.md`，在这个仓库启动 Codex 后显式调用 `$mya-approval`。若希望跨仓库使用：

```bash
npm link
npm run install:skill
```

安装器遇到已有同名 Skill 会停止，不覆盖。可对 Codex 说：

> 使用 MYA 绑定我的手机，然后生成一份演示项目报告，发送到供应商 A 的演示收件箱。发送前通过 MYA 申请审批。

Skill 不会拦截 Codex 的全部 shell 操作，也不改变其权限设置。受控边界是本项目资源 API。`npm link` 的全局安装位置若无写权限，请使用 Node 的用户级安装，或在 Skill 中使用仓库 CLI 的绝对路径，不要为此关闭权限控制。

## 验证

```bash
npm test
npx playwright install chromium
npm run test:browser
```

测试使用随机临时密钥和本地临时 SQLite，不接触真实用户数据。浏览器测试默认 Chromium；可通过 `MYA_BROWSER_EXECUTABLE` 指定已安装的 Chromium。

- [完整产品与开发规格](docs/PLAN.md)
- [实现状态与测试证据](docs/IMPLEMENTATION_STATUS.md)
- [实现决定与原方案差异](docs/DECISIONS.md)
- [HTTP 与协议实现合同](docs/API.md)
- [部署、备份与回滚](docs/DEPLOYMENT.md)
- [Codex 交接与后续工作](docs/HANDOFF.md)
- [凭证钱包、逐项校验与按挑战出示](docs/CREDENTIAL_WALLET.md)

## 当前限制

这是开发中的 Web Demo，尚不是经认证的用户主权运行时。网页提供方仍能更新 JavaScript，同源代码可能调用浏览器密钥。必须保持页面前台；清理浏览器数据会失去本地身份和历史。DID 与标准 VC 互通、真实生物识别和模型、原生 App、企业 IAM 均未实现。

运行时私钥/数据库在 `.data/`，PC 身份在 `~/.mya-demo/`，均不应提交到 Git。真实手机相机、真实 Codex 会话和 Oracle 部署的验证状态以状态文档为准。
