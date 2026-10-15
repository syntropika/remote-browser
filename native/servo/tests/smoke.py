"""Exercise real Servo through the MCP executable against a disposable local fixture."""

import argparse
import base64
import http.server
import json
import os
import pathlib
import queue
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


PAGE = b"""<!doctype html><html><head><title>Servo fixture</title>
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
    matches = [
        element["reference"]
        for element in snapshot["elements"]
        if element["name"] == name
    ]
    assert len(matches) == 1, (name, snapshot)
    return matches[0]


def exercise(client, origin):
    client.request("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "servo-smoke", "version": "1"},
    })
    client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    tools = client.request("tools/list", {})["tools"]
    assert len(tools) == 12
    assert not client.call("browser_status", {})["uncertain"]
    tabs = client.call("browser_tabs", {"action": "list"})["tabs"]
    tab = next(item["id"] for item in tabs if item["active"])
    client.call("browser_tabs", {"action": "close", "tabId": tab}, expect_error=True)
    client.call("browser_navigate", {"tabId": tab, "url": "javascript:alert(1)"}, expect_error=True)
    client.call("browser_navigate", {"tabId": tab, "url": origin})
    page = client.call("browser_snapshot", {"tabId": tab})
    assert page["title"] == "Servo fixture", page
    assert not any(item["name"] == "Hidden action" for item in page["elements"])
    email = reference(page, "Email")
    password = reference(page, "Password")
    client.call("browser_fill", {"tabId": tab, "reference": email, "text": "synthetic@example.test"})
    client.call("browser_fill", {"tabId": tab, "reference": password, "text": "synthetic-only-password"})
    client.call("browser_press", {"tabId": tab, "reference": email, "key": "Tab"})
    page = client.call("browser_snapshot", {"tabId": tab})
    assert "Native input received" in page["text"], page
    assert "synthetic-only-password" not in json.dumps(page)
    assert "synthetic@example.test" not in json.dumps(page)
    client.call("browser_fill", {"tabId": tab, "reference": email, "text": "stale"}, expect_error=True)
    old_button = reference(page, "Replace me")
    client.call("browser_click", {"tabId": tab, "reference": old_button})
    client.call("browser_click", {"tabId": tab, "reference": old_button}, expect_error=True)
    result = client.call("browser_screenshot", {"tabId": tab})
    png = next(item for item in result["content"] if item["type"] == "image")
    data = base64.b64decode(png["data"])
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    width, height = struct.unpack(">II", data[16:24])
    assert width > 0 and height > 0
    client.call("browser_scroll", {"tabId": tab, "y": 300})
    client.call("browser_scroll", {"tabId": tab, "y": -300})
    page = client.call("browser_snapshot", {"tabId": tab})
    client.call("browser_click", {"tabId": tab, "reference": reference(page, "Sign in")})
    for _ in range(10):
        page = client.call("browser_snapshot", {"tabId": tab})
        if page["title"] == "Welcome":
            break
    assert page["title"] == "Welcome" and "Signed in" in page["text"], page
    cookie = client.call("browser_evaluate", {"tabId": tab, "script": "return document.cookie;"})["value"]
    assert "fixture_session=synthetic" in cookie
    owned = client.call("browser_tabs", {"action": "open"})["tabId"]
    assert client.call("browser_snapshot", {"tabId": tab})["title"] == "Welcome"
    client.call("browser_navigate", {"tabId": owned, "url": origin + "/welcome"})
    assert "fixture_session=synthetic" in client.call("browser_evaluate", {"tabId": owned, "script": "return document.cookie;"})["value"]
    second = client.call("browser_tabs", {"action": "open"})["tabId"]
    lease_a = client.call("browser_tabs", {"action": "reserve", "tabId": owned, "task": "task a"})
    lease_b = client.call("browser_tabs", {"action": "reserve", "tabId": second, "task": "task b"})
    a = {"tabId": owned, "leaseId": lease_a["leaseId"]}
    b = {"tabId": second, "leaseId": lease_b["leaseId"]}
    listing = client.call("browser_tabs", {"action": "list"})["tabs"]
    assert lease_a["leaseId"] not in json.dumps(listing)
    assert lease_b["leaseId"] not in json.dumps(listing)
    assert next(item for item in listing if item["id"] == owned)["reservation"]["task"] == "task a"
    client.call("browser_tabs", {"action": "reserve", "tabId": owned, "task": "intruder"}, expect_error=True)
    client.call("browser_snapshot", {"tabId": owned}, expect_error=True)
    client.call("browser_snapshot", {"tabId": owned, "leaseId": lease_b["leaseId"]}, expect_error=True)
    client.call("browser_tabs", {"action": "select", "tabId": owned}, expect_error=True)
    client.call("browser_tabs", {"action": "close", "tabId": owned}, expect_error=True)
    client.call("browser_tabs", {"action": "renew", "tabId": owned, "leaseId": lease_b["leaseId"]}, expect_error=True)
    for target in (a, b):
        client.call("browser_navigate", dict(target, url=origin))
    page_a = client.call("browser_snapshot", a)
    page_b = client.call("browser_snapshot", b)
    email_a = reference(page_a, "Email")
    email_b = reference(page_b, "Email")
    # Alternating tabs preserves each tab's native references and form values.
    client.call("browser_fill", dict(a, reference=email_a, text="task-a@example.test"))
    client.call("browser_fill", dict(b, reference=email_b, text="task-b@example.test"))
    client.call("browser_fill", dict(a, reference=email_b, text="wrong tab"), expect_error=True)
    for target, expected in ((b, "task-b@example.test"), (a, "task-a@example.test")):
        actual = client.call("browser_evaluate", dict(target, script="return document.querySelector('input').value;"))["value"]
        assert actual == expected, (actual, expected)
    renewed = client.call("browser_tabs", dict(a, action="renew", ttlMs=10000))
    assert renewed["leaseId"] == lease_a["leaseId"] and renewed["ttlMs"] == 10000
    client.call("browser_tabs", dict(a, action="release"))
    client.call("browser_snapshot", a, expect_error=True)
    client.call("browser_snapshot", {"tabId": owned})
    client.call("browser_tabs", dict(b, action="close"))
    # Closing the selected tab must not prevent automatic selection of a survivor.
    assert client.call("browser_snapshot", {"tabId": tab})["title"] == "Welcome"
    client.call("browser_tabs", {"action": "close", "tabId": owned})
    client.call("browser_tabs", {"action": "select", "tabId": tab})
    assert not client.call("browser_status", {})["uncertain"]
    print("PASS: real Servo, MCP negotiation/catalog, navigation, native input, "
          "hidden elements, value omission, expired/replaced references, "
          "rendered PNG, scrolling, synthetic login, shared tab cookies "
          "and owned-tab cleanup, task reservations, automatic targeting, "
          "per-tab references, independent forms, lease renewal and release")


def status(port):
    with urllib.request.urlopen(
        "http://127.0.0.1:" + str(port) + "/status", timeout=2
    ) as response:
        return json.load(response)["value"]


def start_mcp(binary, port, log):
    return subprocess.Popen(
        [str(binary.resolve()), "--webdriver-url", "http://127.0.0.1:" + str(port)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=log,
        text=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-binary", required=True, type=pathlib.Path)
    parser.add_argument("--servo-binary", required=True, type=pathlib.Path)
    args = parser.parse_args()
    fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="servo-smoke-") as temporary:
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            with open(pathlib.Path(temporary) / "stderr.log", "w+") as log:
                servo = subprocess.Popen([
                    str(args.servo_binary.resolve()),
                    "--webdriver=" + str(port),
                    "--config-dir=" + str(pathlib.Path(temporary) / "profile"),
                    "--temporary-storage", "--headless",
                    "--screen-size=1024x768", "about:blank",
                ], stdout=log, stderr=log)
                process = None
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        assert servo.poll() is None, "Servo exited during startup"
                        try:
                            assert status(port)["ready"]
                            break
                        except urllib.error.URLError:
                            assert time.monotonic() < deadline, "Servo did not start"
                            time.sleep(0.1)
                    process = start_mcp(args.mcp_binary, port, log)
                    exercise(Mcp(process), "http://127.0.0.1:" + str(fixture.server_port))
                    process.stdin.close()
                    assert process.wait(timeout=10) == 0
                    assert servo.poll() is None, "The external browser must remain running"
                    assert status(port)["ready"], "Automation session was not deleted"
                    if os.name == "posix":
                        # Shutdown before initialize must still release the allocated session.
                        process = start_mcp(args.mcp_binary, port, log)
                        deadline = time.monotonic() + 10
                        while status(port)["ready"]:
                            assert process.poll() is None
                            assert time.monotonic() < deadline
                            time.sleep(0.05)
                        process.terminate()
                        assert process.wait(timeout=10) == 0
                        assert status(port)["ready"], "SIGTERM did not delete the session"
                    print("PASS: EOF and SIGTERM release the session and leave Servo running")
                except Exception:
                    log.seek(0)
                    print(log.read()[-4000:])
                    raise
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    servo.terminate()
                    try:
                        servo.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        servo.kill()
                        servo.wait()
    finally:
        fixture.shutdown()
        fixture.server_close()


if __name__ == "__main__":
    main()
