"""Loopback static server with an optional server-side FCM topic helper."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import socket
from threading import Event, Thread
from urllib.parse import urlsplit
from topics import TopicError, handle_topic_request, topic_auth_status

ROOT = Path(__file__).resolve().parent
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/firebase-config.js": ("firebase-config.js", "text/javascript; charset=utf-8"),
    "/firebase-messaging-sw.js": ("firebase-messaging-sw.js", "text/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in {"/api/topics/list", "/api/topics/subscribe", "/api/topics/unsubscribe"}:
            self.send_error(404)
            return
        try:
            result = handle_topic_request(self)
            status = 200
        except TopicError as error:
            result, status = {"error": str(error)}, error.status
        content = json.dumps(result).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_HEAD(self):
        self.respond(False)

    def do_GET(self):
        self.respond(True)

    def respond(self, body):
        entry = FILES.get(urlsplit(self.path).path)
        if not entry:
            self.send_error(404)
            return
        content = (ROOT / entry[0]).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", entry[1])
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if body:
            self.wfile.write(content)


class LoopbackServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        # Windows SO_REUSEADDR can let another process share a listening port.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    servers = []
    try:
        # Bind all ports before starting: fail cleanly if one is occupied.
        for port in range(8080, 8085):
            server = LoopbackServer(("127.0.0.1", port), Handler)
            servers.append(server)
        for server in servers:
            Thread(target=server.serve_forever, daemon=True).start()
        print("Dashboard: http://localhost:8080", flush=True)
        print("Receivers: http://localhost:8081 through :8084 (Ctrl+C to stop)", flush=True)
        print("Topic helper: " + topic_auth_status(), flush=True)
        Event().wait()
    except KeyboardInterrupt:
        print("\nStopping servers.")
    finally:
        for server in servers:
            server.server_close()


if __name__ == "__main__":
    main()
