"""FCM REST helper with manual, service-account and gcloud authentication."""
import json
import os
import re
import shutil
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
import service_auth

PROJECT_ID = "fcm-push-notification-f55e4"
DEFAULT_SERVICE_ACCOUNT_FILE = service_auth.ROOT / "fcm-service-account.json"
TOPIC_PATTERN = re.compile(r"[a-zA-Z0-9_.~%-]{1,900}\Z")


class TopicError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def topic_auth_status():
    if os.environ.get("FCM_ACCESS_TOKEN", "").strip():
        return "manual FCM_ACCESS_TOKEN (not automatically refreshed)"
    if service_account_file():
        return "automatic via service account (refreshes before expiry)"
    if shutil.which("gcloud"):
        return "automatic via gcloud (run gcloud auth login once)"
    return "not configured (set FCM_SERVICE_ACCOUNT_FILE, sign in with gcloud, or set FCM_ACCESS_TOKEN)"


def service_account_file():
    configured = os.environ.get("FCM_SERVICE_ACCOUNT_FILE", "").strip() or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if configured:
        return configured
    return str(DEFAULT_SERVICE_ACCOUNT_FILE) if DEFAULT_SERVICE_ACCOUNT_FILE.is_file() else ""


def get_access_token(force_refresh=False):
    """Select manual, service-account, or gcloud authentication server-side."""
    manual_token = os.environ.get("FCM_ACCESS_TOKEN", "").strip()
    if manual_token:
        if any(character.isspace() for character in manual_token):
            raise TopicError(503, "FCM_ACCESS_TOKEN has invalid whitespace. Clear it to use automatic gcloud authentication, or supply a valid token.")
        return manual_token
    filename = service_account_file()
    if filename:
        try:
            return service_auth.get_token(filename, force_refresh=force_refresh)
        except service_auth.CredentialError as error:
            raise TopicError(503, str(error)) from None
    executable = shutil.which("gcloud")
    if not executable:
        raise TopicError(503, "Configure FCM_SERVICE_ACCOUNT_FILE for automatic authentication without gcloud. Alternatively use Google Cloud CLI installed locally with gcloud auth login, or set FCM_ACCESS_TOKEN. See README; individual push still works.")
    environment = dict(os.environ)
    environment.update({
        "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
        "CLOUDSDK_CORE_LOG_HTTP": "false",
        "CLOUDSDK_CORE_USER_OUTPUT_ENABLED": "true",
    })
    try:
        result = subprocess.run(
            [executable, "auth", "print-access-token", "--quiet", "--verbosity=error"],
            capture_output=True, text=True, timeout=15, check=False, stdin=subprocess.DEVNULL,
            env=environment, shell=False,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
    except subprocess.TimeoutExpired:
        raise TopicError(503, "Google Cloud CLI authentication timed out. Check connectivity, run gcloud auth login locally, and retry.") from None
    except OSError:
        raise TopicError(503, "Could not run Google Cloud CLI. Check its local installation and run gcloud auth login.") from None
    token = result.stdout.strip()
    if result.returncode != 0 or not token or any(character.isspace() for character in token):
        # Never expose CLI stdout/stderr: they may contain credentials or details
        # of the user's account. Do not open a login prompt from an HTTP request.
        raise TopicError(503, "Google Cloud CLI could not provide an access token. Run gcloud auth login in a local terminal and select an account with FCM permissions, then retry.")
    return token


def topic_request(action, token, topic="", _auth_retry=False):
    if not isinstance(token, str) or not 1 <= len(token) <= 4096 or any(c.isspace() for c in token):
        raise TopicError(400, "A valid FCM registration token is required.")
    if action not in ("list", "subscribe", "unsubscribe"):
        raise TopicError(400, "Unknown topic action.")
    if action != "list" and (not isinstance(topic, str) or not TOPIC_PATTERN.fullmatch(topic)):
        raise TopicError(400, "Use 1–900 letters, digits, _, ., ~, %, or - for the topic. Omit /topics/.")
    access_token = get_access_token(force_refresh=_auth_retry)
    url = f"https://fcm.googleapis.com/v1/projects/{PROJECT_ID}/registrations/{quote(token, safe='')}/topicSubscriptions"
    method = "GET"
    if action == "subscribe":
        method = "POST"
        url += "?topic_name=" + quote(topic, safe="")
    elif action == "unsubscribe":
        method = "DELETE"
        url += "/" + quote(topic, safe="")
    request = Request(url, data=None if method == "GET" else b"{}", method=method,
                      headers={"Authorization": "Bearer " + access_token, "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            raw = response.read(1024 * 1024)
    except HTTPError as error:
        error.close()
        if error.code == 401 and not _auth_retry and service_account_file() and not os.environ.get("FCM_ACCESS_TOKEN", "").strip():
            # Authentication was rejected before the action was authorized.
            # Renew once; never loop on a revoked key or missing permissions.
            return topic_request(action, token, topic, _auth_retry=True)
        if action == "subscribe" and error.code == 409:
            return {}  # Firebase confirms this membership already exists.
        messages = {
            400: "Firebase rejected the token or topic. Check the receiver token and topic name.",
            401: "Firebase rejected the OAuth token. Check the service-account configuration, or sign in again with gcloud. If FCM_ACCESS_TOKEN is set, replace it or clear it and restart to use automatic authentication.",
            403: "Firebase denied topic access. In the target project's IAM, grant this service account Firebase Cloud Messaging API Admin (roles/firebasecloudmessaging.admin), including cloudmessaging.topicSubscriptions permissions. Also check API enablement and OAuth scope.",
            404: "Firebase registration or topic membership was not found. Refresh topics or obtain a current FCM token.",
            429: "Firebase rate limit reached. Wait before retrying.",
        }
        raise TopicError(502, messages.get(error.code, f"Firebase topic request failed (HTTP {error.code}). Retry later.")) from None
    except (URLError, TimeoutError, OSError):
        raise TopicError(502, "Cannot reach Firebase. Check network access and retry; membership is not confirmed.") from None
    try:
        result = json.loads(raw) if raw else {}
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise TopicError(502, "Firebase returned an unexpected response; refresh topics to verify membership.") from None


def handle_topic_request(handler):
    """Same-origin receiver-only API; never accepts browser OAuth credentials."""
    port = handler.server.server_port
    expected_host = f"localhost:{port}"
    if (port not in range(8081, 8085) or handler.headers.get("Host") != expected_host
            or handler.headers.get("Origin") != "http://" + expected_host):
        raise TopicError(403, "Topic requests must come from this localhost receiver origin.")
    actions = {"/api/topics/list": "list", "/api/topics/subscribe": "subscribe", "/api/topics/unsubscribe": "unsubscribe"}
    action = actions.get(handler.path)
    if not action:
        raise TopicError(404, "Unknown API endpoint.")
    if handler.headers.get_content_type() != "application/json" or handler.headers.get("Transfer-Encoding"):
        raise TopicError(415, "Send application/json with Content-Length.")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        raise TopicError(400, "Invalid Content-Length.") from None
    if not 1 <= length <= 16384:
        raise TopicError(413, "Request must contain 1–16384 bytes.")
    handler.connection.settimeout(10)
    try:
        data = json.loads(handler.rfile.read(length))
    except (ValueError, UnicodeError, OSError):
        raise TopicError(400, "Invalid JSON request.") from None
    if not isinstance(data, dict) or set(data) - {"token", "topic"}:
        raise TopicError(400, "Send only token and topic fields; OAuth credentials belong in the server environment.")
    result = topic_request(action, data.get("token"), data.get("topic", ""))
    if action == "list":
        # Actual protobuf JSON uses camelCase; Firebase's guide also shows
        # snake_case. Accept both rather than silently hiding memberships.
        memberships = result.get("topicSubscriptions", result.get("topic_subscriptions", []))
        if not isinstance(memberships, list) or any(not isinstance(item, dict) or not isinstance(item.get("topicName", item.get("topic_name")), str) for item in memberships):
            raise TopicError(502, "Unexpected Firebase membership list. Retry refresh.")
        return {"topics": sorted({item.get("topicName", item.get("topic_name")) for item in memberships})}
    return {"topic": data["topic"], "subscribed": action == "subscribe"}
