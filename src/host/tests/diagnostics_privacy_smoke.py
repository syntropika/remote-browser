"""Check that opt-in native diagnostics never record page-chosen names or text.

A local page uses invented element, CSS property, value, unit, media feature and at-rule
names, invented error classes and messages, an invented URL scheme, HTTP method and path,
and receives a native human click. All of them contain a canary that must not appear in any
diagnostic record, while the records themselves still describe what happened with fixed
vocabulary.
"""
import argparse
import http.server
import json
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

CANARY = 'privatecanary'
PAGE = b'''<!doctype html><style>
body {margin:0}
privatecanaryelement {display:block; width:200px; height:100px; background:gray;
  privatecanaryproperty:1; width:12privatecanaryunit; display:privatecanaryword}
@media (privatecanaryfeature: 1) { body { color: red } }
@media (min-privatecanarywidth: 10px) { body { color: red } }
@privatecanaryrule { body { color: red } }
</style>
<privatecanaryelement id=target>x</privatecanaryelement>
<private-canary-custom></private-canary-custom>
<svg><privatecanarysvg/></svg>
<iframe src="/frame" width=300 height=80></iframe>
<script>
const target = document.getElementById('target');
target.style.setProperty('privatecanarycssom', '1');
target.style.setProperty('width', '5privatecanaryunit');
target.style.setProperty('--privatecanaryvar', 'privatecanaryvalue');
try { document.querySelector('privatecanary['); } catch (error) {}
try { document.createElement('privatecanary name'); } catch (error) {}
try { history.replaceState(null, '', 'privatecanaryscheme://privatecanaryhost/'); } catch (error) {}
try { new Headers([['privatecanary header', 'x']]); } catch (error) {}
fetch('/privatecanarypath?privatecanaryquery', {method: 'PRIVATECANARYMETHOD'}).catch(() => {});
class PrivateCanaryError extends Error {}
setTimeout(() => { const error = new PrivateCanaryError('privatecanarymessage');
  error.name = 'PrivateCanaryError'; throw error; });
setTimeout(() => { throw new TypeError('privatecanarymessage'); });
setTimeout(() => { throw new DOMException('privatecanarymessage', 'PrivateCanaryName'); });
setTimeout(() => { throw 'privatecanarystring'; });
setTimeout(() => { window.ready = true; }, 50);
</script>'''
FRAME = b'''<!doctype html><body><privatecanaryframeelement style="display:block;width:50px;height:20px">
</privatecanaryframeelement><script>
const root = document.body.attachShadow({mode: 'closed'});
root.innerHTML = '<style>privatecanaryshadow{display:block;width:10px;height:5px}</style>' +
  '<privatecanaryshadow></privatecanaryshadow><slot></slot>';
</script>'''


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = FRAME if self.path == '/frame' else PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(LIBGL_ALWAYS_SOFTWARE='1', GALLIUM_DRIVER='llvmpipe', REMOTE_BROWSER_NATIVE_DIAGNOSTICS='1',
                      REMOTE_BROWSER_NATIVE_DIAGNOSTICS_STALE_CHECK='1', REMOTE_BROWSER_NATIVE_DIAGNOSTICS_HOSTS='127.0.0.1=fixture')
    try:
        with tempfile.TemporaryDirectory(prefix='browser-diagnostics-privacy-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w+') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': f'http://127.0.0.1:{server.server_port}/'})
                    deadline = time.monotonic() + 8
                    while not engine.call('evaluate', tab, {'script': 'return window.ready === true;'}):
                        assert time.monotonic() < deadline, 'page did not run'
                        time.sleep(.1)
                    engine.call('take', tab, human=True)
                    engine.call('input', tab, {'kind': 'click', 'x': 50, 'y': 40}, human=True)
                    # The frame's stale check runs eight seconds after its first rendering update.
                    time.sleep(10)
                finally:
                    engine.stop()
                log.seek(0)
                lines = [line for line in log.read().splitlines() if line.startswith('[REMOTE_BROWSER_NATIVE_DIAG] ')]
    finally:
        server.shutdown()
        server.server_close()
    leaked = [line for line in lines if CANARY in line.lower()]
    assert not leaked, 'page-chosen text recorded:\n' + '\n'.join(leaked[:20])
    records = [json.loads(line.split(' ', 1)[1]) for line in lines]

    def has(kind, **fields):
        return any(record.get('kind') == kind and all(record.get(key) == value for key, value in fields.items())
                   for record in records)

    expected = {
        'unknown property': has('css_rejected', error='property', name='unknown', reason='unknown_property'),
        'invalid value of a known property': has('css_rejected', error='property', name='width', reason='invalid_value'),
        'unknown media feature': any(record.get('kind') == 'css_rejected' and 'unknown' in record.get('features', [])
                                     for record in records),
        'unknown at-rule': has('css_rejected', name='unknown', error='unsupported_rule') or
                           has('css_rejected', name='unknown', error='invalid_rule'),
        # setProperty() ignores unknown property names without an error.
        'CSSOM rejection': has('css_rejected', source='cssom', name='width', reason='invalid_value'),
        'pointer target': has('pointer_down', target='other') and has('click', target='other'),
        'uncaught errors': any(record.get('kind') == 'uncaught_error' and record.get('count', 0) >= 4
                               for record in records),
        'DOM exception': has('dom_exception'),
        'history rejection': has('history_state_rejected', targetScheme='other'),
        'HTTP method': any(record.get('kind') == 'http' and record.get('method') == 'other' and 'key' not in record
                           for record in records),
        'stale check': any(record.get('kind') == 'stale_check' and record.get('elements', 0) > 0 for record in records),
    }
    missing = [name for name, present in expected.items() if not present]
    shown = [record for record in records if record.get('kind') in ('css_rejected', 'uncaught_error', 'dom_exception')]
    assert not missing, f'diagnostic records missing: {missing}\n' + '\n'.join(json.dumps(record) for record in shown)
    print(f'PASS: {len(records)} diagnostic records describe the page without page-chosen names or text')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
