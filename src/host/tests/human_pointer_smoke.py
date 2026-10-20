"""Check that human pointer movement, press duration and leave reach a cross-site frame as performed."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

FRAME = b'''<!doctype html><style>body{margin:0}
#box{position:absolute;left:60px;top:40px;width:40px;height:40px;margin:0}</style>
<input type="checkbox" id="box"><script>
const state={movesBeforeDown:0,boxHover:false,down:null,up:null,click:null,left:false,checked:false};
const report=()=>parent.postMessage({state},'*');
addEventListener('pointermove',event=>{if(event.isTrusted&&state.down===null)state.movesBeforeDown++;report()});
box.addEventListener('pointerover',event=>{state.boxHover=event.isTrusted;report()});
box.addEventListener('pointerdown',event=>{state.down=event.timeStamp;report()});
box.addEventListener('pointerup',event=>{state.up=event.timeStamp;report()});
box.addEventListener('click',event=>{state.click=event.isTrusted;state.checked=box.checked;report()});
box.addEventListener('pointerleave',event=>{state.left=event.isTrusted;report()});
requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({ready:true},'*')));
</script>'''


def page(port):
    return ('''<!doctype html><style>body{margin:0}iframe{position:absolute;left:200px;top:100px;width:300px;height:200px;border:0}</style>
<script>window.frame={ready:false,state:null};window.topMoves=0;window.topLeft=false;
addEventListener('pointermove',event=>{if(event.isTrusted)topMoves++});
document.documentElement.addEventListener('mouseleave',event=>{topLeft=event.isTrusted});
onmessage=e=>{if(e.data.ready)frame.ready=true;if(e.data.state)frame.state=e.data.state};</script>
<iframe src="http://localhost:''' + str(port) + '''/frame"></iframe>''').encode()


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = FRAME if self.path == '/frame' else page(self.server.server_port)
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
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='browser-human-pointer-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                    deadline = time.monotonic() + 8
                    while not engine.call('evaluate', tab, {'script': 'return window.frame.ready;'}):
                        assert time.monotonic() < deadline, 'Cross-site frame never became ready'
                        time.sleep(.05)
                    engine.call('take', tab, human=True)
                    # Approach the checkbox centre (280, 160) from the top document, as a hand would.
                    for step in range(9):
                        x, y = 100 + step * 22.5, 60 + step * 12.5
                        engine.call('input', tab, {'kind': 'move', 'x': x, 'y': y}, human=True)
                        time.sleep(.03)
                    engine.call('input', tab, {'kind': 'down', 'x': 280, 'y': 160}, human=True)
                    time.sleep(.15)
                    engine.call('input', tab, {'kind': 'up', 'x': 281, 'y': 160}, human=True)
                    engine.call('input', tab, {'kind': 'move', 'x': 600, 'y': 500}, human=True)
                    engine.call('input', tab, {'kind': 'leave'}, human=True)
                    for kind, x in [('move', -1), ('down', 2000)]:
                        engine.call('input', tab, {'kind': kind, 'x': x, 'y': 10}, human=True, error=True)
                    engine.call('return', tab, human=True)
                    deadline = time.monotonic() + 5
                    while True:
                        result = engine.call('evaluate', tab, {'script': 'return {state:window.frame.state,topMoves,topLeft};'})
                        state = result['state'] or {}
                        if state.get('left') and result['topLeft']:
                            break
                        assert time.monotonic() < deadline, result
                        time.sleep(.05)
                    assert result['topMoves'] >= 3, result
                    assert state['movesBeforeDown'] >= 3 and state['boxHover'], result
                    assert state['up'] - state['down'] >= 100, result
                    assert state['click'] is True and state['checked'] is True, result
                    assert not engine.call('status')['uncertain']
                    print('PASS: human pointer movement, hover, press duration, release and leave reach a cross-site frame in order')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
