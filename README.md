# FCM Push Lab

Plain HTML/CSS/JavaScript, Firebase JS SDK **13.4.0** from gstatic, and a Python loopback server. The app provides individual/topic subscribe and unsubscribe controls and received-message logs. No npm, build, database, or Analytics. Topic membership uses a small server-side helper; service-account mode adds the optional Google auth dependency.

**For sending directly from Postman to Firebase, follow [POSTMAN.md](POSTMAN.md).** Import the collection and environment from `postman/`. Every send request targets `https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send` with a Google OAuth Bearer token. There is no local send endpoint or helper key.

## Start

```sh
python3 serve.py
```

On Windows use `python serve.py` if needed. Open <http://localhost:8080>. Double-clicking `index.html` also renders the dashboard and startup instructions; push controls require localhost receiver tabs. Use **Open receiver**, then click **Subscribe** in that tab and accept notification permission. Allow dashboard popups if blocked. Use a supported desktop browser such as Chrome/Edge and allow network access to gstatic/Firebase. Blocked permission must be changed in the receiver's browser site settings.

Ports 8081–8084 are separate browser origins, with independent permissions and tokens despite shared Firebase config. Keep receivers open for live dashboard updates. Receivers opened independently have no dashboard connection; after refreshing the dashboard, reopen receivers through its buttons. Logs are in memory, limited to 100 messages per view. Existing tokens are restored locally without automatically obtaining a new token. Unsubscribe deletes the FCM token; browser notification permission remains separate. Reloading after opt-out never automatically subscribes.

Foreground messages log without system notifications. Background notification payloads are displayed by Firebase; data-only payloads are displayed by the worker. Hide the receiver tab (or minimize its window) to test background delivery. Closed receivers cannot forward live events. OS settings can affect system notification display.

## Manual delivery test

1. Subscribe Apps 1 and 2; confirm their copied tokens differ.
2. Send directly to App 1 using Postman or Firebase Console's notification **Send test message** dialog. Confirm only App 1 logs it. Repeat for App 2, testing both a visible foreground receiver and a hidden, open background receiver. Confirm one system notification for each background notification payload and a background log in the matching dashboard panel.
3. Save App 1's old token, then Unsubscribe App 1. Confirm its token clears while browser permission can remain granted. Send to its old token: after revocation propagates, FCM should reject it (typically `UNREGISTERED`) and no new push should reach App 1. A push already in flight is not a valid revocation test. Confirm App 2 still receives. Reload App 1 and confirm it stays unsubscribed until Subscribe is clicked.
4. Send this HTTP v1 request from Postman, replacing placeholders:

```http
POST https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send
Authorization: Bearer <OAUTH_2_ACCESS_TOKEN>
Content-Type: application/json

{
  "message": {
    "token": "<APP_1_OR_APP_2_FCM_TOKEN>",
    "notification": {
      "title": "Direct push test",
      "body": "Hello from Postman"
    },
    "data": { "testId": "<UNIQUE_TEST_ID>" }
  }
}
```

The Bearer token stays in Postman. Obtain it via your trusted OAuth flow with permission to send FCM messages and scope `https://www.googleapis.com/auth/firebase.messaging`. Never put OAuth tokens, private keys, or service account credentials into these files. Firebase web config and the public VAPID key are not sending credentials. Console and Postman use the FCM registration token shown here, without a custom Web Push encryption flow.

Firebase background behavior: <https://firebase.google.com/docs/cloud-messaging/web/receive-messages>.

## Enable topic controls

Topic membership needs trusted server credentials; the web SDK does not provide client-side topic subscription. The receiver calls its own Python origin, which calls Firebase's topic REST API for the fixed demo project. OAuth credentials never enter browser JavaScript, local storage, dashboard messages, or repository files. The three topic endpoints accept only exact same-origin receiver requests; the local server does not send push messages or expose OAuth tokens.

### Automatic authentication with a service account (no gcloud)

