"""Check native user activation across same-thread, cross-thread and nested frames."""
import argparse
import html
import http.server
import json
import os
import pathlib
import tempfile
import threading
import time
import urllib.parse

from embedded_smoke import Engine

STYLE = '''<style>body{margin:0}button{position:absolute;left:0;top:0;width:120px;height:80px}
iframe{position:absolute;top:100px;border:0}</style>'''
STATE = 'const state=()=>({active:navigator.userActivation.isActive,sticky:navigator.userActivation.hasBeenActive});'


def frame_page(query):
    """A frame with a button that reports its activation state to the top-level page."""
    name = json.dumps(query['name'][0])
    nested = ''
    if 'nest' in query:
        nested = '<iframe style="left:0;width:200px;height:150px" src="' + html.escape(query['nest'][0]) + '"></iframe>'
    return f'''<!doctype html>{STYLE}<button>Frame button</button>{nested}<script>
{STATE}
const post=data=>top.postMessage(Object.assign({{frame:{name},state:state()}},data),'*');
document.querySelector('button').onclick=e=>post({{clicked:true,trusted:e.isTrusted}});
onmessage=e=>{{
 const d=e.data||{{}};
 if(d.relay)frames[0].postMessage(d.relay,'*');
 if(d.cmd==='query')post({{seq:d.seq}});
 if(d.cmd==='synthetic'){{document.querySelector('button').click();post({{seq:d.seq}});}}
}};
requestAnimationFrame(()=>requestAnimationFrame(()=>post({{ready:true}})));
</script>'''


