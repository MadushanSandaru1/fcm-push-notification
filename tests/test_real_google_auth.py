"""Real RSA/JWT signing and google-auth refresh, with a local fake OAuth server."""
from datetime import datetime, timedelta, timezone
import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

import service_auth

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from google.auth.transport.requests import Request
    HAS_AUTH_LIBRARY = True
except ImportError:
    HAS_AUTH_LIBRARY = False


@unittest.skipUnless(HAS_AUTH_LIBRARY, "Install optional service-account requirements to exercise actual signing")
class RealGoogleAuthTests(unittest.TestCase):
    def test_signed_assertion_token_exchange_cache_and_renewal(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        calls = []

        def decode(value):
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

        def local_oauth(url, method="GET", body=None, headers=None, **kwargs):
            self.assertEqual(url, service_auth.TOKEN_URI)
            self.assertEqual(method, "POST")
            self.assertEqual(kwargs["timeout"], 10)
            values = parse_qs(body.decode())
            self.assertEqual(values["grant_type"], ["urn:ietf:params:oauth:grant-type:jwt-bearer"])
            assertion = values["assertion"][0]
            head, claims, signature = assertion.split(".")
            key.public_key().verify(decode(signature), f"{head}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())
            self.assertEqual(json.loads(decode(head))["alg"], "RS256")
            claim_set = json.loads(decode(claims))
            self.assertEqual(claim_set["iss"], "local-test@example.invalid")
            self.assertEqual(claim_set["scope"], service_auth.SCOPE)
            self.assertEqual(claim_set["aud"], service_auth.TOKEN_URI)
            self.assertLessEqual(claim_set["exp"] - claim_set["iat"], 3600)
            calls.append(True)
            return SimpleNamespace(status=200, data=json.dumps({"access_token": f"local-token-{len(calls)}", "expires_in": 3600, "token_type": "Bearer"}).encode(), headers={})

        with TemporaryDirectory() as directory:
            credential = Path(directory) / "test-service-account.json"
            credential.write_text(json.dumps({"type": "service_account", "project_id": "local-test", "private_key_id": "test-only", "private_key": pem, "client_email": "local-test@example.invalid", "token_uri": service_auth.TOKEN_URI}))
            with patch.object(service_auth, "_credentials", None), patch.object(service_auth, "_file_identity", None), patch("google.auth.transport.requests.Request", return_value=local_oauth):
                self.assertEqual(service_auth.get_token(credential), "local-token-1")
                self.assertEqual(service_auth.get_token(credential), "local-token-1")
                self.assertEqual(len(calls), 1)
                service_auth._credentials.expiry = (datetime.now(timezone.utc) + timedelta(minutes=4)).replace(tzinfo=None)
                self.assertEqual(service_auth.get_token(credential), "local-token-2")
                self.assertEqual(service_auth.get_token(credential, force_refresh=True), "local-token-3")
                self.assertEqual(len(calls), 3)


class PostmanArtifactTests(unittest.TestCase):
    def test_collection_has_individual_topic_and_dry_run_requests(self):
        root = Path(__file__).resolve().parent.parent
        collection = json.loads((root / "postman/FCM-Push-Lab.postman_collection.json").read_text())
        environment = json.loads((root / "postman/FCM-Push-Lab.postman_environment.json").read_text())
        self.assertEqual(len(collection["item"]), 4)
        combinations = set()
        for item in collection["item"]:
            request = item["request"]
            self.assertEqual(request["url"], "https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/messages:send")
            self.assertEqual(request["auth"]["type"], "bearer")
            self.assertEqual(request["auth"]["bearer"], [{"key": "token", "value": "{{google_access_token}}", "type": "string"}])
            self.assertNotIn("X-Push-Lab-Key", json.dumps(request["header"]))
            body = json.loads(request["body"]["raw"])
            target = "token" if "token" in body["message"] else "topic"
            combinations.add((target, body["validate_only"]))
            self.assertNotIn("private_key", json.dumps(item))
        self.assertEqual(combinations, {("token", True), ("token", False), ("topic", True), ("topic", False)})
        values = {item["key"]: item["value"] for item in environment["values"]}
        self.assertEqual(values["google_access_token"], "")
        self.assertNotIn("helper_key", values)
        self.assertEqual(values["receiver_token"], "")


if __name__ == "__main__":
    unittest.main()
