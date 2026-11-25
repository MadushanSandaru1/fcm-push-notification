"""Optional service-account OAuth support, loaded only when configured."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parent
SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
TOKEN_URI = "https://oauth2.googleapis.com/token"
_lock = Lock()
_credentials = None
_file_identity = None


class CredentialError(Exception):
    pass


def get_token(filename, force_refresh=False):
    """Serialize refreshes across all four receivers and retain no token on disk."""
    global _credentials, _file_identity
    with _lock:
        try:
            path = Path(filename).expanduser().resolve()
            if path.is_relative_to(ROOT) and path != ROOT / "fcm-service-account.json":
                raise CredentialError("Use fcm-service-account.json at the project root, or a credential file outside the repository.")
            stat = path.stat()
            identity = (str(path), stat.st_mtime_ns, stat.st_size)
            if stat.st_size > 65536:
                raise CredentialError("Service-account JSON is unexpectedly large. Check the configured credential file.")
        except (OSError, ValueError, RuntimeError):
            raise CredentialError("Cannot read the service-account file. Check FCM_SERVICE_ACCOUNT_FILE and file permissions.") from None
        if identity != _file_identity:
            _credentials = None
            _file_identity = None
            try:
                info = json.loads(path.read_text(encoding="utf-8-sig"))
                if (not isinstance(info, dict) or info.get("type") != "service_account"
                        or not isinstance(info.get("client_email"), str)
                        or not isinstance(info.get("private_key"), str)):
                    raise ValueError()
                # Never send the signed assertion to an endpoint supplied by a file.
                info["token_uri"] = TOKEN_URI
            except (OSError, ValueError, UnicodeError):
                raise CredentialError("Invalid service-account JSON. Use the downloaded Google service-account private-key file.") from None
            try:
                from google.oauth2 import service_account
                credentials = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
            except ImportError:
                raise CredentialError("Service-account mode needs Google's auth library. Run python -m pip install -r requirements-service-account.txt using the same Python as serve.py.") from None
            except Exception:
                raise CredentialError("Could not load the service-account signing key. Check the JSON key file and optional Google auth dependencies.") from None
            _credentials, _file_identity = credentials, identity
        expiry = _credentials.expiry
        if expiry is not None and expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if (force_refresh or not _credentials.token or expiry is None
                or expiry <= datetime.now(timezone.utc) + timedelta(minutes=5)):
            try:
                from google.auth.transport.requests import Request
                request = Request()

                def bounded_request(*args, **kwargs):
                    kwargs["timeout"] = 10
                    return request(*args, **kwargs)

                _credentials.refresh(bounded_request)
            except ImportError:
                raise CredentialError("Service-account transport is missing. Run python -m pip install -r requirements-service-account.txt.") from None
            except Exception:
                _credentials.token = None
                raise CredentialError("Service-account token refresh failed. Check network access, system time, and whether the key/account is enabled. Firebase access also requires appropriate IAM permissions.") from None
        if not isinstance(_credentials.token, str) or not _credentials.token or any(c.isspace() for c in _credentials.token):
            raise CredentialError("Google returned an invalid service-account access token.")
        return _credentials.token