def top_page(query):
    """A top-level page with a button and up to two frames below it."""
    frames = ''.join(
        f'<iframe id="f{index}" allow="fullscreen" style="left:{index * 320}px;width:300px;height:300px" src="{html.escape(source)}"></iframe>'
        for index, source in enumerate(query.get('src', [])))
    return f'''<!doctype html>{STYLE}<button>Top button</button>{frames}<script>
{STATE}
window.log={{}};window.topClick=null;window.layoutReady=false;
window.frame=index=>document.getElementById('f'+index).contentWindow;
onmessage=e=>{{if(e.data&&e.data.frame)log[e.data.frame]=Object.assign(log[e.data.frame]||{{}},e.data);}};
document.querySelector('button').onclick=e=>topClick={{trusted:e.isTrusted}};
requestAnimationFrame(()=>requestAnimationFrame(()=>layoutReady=true));
</script>'''


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, query = self.path.partition('?')
        query = urllib.parse.parse_qs(query)
        body = (frame_page(query) if path == '/frame' else top_page(query)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def url(origin, path, **parameters):
    return origin + path + '?' + urllib.parse.urlencode(parameters, doseq=True)


class Session:
    def __init__(self, engine, tab):
        self.engine = engine
        self.tab = tab
        self.sequence = 0
        self.failures = []
        self.results = {}

    def evaluate(self, script):
        return self.engine.call('evaluate', self.tab, {'script': script})

    def wait_for(self, script, timeout=6):
        deadline = time.monotonic() + timeout
        while True:
            value = self.evaluate(script)
            if value:
                return value
            if time.monotonic() > deadline:
                return None
            time.sleep(.02)

    def load(self, address, frames):
        self.engine.call('navigate', self.tab, {'url': address})
        ready = ' && '.join(['layoutReady'] + [f"log[{json.dumps(name)}]?.ready" for name in frames])
        assert self.wait_for('return ' + ready + ';'), 'Fixture frames did not become ready: ' + address

    def query(self, target, name):
        """Ask a frame, addressed by a JavaScript expression in the top page, for its state."""
        self.sequence += 1
        message = {'cmd': 'query', 'seq': self.sequence}
        for _ in range(target.count('.relay')):
            message = {'relay': message}
        self.evaluate(target.split('.relay')[0] + '.postMessage(' + json.dumps(message) + ",'*');return true;")
        name = json.dumps(name)
        assert self.wait_for(f'return log[{name}]?.seq==={self.sequence};'), 'No state reply from ' + name
        return self.evaluate(f'return log[{name}].state;')

    def poll(self, target, name, expected, timeout=6):
        deadline = time.monotonic() + timeout
        while True:
            state = self.query(target, name)
            if state == expected or time.monotonic() > deadline:
                return state
            time.sleep(.05)

    def top_state(self):
        return self.evaluate('return state();')

    def click(self, x, y):
        self.engine.call('take', self.tab, human=True)
        self.engine.call('input', self.tab, {'kind': 'click', 'x': x, 'y': y}, human=True)
        self.engine.call('return', self.tab, human=True)

    def check(self, case, label, actual, expected):
        self.results.setdefault(case, {})[label] = actual
        if actual != expected:
            self.failures.append(f'{case}: {label} was {actual}, expected {expected}')


INACTIVE = {'active': False, 'sticky': False}
ACTIVE = {'active': True, 'sticky': True}
CONSUMED = {'active': False, 'sticky': True}


def exercise(binary, results_path=None):
    servers = [http.server.ThreadingHTTPServer((host, 0), Fixture) for host in ('127.0.0.1', '127.0.0.1', '127.0.0.2')]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    a = 'http://127.0.0.1:' + str(servers[0].server_port)
    b = 'http://localhost:' + str(servers[0].server_port)
    c = 'http://127.0.0.2:' + str(servers[2].server_port)
    d = 'http://127.0.0.1:' + str(servers[1].server_port)
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    session = None
    try:
        with tempfile.TemporaryDirectory(prefix='browser-user-activation-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    session = Session(engine, engine.call('tabs')[0]['id'])
                    s = session
                    for case, child_origin in [('same', a), ('cross', b)]:
                        s.load(url(a, '/top', src=url(child_origin, '/frame', name='child')), ['child'])
                        s.check(case, 'topBefore', s.top_state(), INACTIVE)
                        s.check(case, 'childBefore', s.query('frame(0)', 'child'), INACTIVE)
                        # Script-generated clicks are untrusted and must not activate anything.
                        s.sequence += 1
                        s.evaluate("frame(0).postMessage({cmd:'synthetic',seq:%d},'*');return true;" % s.sequence)
                        s.wait_for('return log.child.seq===%d;' % s.sequence)
                        s.check(case, 'syntheticTrusted', s.evaluate('return log.child.trusted;'), False)
                        s.check(case, 'childAfterSynthetic', s.evaluate('return log.child.state;'), INACTIVE)
                        s.check(case, 'topAfterSynthetic', s.top_state(), INACTIVE)
                        s.click(50, 140)
                        clicked = s.wait_for('return log.child.trusted&&log.child.state;')
                        s.check(case, 'childAfterClick', clicked, ACTIVE)
                        s.check(case, 'topAfterClick', s.wait_for('return state().sticky&&state();', 2) or s.top_state(), ACTIVE)

                    # Consuming activation in the top-level document consumes it in the remote child.
                    case = 'consumption'
                    before = s.top_state()
                    s.check(case, 'topBeforeFullscreen', before, ACTIVE)
                    s.evaluate("window.fullscreen='pending';document.documentElement.requestFullscreen().then(()=>fullscreen='entered',e=>fullscreen=e.name);return true;")
                    s.wait_for("return fullscreen!=='pending';", 3)
                    s.check(case, 'fullscreen', s.evaluate('return fullscreen;'), 'entered')
                    s.check(case, 'topAfterConsumption', s.top_state(), CONSUMED)
                    s.check(case, 'childAfterConsumption', s.poll('frame(0)', 'child', CONSUMED), CONSUMED)
                    s.evaluate("if(document.fullscreenElement)document.exitFullscreen();return true;")

                    # A fresh child document starts inactive and can activate the top-level document again.
                    case = 'navigation'
                    s.evaluate("document.getElementById('f0').src=" + json.dumps(url(c, '/frame', name='next')) + ';return true;')
                    s.check(case, 'nextReady', bool(s.wait_for('return log.next?.ready;')), True)
                    s.check(case, 'nextBefore', s.query('frame(0)', 'next'), INACTIVE)
                    s.check(case, 'topBefore', s.top_state(), CONSUMED)
                    s.click(50, 140)
                    s.check(case, 'nextAfterClick', s.wait_for('return log.next.trusted&&log.next.state;'), ACTIVE)
                    s.check(case, 'topAfterClick', s.wait_for('return state().active&&state();', 2) or s.top_state(), ACTIVE)

                    # A > B > A: every ancestor of the clicked document is activated.
                    case = 'ancestors'
                    s.load(url(a, '/top', src=url(b, '/frame', name='middle', nest=url(a, '/frame', name='inner'))), ['middle', 'inner'])
                    s.check(case, 'before', [s.top_state(), s.query('frame(0)', 'middle'), s.query('frame(0).relay', 'inner')], [INACTIVE] * 3)
                    s.click(50, 240)
                    s.check(case, 'innerAfterClick', s.wait_for('return log.inner.trusted&&log.inner.state;'), ACTIVE)
                    s.check(case, 'middleAfterClick', s.poll('frame(0)', 'middle', ACTIVE), ACTIVE)
                    s.check(case, 'topAfterClick', s.wait_for('return state().active&&state();', 3) or s.top_state(), ACTIVE)

                    # Descendants are activated only if they are same origin with the clicked document.
                    case = 'descendants'
                    s.load(url(a, '/top', src=[url(b, '/frame', name='middle', nest=url(a, '/frame', name='inner')), url(d, '/frame', name='port')]), ['middle', 'inner', 'port'])
                    s.check(case, 'before', [s.top_state(), s.query('frame(0)', 'middle'), s.query('frame(0).relay', 'inner'), s.query('frame(1)', 'port')], [INACTIVE] * 4)
                    s.click(50, 40)
                    s.check(case, 'topClickTrusted', s.wait_for('return topClick&&topClick.trusted;'), True)
                    s.check(case, 'topAfterClick', s.top_state(), ACTIVE)
                    s.check(case, 'sameOriginInnerAfterClick', s.poll('frame(0).relay', 'inner', ACTIVE), ACTIVE)
                    s.check(case, 'crossOriginMiddleAfterClick', s.query('frame(0)', 'middle'), INACTIVE)
                    s.check(case, 'crossOriginPortAfterClick', s.query('frame(1)', 'port'), INACTIVE)

                    # A srcdoc sender inherits the top origin, including for descendants
                    # that can only be reached through an intervening remote document.
                    case = 'inheritedSender'
                    s.load(url(a, '/top', src='about:blank'), [])
                    inherited = frame_page({'name': ['inherited'], 'nest': [url(b, '/frame', name='middle', nest=url(a, '/frame', name='inner'))]})
                    s.evaluate("document.getElementById('f0').srcdoc=" + json.dumps(inherited) + ';return true;')
                    s.check(case, 'ready', bool(s.wait_for('return log.inherited?.ready&&log.middle?.ready&&log.inner?.ready;')), True)
                    s.check(case, 'before', [s.top_state(), s.query('frame(0)', 'inherited'), s.query('frame(0).relay', 'middle'), s.query('frame(0).relay.relay', 'inner')], [INACTIVE] * 4)
                    s.click(50, 140)
                    s.check(case, 'senderAfterClick', s.wait_for('return log.inherited.trusted&&log.inherited.state;'), ACTIVE)
                    s.check(case, 'topAfterClick', s.top_state(), ACTIVE)
                    s.check(case, 'sameOriginInnerAfterClick', s.poll('frame(0).relay.relay', 'inner', ACTIVE), ACTIVE)
                    s.check(case, 'crossOriginMiddleAfterClick', s.query('frame(0).relay', 'middle'), INACTIVE)

                    s.check('engine', 'uncertain', engine.call('status')['uncertain'], False)
                finally:
                    engine.stop()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        if session and results_path:
            pathlib.Path(results_path).write_text(json.dumps({'results': session.results, 'failures': session.failures}, indent=2) + '\n')
    print(json.dumps(session.results))
    assert not session.failures, '\n'.join(session.failures)
    print('PASS: trusted native activation reaches same-thread and cross-thread ancestors, same-origin descendants only, consumption and fresh navigated documents; untrusted clicks never activate')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    parser.add_argument('--results', type=pathlib.Path, help='Optional JSON file for observed states')
    arguments = parser.parse_args()
    exercise(arguments.engine_binary.resolve(), arguments.results)