1. In Google Cloud Console for this Firebase project, create/select a dedicated service account. Grant the permissions required to manage FCM topic subscriptions and send messages (the **Firebase Cloud Messaging API Admin** role, `roles/firebasecloudmessaging.admin`, is a predefined option). Enable the Firebase Cloud Messaging API. Create a JSON private key if your organization's policy permits service-account keys.
2. Save the downloaded JSON as **`fcm-service-account.json` in the project root**, alongside `serve.py`. It is automatically detected, explicitly ignored by Git, and excluded from every static-file route. Do not put its contents in `firebase-config.js`, paste it into chat, or commit it. Restrict access to your user account. You can alternatively store it outside the repository and configure its path with `FCM_SERVICE_ACCOUNT_FILE`.
3. Install the optional Google auth dependency in a local virtual environment, clear any older environment overrides, and start the server:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-service-account.txt
Remove-Item Env:FCM_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:FCM_SERVICE_ACCOUNT_FILE -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe serve.py
```

For macOS/Linux, use `python3 -m venv .venv`, `.venv/bin/python -m pip install -r requirements-service-account.txt`, `unset FCM_ACCESS_TOKEN FCM_SERVICE_ACCOUNT_FILE GOOGLE_APPLICATION_CREDENTIALS`, and `.venv/bin/python serve.py`.

Startup reports `Topic helper: automatic via service account ...`. On the first topic operation, Google's library signs a service-account assertion and obtains an OAuth access token. The helper caches it in memory and refreshes it on demand within five minutes of expiry. Refresh is shared across the receiver threads; a Firebase 401 triggers one forced renewal and retry. No gcloud, interactive login, or manual token copying is needed. Invalid files, keys, missing dependencies, network failures, or IAM denial produce sanitized errors. The key must remain valid; revoked/disabled keys cannot be refreshed.

`GOOGLE_APPLICATION_CREDENTIALS` is also accepted as a path to a service-account JSON. Selection order is **manual `FCM_ACCESS_TOKEN` → `FCM_SERVICE_ACCOUNT_FILE` → `GOOGLE_APPLICATION_CREDENTIALS` → root `fcm-service-account.json` → gcloud**. A configured but invalid service-account file reports an error instead of silently falling back to another identity. Restart after changing environment variables. Key-file changes invalidate the in-memory credential cache. The default file is resolved beside `serve.py`, independently of the terminal's working directory.

The optional `google-auth[requests]` library performs cryptographic signing and token exchange; the static server, manual mode and gcloud mode still need only Python's standard library. Credential files are never served, returned by an API, or logged; tokens are never persisted by this helper. The helper always uses Google's fixed OAuth token endpoint. Automatic refresh here applies to topic membership operations. Postman sends directly to Firebase and manages its own Bearer token; see `POSTMAN.md`.

For a deployed ESB, prefer an attached service identity or workload identity over distributing private-key files. This JSON-key mode is for the local demo. Firebase authorization reference: <https://firebase.google.com/docs/cloud-messaging/send/v1-api>.

### Automatic authentication with Google Cloud CLI (alternative)

Install [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) on the **same computer running Python**. Sign in once with an account allowed to manage FCM for this project:

```powershell
gcloud auth login
gcloud config set project fcm-push-notification-f55e4
Remove-Item Env:FCM_ACCESS_TOKEN -ErrorAction SilentlyContinue
python serve.py
```

For macOS/Linux, use `unset FCM_ACCESS_TOKEN` instead of `Remove-Item`, and `python3 serve.py`.

The startup message should say `Topic helper: automatic via gcloud ...`. For every topic operation, Python privately runs `gcloud auth print-access-token`; Google Cloud CLI reuses or refreshes its stored credentials as needed. No token copying or server restart is required for normal access-token expiry. There is no background refresh timer, browser login popup, or app-managed credential file. Login credentials are stored by Google Cloud CLI in its normal user configuration outside this repository. Session expiry, revoked access, or an organization's reauthentication policy can still require another `gcloud auth login`. Cloud Shell login alone does not sign in your local computer.

The helper runs the CLI non-interactively, captures its output without logging it, and keeps access tokens only in server process memory. Authentication guidance: <https://docs.cloud.google.com/sdk/docs/authenticate>.

### Manual token fallback

Without local Google Cloud CLI, paste a token obtained from Cloud Shell into a hidden prompt in PowerShell 7:

```powershell
$env:FCM_ACCESS_TOKEN = Read-Host 'FCM access token' -MaskInput
python serve.py
```

Or supply the environment variable in your shell before starting Python:

```sh
export FCM_ACCESS_TOKEN='<OAUTH_ACCESS_TOKEN>'
python3 serve.py
```

`FCM_ACCESS_TOKEN` overrides automatic authentication and **cannot refresh itself**. On expiry, stop the server, replace it, and restart—or clear it to switch to automatic authentication. Do not paste tokens into files or chat. Clear it with `Remove-Item Env:FCM_ACCESS_TOKEN` (PowerShell) or `unset FCM_ACCESS_TOKEN` (shell). Manual mode needs only Python's standard library.

Restart `serve.py` after this update, reload the dashboard and receiver tabs, and click **Open receiver** to reconnect them. In a subscribed receiver, enter `general_announcements` and click **Subscribe to topic**. **Refresh topics** reads actual memberships from Firebase; **Unsubscribe from topic** leaves only that topic and preserves the FCM token. Confirmed memberships/errors mirror to the dashboard. No topic is automatically subscribed on startup or reload. Missing/expired helper credentials leave individual pushes working. A failed or timed-out action shows membership as unknown until refreshed; a successful change followed by a failed list still reports the confirmed action separately.

The regular **Unsubscribe** button deletes the entire FCM token; it is different from leaving one topic. Topic lists are not stored as authoritative local state. The helper has no database and does not attempt background retries.

## Manual topic broadcast test

1. Subscribe Apps 1–4 to obtain their individual tokens. Subscribe only Apps 1 and 2 to `general_announcements`; refresh their topic lists and confirm membership. Apps 3 and 4 should have no membership in that topic.
2. Send this request from Postman. The sending Bearer token stays in Postman; the topic helper's credential stays in the server environment.

```http
POST https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send
Authorization: Bearer <OAUTH_2_ACCESS_TOKEN>
Content-Type: application/json

