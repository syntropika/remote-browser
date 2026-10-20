"""Check label activation for native and script clicks, including inside a cross-site frame."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

LABELS = '''<style>
body{margin:0}label{display:block;position:absolute;left:20px;width:300px;height:60px}
#lab{top:20px}#lab2{top:120px}input{margin:0;width:20px;height:20px}
.text{display:inline-block;width:200px;height:40px}#off{position:absolute;left:400px;top:120px}
</style>
<label id="lab"><input type="checkbox" id="box"><span class="text" id="text">Ordinary label</span></label>
<label id="lab2" for="off"><span class="text" id="text2">Disabled control</span></label>
<input type="checkbox" id="off" disabled>
<script>
window.log=[];
const describe=event=>({type:event.type,target:event.target.id||event.target.tagName,
 trusted:event.isTrusted,pointer:event instanceof PointerEvent,
 clientX:event.clientX??null,clientY:event.clientY??null,detail:event.detail??null,
 pointerType:event.pointerType??null,pointerId:event.pointerId??null,
 active:document.activeElement&&(document.activeElement.id||document.activeElement.tagName),
 checked:document.getElementById('box').checked});
for(const type of ['click','input','change','focus'])
 document.addEventListener(type,event=>{log.push(describe(event));if(parent!==window)parent.postMessage({log},'*')},true);
window.centre=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};
window.reset=()=>{log.length=0;document.getElementById('box').checked=false;document.activeElement?.blur();return true};
if(parent!==window)requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({ready:true},'*')));
</script>'''

PAGE = ('<!doctype html>' + LABELS).encode()


def framed(port):
    return ('''<!doctype html><style>body{margin:0}iframe{position:absolute;left:40px;top:30px;width:500px;height:300px;border:0}</style>
<script>window.frameLog=[];window.frameReady=false;onmessage=e=>{if(e.data.ready)frameReady=true;if(e.data.log)frameLog=e.data.log};</script>
<iframe src="http://localhost:''' + str(port) + '''/labels"></iframe>''').encode()


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = framed(self.server.server_port) if self.path == '/framed' else PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def check_native_label(log, point):
    """A native click on label text focuses the control and forwards a trusted copy."""
    types = [(event['type'], event['target']) for event in log]
    assert types == [('click', 'text'), ('focus', 'box'), ('click', 'box'), ('input', 'box'), ('change', 'box')], types
    original, forwarded = log[0], log[2]
    assert original['trusted'] and forwarded['trusted'], log
    assert forwarded['pointer'] and forwarded['pointerType'] == original['pointerType'] == 'mouse', log
    assert forwarded['pointerId'] == original['pointerId'], log
    for name in ['clientX', 'clientY', 'detail']:
        assert forwarded[name] == original[name], (name, log)
    assert (forwarded['clientX'], forwarded['clientY']) == (int(point['x']), int(point['y'])), (point, log)
    assert forwarded['active'] == 'box' and forwarded['checked'], log
    assert log[3]['trusted'] and log[4]['trusted'], log


def check_script_label(log):
    """Script label.click() also focuses the control but forwards an untrusted click."""
    types = [(event['type'], event['target']) for event in log]
    assert types == [('click', 'lab'), ('focus', 'box'), ('click', 'box'), ('input', 'box'), ('change', 'box')], types
    forwarded = log[2]
    assert not log[0]['trusted'] and not forwarded['trusted'], log
    assert (forwarded['clientX'], forwarded['clientY'], forwarded['detail']) == (0, 0, 0), log
    assert forwarded['pointerId'] == -1 and forwarded['pointerType'] == '', log
    assert forwarded['active'] == 'box' and forwarded['checked'], log


def check_direct_control(log):
    """A click on the control itself is not forwarded again by its label."""
    clicks = [event for event in log if event['type'] == 'click']
    assert len(clicks) == 1 and clicks[0]['target'] == 'box' and clicks[0]['trusted'], log
    assert log[-1]['checked'], log


def check_disabled_control(log):
    """A disabled labeled control is neither focused nor clicked."""
    types = [(event['type'], event['target']) for event in log]
    assert types == [('click', 'text2')], types


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='browser-label-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']

                    def evaluate(script):
                        return engine.call('evaluate', tab, {'script': script})

                    def click(point):
                        engine.call('take', tab, human=True)
                        engine.call('input', tab, {'kind': 'click', 'x': point['x'], 'y': point['y']}, human=True)
                        engine.call('return', tab, human=True)
                        time.sleep(.3)

                    engine.call('navigate', tab, {'url': origin + '/labels'})
                    point = evaluate("return centre('text');")
                    click(point)
                    check_native_label(evaluate('return log;'), point)
                    evaluate('return reset();')
                    check_script_label(evaluate("document.getElementById('lab').click();return log;"))
                    evaluate('return reset();')
                    click(evaluate("return centre('box');"))
                    check_direct_control(evaluate('return log;'))
                    evaluate('return reset();')
                    click(evaluate("return centre('text2');"))
                    check_disabled_control(evaluate('return log;'))
                    assert evaluate("return document.activeElement.tagName;") == 'BODY'

                    engine.call('navigate', tab, {'url': origin + '/framed'})
                    deadline = time.monotonic() + 8
                    while not evaluate('return window.frameReady;'):
                        assert time.monotonic() < deadline, 'Cross-site frame never became ready'
                        time.sleep(.05)
                    # The frame's label text is at the same frame-relative position as above.
                    frame_point = {'x': point['x'] + 40, 'y': point['y'] + 30}
                    click(frame_point)
                    check_native_label(evaluate('return window.frameLog;'), point)
                    assert not engine.call('status')['uncertain']
                    print('PASS: native label clicks focus the control and forward a trusted copy, script label clicks stay untrusted, direct and disabled controls, cross-site frame')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
