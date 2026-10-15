"""Verify correlated JSON logs, payload redaction, levels and stderr backpressure."""
import argparse
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from embedded_smoke import Fixture
from smoke import Mcp, reference
from unified_smoke import Runtime

SECRET = 'synthetic-log-secret-do-not-record'


def records(lines):
    return [json.loads(line) for line in lines if line.startswith('{') and json.loads(line).get('schemaVersion') == 1]


def wait_trace(runtime, trace, expected):
    for _ in range(100):
        events = [event for event in records(runtime.logs) if event['traceId'] == trace]
        if expected <= {event['component'] for event in events if event['event'] == 'operation_finished'}:
            return events
        time.sleep(.01)
    raise AssertionError('Missing correlated operation logs: ' + str(expected))


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    try:
        with tempfile.TemporaryDirectory(prefix='servo-logging-') as directory:
            runtime = Runtime(binary, pathlib.Path(directory), env={**os.environ, 'SERVO_LOG_LEVEL': 'debug'})
            client = runtime.client
            try:
                tab = client.call('browser_tabs', {'action': 'list'})['tabs'][0]['id']
                result = client.request('tools/call', {'name': 'browser_navigate', 'arguments': {'tabId': tab, 'url': origin + '/?credential=' + SECRET}})
                trace = result['_meta']['traceId']
                uuid.UUID(trace)
                events = wait_trace(runtime, trace, {'mcp', 'native', 'engine'})
                finished = [event for event in events if event['event'] == 'operation_finished']
                assert all(event['outcome'] == 'ok' and event['elapsedMs'] >= 0 for event in finished)
                peers = [event for event in finished if event['component'] in ('native', 'engine')]
                assert peers[0]['requestId'] == peers[1]['requestId']
                assert peers[0]['profileKey'] == peers[1]['profileKey']
                assert peers[0]['tabKey'] == peers[1]['tabKey']
                snapshot = client.call('browser_snapshot', {'tabId': tab})
                client.call('browser_fill', {'tabId': tab, 'reference': reference(snapshot, 'Email'), 'text': SECRET})
                client.call('browser_evaluate', {'tabId': tab, 'script': "document.title='" + SECRET + "';document.cookie='credential=" + SECRET + "';return true;"})
                lease = client.call('browser_tabs', {'action': 'reserve','agentName':'Test agent', 'tabId': tab, 'task': SECRET})['leaseId']
                request = urllib.request.Request(runtime.dashboard.origin + '/api/action', data=json.dumps({'profileId': 'default', 'op': 'navigate', 'tabId': tab, 'args': {'url': origin}}).encode(), headers={'Authorization': 'Bearer ' + runtime.dashboard.token, 'Content-Type': 'application/json'})
                try:
                    urllib.request.urlopen(request, timeout=20)
                    raise AssertionError('Reserved human navigation succeeded')
                except urllib.error.HTTPError as error:
                    assert error.code == 409
                    trace = error.headers['X-Request-Id']
                rejected=wait_trace(runtime, trace, {'dashboard', 'native', 'engine'})
                assert next(event for event in rejected if event['component']=='dashboard' and event['event']=='operation_finished')['httpStatus']==409
                runtime.stop()
                text = json.dumps(records(runtime.logs))
                for private in (SECRET, lease, runtime.dashboard.token, origin, tab):
                    assert private not in text, 'Structured logs exposed a private payload or raw identifier'
            finally:
                if runtime.process.poll() is None:
                    runtime.stop()
        with tempfile.TemporaryDirectory(prefix='servo-log-level-') as directory:
            runtime = Runtime(binary, pathlib.Path(directory), env={**os.environ, 'SERVO_LOG_LEVEL': 'info'})
            runtime.client.call('browser_tabs', {'action': 'list'})
            runtime.stop()
            assert not any(event['level'] == 'debug' for event in records(runtime.logs))
        print('PASS: MCP/dashboard/native/engine traces, outcomes, elapsed times, opaque identifiers, payload redaction and log levels')
    finally:
        server.shutdown()
        server.server_close()


def backpressure(binary):
    with tempfile.TemporaryDirectory(prefix='servo-log-pressure-') as directory:
        process = subprocess.Popen([str(binary), '--profile-root', directory], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, 'SERVO_LOG_LEVEL': 'debug'})
        client = Mcp(process)
        lines = []
        try:
            client.request('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'log-pressure', 'version': '1'}})
            client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            # Do not drain stderr: a synchronous sink would block the browser here.
            for _ in range(1500):
                assert client.call('browser_tabs', {'action': 'list'})['tabs']
            reader = threading.Thread(target=lambda: lines.extend(process.stderr), daemon=True)
            reader.start()
            assert client.call('browser_tabs', {'action': 'list'})['tabs']
            process.stdin.close()
            process.wait(timeout=10)
            reader.join(timeout=3)
            assert process.returncode == 0
            assert any(event['droppedEvents'] > 0 for event in records(lines))
            print('PASS: 1500 operations finish with blocked stderr; dropped log events are counted')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    args = parser.parse_args()
    exercise(args.engine_binary.resolve())
    backpressure(args.engine_binary.resolve())
