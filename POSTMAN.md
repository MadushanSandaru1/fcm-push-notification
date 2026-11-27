# Send individual and topic pushes directly from Postman

The web app only manages individual/topic subscriptions and displays received messages. All push sends go directly to:

```text
https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send
```

There is no localhost sending endpoint, local helper key, or OAuth-token HTTP endpoint.

## 1. Start the receiver project

Use Node.js 22.12+ and pnpm, then run from the project directory:

```powershell
pnpm install
pnpm dev
```

For built output, use `pnpm build` followed by `pnpm start`. Python and gcloud are not required.

Keep your Git-ignored `fcm-service-account.json` at the project root. The account needs **Firebase Cloud Messaging API Admin** (`roles/firebasecloudmessaging.admin`) on the target project, including topic-management permissions. Enable the Firebase Cloud Messaging API.

Open <http://localhost:6060>, then use **Open receiver** for each app you want to test. Click **Subscribe** in each receiver to obtain an FCM registration token. For a topic test, enter `general_announcements`, click **Subscribe to topic**, and confirm it with **Refresh topics**.

## 2. Obtain a Google OAuth access token

You can use the same service account for Postman. Generate a token privately and copy it to the clipboard:

```powershell
Remove-Item Env:FCM_ACCESS_TOKEN -ErrorAction SilentlyContinue
pnpm --silent auth:token | Set-Clipboard
```

Run this from the project directory. The root service-account file is automatically detected unless an explicit credential-file environment variable overrides it. The private key stays in Node; paste only the generated access token into Postman.

A pasted token expires and must be replaced by rerunning this command. The Node topic helper's automatic renewal does not update a token previously copied into Postman. For native Postman OAuth auto-refresh, see step 7.

## 3. Import the supplied Postman files

1. In Postman, click **Import** and select:
   - `postman/FCM-Push-Lab.postman_collection.json`
   - `postman/FCM-Push-Lab.postman_environment.json`
2. Select the imported **FCM Push Lab - direct Firebase** environment.
3. Fill the variables privately:

| Variable | Value |
|---|---|
| `google_access_token` | Google OAuth token from step 2 |
| `receiver_token` | Current FCM registration token copied from App 1 |
| `topic` | `general_announcements` |

4. Keep populated secrets local. Do not commit or share an exported environment containing them.
5. The requests already use **Authorization → Bearer Token → `{{google_access_token}}`** and `Content-Type: application/json`.

If you imported the old localhost collection, replace it with these updated files. Its `base_url` and `helper_key` variables are no longer used.

## 4. Send an individual push

Open **Validate only - Individual** and click **Send** to validate without delivering. Then open **Send - Individual** and send.

To configure manually:

- Method: **POST**
- URL: **https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send**
- Authorization: **Bearer Token**, value **`{{google_access_token}}`**
- Body: **raw → JSON**

```json
{
  "message": {
    "token": "{{receiver_token}}",
    "notification": {
      "title": "Individual push test",
      "body": "Only the selected receiver should log this."
    },
    "data": { "testId": "{{$guid}}" }
  }
}
```

Only the receiver owning that FCM token should log it. Replace `receiver_token` with App 2's token and repeat.

## 5. Send a topic broadcast

Use the same URL and Bearer authorization. Open **Validate only - Topic**, then **Send - Topic**. The body targets `topic` instead of `token`:

```json
{
  "message": {
    "topic": "{{topic}}",
    "notification": {
      "title": "Topic broadcast test",
      "body": "Hello to general_announcements subscribers!"
    },
    "data": { "testId": "{{$guid}}" }
  }
}
```

Subscribe only Apps 1 and 2 to the topic and confirm membership. A broadcast should reach them, while receivers outside the topic should not log it.

Firebase success response:

```json
{
  "name": "projects/fcm-push-notification-f55e4/messages/<MESSAGE_ID>"
}
```

This means accepted by Firebase, not delivered/read by every device. The local-helper `status` field no longer exists. Adding top-level `"validate_only": true` validates without delivering; remove it or set false to send.

## 6. Test foreground, background and unsubscribe

1. Keep the targeted receiver visible and send: expect a **foreground** log.
2. Switch away but keep the receiver open and send again: expect a **background** log mirrored to the dashboard. OS settings affect system notification display.
3. In App 1, click **Unsubscribe from topic** and confirm removal. Broadcast again: only App 2 should receive. A direct push to App 1's unchanged token should still work.
4. Save App 1's old token, click the regular **Unsubscribe**, and confirm its token clears. Firebase should eventually reject sends to that old token. App 2 should remain active. Already in-flight messages are not a valid revocation test.
5. Reload App 1 and confirm it stays unsubscribed. Browser permission may remain granted; permission and FCM subscription are separate.

## 7. Optional: automatic OAuth refresh inside Postman

For direct Firebase sends with Postman's built-in refresh, configure **OAuth 2.0 → Authorization Code**, using a Google OAuth client rather than a pasted service-account token:

1. Create a Google OAuth client of type **Web application**, configure consent/test users, and register the exact callback URL displayed by Postman.
2. In Postman set Auth URL `https://accounts.google.com/o/oauth2/v2/auth`, Access Token URL `https://oauth2.googleapis.com/token`, your client ID/secret, and scope `https://www.googleapis.com/auth/firebase.messaging`.
3. Under advanced authorization-request parameters, add `access_type=offline` and `prompt=consent`.
4. Get a new token, sign in with an authorized account, choose **Use Token**, and enable **Auto-refresh access token**. Google must return a refresh token for this feature to work.
5. Change the request authorization from the imported Bearer variable to this OAuth 2.0 configuration. Leave token sharing off.

This is separate from the service-account authentication used by the Node topic helper. Normal Postman auto-refresh applies to manually sending requests, not monitors/Newman/Postman CLI. References: <https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/> and <https://developers.google.com/identity/protocols/oauth2/web-server>.

## Token types

| Value | Purpose |
|---|---|
| Google OAuth access token | Bearer credential authorizing Postman or the topic helper to call Firebase |
| FCM registration token | Destination identifying a subscribed receiver; goes in `message.token` |
| Public VAPID key | Browser push registration configuration; not a sending credential |

## Troubleshooting

| Result | Action |
|---|---|
| 401 | Generate/paste a new OAuth token or repair Postman's OAuth configuration. |
| 403 | Check the sending account's IAM role, API enablement and OAuth scope. |
| Topic membership 403 in receiver | Grant `roles/firebasecloudmessaging.admin` to the service account used by Node. |
| 404 / UNREGISTERED | Obtain and copy the receiver's current FCM token. |
| 400 | Target exactly one of `token`/`topic`; data values must be strings. |
| Success but no notification | Ensure validate_only is false, receiver is subscribed, correct topic/token is used, and tabs stay open for logs. |

Firebase send reference: <https://firebase.google.com/docs/cloud-messaging/send/v1-api>.
