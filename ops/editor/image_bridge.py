"""Private, no-retry Anthropic image compatibility bridge for 9Router 0.5.30.

Only lift images from tool_result to a following user message. Never log bodies,
credentials, request headers, or upstream exception text. No provider fallback.
"""
import base64
import copy
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import socket
import threading
from urllib.parse import urlsplit

ORIGIN = "https://router.yundongyl.cn"
MODEL = "ezr/claude-opus-5-5"
PATHS = {"/v1/messages", "/v1/messages/count_tokens"}
MAX_BODY = 32 * 1024 * 1024
MAX_IMAGE = 8 * 1024 * 1024
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade", "content-length"}


def lift_images(body):
    """Copy-on-write; preserve all tool IDs, errors, text, and existing top-level images.

    Emit images after the complete tool-result message, not between parallel tool
    responses. Tags retain their source tool association without encoding image bytes.
    """
    if not isinstance(body, dict) or body.get("model") != MODEL:
        raise ValueError("invalid request model")
    if not isinstance(body.get("messages"), list):
        raise ValueError("invalid messages")
    result = dict(body); messages = []; count = 0
    for message in body["messages"]:
        if not isinstance(message, dict): raise ValueError("invalid message")
        content = message.get("content")
        if message.get("role") != "user" or not isinstance(content, list):
            messages.append(message); continue
        replacement = []; lifted = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result" or not isinstance(block.get("content"), list):
                replacement.append(block); continue
            remaining = []; images = []
            for part in block["content"]:
                if not isinstance(part, dict) or part.get("type") != "image":
                    remaining.append(part); continue
                source = part.get("source", {})
                if not isinstance(source, dict) or source.get("type") != "base64" or source.get("media_type") not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
                    raise ValueError("unsupported tool image")
                data = source.get("data")
                if not isinstance(data, str) or not data or len(data) > ((MAX_IMAGE + 2) // 3) * 4:
                    raise ValueError("invalid image size")
                if len(base64.b64decode(data, validate=True)) > MAX_IMAGE:
                    raise ValueError("invalid image size")
                images.append(part)
            if not images:
                replacement.append(block); continue
            tid = block.get("tool_use_id")
            if not isinstance(tid, str) or not tid or len(tid) > 256:
                raise ValueError("invalid tool association")
            tag = {"type": "text", "text": f"[Image from tool result {tid}; original image follows.]"}
            replacement.append(dict(block, content=remaining or [tag]))
            lifted.extend([tag, *images]); count += len(images)
        messages.append(dict(message, content=replacement) if lifted else message)
        if lifted: messages.append({"role": "user", "content": lifted})
    result["messages"] = messages
    return result, count


class ImageBridge:
    """One attempt, one loopback listener, fixed TLS upstream; no retries or redirects."""
    def __init__(self, origin, key):
        if origin != ORIGIN or not isinstance(key, str) or not key:
            raise ValueError("unsupported bridge origin or credential")
        self.key = key; self.token = secrets.token_urlsafe(48)
        self.stats = {"schema": 1, "mode": "tool_result_images_to_following_user_message",
                      "forwardedRequests": 0, "liftedImages": 0, "rejectedRequests": 0,
                      "transportErrors": 0, "responseStatuses": []}
        self.guard = threading.Lock(); self.server = None; self.thread = None
        self.connections = set()

    def evidence(self):
        with self.guard: return copy.deepcopy(self.stats)

    def connection(self):
        # http.client does not follow redirects and does not retry requests.
        return http.client.HTTPSConnection("router.yundongyl.cn", 443, timeout=180)

    def __enter__(self):
        bridge = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args): pass

            def setup(self):
                super().setup(); self.connection.settimeout(30)

            def error(self, status):
                self.close_connection = True
                payload = b'{"type":"error","error":{"type":"bridge_error","message":"Private image bridge request failed; no automatic retry."}}'
                self.send_response(status); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload))); self.send_header("Connection", "close")
                self.end_headers(); self.wfile.write(payload)

            def do_POST(self):
                upstream = None; started_response = False
                try:
                    parsed = urlsplit(self.path)
                    if parsed.scheme or parsed.netloc or parsed.fragment or parsed.path not in PATHS or parsed.query not in ("", "beta=true"):
                        self.error(404); return
                    # No ambiguous auth/content length or chunked request smuggling.
                    keys = self.headers.get_all("x-api-key", [])
                    auth = self.headers.get_all("authorization", [])
                    supplied = keys + [a.removeprefix("Bearer ") for a in auth if a.startswith("Bearer ")]
                    if len(keys) > 1 or len(auth) > 1 or len(supplied) != len(keys) + len(auth) or not supplied or any(not hmac.compare_digest(x, bridge.token) for x in supplied):
                        self.error(401); return
                    lengths = self.headers.get_all("content-length", [])
                    if len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get("transfer-encoding"):
                        self.error(400); return
                    size = int(lengths[0])
                    if not 0 < size <= MAX_BODY:
                        self.error(413); return
                    if self.headers.get("content-encoding", "identity") != "identity" or self.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
                        self.error(415); return
                    raw = self.rfile.read(size)
                    if len(raw) != size: self.error(400); return
                    converted, moved = lift_images(json.loads(raw))
                    payload = json.dumps(converted, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
                    headers = {"Content-Type": "application/json", "Accept-Encoding": "identity", "x-api-key": bridge.key}
                    for name in ("anthropic-version", "anthropic-beta", "accept"):
                        if self.headers.get(name): headers[name] = self.headers[name]
                    upstream = bridge.connection()
                    with bridge.guard:
                        bridge.connections.add(upstream)
                        bridge.stats["forwardedRequests"] += 1; bridge.stats["liftedImages"] += moved
                    upstream.request("POST", self.path, body=payload, headers=headers)
                    response = upstream.getresponse()
                    with bridge.guard: bridge.stats["responseStatuses"].append(response.status)
                    if 300 <= response.status < 400:
                        self.error(502); return
                    self.send_response(response.status)
                    ignored = HOP_HEADERS | {"set-cookie", "location", "authorization", "x-api-key"}
                    ignored |= {p.strip().lower() for p in response.getheader("connection", "").split(",")}
                    for name, value in response.getheaders():
                        if name.lower() not in ignored: self.send_header(name, value)
                    self.send_header("Connection", "close"); self.end_headers(); started_response = True
                    self.close_connection = True
                    while True:
                        chunk = response.read1(65536)
                        if not chunk: break
                        self.wfile.write(chunk); self.wfile.flush()
                except (ValueError, TypeError, UnicodeError):
                    with bridge.guard: bridge.stats["rejectedRequests"] += 1
                    if not started_response: self.error(400)
                except Exception:
                    with bridge.guard: bridge.stats["transportErrors"] += 1
                    if not started_response:
                        try: self.error(502)
                        except Exception: pass
                    self.close_connection = True
                finally:
                    if upstream:
                        upstream.close()
                        with bridge.guard: bridge.connections.discard(upstream)

            def do_GET(self): self.error(405)
            def do_PUT(self): self.error(405)
            def do_DELETE(self): self.error(405)
            def do_HEAD(self): self.error(405)

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            def handle_error(self, *args): pass

        self.server = Server(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start(); return self

    def __exit__(self, *args):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        with self.guard: connections = list(self.connections)
        for connection in connections:
            try:
                if connection.sock: connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            connection.close()
        self.key = ""; self.token = ""
