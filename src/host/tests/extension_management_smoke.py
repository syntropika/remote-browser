"""Exercise native extension management against a real Store install in fresh profiles."""
import argparse
import http.server
import json
import pathlib
import tempfile
import threading

from embedded_smoke import Engine
from extension_install_smoke import EXTENSION, PAYLOAD, pending, set_theme, status, stored_theme, wait


def inventory(engine):
    value = engine.call('extensions')
    assert value['available'] is True, 'This CEF build lacks the native management bridge'
    return value['extensions']


def entry(engine):
    return next((value for value in inventory(engine) if value['id'] == EXTENSION), None)


def exercise(binary):
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
    engines = []
    try:
        with tempfile.TemporaryDirectory(prefix='browser-extension-management-') as directory:
            root = pathlib.Path(directory)
            with (root / 'engine.log').open('w+') as log:
                def start(name='profile'):
                    engine = Engine(binary, root / name, log)
                    engines.append(engine)
                    inventory(engine)
                    return engine

                def formatted(engine, expected):
                    tab = engine.call('open')
                    engine.call('navigate', tab, {'url': f'http://127.0.0.1:{server.server_port}/state.json'}, human=True)
                    wait(lambda: engine.call('evaluate', tab, {'script': "return !!document.getElementById('jsonFormatterParsed');"}),
                         lambda actual: actual is expected)
                    engine.call('close', tab, human=True)

                try:
                    engine = start()
                    assert inventory(engine) == [], 'Component extensions must not be exposed'
                    tab = engine.call('tabs')[0]['id']
                    request = pending(engine, tab)
                    engine.call('extension_install_decide', tab, {'id': request['id'], 'allow': True}, human=True)
                    wait(lambda: status(engine, tab), lambda value: value == 'enabled', seconds=60)
                    value = wait(lambda: entry(engine))
                    assert value['name'] == 'JSON Formatter' and value['version']
                    assert value['enabled'] and value['mayDisable'] and value['mayRemove'] and value['hasOptions']
                    print('PASS: the real Store extension is listed with metadata and native capabilities.', flush=True)

                    for op, args in [
                        ('extension_set_enabled', {'id': EXTENSION, 'enabled': False}),
                        ('extension_remove', {'id': EXTENSION, 'confirmed': True}),
                        ('extension_options', {'id': EXTENSION}),
                    ]:
                        assert 'require' in engine.call(op, args=args, error=True)
                    engine.call('extension_set_enabled', args={'id': EXTENSION, 'enabled': 'false'}, human=True, error=True)
                    engine.call('extension_remove', args={'id': EXTENSION}, human=True, error=True)
                    engine.call('extension_remove', args={'id': EXTENSION, 'confirmed': 'true'}, human=True, error=True)
                    engine.call('extension_remove', args={'id': 'a' * 32, 'confirmed': True}, human=True, error=True)
                    other = start('other-profile')
                    assert inventory(other) == []
                    other.call('extension_set_enabled', args={'id': EXTENSION, 'enabled': False}, human=True, error=True)
                    other.call('extension_remove', args={'id': EXTENSION, 'confirmed': True}, human=True, error=True)
                    other.stop()
                    assert entry(engine)['enabled']
                    options_tab = engine.call('extension_options', args={'id': EXTENSION}, human=True)
                    assert engine.call('evaluate', options_tab, {'script': 'return chrome.runtime.id;'}) == EXTENSION
                    set_theme(engine, options_tab, 'force_dark')
                    engine.call('close', options_tab, human=True)
                    formatted(engine, True)
                    engine.call('extension_set_enabled', args={'id': EXTENSION, 'enabled': False}, human=True)
                    assert entry(engine)['enabled'] is False and entry(engine)['mayEnable']
                    engine.call('extension_options', args={'id': EXTENSION}, human=True, error=True)
                    formatted(engine, False)
                    engine.stop()
                    print('PASS: human-only changes, explicit confirmation, profile isolation, real options and disabled page behavior.', flush=True)

                    engine = start()
                    wait(lambda: entry(engine), lambda value: value is not None and value['enabled'] is False)
                    engine.call('extension_set_enabled', args={'id': EXTENSION, 'enabled': True}, human=True)
                    assert entry(engine)['enabled'] is True
                    options_tab = engine.call('extension_options', args={'id': EXTENSION}, human=True)
                    assert stored_theme(engine, options_tab) == 'force_dark'
                    engine.call('close', options_tab, human=True)
                    formatted(engine, True)
                    engine.call('extension_remove', args={'id': EXTENSION, 'confirmed': True}, human=True)
                    assert entry(engine) is None
                    formatted(engine, False)
                    engine.stop()
                    engine = start()
                    assert inventory(engine) == []
                    engine.stop()
                    print('PASS: disabling persists across restart, re-enabling preserves settings and actual behavior, removal persists across restart.', flush=True)
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
    args = parser.parse_args()
    exercise(args.engine_binary.resolve())
