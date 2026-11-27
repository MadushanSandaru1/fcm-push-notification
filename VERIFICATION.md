# pnpm / Vue migration verification — 25 November 2026

## Current implementation

- Vue 3 single-file components and composables replace the old DOM script.
- Vite builds only `web/` into `dist/`; the root credential file is outside the frontend source/public directory.
- One Node process serves the dashboard on 6060 and receivers on 6061–6064, all on loopback. Development also uses WebSocket port 6065.
- The Node topic adapter replaces Python. Google's Node auth library manages the shared service-account cache, renewal within five minutes of expiry, and one forced renewal/retry after a Firebase 401.
- Postman still sends directly to Firebase. No local push sender or HTTP OAuth-token endpoint exists.
- Firebase JS SDK 13.4.0 remains pinned to gstatic, including classic worker compat scripts.
- Existing storage keys, origins, root worker scope and public Firebase config are preserved. The migration does not automatically opt a receiver or topic back in.

## Automated checks

`pnpm check` passed: **38 tests across five Vitest files**, followed by a successful production build. `git diff --check` passed. Recent component tests cover individual/topic button transitions, selecting another topic, unknown membership, request-time locking and per-topic list actions. Dashboard-to-receiver integration verifies confirmed removal, preservation of other topics/the individual FCM token and other panels, and Firebase failure handling. Command tests check exact origins/window references, correlated replies, busy/disconnected controls, receiver closure and confirmation timeouts.

The dashboard unsubscribe change was checked with simulated Firebase responses; no new live Firebase unsubscribe or delivery was performed for this change.

The tests cover:

- Vue panel rendering, safe text interpolation, 100-message history and duplicate suppression.
- Explicit individual subscribe/unsubscribe, denied permission, blocked local storage and opt-out reload behavior.
- Exact dashboard/opener and worker origin/reference checks.
- Topic join/leave/list behavior, error recovery and token preservation when leaving a topic.
- Actual camelCase Firebase membership responses as well as snake_case examples.
- Fixed Firebase destinations, same-origin API restrictions, body validation and sanitized failures.
- Private-file denial, root worker/config MIME types, missing local send/token endpoints and production static serving.
- Service-account precedence, concurrent request sharing, key rotation, missing/invalid keys, bounded OAuth transport and secret-safe failures.
- Real RSA/JWT signing using Google's installed Node library with an ephemeral test key and an isolated fake OAuth transport. Cache reuse, near-expiry renewal and forced refresh are checked.
- Worker background forwarding and duplicate system-notification prevention for notification payloads.
- Credential-free Postman templates, direct Firebase URLs, Bearer authorization and individual/topic dry-run/send variants.

## Live checks performed for this migration

| Check | Result |
|---|---|
| Node service-account exchange against Google OAuth | Passed; no credentials printed |
| Node access-token cache reuse and forced renewal | Passed |
| Node topic adapter reading App 2's actual Firebase membership | Passed |
| Development serving on 6060–6064 | Passed |
| Development private-file and backend-source denial | Passed, including encoded and /@fs key paths |
| Production built-app serving on 6060–6064 | Passed |
| Production root worker/config and private-file denial | Passed |
| Production topic HTTP endpoint → Firebase | Passed |
| Built Vue dashboard in Chrome | Four panels rendered |
| Built Vue receiver restoring App 2 | Existing token and general_announcements membership restored |
| Direct individual send through Firebase HTTP v1 → Vue | Passed; foreground log visible |
| Direct general_announcements broadcast → Vue | Passed; log visible |
| Vue dashboard message mirroring | Both messages appeared in the matching App 2 panel |
| CLI token-only output | Passed using a non-secret dummy override; command is suitable for piping to clipboard |

The migration's live messages were classified foreground by Firebase/Chrome. Live background delivery was not separately re-established in this migration; worker background behavior is covered automatically and had passed during the prior plain-JavaScript review. Exact OS notification counts were not inspected.

Apps 1, 3 and 4 were not independently subjected to a new full live push cycle during this migration. App 2's existing subscription/topic membership was preserved. All four origins use the same tested Vue app. Importing the Postman collection in the Postman UI was not performed; its artifacts were tested.

## Setup and evidence

Use `pnpm install`, then `pnpm dev`. For built output use `pnpm build`, then `pnpm start`. To privately generate a Postman token, run `pnpm --silent auth:token` (or pipe to Set-Clipboard). See README.md and POSTMAN.md.

The root service-account key remains Git-ignored and was not modified or copied into frontend/build assets. Temporary browser evidence under artifacts/verification is also Git-ignored. The verification server is stopped after checks; start it yourself for ongoing testing.
