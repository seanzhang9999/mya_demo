---
name: mya-approval
description: Pair a local MYA client with the user's phone, request approval, inspect credential verification, and present credentials against a trusted MYA challenge. Use for MYA pairing, credential wallet, approval, review, and demo report delivery.
---

Use the installed `mya` CLI. Run `mya help` to inspect commands. If it is not on PATH, use `node <repository>/packages/cli/mya.mjs` from the configured repository; do not invent the location.

## Agent identity and profile selection

- Before any stateful command, select an explicit per-agent `MYA_HOME`. Different agents on one computer (for example Codex and WorkBuddy) must use different identity keys and state directories. The legacy default `~/.mya-demo` may belong to another agent; never silently adopt it, copy its private keys, overwrite it, or revoke its bindings to fix setup.
- Use a stable profile per intended agent installation, not a new key for each task. On this Mac, Codex uses `MYA_HOME=/Users/sean/.mya-agents/codex`, display name `Codex · Sean Mac`. WorkBuddy must use its own established profile; inspect metadata before deciding its path. For other hosts choose an explicit agent-specific directory such as `~/.mya-agents/<agent>`.
- Include the selected `MYA_HOME` on every command (init, pair, doctor, bindings, request, status, present, execute, receipt, revoke). An omitted environment variable falls back to the shared legacy identity. Before issuing a request, verify profile name, server and intended binding from metadata without printing private keys or raw credentials.
- Always provide `init --name` with a meaningful agent and device label. Explain the proposed name to the user; use a supplied name when available. Re-pair with an existing correctly owned profile when appropriate. A new independent identity requires new keys, not a renamed or copied key file. Keep old bindings until the user explicitly requests their removal.
- Names are labels; the signing public-key fingerprint identifies the agent. Local profiles prevent accidental mixing but do not authenticate the calling application or isolate mutually untrusted processes running as the same OS user. Strong application isolation needs a protected wallet service and authenticated caller identities.

## Approval devices and ending a relationship

- The mobile web app stores its keys and binding list in each browser's IndexedDB. Another device, browser, browser profile, or private session is a different approval identity; the same URL does not synchronize them. Pair using the user's intended phone browser. Do not clear browser storage or export/copy keys to fix differing lists.
- Current `mya revoke` signs as the agent and the server permits either agent or user to terminate a relationship. This is agent withdrawal, not a phone-signed user revocation. Never run it merely because a new pairing is requested. User-side revocation uses the phone's signed confirmation; the fingerprint interaction is simulated, while the signature is real. Multi-device user identity, synchronization and distinct withdrawal/revocation audit events are not implemented.

- `mya doctor` checks setup. Initial setup requires the correct server URL and witness fingerprint; local loopback testing may use `--trust-local`. Never auto-trust an unknown remote key.
- `mya pair` opens a local confirmation page and waits. Give its URL/QR to the user. The user must compare the two short codes and confirm in both interfaces; do not click their confirmations yourself.
- To send a demo report, write an input JSON file using `fixtures/request-safe.json` or `fixtures/request-cost.json` as a shape. `payload_path` resolves relative to that input. Pass the filename to `mya request --file ...`; do not interpolate report text into shell commands.
- Record the returned request_id. Continue calling `mya status --request ID --wait 20` while pending, with concise progress updates between waits, until a decision, request expiry (at most 10 minutes), cancellation, or a persistent error. Do not end the task after one pending response or ask the user to repeat their phone decision in chat. Pending means awaiting the phone, not approved. Refusal, cancellation, expiry, invalid signature or network failure does not authorize delivery. Network errors require bounded retries and an honest unresolved status.
- On `changes_requested`, prepare a new file/request and set `supersedes_request_id` to the prior ID. Preserve the user's intended scope.
- On `approved`, invoke `mya execute --request ID` without replacing the frozen file or destination. If execution times out, use `mya receipt --request ID` to resolve uncertainty before creating another request.
- Report success only when the resource receipt confirms delivery to the **demo inbox**. This does not send a real email.
- The phone saves Review history and can suggest a policy. A single approval is not consent to activate a rule. Rule activation is a separate user action on the phone.

## Credential wallet and challenge presentation

- `mya wallet` lists credential inventory metadata; `mya inspect --request ID` freshly checks signatures, scope, current validity, online status and historical execution evidence. Without a request ID, inspect checks the selected/default binding. A valid signature and an expired authorization can both be true; a historical receipt does not renew that authorization.
- The existing `request`/phone approval flow acquires a user-signed grant. The Agent cannot issue a replacement user credential itself. When a grant expires or its scope changes, create a new approval request.
- After approval, `mya execute --request ID --presentation` obtains a server-signed challenge, asks the wallet to present the existing credentials, verifies the result, and then executes the frozen report. Query the resource receipt to resolve an uncertain execution. Keep following the result within the current task.
- For a separate verifier response, `mya challenge --request ID --out challenge.json` writes a signed challenge; `mya present --request ID --challenge challenge.json` verifies it and sends a fresh holder proof with credentials. It does not execute. Follow with `mya execute --request ID --presentation` only when delivery was requested. The verification result is short-lived; it is not a reusable bearer permission.
- This release supports only the configured MYA server and its exact `/v1/wallet/present` endpoint. The wallet checks the signature, verifier, response URI, transaction ID, nonce, action and context hashes. Do not forward credentials to arbitrary URLs, change trusted keys to satisfy a response, or describe this custom profile as W3C VC/OpenID4VP interoperability.

This Skill is a cooperative integration, not a universal shell interceptor. It does not override Codex permissions. Do not print private keys or raw grants, silently weaken TLS/trust checks, or claim simulated fingerprint confirmation is system biometric authentication.
