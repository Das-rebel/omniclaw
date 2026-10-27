# OpenDots (CopilotKit/OpenDots) — Extraction for omniclaw

> Reviewed @ commit depth-1, 2026-10-27. Clone: `/tmp/opendots` (84 TS files, single-app: src/{client,server,shared,browser}).
> Verdict: **do not adopt the stack** (alpha; every conversation incl. scheduled turns requires CopilotKit
> Intelligence — hosted / Docker-eval / licensed self-host; per-Dot containers need RAM we don't have).
> **Adopt the patterns below.** They map 1:1 onto infra we already run (server.js :8443, watchdog, cron).

---

## 1. Approval-card protocol (BUILD — highest value)

Source: `docs/CONNECTIONS.md` + `src/server/connection-{store,routes}.ts`.

OpenDots' model, translated to WhatsApp:

- Watchdog / cron detects a **judgment state** (cookies expired, disk >70%, sync fail, service down, port drift).
- Instead of failing silently (the IG-cookie week) or auto-fixing, it **posts a numbered-option card** to the
  owner's WhatsApp via existing `server.js :8443`.
- The **action + exact args are stored server-side** at card-creation time (SQLite row: id, action, args JSON,
  created_at, expires_at, state).
- The human reply is only a **selector** ("reply 1 …"). The handler executes the STORED args — never anything
  parsed from the reply. This is OpenDots' key security property: *the approval route runs the stored request*.
- Rules copied from OpenDots: requests **expire** (12h for us); each approval **runs at most once**;
  **owner-JID only** (allowlist already exists in server.js); result is posted back and persisted, so asking
  "what happened?" re-shows the stored outcome; editing the pipeline mid-flight cancels pending cards.

Fixes the actual failure class we hit this month: every silent-skip becomes a one-tap decision.

## 2. Draft-review-before-publish tool pattern (BUILD-LATER)

Source: `src/shared/page-review.ts` — `review_space_page` tool.

- A tool whose ONLY job: present a draft, wait for approve/decline. Its description explicitly forbids the
  model from self-publishing ("its approved result includes the saved page URL. Call once, then wait.").
- The side effect lives in the approval handler, not in model-controlled code.
- omniclaw use: Sunday Wrapped / auto-posted digests get a "reply 1 to post / 2 to discard" gate before publish.

## 3. Fail-closed principle (ADOPT AS RULE)

Source: `docs/COMPUTERS.md` — "No action falls back to your host's shell or files when the computer service
is unavailable."

- Our two recent silent failures (ms-playwright cache deletion killed Twitter scrape; IG cookies expired →
  scrape skipped) were **fail-open** behaviors.
- Rule for all droplet scripts + Mac launchd jobs: missing dependency ⇒ exit nonzero AND emit an approval-card
  notification. Never skip-and-continue on infrastructure errors.

## 4. Audit-without-values (ADD when building #1)

Source: `docs/COMPUTERS.md` — activity log keeps action name, requester, success/fail; deliberately excludes
typed values, file contents, full commands.

- Approve-card log stores action + outcome only. Never log cookie values, tokens, or arg payloads.

## 5. Capabilities default-off (PRINCIPLE)

Source: `docs/COMPUTERS.md` — browser/file/shell permissions start disabled, granted per Dot, enforced
server-side; revocation cancels in-flight requests (docs are honest that completed side effects can't be undone).

- Any new droplet service starts with zero capabilities; grant explicitly. Master-credential-derived per-use
  credentials is the pattern to remember if we ever add multi-tenant anything.

## 6. Verification checklist (ADD when building #1)

Source: `docs/COMPUTERS.md` "Verify and troubleshoot".

Test matrix for the WhatsApp card system: non-owner JID → rejected; expired card → dead;
one-shot card → second "1" does nothing; result persistence → asking later re-shows outcome;
service-down → fail-closed notification, not silence.

---

## Skipped on purpose

| OpenDots feature | Why not |
|---|---|
| CopilotKit Intelligence runtime | Hard dependency for ALL turns (confirmed `src/server/headless.ts`: scheduled work = WS to Intelligence). Hosted chokepoint / paid self-host. Same category as Green API lock-in. |
| Per-Dot containers (OpenBot supervisor) | 1GB droplet can't; Mac could but duplicates browser-harness idea. Keep OpenBot as reference for sandboxed real-Chrome profiles with persistent cookies. |
| Spaces/Docs | Vault + briefs already cover it, with WhatsApp delivery OpenDots lacks. |
| Voice calls | Out of scope (standing exclusion). |
| Composio apps | PI MCP ecosystem already covers tool connections. |

## Revisit triggers (any one)

1. CopilotKit conversations ship pure BYOK (no Intelligence runtime) or a self-host license we'd actually buy.
2. Droplet budget increases (4GB+ could host one Dot honestly).
3. OpenDots exits alpha with a stable API.

## Implementation note for #1 (no new deps)

Everything needed exists on the droplet: server.js webhook loop (gowa), SQLite, allowlist, watchdog.sh.
Approx: card table + 2 endpoints (create-card [internal], resolve-card [owner webhook]) + watchdog hook + ~3
card templates. Est: one afternoon. Storage: same DB, WAL checkpoint already handled by sync pipeline.
