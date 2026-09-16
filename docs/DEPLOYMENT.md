# Oracle 极简部署

Oracle 已部署 HTTPS Demo。手机入口为 https://mya-esand.duckdns.org/mobile/ ，服务通过 `mya-demo.service` 运行，监听 127.0.0.1:8787。已有真实用户配对与演示审批记录。升级沿用现有密钥、数据库和代理。

部署布局：代码 `/opt/mya-demo/releases/`，`/opt/mya-demo/current` 指向当前 release；Node24 位于 `/opt/mya-demo/runtime/`；持久数据 `/var/lib/mya-demo`；环境配置 `/etc/mya-demo/server.env`。下文为维护及新主机安装步骤。

2026-09-15 凭证钱包版本：代码 `0240f65`，发布目录 `/opt/mya-demo/releases/0240f65-20260915`。切换前一致性备份位于主机 `/opt/mya-demo/backups/20260915T061125Z-before-0240f65`（root 0700）；前一发布 `/opt/mya-demo/releases/9471309-20260915` 保留。备份包含私钥与数据库，不应下载到公共目录或提交 Git。需要回滚时切回前一发布并 **restart** 服务，保持当前持久数据；本次新增 kv 类型兼容旧代码，不应直接恢复旧备份而丢失升级后记录。

## 2026-09-16 账号与审批设备升级

本版新增账号、设备登记、会话与撤销审计 KV 记录，保留原数据库及签名密钥。操作步骤见 [账号与设备](ACCOUNT_AND_DEVICES.md)。未预置用户账号或密码，原手机用户自行注册。

发布前停止服务并备份整个数据目录；新 release 使用同一份持久数据。升级后核验 HTTPS、见证公钥、既有关系和新账号 API。部署记录保存在主机备份目录。

**回滚边界：** 在用户尚未使用新账号功能时，可切回原 release 并保持当前数据库。用户开始登记或停用设备后，旧代码不具备账号和设备校验，不能无条件回滚运行；应优先向前修复或暂停服务。不要用旧数据库覆盖升级后产生的用户记录，也不要以回滚恢复已撤销权限。

## 主机准备

只读核查 Node 24、CPU 架构、磁盘、已有 80/443 服务和代理配置。使用已有 SSH alias `oracle` 时核对实际目标；当前会话已有部署授权时无需重复确认。不要打印 SSH 私钥或替换无关服务。

在非 root 应用账号工作目录检出仓库，执行 `npm ci && npm run build`。生产环境 `npm ci` 需要 esbuild 来构建；构建后可以 `npm prune --omit=dev`。程序监听 127.0.0.1:8787。

## 配置

复制 `deploy/server.env.example`，替换 PUBLIC_ORIGIN 为实际 HTTPS origin。首次启动自动在 MYA_DATA_DIR 生成见证与资源密钥，目录 0700、文件 0600。不得每次重启重新初始化或删除此目录。

- `ACCEPT_DEMO_ASSURANCE=true`：仅演示环境打开。
- `PUBLIC_ORIGIN=https://mya.example.com`：必须与手机和 CLI 配置一致。
- `MYA_DATA_DIR=/var/lib/mya-demo`：持久目录。
- `LISTEN_HOST=127.0.0.1`、`PORT=8787`。

使用 `deploy/mya-demo.service` 前核对 Node 可执行路径、应用账号和目录。主机用户创建及目录授权由部署者按现有环境完成。

## HTTPS 与手机

优先复用现有代理，无代理时可使用 Caddy。配置模板 `deploy/Caddyfile.example`。不要关闭 TLS 验证。普通手机浏览器通过内网 HTTP IP 访问通常无法正常使用相机/Web Crypto；应使用有效 HTTPS。

网页可以使用系统相机扫描邀请 URL，或自己的相机扫码。摄像头权限被拒可输入配对码。页面保持前台；不保证锁屏自动执行。

PC 初始化远程服务时使用服务启动日志显示的 witness fingerprint，保持配对进程的本地窗口开启，用户完成两端确认。

## 升级与回滚

1. 保留 `/var/lib/mya-demo` 与原私钥；不能覆盖或提交到 Git。
2. 先停止服务，再一致性备份整个数据目录。也可在后续实现 SQLite backup 命令后在线备份；不要运行中只复制主 db 而遗漏 WAL。
3. 在新 release 目录 `npm ci && npm run build && npm test`。
4. 切换 current 链接，重启，检查 healthz、固定公钥、测试配对与旧关系状态。
5. 本版只有初始化表，没有破坏性迁移。未来数据库升级必须另写迁移与回滚策略。

本服务同一主机承载见证、relay 和资源模块，仅供演示。日志不应记录正文/私钥；资源 SQLite 依法保存演示报告及授权记录，浏览器保存其私有 Review。

## 卸载

停用 systemd unit，移除应用目录和 unit；数据目录默认保留，须另行明确决定是否删除。PC `npm unlink -g mya-demo`；用户级 Skill 安装器打印了其路径，只删除本项目已安装的 Skill，保留其它技能。删除 `~/.mya-demo/` 会丢失 PC 私钥；先撤销关系并按需导出记录。
