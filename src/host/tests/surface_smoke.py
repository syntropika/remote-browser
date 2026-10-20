"""Verify virtual screen geometry and live captures while an iframe is loading."""
import argparse
import base64
import http.server
import os
import pathlib
import struct
import tempfile
import threading
import time

from embedded_smoke import Engine


def exercise(binary):
    release = threading.Event()
    started = threading.Event()

    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/pending':
                started.set()
                release.wait(30)
            body = b'<!doctype html><style>body{background:#204080}</style><title>Live viewport</title>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='browser-live-capture-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                    geometry = engine.call('evaluate', tab, {'script': '''return {
                        width:screen.width,height:screen.height,
                        availableWidth:screen.availWidth,availableHeight:screen.availHeight,
                        outerWidth,outerHeight,innerWidth,innerHeight,ratio:devicePixelRatio
                    };'''})
                    assert geometry['width'] == geometry['availableWidth'] == geometry['outerWidth'] == geometry['innerWidth'] > 0, geometry
                    assert geometry['height'] == geometry['availableHeight'] == geometry['outerHeight'] == geometry['innerHeight'] > 0, geometry
                    engine.call('evaluate', tab, {'script': '''
                        const frame=document.createElement('iframe');
                        frame.src='/pending';document.body.appendChild(frame);return true;
                    '''})
                    assert started.wait(3), 'Pending iframe request never started'
                    begin = time.monotonic()
                    png = base64.b64decode(engine.call('screenshot', tab, human=True))
                    assert time.monotonic() - begin < 3, 'Live capture waited for iframe loading'
                    assert png.startswith(b'\x89PNG\r\n\x1a\n')
                    dimensions = struct.unpack('>II', png[16:24])
                    assert dimensions == (geometry['width'] * geometry['ratio'], geometry['height'] * geometry['ratio']), dimensions
                    saved = engine.call('save_screenshot', tab, {'name': 'Loading.png'}, human=True)
                    assert saved['id'] == 'captures/Loading.png', saved
                    assert pathlib.Path(saved['path']).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
                    assert not engine.call('status')['uncertain']
                    assert engine.call('evaluate', tab, {'script': 'return 42;'}) == 42
                    print('PASS: screen geometry matches the surface; live and saved captures work while an iframe loads; tab stays usable')
                finally:
                    release.set()
                    try:
                        engine.stop()
                    except Exception:
                        engine.process.kill()
                        engine.process.wait()
    finally:
        release.set()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
