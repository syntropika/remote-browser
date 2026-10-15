"""Exercise genuine PST Fetch/WebIDL/network/storage against a disposable issuer."""
import argparse
import base64
import hmac
import http.server
import json
import os
import pathlib
import subprocess
import shutil
import tempfile
import threading
import time
from embedded_smoke import Engine


def exercise(binary, issuer_binary):
    issuer = subprocess.Popen([issuer_binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    public_key = bytes.fromhex(issuer.stdout.readline().strip())
    assert len(public_key) == 101
    key = os.urandom(32)
    lock = threading.Lock()
    requests = []
    records = set()
    spent_requests = []

    def crypto(command, body):
        with lock:
            issuer.stdin.write(command + ' ' + body.hex() + '\n')
            issuer.stdin.flush()
            answer = issuer.stdout.readline().strip()
        assert answer.startswith('ok '), 'Test issuer rejected cryptographic exchange'
        return bytes.fromhex(answer[3:])

    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path.startswith('/page'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                if self.path == '/page-denied':
                    self.send_header('Permissions-Policy', 'private-state-token-issuance=(), private-state-token-redemption=()')
                self.end_headers()
                self.wfile.write(b'<!doctype html><title>PST test</title><p>Disposable PST issuer</p>')
                return
            header = self.headers.get('Sec-Private-State-Token')
            version = self.headers.get('Sec-Private-State-Token-Crypto-Version')
            response = None
            status = 200
            if self.path in ['/issue', '/bad-issue', '/redirect', '/redeem', '/redeem-expired']:
                assert header and version == 'PrivateStateTokenV1VOPRF'
                body = base64.b64decode(header, validate=True)
                if self.path == '/redirect':
                    status = 302
                elif 'issue' in self.path:
                    response = crypto('issue', body)
                    if self.path == '/bad-issue':
                        response = response[:-1] + bytes([response[-1] ^ 1])
                else:
                    spent_requests.append(body)
                    data = crypto('redeem', body)
                    assert b'redeeming-origin' in data and b'redemption-timestamp' in data
                    response = hmac.digest(key, data, 'sha256') + data
                    records.add(base64.b64encode(response).decode())
            elif self.path in ['/send', '/send-failure']:
                value = self.headers.get('Sec-Redemption-Record', '')
                assert any('redemption-record="' + item + '"' in value for item in records), 'Issuer record absent'
                assert header is None
                if self.path == '/send-failure':
                    status = 418
            elif self.path == '/empty-send':
                assert not self.headers.get('Sec-Redemption-Record'), 'Record leaked across top-level origins'
            else:
                assert header is None, 'Token header leaked into ordinary request'
            self.send_response(status)
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', '*'))
            self.send_header('Access-Control-Allow-Credentials', 'true')
            # Deliberately attempt to expose protocol secrets through CORS.
            self.send_header('Access-Control-Expose-Headers', '*')
            if response is not None:
                self.send_header('Sec-Private-State-Token', base64.b64encode(response).decode())
                self.send_header('Sec-Private-State-Token-Lifetime', '0' if self.path.endswith('expired') else '600')
            if status == 302:
                self.send_header('Location', '/unexpected-redirect')
            self.end_headers()
            self.wfile.write(b'ok')

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    second_top = 'http://localhost:' + str(server.server_port)
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='servo-pst-') as root:
            root = pathlib.Path(root)
            os.environ['XDG_RUNTIME_DIR'] = str(root)
            registry = root / 'commitments.json'
            registry.write_text(json.dumps({origin: {'PrivateStateTokenV1VOPRF': {
                'batchsize': 2, 'keys': {'7': {'Y': base64.b64encode(public_key).decode(),
                    'expiry': str(int((time.time() + 3600) * 1_000_000))}}}}}))
            os.environ['SERVO_PST_KEY_COMMITMENTS'] = str(registry)

            def start(profile):
                log = open(root / (profile + '.log'), 'a')
                engine = Engine(binary, root / profile, log)
                tab = engine.call('tabs')[0]['id']
                engine.call('navigate', tab, {'url': origin + '/page'})
                return engine, tab, log

            def run(engine, tab, script):
                engine.call('evaluate', tab, {'script': "window.pstResult=null;(async()=>{" + script + "})().then(value=>window.pstResult={ok:true,value},error=>window.pstResult={ok:false,name:error.name,message:String(error)});return true;"})
                deadline = time.monotonic() + 8
                while True:
                    value = engine.call('evaluate', tab, {'script': 'return window.pstResult;'})
                    if value is not None:
                        return value
                    assert time.monotonic() < deadline, 'PST operation did not complete'
                    time.sleep(.02)

            query = 'return await document.hasPrivateToken(' + json.dumps(origin) + ');'
            query_rr = 'return await document.hasRedemptionRecord(' + json.dumps(origin) + ');'

            def fetch(path, operation, extra=''):
                return "const r=await fetch(" + json.dumps(origin + path) + ",{privateToken:{version:1,operation:" + json.dumps(operation) + extra + "}});return {status:r.status,token:r.headers.get('Sec-Private-State-Token'),lifetime:r.headers.get('Sec-Private-State-Token-Lifetime')};"

            engine, tab, log = start('profile-a')
            try:
                assert run(engine, tab, query) == {'ok': True, 'value': False}
                assert run(engine, tab, query_rr) == {'ok': True, 'value': False}
                assert run(engine, tab, fetch('/bad-issue', 'token-request'))['ok'] is False
                value = run(engine, tab, "const r=new Request('/bad-issue',{privateToken:{version:1,operation:'token-request'}});return await fetch(r.clone());")
                assert value['ok'] is False
                value = run(engine, tab, "return await document.implementation.createHTMLDocument('inactive').hasPrivateToken(location.origin);")
                assert value['ok'] is False and value['name'] == 'InvalidStateError', value
                value = run(engine, tab, "const f=document.createElement('iframe');document.body.append(f);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return await f.contentDocument.hasPrivateToken(location.origin);")
                assert value['ok'] is False and value['name'] == 'NotAllowedError', value
                assert run(engine, tab, query)['value'] is False
                value = run(engine, tab, fetch('/issue', 'token-request'))
                assert value == {'ok': True, 'value': {'status': 200, 'token': None, 'lifetime': None}}, value
                assert run(engine, tab, query)['value'] is True
                value = run(engine, tab, fetch('/redeem', 'token-redemption'))
                assert value == {'ok': True, 'value': {'status': 200, 'token': None, 'lifetime': None}}, value
                assert run(engine, tab, query_rr)['value'] is True
                value = run(engine, tab, fetch('/send', 'send-redemption-record', ',issuers:[' + json.dumps(origin) + ']'))
                assert value['ok'], value
                value = run(engine, tab, fetch('/send-failure', 'send-redemption-record', ',issuers:[' + json.dumps(origin) + ']'))
                assert value == {'ok': True, 'value': {'status': 418, 'token': None, 'lifetime': None}}, value
                count = requests.count('/redeem')
                assert run(engine, tab, fetch('/redeem', 'token-redemption'))['ok'] is False
                assert requests.count('/redeem') == count, 'Cached redemption caused another network operation'
                assert run(engine, tab, "return await document.hasPrivateToken('http://untrusted.example');")['ok'] is False
                assert run(engine, tab, "await fetch('/issue',{privateToken:{version:2,operation:'token-request'}});return true;")['ok'] is False
                engine.call('navigate', tab, {'url': origin + '/page-denied'})
                assert run(engine, tab, query)['ok'] is False
                assert run(engine, tab, fetch('/issue', 'token-request'))['ok'] is False
                engine.call('navigate', tab, {'url': second_top + '/page'})
                assert run(engine, tab, query_rr)['value'] is False
                value = run(engine, tab, fetch('/empty-send', 'send-redemption-record', ',issuers:[' + json.dumps(origin) + ']'))
                assert value['ok'], value
                engine.call('navigate', tab, {'url': origin + '/page'})
                # Redirects cannot carry or replay protocol state.
                assert run(engine, tab, fetch('/redirect', 'token-request'))['ok'] is False
                assert '/unexpected-redirect' not in requests
                diagnostics = engine.call('status')['privateStateTokens']
                assert diagnostics['enabled'] and diagnostics['apiCalls'] > 10
                assert diagnostics['successfulExchanges'] >= 4 and diagnostics['failedExchanges'] >= 3
                assert set(diagnostics) == {'enabled', 'apiCalls', 'fetchOperations', 'successfulExchanges', 'failedExchanges'}
            finally:
                engine.stop()
                log.close()
            shutil.copytree(root / 'profile-a/private-state-tokens', root / 'profile-saved/private-state-tokens')
            engine, tab, log = start('profile-b')
            try:
                assert run(engine, tab, query)['value'] is False
                assert run(engine, tab, query_rr)['value'] is False
            finally:
                engine.stop()
                log.close()
            engine, tab, log = start('profile-a')
            try:
                assert run(engine, tab, query)['value'] is True
                assert run(engine, tab, query_rr)['value'] is True
                value = run(engine, tab, fetch('/redeem-expired', 'token-redemption', ",refreshPolicy:'refresh'"))
                assert value['ok'], value
                assert run(engine, tab, query)['value'] is False
                assert run(engine, tab, query_rr)['value'] is False
                assert len(spent_requests) == 2 and spent_requests[0] != spent_requests[1]
                assert run(engine, tab, fetch('/redeem', 'token-redemption', ",refreshPolicy:'refresh'"))['ok'] is False
            finally:
                engine.stop()
                log.close()
            state_path = root / 'profile-a/private-state-tokens/state.json'
            assert state_path.stat().st_mode & 0o777 == 0o600
            assert state_path.parent.stat().st_mode & 0o777 == 0o700
            # Rotate the issuer key commitment away: old state must no longer be usable.
            registry.write_text('{}')
            engine, tab, log = start('profile-saved')
            try:
                assert run(engine, tab, query)['value'] is False
                assert run(engine, tab, query_rr)['value'] is False
                assert run(engine, tab, fetch('/issue', 'token-request'))['ok'] is False
            finally:
                engine.stop()
                log.close()
        print('PASS: native PST issuance, proof rejection, redemption, private HTTP headers, profile persistence/isolation, top-level record isolation, permissions, expiry, key removal and redirect rejection')
    finally:
        server.shutdown()
        issuer.stdin.close()
        issuer.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-binary', required=True)
    parser.add_argument('--issuer-binary', required=True)
    args = parser.parse_args()
    exercise(args.engine_binary, args.issuer_binary)
