# Agent identity, approval browsers and relationship termination

Updated: 2026-09-16. The account/device release preserves existing keys and relationships. See [account setup](ACCOUNT_AND_DEVICES.md) and [revocation scenarios](REVOCATION_SCENARIOS.md).

## Same computer, different agents

Current CLI defaults to `~/.mya-demo/agent.json`, and defaults its display name to `我的 PC Codex`. This is a shared per-OS-user file, not automatic per-application identity. Codex and WorkBuddy must select different `MYA_HOME` directories and generate independent keys. Renaming an identity or copying a private key does not create an independent identity.

Choose a stable profile for each agent installation. Include it on every CLI invocation. Name each identity explicitly with `init --name`. This Mac's new Codex profile is `~/.mya-agents/codex`, named `Codex · Sean Mac`; do not repurpose the legacy profile or touch WorkBuddy's established binding. Rebinding does not implicitly revoke old relationships.

`doctor` now reports the profile directory, agent name and public-key fingerprint without exposing private keys. The installed and repository Skill documents explicit profile selection. The server distinguishes signed keys/binding IDs, not the process name or display name.

Profiles address accidental identity mixing. Processes sharing the same OS user can still read each other's files. Strong caller authentication requires an isolated wallet service, per-client access control and protected keys. A claimed app name, environment variable or user-agent string is not authentication. Design separately for runtime installation identity versus task/session correlation.

## User revocation versus agent withdrawal

Current authenticated `/v1/bindings/revoke` accepts either the user signing key or agent signing key after challenge/proof verification. CLI `revoke` uses the agent key; phone `revoke` uses the user key. It does not allow the agent to forge a user signature. Phone fingerprint interaction is simulated; cryptographic signing is real.

Implemented semantics: allow either party to end a relationship, but distinguish `user_revoked` from `agent_withdrawn`. Both stop future use; neither grants or restores permissions. Record actor role, signing-key fingerprint, time, reason, signed evidence and binding ID in an append-only event. Update all authorized devices and refuse existing grants at execution. Keep historical receipts. Reactivation requires a new user-approved relationship, not a status flip.

If the product requires *user revocation* exclusively from the phone, enforce the user role on that operation and provide a separate agent withdrawal/disable operation. Do not rename an agent request as a user decision. The current release records distinct signed termination events and exposes their actor and reason.

## Different lists at the same mobile URL

The deployed browser app uses IndexedDB `mya-demo-v1`, creates and stores a local phone/user key identity, and stores its encrypted state and binding list locally. Different devices, browsers, browser profiles and private sessions therefore have separate identities and state. The same HTTPS origin does not synchronize them. A macOS browser is another approval device, not automatically a mirror of the phone.

Immediate workflow: use the established phone browser as the approval authority for both Codex and WorkBuddy. Use the PC local pairing confirmation page for the PC half. Do not clear browser storage or copy private keys as a repair. Compare each browser's public identity fingerprint and exact binding IDs before attributing a specific mismatch.

Recommended product work: prominently display approval-device name/fingerprint and agent name/fingerprint; provide a read-only management view distinct from a signer; add user-approved enrollment of an additional device with independent keys, explicit read/sign capabilities, encrypted synchronization and per-device revocation. A common account or identical display name must not silently confer signing authority. This release implements password accounts, signed device enrollment, roles, metadata directory and revocation. Encrypted request/history synchronization and signing old relationships from a new device are not implemented.

The report that WorkBuddy succeeds when started in the foreground is user-provided. No matched reproduction establishes its cause; foreground readiness and identity/profile selection are separate issues.
