"""Check native screen coordinates independently of nested/translated frame viewports."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time
from embedded_smoke import Engine

PAGE = b'''<!doctype html><style>body{margin:0}iframe{position:absolute;left:16px;top:24px;width:800px;height:650px;border:0}</style>
<script>window.ready=false;window.trace=[];onmessage=e=>{if(e.data?.kind==='ready')ready=true;if(e.data?.kind==='trace')trace.push(e.data.value)};</script><iframe src="/frame"></iframe>'''
FRAME = b'''<!doctype html><style>body{margin:0}button{position:absolute;left:0;top:0;width:160px;height:100px}iframe{position:absolute;left:220px;top:120px;width:350px;height:300px;border:0;transform:scale(1.5);transform-origin:top left}</style><button>Frame button</button><iframe src="/nested"></iframe><script>
const report=e=>parent.postMessage({kind:'trace',value:{type:e.type,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY,trusted:e.isTrusted}},'*');
for(const type of ['pointerover','pointerenter','pointermove','pointerdown','pointerup','click','dblclick'])document.querySelector('button').addEventListener(type,report);
onmessage=e=>{if(e.data?.kind==='trace'||e.data?.kind==='ready')parent.postMessage(e.data,'*')};
</script>'''
NESTED = b'''<!doctype html><style>body{margin:0;height:1000px}button{position:absolute;left:0;top:40px;width:160px;height:100px}</style><button>Nested button</button><script>
const report=e=>parent.postMessage({kind:'trace',value:{type:e.type,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY,trusted:e.isTrusted}},'*');
for(const type of ['pointerover','pointerenter','pointermove','pointerdown','pointerup','click','dblclick'])document.querySelector('button').addEventListener(type,report);
scrollTo(0,40);requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({kind:'ready'},'*')));
</script>'''


def exercise(binary):
    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = NESTED if self.path == '/nested' else FRAME if self.path == '/frame' else PAGE
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='browser-pointer-screen-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                    deadline = time.monotonic() + 5
                    while not engine.call('evaluate', tab, {'script': 'return window.ready;'}):
                        assert time.monotonic() < deadline, 'Frames not ready'
                        time.sleep(.02)
                    for index, (x, y, expected) in enumerate([(50, 60, (34, 36)), (50, 60, (34, 36)), (266, 174, (20, 20))]):
                        engine.call('evaluate', tab, {'script': 'window.trace=[];return true;'})
                        engine.call('take', tab, human=True)
                        engine.call('input', tab, {'kind': 'click', 'x': x, 'y': y}, human=True)
                        engine.call('return', tab, human=True)
                        trace = engine.call('evaluate', tab, {'script': 'return window.trace;'})
                        assert any(item['type'] == 'click' for item in trace), trace
                        if index == 1:
                            assert any(item['type'] == 'dblclick' for item in trace), trace
                        for event in trace:
                            assert event['trusted'], event
                            assert (event['x'], event['y']) == expected, event
                            assert (event['sx'], event['sy']) == (x, y), 'Native screen coordinates became frame-local: ' + str(event)
                    # Constructor-supplied screen coordinates must remain untouched.
                    assert engine.call('evaluate', tab, {'script': "const e=new MouseEvent('click',{screenX:17,screenY:29,clientX:3,clientY:4});return [e.screenX,e.screenY,e.clientX,e.clientY,e.isTrusted];"}) == [17, 29, 3, 4, False]
                    assert not engine.call('status')['uncertain']
                    print('PASS: native screen coordinates stay in the headless screen across nested/transformed/scrolled frames; client coordinates remain frame-local')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
