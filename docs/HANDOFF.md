# 给下一位 Codex 的交接

先读 README、IMPLEMENTATION_STATUS、DECISIONS，再按需查 PLAN。当前已实现 Web/Node 功能闭环；不要以“已有代码”推断真机/部署完成。

## 开发入口

- `packages/protocol/core.mjs`：密码封装、凭证、请求/授权验证、固定规则。
- `packages/protocol/session.mjs`：PC/手机状态机及消息流程。
- `packages/protocol/wallet.mjs`：凭证逐项检查、挑战与持钥出示；`authorization.mjs` 是两种执行路径共用的授权校验。
- `services/server.mjs`：HTTP、持钥认证、SQLite、见证、密文队列、资源验证。
- `apps/mobile-web`：手机界面、扫码、IndexedDB/CryptoKey 与加密记录。
- `packages/cli/mya.mjs`：PC 安装实例、冻结请求、本地配对页。
- `.agents/skills/mya-approval`：可被 Codex 发现的 Skill。

## 先完成实际环境验证

PC CLI/Skill、Oracle HTTPS 和真实用户配对/修订审批已完成。当前状态以 IMPLEMENTATION_STATUS.md 为准；下面流程也作为升级回归清单。手机新钱包入口与 CLI 挑战出示参见 CREDENTIAL_WALLET.md。保留现有 MYA_HOME、服务器密钥和数据目录。

1. 在用户 PC 安装 Node24/依赖，显式用 `$mya-approval` 运行，而非只从测试脚本调用 session。
2. 在已有 Oracle 部署有效 HTTPS；部署前检查授权和已有服务，禁止覆盖现有代理。
3. 真手机扫 PC 码，拒绝相机权限再走配对码，刷新/重开浏览器验证持久化。
4. 演示含成本报告→要求修改→干净模板→手机人工确认→执行回执→单独创建规则→第二次自动→换收件人转人工→暂停规则。
5. 确认网页没有溢出、错误提示可理解、前台运行限制可见。真实用户完成确认，Agent 不代点。

## 优先改进

- 完整 JSON Schema/OpenAPI 与更细粒度类型覆盖。
- 自动授权签名/持久化崩溃窗口的恢复、浏览器异常 outbox 与失效请求隔离。
- 手机不支持 Web Locks 的显式替代路径或稳定的 IndexedDB 租约。
- Review 保留期限和正文清理、更多审计检索和规则版本编辑。
- 服务状态变化/已有签名的时序与资源端撤销语义持续测试。

以上改进不能省略已有签名/持钥/范围验证。先用 tests 的可复现失败证明问题再修复。

## 后续能力（不伪装为首版已有）

真实端侧模型、WebAuthn/原生 Android 生物识别、标准 VC/DID/ANP 互通、独立发行签名与运行时证明、企业策略治理及后台推送。用户可按价值顺序选择。
