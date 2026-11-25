"""Service-account lifecycle tests with a substituted Google auth transport."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import service_auth
import topics


class ServiceAccountTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.file = Path(directory.name) / "service-account.json"
        self.info = {"type": "service_account", "client_email": "test@example.invalid",
                     "private_key": "FAKE-PRIVATE-KEY", "token_uri": "https://untrusted.invalid/token"}
        self.file.write_text(json.dumps(self.info))
        self.credentials = SimpleNamespace(token=None, expiry=None)

        def refresh(transport):
            transport("https://oauth2.googleapis.com/token", method="POST", body=b"fake-assertion")
            self.credentials.token = "fresh-access-token"
            self.credentials.expiry = datetime.now(timezone.utc) + timedelta(hours=1)

        self.credentials.refresh = MagicMock(side_effect=refresh)
        self.factory = MagicMock(return_value=self.credentials)
        self.transport = MagicMock()
        modules = {name: ModuleType(name) for name in ["google", "google.oauth2", "google.oauth2.service_account", "google.auth", "google.auth.transport", "google.auth.transport.requests"]}
        for name, module in modules.items():
            module.__path__ = []
            if "." in name:
                parent, attribute = name.rsplit(".", 1)
                setattr(modules[parent], attribute, module)
        modules["google.oauth2.service_account"].Credentials = SimpleNamespace(from_service_account_info=self.factory)
        modules["google.auth.transport.requests"].Request = MagicMock(return_value=self.transport)
        self.modules = modules
        patches = [patch.dict(sys.modules, modules),
                   patch.object(service_auth, "_credentials", None),
                   patch.object(service_auth, "_file_identity", None),
                   patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "", "FCM_SERVICE_ACCOUNT_FILE": str(self.file), "GOOGLE_APPLICATION_CREDENTIALS": ""})]
        for mock in patches:
            mock.start()
            self.addCleanup(mock.stop)

    def test_initial_exchange_scope_endpoint_and_cache(self):
        self.assertEqual(service_auth.get_token(self.file), "fresh-access-token")
        self.assertEqual(service_auth.get_token(self.file), "fresh-access-token")
        self.credentials.refresh.assert_called_once()
        self.assertEqual(self.factory.call_args.kwargs["scopes"], ["https://www.googleapis.com/auth/firebase.messaging"])
        self.assertEqual(self.factory.call_args.args[0]["token_uri"], "https://oauth2.googleapis.com/token")
        self.assertEqual(self.transport.call_args.kwargs["timeout"], 10)
        self.assertIn("service account", topics.topic_auth_status())

    def test_renews_before_expiry_and_on_forced_refresh(self):
        service_auth.get_token(self.file)
        self.credentials.expiry = datetime.now(timezone.utc) + timedelta(minutes=4)
        service_auth.get_token(self.file)
        self.assertEqual(self.credentials.refresh.call_count, 2)
        service_auth.get_token(self.file, force_refresh=True)
        self.assertEqual(self.credentials.refresh.call_count, 3)

    def test_naive_expiry_from_google_auth(self):
        service_auth.get_token(self.file)
        self.credentials.expiry = (datetime.now(timezone.utc) + timedelta(hours=1)).replace(tzinfo=None)
        service_auth.get_token(self.file)
        self.credentials.refresh.assert_called_once()

    def test_concurrent_receivers_share_one_refresh(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: service_auth.get_token(self.file), range(12)))
        self.assertEqual(results, ["fresh-access-token"] * 12)
        self.credentials.refresh.assert_called_once()

    def test_changed_key_file_reloads_credentials(self):
        service_auth.get_token(self.file)
        self.info["private_key_id"] = "rotated-key-id"
        self.file.write_text(json.dumps(self.info))
        service_auth.get_token(self.file)
        self.assertEqual(self.factory.call_count, 2)

    def test_other_credential_file_inside_repository_rejected(self):
        with self.assertRaisesRegex(service_auth.CredentialError, "project root"):
            service_auth.get_token(service_auth.ROOT / "private-service-account.json")
        self.factory.assert_not_called()

    def test_approved_root_filename_allowed(self):
        # Use only a fake key in a temporary faux repository, never a real key.
        with patch.object(service_auth, "ROOT", self.file.parent):
            self.file.rename(self.file.parent / "fcm-service-account.json")
            self.assertEqual(service_auth.get_token(self.file.parent / "fcm-service-account.json"), "fresh-access-token")

    def test_default_file_detected_and_explicit_configuration_wins(self):
        with patch.object(topics, "DEFAULT_SERVICE_ACCOUNT_FILE", self.file):
            with patch.dict(os.environ, {"FCM_SERVICE_ACCOUNT_FILE": "", "GOOGLE_APPLICATION_CREDENTIALS": ""}):
                self.assertEqual(topics.service_account_file(), str(self.file))
                self.assertEqual(topics.get_access_token(), "fresh-access-token")
            with patch.dict(os.environ, {"FCM_SERVICE_ACCOUNT_FILE": "explicit-path"}):
                self.assertEqual(topics.service_account_file(), "explicit-path")

    def test_invalid_file_and_missing_file_are_sanitized(self):
        for contents in ["PRIVATE-BAD-JSON", "[]", '{"type":"authorized_user"}', '{"type":"service_account"}']:
            self.file.write_text(contents)
            with self.assertRaises(service_auth.CredentialError) as error:
                service_auth.get_token(self.file)
            self.assertNotIn("PRIVATE", str(error.exception))
        with self.assertRaisesRegex(service_auth.CredentialError, "Cannot read"):
            service_auth.get_token(self.file.parent / "missing.json")

    def test_bad_key_or_missing_library_is_actionable(self):
        self.factory.side_effect = ValueError("FAKE-PRIVATE-KEY")
        with self.assertRaises(service_auth.CredentialError) as error:
            service_auth.get_token(self.file)
        self.assertNotIn("FAKE-PRIVATE-KEY", str(error.exception))
        self.factory.side_effect = ImportError("not installed")
        with self.assertRaisesRegex(service_auth.CredentialError, "requirements-service-account"):
            service_auth.get_token(self.file)

    def test_refresh_failure_never_returns_old_token_or_secrets(self):
        service_auth.get_token(self.file)
        self.credentials.refresh.side_effect = RuntimeError("FAKE-PRIVATE-KEY private-account-info")
        with self.assertRaises(service_auth.CredentialError) as error:
            service_auth.get_token(self.file, force_refresh=True)
        self.assertIsNone(self.credentials.token)
        self.assertNotIn("private-account", str(error.exception))
        self.assertNotIn("FAKE-PRIVATE-KEY", str(error.exception))

    def test_auth_selection_manual_then_service_account_without_gcloud(self):
        with patch.object(topics.shutil, "which", side_effect=AssertionError("gcloud must not be used")):
            self.assertEqual(topics.get_access_token(), "fresh-access-token")
            with patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "manual-token"}):
                self.assertEqual(topics.get_access_token(), "manual-token")
            with patch.dict(os.environ, {"FCM_SERVICE_ACCOUNT_FILE": "", "GOOGLE_APPLICATION_CREDENTIALS": str(self.file)}):
                self.assertEqual(topics.get_access_token(), "fresh-access-token")

    @patch.object(topics, "build_opener")
    def test_firebase_401_forces_one_refresh_and_retry(self, opener):
        from urllib.error import HTTPError
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"{}"
        opener.return_value.open.side_effect = [HTTPError("hidden", 401, "unauthorized", {}, None), response]
        self.assertEqual(topics.topic_request("subscribe", "registration-token", "demo"), {})
        self.assertEqual(self.credentials.refresh.call_count, 2)
        self.assertEqual(opener.return_value.open.call_count, 2)

    @patch.object(topics, "build_opener")
    def test_firebase_auth_retry_is_bounded(self, opener):
        from urllib.error import HTTPError
        opener.return_value.open.side_effect = HTTPError("hidden", 401, "unauthorized", {}, None)
        with self.assertRaises(topics.TopicError):
            topics.topic_request("list", "registration-token")
        self.assertEqual(opener.return_value.open.call_count, 2)


if __name__ == "__main__":
    unittest.main()
