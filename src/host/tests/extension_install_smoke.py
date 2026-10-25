"""Opt-in real Chrome Web Store acceptance test for a CEF build with the native bridge.

Uses only fresh temporary profiles. This test requires internet access and intentionally
fails, rather than skips, if the native bridge is unavailable. No debugger is used.
"""
import argparse
import http.server
import json
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

EXTENSION = 'bcjindcccaagfpapjjmafapmmgkkhgoa'
STORE = 'https://chromewebstore.google.com/detail/json-formatter/' + EXTENSION + '?hl=en'
PAYLOAD = {'source': 'extension-install-test', 'nested': {'value': 42}}


def wait(operation, predicate=bool, seconds=30):
    deadline = time.monotonic() + seconds
    value = None
    while time.monotonic() < deadline:
        value = operation()
        if predicate(value):
            return value
        time.sleep(.15)
    raise AssertionError(f'Timed out waiting for expected state; last value: {value!r}')


def snapshot(engine, tab):
    try:
        return engine.call('snapshot', tab)
    except AssertionError as error:
        if 'Cannot find context' in str(error) or "'error': 'Uncaught'" in str(error):
            return {}
        raise


def store(engine, tab):
    engine.call('navigate', tab, {'url': STORE}, human=True)
    value = wait(lambda: snapshot(engine, tab), lambda value: bool(value.get('elements')))
    if value.get('title') == 'Before you continue':
        reject = next(element for element in value['elements'] if element['name'] == 'Reject all')
        engine.call('click', tab, {'reference': reject['reference']}, human=True)
    return wait(lambda: snapshot(engine, tab), lambda value: any(
        element.get('name') == 'Add to Chrome' and not element.get('disabled')
        for element in value.get('elements', [])))


def begin(engine, tab):
    value = store(engine, tab)
    button = next(element for element in value['elements'] if element['name'] == 'Add to Chrome')
    engine.call('click', tab, {'reference': button['reference']}, human=True)
    return wait(lambda: engine.call('extension_installs')['requests'],
                lambda requests: any(request['tabId'] == tab for request in requests))


def pending(engine, tab):
    requests = begin(engine, tab)
    request = next(request for request in requests if request['tabId'] == tab)
    assert request['extensionId'] == EXTENSION, request
    assert request['origin'] == 'https://chromewebstore.google.com', request
    assert request['name'] and request['version'], request
    return request


def empty(engine):
    return wait(lambda: engine.call('extension_installs'), lambda value: value['requests'] == [])


def status(engine, tab):
    reply = engine.call('cdp', tab, {'method': 'Runtime.evaluate', 'params': {
        'expression': "new Promise(resolve=>chrome.webstorePrivate.getExtensionStatus('" + EXTENSION + "',resolve))",
        'awaitPromise': True, 'returnByValue': True,
    }})
    return reply['result'].get('value')


def options(engine, tab):
    engine.call('cdp', tab, {'method': 'Page.navigate', 'params': {
        'url': f'chrome-extension://{EXTENSION}/options/options.html',
    }})
    return wait(lambda: engine.call('evaluate', tab, {'script': '''return {
        id:chrome.runtime?.id,
        checked:document.querySelector('input[name=theme]:checked')?.value
    };'''}), lambda value: value.get('id') == EXTENSION and bool(value.get('checked')))


def set_theme(engine, tab, value):
    point = engine.call('evaluate', tab, {'script': '''const r=document.querySelector(
        'input[value=' + ''' + json.dumps(value) + ''' + ']').getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};'''})
    engine.call('input', tab, {'kind': 'click', **point}, human=True)
    return wait(lambda: stored_theme(engine, tab), lambda actual: actual == value)


def stored_theme(engine, tab):
    reply = engine.call('cdp', tab, {'method': 'Runtime.evaluate', 'params': {
        'expression': "chrome.storage.local.get('themeOverride')",
        'awaitPromise': True, 'returnByValue': True,
    }})
    return reply['result'].get('value', {}).get('themeOverride')


