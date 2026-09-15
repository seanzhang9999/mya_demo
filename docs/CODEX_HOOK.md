# Codex Hook 与 MYA 授权门禁

更新：2026-09-15。本文区分已实现脚本、原生 Hook 加载和资源端授权，不将三者混称为“不可旁路”。

## 设计与边界

### 两种触发入口，Agent 自主调用同一钱包能力

- **外部业务系统拦截**：业务资源返回缺失授权、凭证要求或受信挑战。Agent 理解要求后，自主决定调用 MYA Skill，通过钱包申请所需授权，或出示已有且适用的凭证，再重试原行动。
- **Agent 运行环境的内部检查点**：Hook 在工具执行前检查条件，不足时阻止并反馈。Agent 收到反馈后同样自主调用 Skill，通过钱包处理并持续跟进。Hook 本身不替 Agent 调用 Skill，也不替用户批准。

Skill 是 Agent 可选择调用的授权协作能力；钱包负责申请、凭证持有和受信出示；Hook 是运行环境内的检查点；业务方负责最终验证与执行。两种入口可以单独采用或配合部署，不要求每次操作依次触发两次拦截。这样的适配可让认证器融入既有业务流程，而不要求业务交给 MYA 平台执行。

这是集成方向，并非已兼容任意系统：当前钱包只接受预配置 MYA 服务及固定验证端点，通用外部授权响应适配仍待扩展，当前桌面会话的 Hook 热插入也尚未通过验收。

业务验证器与执行 API 在架构图中独立放在“业务资源方”区域。**MYA 提供可验证的用户授权，业务系统掌握执行权。**

> 当前 Demo 为便于演示，将业务资源模拟器与 MYA 服务同机部署在 Oracle；正式接入时，业务资源由相应业务方控制。

1. Skill 负责准备内容、提交申请、持续等待、处理修改和查询回执。
2. Codex 同步 `PreToolUse` Hook 在受支持的工具执行前做授权检查。缺少有效授权时返回 `deny`，提示 Agent 走 MYA 流程。
3. 钱包验证固定受信服务签名挑战，出示关系/授权凭证，并签署持钥证明。
4. 资源 API 在实际产生副作用前独立校验签名、内容/接收方、时效、撤销、规则和幂等性。最终强制边界在资源端。

Hook 拒绝后由 Agent 提交/继续审批；Hook 不自己发起重复申请、不代替手机签字，也不无限阻塞一个工具调用。Skill 必须在同一任务持续等待决定。

当前脚本 `scripts/codex-approval-hook.mjs` 只支持严格的单命令形式：

```sh
mya execute --request REQUEST_UUID --presentation
```

也接受绝对路径的 `mya`。它通过 `mya inspect` 检查至少十项必须通过的签名、关联、范围、时效和在线状态；附加检查失败也拒绝。检查异常、缺项或超时均由脚本返回拒绝。命令本身仍会在资源端重新验证，以处理检查与执行之间的状态变化。

**范围限制：** shell 组合命令、别名、环境变量前缀、`node .../mya.mjs`、直接 curl、其它工具路径不在这个窄适配器的解析合同内。未匹配命令继续原有执行策略。因此它是集成样例，不是恶意 Agent 的通用 shell 隔离器。脚本与钱包同属本机用户权限，Agent 若能改脚本/配置，就不能把它当独立安全域。

后续应优先提供结构化 `mya_execute(request_id)` 工具；企业将受控执行入口、业务凭证和 Hook 管理权限隔离。实际业务系统必须自行验证 MYA 授权，不能只信客户端“已检查”。

## 原生 Hook 安装

