---
name: mya-approval
description: Pair a local MYA client with the user's phone, request approval, inspect credential verification, and present credentials against a trusted MYA challenge. Use for MYA pairing, credential wallet, approval, review, and demo report delivery.
---

Use the installed `mya` CLI. Run `mya help` to inspect commands. If it is not on PATH, use `node <repository>/packages/cli/mya.mjs` from the configured repository; do not invent the location.

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
