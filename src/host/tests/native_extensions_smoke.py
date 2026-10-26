"""Exercise independent optional MCP and browser-login extensions with a real engine."""
import argparse
import http.cookiejar
import json
import pathlib
import queue
import signal
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request

from http_smoke import Http

INIT = {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'native-extension-test', 'version': '1'}}
LOGIN = {'username': 'test-owner', 'password': 'synthetic-browser-login-only'}


class Browser:
    def __init__(self, origin):
        self.origin = origin
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def api(self, path, body=None, expected=200, origin=True):
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = self.origin if origin is True else origin
        request = urllib.request.Request(self.origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.status == expected, (path, response.status, raw[:300])
            return json.loads(raw) if raw else {}, response.headers

    def change(self, extension, action, expected=200, **extra):
        return self.api('/api/extensions/native', {'id': extension, 'action': action, **extra}, expected)[0]


class Runtime:
    def __init__(self, host, engine, root):
        self.logs = []
        urls = queue.Queue()
        self.process = subprocess.Popen([str(host), '--profile-root', str(root), '--engine-binary', str(engine), '--dashboard-port', '0'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def read():
            for line in self.process.stderr:
                self.logs.append(line)
                if line.startswith('Remote Browser dashboard: '):
                    urls.put(line.removeprefix('Remote Browser dashboard: ').strip())

        threading.Thread(target=read, daemon=True).start()
        try:
            self.origin = urls.get(timeout=20)
        except Exception:
            self.stop()
            raise AssertionError('Dashboard did not start: ' + ''.join(self.logs[-8:]))

    def stop(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(timeout=15)
        assert self.process.returncode == 0, self.process.returncode


def run(host, engine):
    with tempfile.TemporaryDirectory(prefix='native-extensions-') as directory:
        root = pathlib.Path(directory)
        runtime = Runtime(host, engine, root)
        try:
            owner = Browser(runtime.origin)
            entries = owner.api('/api/extensions/native')[0]['extensions']
            assert {item['id'] for item in entries} == {'mcp', 'access'}
            assert all(not item['installed'] for item in entries)
            assert not (root / 'api-keys.json').exists()
            owner.api('/api/keys', expected=409)
            owner.api('/api/extensions/native', {'id': 'mcp', 'action': 'install'}, 403, origin=False)
            owner.api('/api/extensions/native', {'id': 'mcp', 'action': 'install'}, 403, origin='https://foreign.example')
            owner.change('missing', 'install', 409)
            Http(runtime.origin, 'absent').request('initialize', INIT, expected=503)
            assert owner.api('/api/profiles')[0]['profiles']

            assert owner.change('mcp', 'install')['enabled']
            key = owner.api('/api/keys', {'name': 'Test agent'}, 201)[0]
            secret = key['secret']
            agent = Http(runtime.origin, secret)
            agent.request('initialize', INIT)
            assert any(tool['name'] == 'browser_navigate' for tool in agent.request('tools/list', {})['result']['tools'])
            tab = agent.call('browser_tabs', {'action': 'open'})['tabId']
            lease = agent.call('browser_tabs', {'action': 'reserve', 'tabId': tab, 'agentName': 'Test agent', 'task': 'native extension acceptance'})['leaseId']
            assert agent.call('browser_evaluate', {'tabId': tab, 'leaseId': lease, 'script': 'return 42;'})['value'] == 42
            print('PASS: fresh browser has no MCP or keys; installing the native MCP extension enables real authenticated automation.', flush=True)

            access = owner.change('access', 'install')
            assert access['installed'] and not access['enabled']
            owner.change('access', 'enable', 409)
            configured, headers = owner.api('/api/extensions/access/configure', LOGIN)
            assert configured['enabled'] and configured['configured']
            assert 'HttpOnly' in headers['Set-Cookie'] and 'SameSite=Strict' in headers['Set-Cookie']
            stored = (root / 'access-extension.json').read_text()
            assert LOGIN['password'] not in stored and '$argon2id$' in stored
            assert (root / 'access-extension.json').stat().st_mode & 0o077 == 0
            visitor = Browser(runtime.origin)
            assert visitor.api('/api/access/status')[0]['required']
            visitor.api('/api/profiles', expected=401)
            visitor.api('/api/extensions/native', expected=401)
            visitor.api('/api/keys', expected=401)
            visitor.api('/api/access/login', LOGIN, 403, origin=False)
            visitor.api('/api/access/login', LOGIN, 403, origin='https://foreign.example')
            visitor.api('/api/access/login', {**LOGIN, 'password': 'incorrect'}, 401)
            visitor.api('/api/access/login', LOGIN)
            assert visitor.api('/api/profiles')[0]['profiles']
            visitor.api('/api/access/logout', {})
            visitor.api('/api/profiles', expected=401)
            assert agent.call('browser_profiles', {'action': 'list'})['profiles']
            owner.change('mcp', 'disable')
            agent.request('tools/list', {}, expected=503)
            assert owner.api('/api/profiles')[0]['profiles']
            assert owner.api('/api/access/status')[0]['required']
            assert owner.api('/api/keys')[0]['keys']
            print('PASS: Access protects only the browser with hashed credentials and revocable cookies; MCP remains independently authenticated and optional.', flush=True)
        finally:
            runtime.stop()
        assert secret not in ''.join(runtime.logs) and LOGIN['password'] not in ''.join(runtime.logs)

        runtime = Runtime(host, engine, root)
        try:
            owner = Browser(runtime.origin)
            owner.api('/api/profiles', expected=401)
            owner.api('/api/access/login', LOGIN)
            states = {entry['id']: entry for entry in owner.api('/api/extensions/native')[0]['extensions']}
            assert states['access']['enabled'] and not states['mcp']['enabled']
            owner.change('mcp', 'enable')
            agent = Http(runtime.origin, secret)
            agent.request('initialize', INIT)
            owner.api('/api/keys/revoke', {'id': key['key']['id']})
            agent.request('tools/list', {}, expected=401)
            owner.change('access', 'disable')
            assert Browser(runtime.origin).api('/api/profiles')[0]['profiles']
            owner.change('mcp', 'uninstall', 400)
            assert not owner.change('mcp', 'uninstall', confirmed=True)['installed']
            owner.api('/api/keys', expected=409)
            agent.request('tools/list', {}, expected=503)
            owner.change('mcp', 'install')
            agent.request('initialize', INIT, expected=401)
            owner.change('access', 'uninstall', confirmed=True)
            assert not owner.api('/api/access/status')[0]['required']
            assert not owner.change('access', 'install')['enabled']
            assert owner.api('/api/action', {'profileId': 'default', 'op': 'tabs', 'args': {}})[0]
            print('PASS: independent extension state and login persist across restart; uninstall is confirmed, key revocation survives reinstall, and the browser stays usable.', flush=True)
        finally:
            runtime.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host-binary', required=True, type=pathlib.Path)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    args = parser.parse_args()
    run(args.host_binary.resolve(), args.engine_binary.resolve())
