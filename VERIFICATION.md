# Project verification — receiver-only design, 25 November 2026

## Changes from this review

- Fixed actual Firebase topic-list parsing: responses use `topicSubscriptions` / `topicName`; the helper now accepts both those fields and the guide's snake_case examples. Previously a successful subscription could incorrectly display an empty membership list.
- Removed the local Postman sending endpoint, its module/tests and helper-key configuration. The app now manages individual/topic subscribe/unsubscribe operations and received-message logs only.
- Updated the importable Postman collection/environment and `POSTMAN.md` so every send/validation request goes directly to Firebase's `messages:send` endpoint with a Google OAuth Bearer token.
- Retained individual/message-worker, topic HTTP boundary, collection-artifact and actual Google-auth RSA-signing regression coverage. Added checks that local sending/token endpoints do not exist.
- Improved the topic IAM error to name the required role. The service account initially lacked `cloudmessaging.topicSubscriptions.list`; after the user granted the role, live membership operations succeeded.

## Automated checks

Run with the project's virtual environment:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --check app.js
node --check firebase-config.js
node --check firebase-messaging-sw.js
node tests/check-topics.cjs
node tests/check-messages.cjs
git diff --check
```

After the receiver-only change, all 35 Python tests and both Node behavior suites passed. This includes actual RSA/JWT signing using Google's installed library and an ephemeral test key, with an isolated fake OAuth transport. Other automated tests use substitutes for external Firebase calls; earlier live receiver checks are listed separately below. No additional live push was sent for the sender removal.

Coverage includes exact origin/window validation, safe message text, token deletion, permission denial, no automatic opt-in after reload, topic errors and recovery, foreground/background forwarding, notification deduplication behavior, 100-message history limits, input validation, fixed Firebase destinations, token-cache concurrency, near-expiry refresh, one bounded 401 retry, private-file denial, direct-Firebase collection targets, empty Bearer-token placeholders, and rejection of removed local sending/token endpoints.

## Earlier live Google/Firebase/browser checks

| Check | Result |
|---|---|
| Service-account token exchange using root JSON | Passed; no key/token printed or saved |
| Reuse cached token | Passed |
| Near-expiry renewal against Google's real OAuth endpoint | Passed by moving the in-memory expiry into the refresh window; no hour-long wait was performed |
| Firebase HTTP v1 individual validation | Passed during the earlier live review |
| Firebase HTTP v1 topic validation | Passed during the earlier live review |
| Browser FCM registration for Apps 1 and 2 | Passed; different tokens |
| Individual push to App 1 | Passed; foreground log visible |
| Individual background push to hidden App 1 | Passed; background log visible and mirrored to dashboard |
| Individual isolation | App 2 did not log pushes targeted to App 1 |
| Join `general_announcements` in Apps 1 and 2 | Passed after IAM role update |
| Refresh topics using actual Firebase response | Passed after parser fix |
| Broadcast to topic | Both Apps 1 and 2 logged it; foreground/background states observed |
| Leave topic in App 1 | Firebase membership removal confirmed; individual token unchanged |
| Broadcast after App 1 leaves | App 2 logged it; App 1 did not log the new broadcast |
| Direct push to App 1 after leaving topic | Passed |
| Full unsubscribe App 1 | Token cleared; browser permission remained granted |
| Send to deleted App 1 token | Firebase rejected it with HTTP 404 |
| App 2 after App 1 full unsubscribe | Still received a direct push |
| Reload opted-out App 1 | Remained unsubscribed; no token or membership recreated |

## Practical limits and final test state

- Live delivery was exercised in the user's Chrome with Apps 1 and 2. Apps 3 and 4 use the same tested page, but their real delivery was not separately exercised during this review.
- A background log was verified. Exact OS notification display/count was not independently inspected; duplicate-notification prevention was checked in the worker tests.
- Updated direct-Firebase Postman artifacts were checked automatically. Importing/running the collection in the Postman UI itself was not performed.
- At the end of live tests, **App 1 is fully unsubscribed; App 2 remains subscribed to `general_announcements`**. Re-enable App 1 explicitly if needed.
- The review's temporary server was stopped after testing. Start `serve.py` yourself for receiver subscriptions and logs. There is no helper key: Postman sends directly to Firebase with its own Google OAuth access token.
- Automatic service-account OAuth refresh applies to the Python topic-membership helper. A token copied into Postman does not update automatically; `POSTMAN.md` documents both manual service-account token generation and Postman's separate OAuth 2.0 auto-refresh option.
- Cropped local browser evidence is in `artifacts/verification/individual-and-topic-delivery.jpg` and is Git-ignored. Service-account JSON and populated Postman secrets must remain uncommitted.