确认实际承载会话的 Codex 版本，而不是只检查 PATH 中的 CLI。将以下配置合并到 `~/.codex/hooks.json`，先保存带时间戳的备份，不覆盖其它 Hook。把两个路径替换为本机绝对路径：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "/ABSOLUTE/NODE /ABSOLUTE/REPO/scripts/codex-approval-hook.mjs",
        "timeout": 30,
        "statusMessage": "MYA approval verification"
      }]
    }]
  }
}
```

在对应版本 CLI 的 `/hooks` 中审阅这一条定义并信任。新定义、改动的定义在信任前会被跳过。配置发现、信任登记和已运行会话加载是三个不同状态；不能凭 Trusted 字样就宣布当前会话受保护。

回滚：只删除本次新增的 MYA `PreToolUse` 条目；若文件原来不存在且没有其它条目，再删除空文件。其它设置保持不动。Hook 信任记录由 Codex 原生界面管理，不手写注册表。

## 已执行的当前进程热插入测试

环境：ChatGPT macOS 内置 `codex-cli 0.154.0-alpha.6.2`，功能表 `hooks=true`。PATH 中独立 CLI 为 0.147.0，不能代表本会话。

| 步骤 | 证据与结论 |
|---|---|
| 写入用户 Hook 配置 | 已写入 `~/.codex/hooks.json`；原文件不存在，已记录时间戳回滚清单 |
| 第一次当前工具调用 | canary 成功写入标记，原生拦截未成立 |
| 同版本 CLI 原生审阅 | `/hooks` 显示 MYA、Bash、Sync、30s；审阅后显示 Trusted |
| 第二次当前工具调用 | canary 仍执行，未出现 Hook 拒绝；当前活跃会话没有验证到热加载 |
| Hook 处理函数测试 | 单独自动测试及过期历史授权检查；它们不证明原生工具链接入 |

结论：**已安装并原生信任；当前进程热插入验收失败。** 未重启正在运行的桌面应用，未启动另一个模型任务来冒充本会话的成功。原生加载/拦截和批准后放行的下一轮验收尚待完成。

## 下一轮验收：先证明拦截，再让用户审批

### A. 原生加载探针（必须先过）

在重新加载配置后的目标会话，让 Agent **通过工具**执行：

```sh
node scripts/mya-hook-canary.mjs
```

该命令只写 `artifacts/hook-canary-executed.json`。执行前记录旧文件的存在与修改时间。通过标准必须同时满足：

- 工具调用被原生 Hook 返回 `MYA_HOOK_CANARY_BLOCKED` 拒绝；
- `artifacts/hook-events.jsonl` 出现对应本次 session/tool_use_id 的拒绝记录；
- 标记文件没有新建/更新。已有旧文件不代表这一次执行了；必须比较时间或先归档旧文件。

若打印 `CANARY_EXECUTED`，立即判定不通过，不继续把后续手机流程称作 Hook 测试。

### B. 未批准 → 手机批准 → 钱包出示 → 执行

1. 以 `fixtures/request-safe.json` 为形状写新输入，显式选择当前手机绑定；用 `mya request --file ...` 提交，记录新 UUID。
2. 在批准前调用 `mya execute --request UUID --presentation`。必须是 Hook 原生拒绝 `MYA_APPROVAL_REQUIRED`，同时资源端没有新回执。只有 CLI 抛 `NOT_APPROVED` 不能算 Hook 命中。
3. Agent 持续 `mya status --request UUID --wait 20`，保持手机页面前台。用户可要求修改，Agent 新建请求并填 `supersedes_request_id`，原请求不能执行。
4. 手机批准后，Agent 自动重试相同的新请求；Hook 检查通过，CLI 获取受信挑战并出示凭证，资源端核验后执行。
5. 查询 `mya receipt` 和 `mya inspect`，核对 request/execution/transaction/verification 关联以及逐项检查；保存不含私钥和原始凭证的测试摘要。
6. 改收件人或内容必须创建新请求并再次人工审批；旧批准不能用于新行动。过期、取消、撤销、服务不可达均不可当作批准。

**通过标准：** 同一业务演示中具备“原生拒绝证据 + 无执行副作用 + 手机真实授权 + 原生放行 + 资源签名回执”。当前尚未完成这一组完整验收。

## 官方依据

[OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks)，2026-09-15 核验。同步 PreToolUse 可拒绝受支持本地工具，但不是所有执行路径的总开关；已有 exec 会话的 `write_stdin` 不重新触发。后台 Hook 不能阻止执行，事后 Hook 不能撤销副作用。应明确区分本地插件失效和资源端持续拒绝未授权请求。
