# FCM Push Lab

A **pnpm + Vue 3 + Vite** test app with a Node.js helper for topic subscriptions and optional PostgreSQL device registration. No Python, Analytics or message-sending backend.

The app manages individual/topic subscriptions and displays received messages. **Postman sends directly to Firebase HTTP v1**. Firebase JS SDK **13.4.0** stays pinned to the gstatic CDN in both the browser adapter and classic service worker.

## Quick start

Use Node.js **22.12+** (Node 24 recommended) and pnpm. From the repository root:

```sh
pnpm install
pnpm dev
```

Open <http://localhost:6060>. The same command serves receivers at ports **6061–6064**, all bound to loopback. Vite's development WebSocket uses port **6065**. Stop old Python/Node servers occupying these ports before starting.

Use **Open receiver** in each dashboard panel, then **Subscribe** in that top-level receiver tab. Notification permission must be requested by an explicit click. Keep receivers open for live dashboard updates. Browser permission and FCM subscription status are separate.

The four ports remain separate origins, preserving independent permissions, worker registrations, tokens and storage. Existing saved tokens are read without requesting a new token on startup. An opt-out never triggers automatic individual/topic re-subscription. Reloading the dashboard requires reopening its receivers through its buttons to reconnect.

## Saving tokens to PostgreSQL

Copy `.env.example` to `.env` at the repository root and fill in your PostgreSQL connection settings (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), or use `DATABASE_URL`. Restart `pnpm dev` after changing them. Credentials stay on the server; never use `VITE_*` variables for database credentials. Without configuration the app still receives notifications, and its DB indicator shows Disconnected.

Install the unique index and `fin_user.prc_u37_insert` procedure from `database/prc_u37_insert.sql` in your database, then install `database/prc_u37_unsubscribe.sql`. The table and `fin_master.get_next_sequence` must already exist. Resolve existing duplicate login/org/device combinations before creating the index. The insert procedure requires exactly one matching notification type for the supplied organization. The connection user must have the required procedure/table/sequence-function permissions.

If saving returns `42P10`, the connected database has no usable unique index on `(u37_u09_login_id, u37_m01_org_id, u37_devide_id)`. Run the entire SQL setup script in the same database configured in `.env`. It checks duplicates and validates the conflict target before replacing the procedure. An existing index with the same name can have the wrong definition: `IF NOT EXISTS` does not check that definition. Inspect it with `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'fin_user' AND tablename = 'u37_push_notification_devices';`. Resolve duplicates explicitly; the setup script never deletes records. If the script fails inside its transaction, execute `ROLLBACK;` before retrying.

Each app section has Login ID, Customer ID, and Organization ID fields, a DB connection indicator, and a Save token retry button. Fill the IDs and leave the field to save automatically once the receiver supplies a token. If either login or customer ID is empty, the entire database write is skipped. Organization ID is also required by the procedure. The same rules apply in standalone receiver tabs. Fields are remembered per app in that page's origin; dashboard and receiver forms have separate saved values. For the usual dashboard workflow, enter IDs in the dashboard and leave receiver forms empty.

A device ID is generated once per receiver origin and retained in browser storage. The dashboard gets that same ID with the token. Subsequent tokens for the same login, organization, and device update the existing record. Clearing receiver storage creates a new device identity. Browser storage must be available for automatic database registration.

The DB indicator checks `SELECT 1` at startup, every 15 seconds, and on demand. Disconnected forms do not submit registrations. The server also checks the actual connection before every procedure call and skips the call if connectivity fails. A pending token is saved when connectivity recovers if all IDs remain filled. Procedure output `p_status = 1` displays success; `p_status = 0` displays `p_error_message` and allows retry. Database failures do not delete or unsubscribe the FCM token.

After Firebase confirms an individual **Unsubscribe**, the app calls `fin_user.prc_u37_unsubscribe` for the matching login/org/device. It sets `u37_c01_app_status_id = 12`, `u37_c01_status_id = 2`, `u37_token = NULL`, `u37_u01_updated_by_id = 0`, and the update timestamp, retaining the row. Both login and customer ID fields must be filled for app database operations. Failed Firebase deletion and topic unsubscribe do not change database device status. When the DB is unavailable, the status update stays pending in memory; keep the page open for automatic retry after connectivity recovers, or use **Retry status update**. Closing/reloading the page loses that pending request. A missing matching row returns status 0 with an error message. Re-subscribing uses the insert procedure to save the new token and restore both statuses to 1.

## Topic authentication

Keep your existing **fcm-service-account.json** at the project root. It is Git-ignored, outside Vite's frontend root and blocked from HTTP access. Never place it in `web/public/`, frontend imports or a `VITE_*` variable.

The committed [fcm-service-account.example.json](fcm-service-account.example.json) shows the expected structure using placeholders only. For setup, download a service-account JSON key from Firebase Console → Project settings → Service accounts → Generate new private key, then save the downloaded file at the project root as `fcm-service-account.json`. The example cannot authenticate. Keep real values only in the ignored file; never fill in or commit credentials in the example.

The service account needs **Firebase Cloud Messaging API Admin** (`roles/firebasecloudmessaging.admin`) in project `fcm-push-notification-f55e4`, including topic-management permissions. Enable the Firebase Cloud Messaging API.