{
  "message": {
    "topic": "general_announcements",
    "notification": {
      "title": "Topic broadcast test",
      "body": "Hello topic subscribers!"
    },
    "data": { "testId": "<UNIQUE_TEST_ID>" }
  }
}
```

3. Confirm Apps 1 and 2 receive it, while Apps 3 and 4 do not. Test visible foreground receivers and hidden/open background receivers.
4. Leave the topic in App 1, refresh to confirm removal, and broadcast again. Only App 2 should receive the new broadcast after membership removal has taken effect. App 1 should still receive a direct push to its unchanged token. Messages already in flight can still arrive.
5. Reload App 1 and refresh its topics; confirm it has not rejoined. Try an invalid topic name and missing/expired server credentials: errors must be clear and must not claim success.

Topics are for general, non-sensitive broadcasts, not private account/order information. This local helper simulates the trusted ESB/Firebase boundary; it is not a production BO, ESB, authorization or retry implementation. API reference: <https://firebase.google.com/docs/cloud-messaging/manage-topic-subscriptions>.

## Local checks

```sh
python -m unittest discover -s tests -v
node --check app.js
node --check firebase-messaging-sw.js
node tests/check-topics.cjs
node tests/check-messages.cjs
```

Use `.venv\Scripts\python.exe` instead of `python` to run tests with the optional auth dependency installed. Automated tests mock Firebase and Google credentials. See `VERIFICATION.md` for the latest actual checks and remaining live IAM requirements.
