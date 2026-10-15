"""Check native hover boundaries, click interfaces and activation inside an iframe."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

PAGE = b'''<!doctype html><style>
body{margin:0}iframe{position:absolute;left:16px;top:24px;width:800px;height:600px;border:0}
</style><script>
window.ready=false;window.result=null;
onmessage=e=>{if(e.data?.kind==='ready')ready=true;if(e.data?.kind==='trace')result=e.data};
</script><iframe src="/frame"></iframe>'''
FRAME = b'''<!doctype html><style>
body{margin:0}#parent{position:absolute;left:0;top:0;width:400px;height:300px}
button{position:absolute;top:0;width:160px;height:100px}#a{left:0}#b{left:220px}
#check{appearance:none;position:absolute;left:20px;top:150px;width:40px;height:40px;border:1px solid black}
</style><div id="parent"><button id="a">A</button><button id="b">B</button>
<input type="checkbox" id="check"></div><script>
const trace=[];window.preventCheck=false;
function record(event){
 if(event.target!==event.currentTarget)return;
 trace.push({type:event.type,target:event.target.id,trusted:event.isTrusted,
   pointerClass:event instanceof PointerEvent,mouseClass:event instanceof MouseEvent,
   pointerType:event.pointerType??null,pointerId:event.pointerId??null,
   isPrimary:event.isPrimary??null,pressure:event.pressure??null,
   button:event.button,buttons:event.buttons,detail:event.detail,
   clientX:event.clientX,clientY:event.clientY,composed:event.composed,
   viewIsWindow:event.view===window,active:navigator.userActivation.isActive});
 parent.postMessage({kind:'trace',trace},'*');
}
for(const node of document.querySelectorAll('#parent,button,input'))
 for(const type of ['pointerenter','mouseenter','pointerleave','mouseleave','pointerdown','pointerup','click','dblclick'])
  node.addEventListener(type,record);
document.querySelector('#check').addEventListener('click',event=>{if(preventCheck)event.preventDefault()});
requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({kind:'ready'},'*')));
</script>'''


def exercise(binary):
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

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='servo-pointer-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                    deadline = time.monotonic() + 5
                    while not engine.call('evaluate', tab, {'script': 'return window.ready;'}):
                        assert time.monotonic() < deadline, 'Iframe never became ready'
                        time.sleep(.02)

                    def click(x, y):
                        engine.call('take', tab, human=True)
                        engine.call('input', tab, {'kind': 'click', 'x': x, 'y': y}, human=True)
                        engine.call('return', tab, human=True)
                        return engine.call('evaluate', tab, {'script': 'return window.result.trace;'})

                    trace = click(50, 60)
                    types = [event['type'] for event in trace if event['target'] == 'a']
                    assert 'pointerenter' in types and 'mouseenter' in types, types
                    assert types.index('pointerenter') < types.index('pointerdown'), types
                    enters = [event['target'] for event in trace if event['type'] == 'pointerenter']
                    assert enters == ['parent', 'a'], enters
                    click_event = next(event for event in trace if event['type'] == 'click')
                    assert click_event['pointerClass'] and click_event['mouseClass'], click_event
                    assert click_event['trusted'] and click_event['active'] and click_event['composed'], click_event
                    assert click_event['viewIsWindow'] and click_event['pointerType'] == 'mouse', click_event
                    assert (click_event['button'], click_event['buttons'], click_event['detail']) == (0, 0, 1), click_event
                    assert (click_event['clientX'], click_event['clientY']) == (34, 36), click_event
                    assert click_event['isPrimary'] is False and click_event['pressure'] == 0, click_event
                    pointer_up = next(event for event in trace if event['type'] == 'pointerup')
                    assert click_event['pointerId'] == pointer_up['pointerId'], trace
                    trace = click(50, 60)
                    double = [event for event in trace if event['type'] == 'dblclick']
                    assert len(double) == 1 and double[0]['detail'] == 2, double
                    assert double[0]['mouseClass'] and not double[0]['pointerClass'], double
                    trace = click(250, 60)
                    for event_type in ['pointerenter', 'mouseenter']:
                        assert sum(event['type'] == event_type and event['target'] == 'parent' for event in trace) == 1, trace
                        assert any(event['type'] == event_type and event['target'] == 'b' for event in trace), trace
                    for event_type in ['pointerleave', 'mouseleave']:
                        assert any(event['type'] == event_type and event['target'] == 'a' for event in trace), trace
                    point = engine.call('evaluate', tab, {'script': "const r=document.querySelector('iframe').contentWindow.document.querySelector('#check').getBoundingClientRect();return {x:16+r.x+r.width/2,y:24+r.y+r.height/2};"})
                    click(point['x'], point['y'])
                    script = "return document.querySelector('iframe').contentWindow.document.querySelector('#check').checked;"
                    assert engine.call('evaluate', tab, {'script': script}) is True
                    engine.call('evaluate', tab, {'script': "document.querySelector('iframe').contentWindow.preventCheck=true;return true;"})
                    click(point['x'], point['y'])
                    assert engine.call('evaluate', tab, {'script': script}) is True, 'Canceled click changed the checkbox'
                    trace = click(700, 500)
                    for event_type in ['pointerleave', 'mouseleave']:
                        assert sum(event['type'] == event_type and event['target'] == 'parent' for event in trace) == 1, trace
                    assert not engine.call('status')['uncertain']
                    print('PASS: initial/sibling hover boundaries, trusted PointerEvent clicks, double clicks, activation and cancelation')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
