---
name: mya-approval
description: Pair a local Codex MYA client with the user's phone, request approval for MYA demo report delivery, and continue only after a verified decision. Use for MYA pairing, approval, review, and demo report delivery.
---

Use the installed `mya` CLI. Run `mya help` to inspect commands. If it is not on PATH, use `node <repository>/packages/cli/mya.mjs` from the configured repository; do not invent the location.

- `mya doctor` checks setup. Initial setup requires the correct server URL and witness fingerprint; local loopback testing may use `--trust-local`. Never auto-trust an unknown remote key.
- `mya pair` opens a local confirmation page and waits. Give its URL/QR to the user. The user must compare the two short codes and confirm in both interfaces; do not click their confirmations yourself.
- To send a demo report, write an input JSON file using `fixtures/request-safe.json` or `fixtures/request-cost.json` as a shape. `payload_path` resolves relative to that input. Pass the filename to `mya request --file ...`; do not interpolate report text into shell commands.
- Record the returned request_id. Use `mya status --request ID --wait 20` for bounded waits. Pending means awaiting the phone, not approved. Refusal, cancellation, expiry, invalid signature or network failure does not authorize delivery.
- On `changes_requested`, prepare a new file/request and set `supersedes_request_id` to the prior ID. Preserve the user's intended scope.
- On `approved`, invoke `mya execute --request ID` without replacing the frozen file or destination. If execution times out, use `mya receipt --request ID` to resolve uncertainty before creating another request.
- Report success only when the resource receipt confirms delivery to the **demo inbox**. This does not send a real email.
- The phone saves Review history and can suggest a policy. A single approval is not consent to activate a rule. Rule activation is a separate user action on the phone.

This Skill is a cooperative integration, not a universal shell interceptor. It does not override Codex permissions. Do not print private keys or raw grants, silently weaken TLS/trust checks, or claim simulated fingerprint confirmation is system biometric authentication.
