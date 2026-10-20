"""Distinguish a timed-out tab from a crashed native profile without logging page data."""
import argparse
import http.server
import json
import pathlib
import tempfile
import threading
import time
from unified_smoke import Runtime


class Fixture(http.server.BaseHTTPRequestHandler):
    release = threading.Event()

    def do_GET(self):
        if self.path == '/pending':
            self.release.wait(20)
        body = b'<!doctype html><title>Stable fixture</title><p>Native timeout fixture</p>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


def exercise(binary):
    Fixture.release.clear()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    try:
        with tempfile.TemporaryDirectory(prefix='browser-failure-') as directory:
            runtime = Runtime(binary, pathlib.Path(directory))
            client = runtime.client
            try:
                healthy = client.call('browser_tabs', {'action': 'list'})['tabs'][0]['id']
                client.call('browser_navigate', {'tabId': healthy, 'url': origin})
                failed = client.call('browser_tabs', {'action': 'open'})['tabId']
                result = client.call('browser_navigate', {'tabId': failed, 'url': origin + '/pending'}, expect_error=True)
                assert result['content'][0]['text'] == 'Browser completion is unknown. Restart the MCP server before further actions'
                tabs = client.call('browser_tabs', {'action': 'list'})['tabs']
                assert next(tab for tab in tabs if tab['id'] == failed)['uncertain']
                assert not next(tab for tab in tabs if tab['id'] == healthy)['uncertain']
                assert client.call('browser_evaluate', {'tabId': healthy, 'script': 'return 42;'})['value'] == 42
                for _ in range(20):
                    events = [json.loads(line) for line in runtime.logs if line.startswith('{') and json.loads(line).get('schemaVersion') == 1]
                    if any(event.get('reason') == 'operation_timeout' for event in events):
                        break
                    time.sleep(.05)
                event = next(event for event in events if event.get('reason') == 'operation_timeout')
                assert event['operation'] == 'navigate' and event['tabKey'].startswith('t-')
                assert event['traceId'] == result['_meta']['traceId']
                assert all('timestamp' in event and 'level' in event for event in events)
                assert origin not in json.dumps(events)
                print('PASS: exact completion-unknown message, per-tab containment, working peer tab and redacted timeout diagnostic')
            finally:
                Fixture.release.set()
                runtime.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    args = parser.parse_args()
    exercise(args.engine_binary.resolve())
