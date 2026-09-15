# 当前实现 API（以本文件及代码为准）

JSON 数值时间为 UTC epoch milliseconds；与 PLAN.md 的 RFC3339 表达建议不同，全部实现统一。写请求 `Content-Type: application/json`，外层最大 1 MB。JWS ES256 / JWE ECDH-ES+A256KW+A256GCM；客户端和服务均校验算法和 key id。

## 公共入口

| 路径 | 方法 | 内容 |
|---|---|---|
| /mobile/ | GET | 手机页面 |
| /healthz | GET | 版本与状态 |
| /v1/server-info | GET | witness/resource 公钥、演示公司规则与模拟保证开关 |
| /v1/pairings | POST | `{invite: <Agent JWS>}` |
| /v1/pairings/lookup | POST | `{code}` 定位一次性邀请 |
| /v1/pairings/:id | GET | 当前配对材料；需知道高熵邀请 ID |
| /v1/pairings/:id/join | POST | `{join: <手机通信钥 JWS>}` |
| /v1/pairings/:id/confirm | POST | `{role: agent或phone, signature}` |
| /v1/auth/challenges | POST | `{binding_id,kid,path}`，返回30秒单用挑战 |

配对字段由 `packages/protocol/core.mjs` 的 relation 固定生成，双方独立检查预期材料并签名。双端确认完成后签发见证，关系公钥固定，不随 server-info 静默更新。

## 需认证入口

全部 POST。外层 `{data,proof}`。proof 为 JWS，绑定 challenge_id、nonce、binding_id、kid、method、path、audience、SHA256(JSON.stringify(data))、issued_at、expires_at。`Client.auth` 负责封装。challenge 单用，具体操作仍需权限检查。

| 路径 | data | 权限 |
|---|---|---|
| /v1/bindings/status | `{}` | 绑定端，返回签名状态 |
| /v1/bindings/revoke | `{}` | 用户钥或当前 Agent 自己退出 |
| /v1/relay/send | `{message_id,to,ciphertext}` | Agent/手机通信钥，只能发给关系另一端 |
| /v1/relay/poll | `{}` | 同上，只读自己的密文队列 |
| /v1/relay/ack | `{message_id}` | 实际接收端 |
| /v1/requests/cancel | `{request_id}` | Agent/用户钥 |
| /v1/delegations | `{jws}` | 手机通信钥，内层委托必须由用户钥签署 |
| /v1/delegations/pause | `{delegation_id}` | 用户钥 |
| /v1/demo/reports | `{request_jws,payload_b64,grant,delegation?}` | Agent 持钥＋有效用户授权 |
| /v1/demo/executions/query | `{request_id}` | 绑定端，只能查询自己关系的回执 |

## 内容与授权绑定

ApprovalRequest JWS 含 action_b64、action_hash、context_hash 等元数据。报告和上下文单独放加密 request bundle。资源执行只接收最终报告，不接收完整审批上下文。资源端逐项验证 request、grant、委托、当前状态、实际字节和范围。

SQLite 事务内重新检查关系/撤销/规则状态、消费执行额度，写报告和回执事实。request_id / grant_id 唯一。重复投递不产生第二副作用；过期授权应通过 executions/query 查询旧结果。

`packages/protocol/core.mjs` 包含实际字段白名单、类型和约束；测试有可执行端到端样例。尚未提供完整外部 JSON Schema/OpenAPI 文件，不把接口说明当已完成 schema 自动生成。