`google-auth-library` performs signing and OAuth exchange. Tokens are cached server-side, renewed within five minutes of expiry, and shared across all receivers. A 401 causes at most one forced renewal/retry. OAuth values and private keys never enter the browser, dashboard messages, logs, or build.

Credential selection:

1. `FCM_ACCESS_TOKEN`: optional manual override; does not automatically refresh.
2. `FCM_SERVICE_ACCOUNT_FILE`: explicit service-account JSON path.
3. `GOOGLE_APPLICATION_CREDENTIALS`: alternative JSON path.
4. Root `fcm-service-account.json`.

There is no gcloud or Python requirement. Clear stale overrides in PowerShell before starting if you want the root file:

```powershell
Remove-Item Env:FCM_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:FCM_SERVICE_ACCOUNT_FILE -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue
pnpm dev
```

In a subscribed receiver, enter `general_announcements` and use **Subscribe to topic**, **Unsubscribe from topic**, or **Refresh topics**. Topic removal preserves the individual token. The regular **Unsubscribe** deletes the FCM token. Topic operations show Firebase-confirmed results; errors leave membership unknown until refreshed.

Subscription buttons follow the current state: Subscribe is enabled when unsubscribed, and Unsubscribe when subscribed. Topic buttons follow the name currently entered. Both actions are disabled during requests; unknown topic membership requires Refresh topics before making changes.

Confirmed topic subscriptions appear as a list with an Unsubscribe button beside each topic in both receivers and dashboard panels. Dashboard actions run through the matching open receiver without switching tabs. Keep that receiver connected; buttons disable while it is busy, disconnected or awaiting confirmation. Leaving a topic preserves the individual FCM token and other memberships.

## Postman

Follow [POSTMAN.md](POSTMAN.md). Import the collection and empty environment in `postman/`. All four send/validation requests target:

```text
https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send
```

To generate a Google OAuth token for Postman using the same service account:

```powershell
pnpm --silent auth:token | Set-Clipboard
```

Paste it into the private `google_access_token` Postman variable. This CLI deliberately outputs a token; never commit or share it. A copied Postman token does not refresh when the Node helper refreshes its own token. The guide also explains Postman's separate native OAuth auto-refresh option.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Vue/Vite development with hot updates and all five loopback ports |
| `pnpm build` | Compile frontend to `dist/` |
| `pnpm start` | Serve built output plus topic API on the same five ports |
| `pnpm preview` | Alias for built-app serving; run build first |
| `pnpm test` | Vitest server/auth/component/worker regression tests |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm check` | Tests followed by production build |
| `pnpm --silent auth:token` | Print a Google OAuth token for private use in Postman |

This framework application must run over localhost; double-clicking HTML is no longer a supported startup method.

## Project structure

```text
web/
  index.html
  src/
    App.vue                    # Dashboard and receiver routing by port
    dashboard.js               # Validated receiver commands and status mirroring
    components/ReceiverPanel.vue
    useReceiver.js             # Permission, subscription, message lifecycle
    firebase.js                # Pinned gstatic SDK adapter
    model.js                   # Validated bridge snapshots and bounded logs
    style.css
  public/
    firebase-config.js         # Public config shared with worker
    firebase-messaging-sw.js   # Root-scoped classic compat worker
server/
  index.js                     # Loopback Vite/built server; topic and device APIs
  devices.js                   # Server-only PostgreSQL health and procedure calls
  topics.js                    # Firebase topic REST adapter
  auth.js                      # Server-only credentials and refresh
  print-token.js               # CLI-only token generation
database/prc_u37_insert.sql     # Unique index and registration procedure
postman/                       # Direct Firebase requests, no filled secrets
tests/                         # Vitest, Vue Test Utils, Node HTTP and RSA tests
vite.config.js
package.json
pnpm-lock.yaml
```

## Manual delivery checks

1. Subscribe Apps 1 and 2 and verify their tokens differ.
2. Send to App 1 from Postman; only App 1 should log it. Repeat for App 2. Test a visible foreground receiver, then hide it but keep it open for background delivery.
3. Join `general_announcements` in Apps 1 and 2; leave Apps 3 and 4 outside it. Broadcast and confirm only members receive it.
4. Leave the topic in App 1, refresh to confirm removal, and broadcast again. App 2 receives; App 1's direct token still works.
5. Save App 1's old token, fully Unsubscribe it and confirm the token clears. Firebase should reject later sends to that token after revocation propagates. App 2 remains active. Reload App 1 and confirm no opt-in occurs.

Logs are in memory, deduplicated and bounded to 100 messages per view. Foreground notifications log without a system notification. Firebase displays background notification payloads; the worker displays data-only payloads itself to avoid duplicates. Background payloads are forwarded only to same-origin receiver windows, then mirrored to the exact dashboard opener/origin. OS/browser settings affect system display. Closed receivers cannot forward live events.

See [VERIFICATION.md](VERIFICATION.md) for checks and limits. Firebase references: <https://firebase.google.com/docs/cloud-messaging/web/receive-messages> and <https://firebase.google.com/docs/cloud-messaging/manage-topic-subscriptions>.
