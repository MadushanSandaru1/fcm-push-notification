"""No live credentials or Firebase traffic: test the topic boundary with mocks."""
import io
import json
import os
import subprocess
from email.message import Message
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

import serve
import topics


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        default_file = patch.object(topics, "DEFAULT_SERVICE_ACCOUNT_FILE", SimpleNamespace(is_file=lambda: False))
        default_file.start()
        self.addCleanup(default_file.stop)
        environment = patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "", "FCM_SERVICE_ACCOUNT_FILE": "", "GOOGLE_APPLICATION_CREDENTIALS": ""})
        environment.start()
        self.addCleanup(environment.stop)
        executable = patch.object(topics.shutil, "which", return_value="/fake/google-cloud/gcloud")
        executable.start()
        self.addCleanup(executable.stop)
        self.runner = patch.object(topics.subprocess, "run")
        self.run = self.runner.start()
        self.addCleanup(self.runner.stop)

    def test_gets_current_token_each_time_without_interactive_login(self):
        self.run.side_effect = [SimpleNamespace(returncode=0, stdout="first-token\n", stderr=""),
                                SimpleNamespace(returncode=0, stdout="refreshed-token\n", stderr="")]
        self.assertEqual(topics.get_access_token(), "first-token")
        self.assertEqual(topics.get_access_token(), "refreshed-token")
        self.assertEqual(self.run.call_count, 2)
        command = self.run.call_args.args[0]
        self.assertEqual(command, ["/fake/google-cloud/gcloud", "auth", "print-access-token", "--quiet", "--verbosity=error"])
        options = self.run.call_args.kwargs
        self.assertFalse(options["shell"])
        self.assertTrue(options["capture_output"])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["env"]["CLOUDSDK_CORE_DISABLE_PROMPTS"], "1")
        self.assertEqual(options["env"]["CLOUDSDK_CORE_LOG_HTTP"], "false")
        if os.name == "nt":
            self.assertEqual(options["creationflags"], subprocess.CREATE_NO_WINDOW)

    def test_manual_override_never_launches_cli(self):
        with patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "manual-token"}):
            self.assertEqual(topics.get_access_token(), "manual-token")
            self.assertIn("manual", topics.topic_auth_status())
        self.run.assert_not_called()

    def test_missing_cli_is_actionable(self):
        with patch.object(topics.shutil, "which", return_value=None):
            with self.assertRaisesRegex(topics.TopicError, "installed locally"):
                topics.get_access_token()
            self.assertIn("not configured", topics.topic_auth_status())
        self.run.assert_not_called()

    def test_cli_failure_and_malformed_output_do_not_leak(self):
        for code, output in [(1, "private-secret"), (0, ""), (0, "private-secret\nextra-output")]:
            self.run.return_value = SimpleNamespace(returncode=code, stdout=output, stderr="private-account-detail")
            with self.assertRaises(topics.TopicError) as result:
                topics.get_access_token()
            self.assertEqual(result.exception.status, 503)
            self.assertIn("gcloud auth login", str(result.exception))
            self.assertNotIn("private-", str(result.exception))

    def test_cli_timeout_and_execution_error(self):
        for error in [subprocess.TimeoutExpired("private-command", 15, output="private-secret"), FileNotFoundError("private-path")]:
            self.run.side_effect = error
            with self.assertRaises(topics.TopicError) as result:
                topics.get_access_token()
            self.assertNotIn("private-", str(result.exception))
            self.assertEqual(result.exception.status, 503)

    def test_invalid_manual_token_does_not_launch_cli(self):
        with patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "invalid token"}):
            with self.assertRaisesRegex(topics.TopicError, "whitespace"):
                topics.get_access_token()
        self.run.assert_not_called()

    @patch.object(topics, "build_opener")
    def test_firebase_request_uses_auto_token(self, opener):
        self.run.return_value = SimpleNamespace(returncode=0, stdout="auto-token\n", stderr="")
        client = opener.return_value
        client.open.return_value.__enter__.return_value.read.return_value = b"{}"
        topics.topic_request("list", "registration-token")
        request = client.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer auto-token")
        self.assertIn("automatic", topics.topic_auth_status())


