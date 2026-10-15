"""Exercise native IntersectionObserver callbacks, thresholds and root margins."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

PAGE = b'''<!doctype html><style>
body{margin:0}#root{position:absolute;left:20px;top:20px;width:200px;height:200px;overflow:hidden}
#target{position:absolute;top:300px;width:100px;height:100px}
</style><div id="root"><div id="target"></div></div><script>
window.entries=[];window.marginEntries=[];
window.start=()=>{
 const root=document.querySelector('#root'),target=document.querySelector('#target');
 window.observer=new IntersectionObserver(items=>entries.push(...items.map(e=>({
  intersecting:e.isIntersecting,ratio:e.intersectionRatio,target:e.target.id,
  rootWidth:e.rootBounds.width,rootHeight:e.rootBounds.height,
  width:e.intersectionRect.width,height:e.intersectionRect.height,
  boundingHeight:e.boundingClientRect.height,time:e.time
 }))),{root,threshold:[0,.5,1]});
 window.marginObserver=new IntersectionObserver(items=>marginEntries.push(...items.map(e=>({
  intersecting:e.isIntersecting,ratio:e.intersectionRatio,
  rootWidth:e.rootBounds.width,rootHeight:e.rootBounds.height
 }))),{root,rootMargin:'150px',threshold:[0,1]});
 observer.observe(target);marginObserver.observe(target);return true;
};
</script>'''


def exercise(binary):
    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    # The experimental observer is only enabled on request.
    os.environ['SERVO_EXPERIMENTAL_INTERSECTION_OBSERVER'] = '1'
    try:
        with tempfile.TemporaryDirectory(prefix='servo-intersection-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})

                    def evaluate(script):
                        return engine.call('evaluate', tab, {'script': script})

                    def wait_for(script):
                        deadline = time.monotonic() + 5
                        while not evaluate(script):
                            assert time.monotonic() < deadline, script
                            time.sleep(.02)

                    evaluate('window.layoutReady=false;requestAnimationFrame(()=>requestAnimationFrame(()=>layoutReady=true));return true;')
                    wait_for('return layoutReady;')
                    assert evaluate('return typeof IntersectionObserver;') == 'function', 'Native IntersectionObserver is disabled'
                    assert evaluate('return start();')
                    wait_for('return entries.length===1 && marginEntries.length===1;')
                    initial = evaluate('return {normal:entries[0],margin:marginEntries[0]};')
                    assert initial['normal']['intersecting'] is False, initial
                    assert initial['normal']['ratio'] == 0, initial
                    assert initial['margin']['intersecting'] is True, initial
                    assert abs(initial['margin']['ratio'] - .5) < .01, initial
                    assert initial['normal']['rootWidth'] == initial['normal']['rootHeight'] == 200, initial
                    assert initial['margin']['rootWidth'] == initial['margin']['rootHeight'] == 500, initial

                    for top, ratio in [(150, .5), (100, 1), (300, 0)]:
                        previous = evaluate('return entries.length;')
                        evaluate("document.querySelector('#target').style.top='" + str(top) + "px';return true;")
                        wait_for('return entries.length>' + str(previous) + ';')
                        entry = evaluate('return entries[entries.length-1];')
                        assert abs(entry['ratio'] - ratio) < .01, entry
                        assert entry['intersecting'] == (ratio > 0), entry
                        assert entry['target'] == 'target' and entry['boundingHeight'] == 100, entry
                        if ratio:
                            assert entry['width'] == 100 and entry['height'] == ratio * 100, entry

                    evaluate("observer.unobserve(document.querySelector('#target'));marginObserver.disconnect();window.count=entries.length;document.querySelector('#target').style.top='100px';window.observerFrames=0;requestAnimationFrame(()=>requestAnimationFrame(()=>observerFrames=2));return true;")
                    wait_for('return observerFrames===2;')
                    assert evaluate('return entries.length===count && observer.takeRecords().length===0;')
                    assert not engine.call('status')['uncertain']
                    print('PASS: native intersection callbacks, partial/full visibility thresholds, root margins, geometry and observer cleanup')
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
