"""Shared harness: a disposable local fixture, an MCP client, and element lookup."""

import http.server
import json
import queue
import threading


PAGE = b"""<!doctype html><html><head><title>Browser fixture</title>
<style>body{font:18px sans-serif;background:white;padding:24px}label,input,button{display:block;margin:12px} .hidden{display:none} .spacer{height:1600px}</style></head>
<body><h1>Shared login fixture</h1>
<form id="login"><label for="email">Email</label><input id="email" type="email">
<label for="password">Password</label><input id="password" type="password">
<button id="submit" type="submit">Sign in</button></form>
<button class="hidden">Hidden action</button><button id="replace">Replace me</button>
<p id="events"></p><div class="spacer"></div><p>End of fixture</p>
<script>
document.getElementById('email').addEventListener('input',()=>{document.getElementById('events').textContent='Native input received';});
document.getElementById('replace').addEventListener('click',event=>{event.currentTarget.outerHTML='<button id=replace>Replacement</button>';});
document.getElementById('login').addEventListener('submit',event=>{event.preventDefault();document.cookie='fixture_session=synthetic; path=/';location.href='/welcome';});
</script></body></html>"""
WELCOME = b"""<!doctype html><html><head><title>Welcome</title></head><body><h1>Signed in</h1><a href="/">Return</a></body></html>"""


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = WELCOME if self.path == "/welcome" else PAGE
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Mcp:
    """The stdio MCP client the host serves, with one request in flight at a time."""

    def __init__(self, process):
        self.process = process
        self.sequence = 0
        self.messages = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                self.messages.put({"invalid_stdout": line})
        self.messages.put({"eof": True})

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        identifier = self.sequence
        self.send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        while True:
            result = self.messages.get(timeout=35)
            assert "eof" not in result and "invalid_stdout" not in result, result
            if result.get("id") == identifier:
                assert "error" not in result, result
                return result["result"]

    def call(self, name, arguments, expect_error=False):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        assert bool(result.get("isError")) == expect_error, result
        if expect_error:
            return result
        if "structuredContent" in result:
            return result["structuredContent"]
        return result


def reference(snapshot, name):
    """The one element of a snapshot with this accessible name."""
    matches = [
        element["reference"] for element in snapshot["elements"] if element["name"] == name
    ]
    assert len(matches) == 1, (name, snapshot)
    return matches[0]