class FirebaseTests(unittest.TestCase):
    def setUp(self):
        default_file = patch.object(topics, "DEFAULT_SERVICE_ACCOUNT_FILE", SimpleNamespace(is_file=lambda: False))
        default_file.start()
        self.addCleanup(default_file.stop)
        self.env = patch.dict(os.environ, {"FCM_ACCESS_TOKEN": "fake-server-credential", "FCM_SERVICE_ACCOUNT_FILE": "", "GOOGLE_APPLICATION_CREDENTIALS": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.opener = MagicMock()
        self.opener.open.return_value.__enter__.return_value.read.return_value = b"{}"
        self.mock = patch.object(topics, "build_opener", return_value=self.opener)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def test_methods_fixed_destination_and_encoding(self):
        for action, method in [("list", "GET"), ("subscribe", "POST"), ("unsubscribe", "DELETE")]:
            topics.topic_request(action, "test:token/segment", "general_announcements")
            request = self.opener.open.call_args.args[0]
            self.assertEqual(request.method, method)
            self.assertTrue(request.full_url.startswith("https://fcm.googleapis.com/v1/projects/fcm-push-notification-f55e4/registrations/test%3Atoken%2Fsegment/topicSubscriptions"))
            self.assertEqual(request.get_header("Authorization"), "Bearer fake-server-credential")
            self.assertNotIn("fake-server-credential", request.full_url)
        self.assertTrue(request.full_url.endswith("/general_announcements"))

    def test_invalid_input_does_not_call_firebase(self):
        for action, token, topic in [("subscribe", "token", "../bad"), ("subscribe", "token", ""), ("subscribe", "token", "x" * 901), ("list", "bad token", ""), ("list", None, ""), ("send", "token", "test")]:
            with self.assertRaises(topics.TopicError):
                topics.topic_request(action, token, topic)
        self.opener.open.assert_not_called()

    def test_missing_credentials(self):
        with patch.dict(os.environ, {"FCM_ACCESS_TOKEN": ""}), patch.object(topics.shutil, "which", return_value=None):
            with self.assertRaises(topics.TopicError) as result:
                topics.topic_request("list", "token")
        self.assertEqual(result.exception.status, 503)
        self.opener.open.assert_not_called()

    def test_already_subscribed_is_success(self):
        self.opener.open.side_effect = HTTPError("hidden", 409, "conflict", {}, None)
        self.assertEqual(topics.topic_request("subscribe", "token", "demo"), {})

    def test_upstream_errors_are_sanitized(self):
        for code in [400, 401, 403, 404, 429, 500, 503]:
            self.opener.open.side_effect = HTTPError("private-token-url", code, "private-error", {}, None)
            with self.assertRaises(topics.TopicError) as result:
                topics.topic_request("unsubscribe", "token", "demo")
            message = str(result.exception)
            self.assertNotIn("private-", message)
            self.assertNotIn("fake-server-credential", message)
            self.assertEqual(result.exception.status, 502)
        self.opener.open.side_effect = URLError("private-url")
        with self.assertRaisesRegex(topics.TopicError, "Cannot reach Firebase"):
            topics.topic_request("list", "token")

    def test_malformed_provider_response(self):
        for response in [b"not json", b"[]"]:
            self.opener.open.return_value.__enter__.return_value.read.return_value = response
            with self.assertRaises(topics.TopicError):
                topics.topic_request("list", "token")


class BoundaryTests(unittest.TestCase):
    def handler(self, data=None, origin="http://localhost:8081", host="localhost:8081", port=8081, path="/api/topics/list", raw=None):
        body = json.dumps(data if data is not None else {"token": "fake-token"}).encode() if raw is None else raw
        headers = Message()
        for name, value in [("Origin", origin), ("Host", host), ("Content-Type", "application/json"), ("Content-Length", str(len(body)))]:
            headers[name] = value
        return SimpleNamespace(server=SimpleNamespace(server_port=port), headers=headers, path=path,
                               rfile=io.BytesIO(body), connection=MagicMock())

    @patch.object(topics, "topic_request")
    def test_exact_origin_host_and_receiver_only(self, upstream):
        for args in [{"origin": "https://evil.example"}, {"origin": "http://localhost:8082"}, {"host": "evil.example:8081"}, {"origin": "null"}, {"port": 8080}]:
            with self.assertRaises(topics.TopicError) as result:
                topics.handle_topic_request(self.handler(**args))
            self.assertEqual(result.exception.status, 403)
        upstream.assert_not_called()

    @patch.object(topics, "topic_request")
    def test_input_restrictions(self, upstream):
        for args in [{"raw": b"{"}, {"raw": b"[]"}, {"raw": b"x" * 17000}, {"data": {"token": "x", "oauthToken": "must-not-be-accepted"}}, {"path": "/api/send"}]:
            with self.assertRaises(topics.TopicError):
                topics.handle_topic_request(self.handler(**args))
        handler = self.handler()
        handler.headers.replace_header("Content-Type", "text/plain")
        with self.assertRaises(topics.TopicError):
            topics.handle_topic_request(handler)
        upstream.assert_not_called()

    @patch.object(topics, "topic_request", return_value={"topic_subscriptions": [{"topic_name": "z"}, {"topic_name": "a"}, {"topic_name": "a"}]})
    def test_list_normalization(self, upstream):
        self.assertEqual(topics.handle_topic_request(self.handler()), {"topics": ["a", "z"]})
        upstream.return_value = {"topicSubscriptions": [{"topicName": "general_announcements", "createTime": "2026-11-25T00:00:00Z"}]}
        self.assertEqual(topics.handle_topic_request(self.handler()), {"topics": ["general_announcements"]})
        upstream.return_value = {"topic_subscriptions": ["invalid"]}
        with self.assertRaises(topics.TopicError):
            topics.handle_topic_request(self.handler())


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class QuietHandler(serve.Handler):
            def log_message(self, *args):
                pass
        # Ephemeral loopback port avoids disturbing a user's running demo.
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_port
        # Model a receiver's logical origin while keeping the test socket isolated.
        cls.server.server_port = 8081
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, method="GET", data=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=data, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_static_routes_and_private_files(self):
        for path, mime in [("/", "text/html"), ("/index.html", "text/html"), ("/app.js", "text/javascript"), ("/firebase-config.js", "text/javascript"), ("/style.css", "text/css"), ("/firebase-messaging-sw.js", "text/javascript")]:
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertTrue(headers["Content-Type"].startswith(mime))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(len(body), int(headers["Content-Length"]))
        for path in ["/.git/config", "/fcm-service-account.json", "/fcm-service-account.json?download=1", "/topics.py", "/service_auth.py", "/serve.py", "/tests/test_topics.py", "/.venv/pyvenv.cfg", "/../LICENSE"]:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request("/firebase-messaging-sw.js", "HEAD")[2], b"")

    def test_no_local_sender_or_oauth_token_endpoint(self):
        for path in ["/api/push/send", "/api/send", "/api/token", "/api/auth/token"]:
            self.assertEqual(self.request(path, "POST", "{}")[0], 404)
            self.assertEqual(self.request(path)[0], 404)

    @patch.object(topics, "topic_request", return_value={"topic_subscriptions": [{"topic_name": "demo"}]})
    def test_real_http_topic_boundary(self, upstream):
        headers = {"Host": "localhost:8081", "Origin": "http://localhost:8081", "Content-Type": "application/json"}
        status, response_headers, body = self.request("/api/topics/list", "POST", '{"token":"fake"}', headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"topics": ["demo"]})
        self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        headers["Origin"] = "http://evil.example"
        self.assertEqual(self.request("/api/topics/subscribe", "POST", '{"token":"fake","topic":"demo"}', headers)[0], 403)
        self.assertEqual(upstream.call_count, 1)


if __name__ == "__main__":
    unittest.main()