def exercise(binary, verify_expiry, protocol_only):
    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(PAYLOAD).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='browser-extension-install-') as directory:
            root = pathlib.Path(directory)
            with (root / 'engine.log').open('w+') as log:
                engines = []

                def start(profile='profile'):
                    engine = Engine(binary, root / profile, log)
                    engines.append(engine)
                    available = engine.call('extension_installs')['available']
                    assert isinstance(available, bool)
                    assert available or protocol_only, 'This CEF distribution lacks the native installation bridge'
                    return engine

                try:
                    engine = start()
                    tab = engine.call('tabs')[0]['id']
                    if protocol_only:
                        assert engine.call('extension_installs')['requests'] == []
                        decision = {'id': 'nonexistent-request', 'allow': True}
                        refused = engine.call('extension_install_decide', tab, decision, error=True)
                        assert 'require the dashboard' in refused, refused
                        malformed = engine.call('extension_install_decide', tab, {'id': 'nonexistent-request'}, human=True, error=True)
                        assert 'explicit installation decision' in malformed, malformed
                        engine.call('extension_install_decide', tab, decision, human=True, error=True)
                        assert engine.call('evaluate', tab, {'script': 'return 42;'}) == 42
                        engine.stop()
                        print('PASS: protocol only; bridge availability, human-only decisions, explicit booleans, nonexistent requests, subsequent browsing and clean shutdown. No installation tested.')
                        return
                    wrong_tab = engine.call('open')
                    request = pending(engine, tab)
                    decision = {'id': request['id'], 'allow': True}
                    engine.call('extension_install_decide', wrong_tab, decision, human=True, error=True)
                    engine.call('extension_install_decide', tab, decision, error=True)
                    engine.call('extension_install_decide', tab, {'id': request['id'], 'allow': 'true'}, human=True, error=True)
                    assert engine.call('extension_installs')['requests'][0]['id'] == request['id']
                    other = start('other-profile')
                    assert other.call('extension_installs')['requests'] == []
                    other.call('extension_install_decide', other.call('tabs')[0]['id'], decision, human=True, error=True)
                    other.stop()
                    engine.call('extension_install_decide', tab, {'id': request['id'], 'allow': False}, human=True)
                    empty(engine)
                    assert wait(lambda: status(engine, tab)) == 'installable'
                    engine.call('extension_install_decide', tab, decision, human=True, error=True)

                    pending(engine, tab)
                    engine.call('navigate', tab, {'url': 'about:blank'}, human=True)
                    empty(engine)
                    closing_tab = engine.call('open')
                    pending(engine, closing_tab)
                    engine.call('close', closing_tab, human=True)
                    empty(engine)
                    if verify_expiry:
                        request = pending(engine, tab)
                        wait(lambda: engine.call('extension_installs')['requests'],
                             lambda requests: not requests, seconds=195)
                        engine.call('extension_install_decide', tab, {'id': request['id'], 'allow': True}, human=True, error=True)

                    request = pending(engine, tab)
                    decision = {'id': request['id'], 'allow': True}
                    engine.call('extension_install_decide', tab, decision, human=True)
                    engine.call('extension_install_decide', tab, decision, human=True, error=True)
                    empty(engine)
                    wait(lambda: status(engine, tab), lambda value: value == 'enabled', seconds=60)
                    options(engine, tab)
                    set_theme(engine, tab, 'force_light')
                    engine.stop()

                    for expected, color in [('force_light', 'rgb(255, 255, 255)'), ('force_dark', 'rgb(26, 26, 26)')]:
                        engine = start()
                        tab = engine.call('tabs')[0]['id']
                        assert options(engine, tab)['checked'] == expected
                        assert stored_theme(engine, tab) == expected
                        engine.call('navigate', tab, {'url': f'http://127.0.0.1:{server.server_port}/state.json'}, human=True)
                        wait(lambda: engine.call('evaluate', tab, {'script': '''return {
                            parsed:!!document.getElementById('jsonFormatterParsed'),
                            json:window.json, background:getComputedStyle(document.body).backgroundColor
                        };'''}), lambda value: value['parsed'] and value.get('json') == PAYLOAD and value['background'] == color)
                        if expected == 'force_light':
                            options(engine, tab)
                            set_theme(engine, tab, 'force_dark')
                        engine.stop()
                    print('PASS: native store install decisions, refusal, single use, wrong tabs, human-only approval, profile isolation, navigation, closure, signed identity, clean shutdown and state after two restarts')
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-6000:])
                    raise
                finally:
                    for engine in engines:
                        if engine.process.poll() is None:
                            try:
                                engine.stop()
                            except Exception:
                                engine.process.kill()
                                engine.process.wait()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    parser.add_argument('--verify-expiry', action='store_true', help='Also wait for the three-minute native decision timeout')
    parser.add_argument('--protocol-only', action='store_true', help='Check IPC permission guards without network access or a custom CEF build; does not test installation')
    args = parser.parse_args()
    exercise(args.engine_binary.resolve(), args.verify_expiry, args.protocol_only)
