"""Check click targeting when pointer capture survives a control moving on press."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time
from embedded_smoke import Engine

PAGE = b'''<!doctype html><style>body{margin:0}iframe{position:absolute;left:16px;top:24px;width:800px;height:650px;border:0}</style><script>
window.ready=false;window.result=null;onmessage=e=>{if(e.data?.ready)ready=true;if(e.data?.trace)result=e.data};
</script><iframe src="/frame"></iframe>'''
FRAME = b'''<!doctype html><style>body{margin:0;height:600px}button{position:absolute;left:0;top:0;width:160px;height:100px}</style><button id="target">Moving button</button><script>
const target=document.querySelector('button');let trace=[],pointerId=null;
window.releaseOnUp=false;window.useCapture=true;
const report=()=>parent.postMessage({trace,captured:target.hasPointerCapture(pointerId??-1)},'*');
for(const type of ['pointerdown','pointerup','gotpointercapture','lostpointercapture','mouseup','click'])
 document.addEventListener(type,e=>{
  if(e.type==='pointerdown'&&e.target===target){pointerId=e.pointerId;if(useCapture)target.setPointerCapture(pointerId);target.style.left='220px';target.getBoundingClientRect()}
  if(e.type==='pointerup'&&releaseOnUp)target.releasePointerCapture(pointerId);
  trace.push({type:e.type,target:e.target.id||e.target.tagName,trusted:e.isTrusted,pointerId:e.pointerId??null});report();
 },true);
window.reset=(capture,release)=>{trace=[];useCapture=capture;releaseOnUp=release;target.style.left='0px';target.getBoundingClientRect()};
requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({ready:true},'*')));
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
        with tempfile.TemporaryDirectory(prefix='servo-pointer-capture-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                    deadline = time.monotonic() + 5
                    while not engine.call('evaluate', tab, {'script': 'return window.ready;'}):
                        assert time.monotonic() < deadline
                        time.sleep(.02)
                    for release in [False, True]:
                        engine.call('evaluate', tab, {'script': "document.querySelector('iframe').contentWindow.reset(true," + str(release).lower() + ');return true;'})
                        engine.call('take', tab, human=True)
                        engine.call('input', tab, {'kind': 'click', 'x': 50, 'y': 60}, human=True)
                        engine.call('return', tab, human=True)
                        value = engine.call('evaluate', tab, {'script': 'return window.result;'})
                        trace = value['trace']
                        assert any(e['type'] == 'pointerup' and e['target'] == 'target' for e in trace), trace
                        assert any(e['type'] == 'click' and e['target'] == 'target' for e in trace), 'Captured release lost its click target: ' + str(trace)
                        assert any(e['type'] == 'mouseup' and e['target'] == 'target' for e in trace), trace
                        assert any(e['type'] == 'lostpointercapture' for e in trace), trace
                        assert all(e['trusted'] for e in trace), trace
                        assert not value['captured'], value
                    engine.call('evaluate', tab, {'script': "document.querySelector('iframe').contentWindow.reset(false,false);return true;"})
                    engine.call('take', tab, human=True)
                    engine.call('input', tab, {'kind': 'click', 'x': 50, 'y': 60}, human=True)
                    engine.call('return', tab, human=True)
                    trace = engine.call('evaluate', tab, {'script': 'return window.result.trace;'})
                    assert any(e['type'] == 'pointerup' and e['target'] == 'BODY' for e in trace), trace
                    assert not any(e['type'] == 'click' and e['target'] == 'target' for e in trace), trace
                    assert not engine.call('status')['uncertain']
                    print('PASS: captured pointerup, compatibility mouseup and click retain the capture target after movement and release in pointerup')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
