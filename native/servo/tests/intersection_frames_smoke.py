"""Check implicit-root IntersectionObserver geometry and privacy inside nested frames.

The experimental observer is enabled with SERVO_EXPERIMENTAL_INTERSECTION_OBSERVER=1. Loopback
IP addresses and localhost are different sites, so their documents run in different script
threads; different ports on one address are cross-origin documents in the same thread.
"""
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

TOP = '''<!doctype html><style>body{{margin:0;{body}}}#wrap{{position:absolute;left:20px;top:20px}}
iframe{{display:block;border:0;width:200px;height:200px;{frame}}}</style>
<div id="wrap"><iframe id="f" src="{source}"></iframe></div><script>
window.log=[];onmessage=e=>log.push(e.data);
window.entries=(name,kind='entries')=>log.filter(m=>m.frame===name&&m[kind]).flatMap(m=>m[kind]);
window.frame=()=>document.getElementById('f').contentWindow;
window.wrap=document.getElementById('wrap');
window.layoutReady=false;requestAnimationFrame(()=>requestAnimationFrame(()=>layoutReady=true));
</script>'''

FRAME = '''<!doctype html><html><head><style>body{{margin:0;{body}}}#t{{width:100px;height:100px;{target}}}
#w{{position:absolute;left:0;top:0}}iframe{{display:block;border:0;width:200px;height:200px}}</style><script>
const NAME={name};
const post=data=>top.postMessage(Object.assign({{frame:NAME}},data),'*');
const rect=r=>r&&{{x:r.x,y:r.y,w:r.width,h:r.height}};
const record=kind=>items=>post({{[kind]:items.map(e=>({{ratio:e.intersectionRatio,intersecting:e.isIntersecting,rootBounds:rect(e.rootBounds),ir:rect(e.intersectionRect)}}))}});
const options={{threshold:[0,.25,.5,.75,1]}};
if({early})new IntersectionObserver(record('entries'),options).observe(document.documentElement);
onmessage=e=>{{
 const d=e.data||{{}};
 if(d.relay)frames[0].postMessage(d.relay,'*');
 if(d.wrap!==undefined)document.getElementById('w').style.cssText=d.wrap;
 if(d.navigate)location.href=d.navigate;
 if(d.scroll!==undefined)scrollTo(0,d.scroll);
 if(d.ping)requestAnimationFrame(()=>requestAnimationFrame(()=>post({{pong:d.ping}})));
}};
</script></head><body>{target_markup}{nested}<script>
if(!{early}){{
 new IntersectionObserver(record('entries'),options).observe(document.getElementById('t'));
 if({margin})new IntersectionObserver(record('margin'),{{rootMargin:{margin},threshold:[0,1]}}).observe(document.getElementById('t'));
 if({scrollmargin})new IntersectionObserver(record('scrollMargin'),{{scrollMargin:{scrollmargin},threshold:[0,1]}}).observe(document.getElementById('t'));
}}
requestAnimationFrame(()=>requestAnimationFrame(()=>post({{ready:true}})));
</script></body></html>'''


def page(path, query):
    value = lambda key, default='': query.get(key, [default])[0]
    if path == '/frame':
        nested = ''
        if 'nest' in query:
            nested = '<div id="w"><iframe src="' + html.escape(value('nest')) + '"></iframe></div>'
        return FRAME.format(
            name=json.dumps(value('name')), target=value('target'), body=value('body'), nested=nested,
            early='true' if 'early' in query else 'false',
            margin=json.dumps(value('margin')) if 'margin' in query else 'false',
            scrollmargin=json.dumps(value('scrollmargin')) if 'scrollmargin' in query else 'false',
            target_markup='<div style="height:50px;width:100px;overflow:auto"><div id="t"></div></div>' if 'scrollclip' in query else '<div id="t"></div>')
    return TOP.format(source=html.escape(value('src')), frame=value('frame'), body=value('body'))


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, query = self.path.partition('?')
        body = page(path, urllib.parse.parse_qs(query)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def url(origin, path, **parameters):
    return origin + path + '?' + urllib.parse.urlencode(parameters)


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
            if value or time.monotonic() > deadline:
                return value
            time.sleep(.02)

    def load(self, top, ready):
        self.engine.call('navigate', self.tab, {'url': top})
        condition = ' && '.join(['layoutReady'] + [f'log.some(m=>m.frame==={json.dumps(name)}&&m.ready)' for name in ready])
        if not self.wait_for('return ' + condition + ';'):
            self.failures.append('Fixture did not become ready: ' + top)
        self.viewport = self.evaluate('return {w:innerWidth,h:innerHeight};')

    def entries(self, name, kind='entries'):
        return self.evaluate(f'return entries({json.dumps(name)},{json.dumps(kind)});')

    def settle(self, name, depth=0):
        """Wait for two animation frames of a frame, so queued observations have been reported."""
        self.sequence += 1
        message = {'ping': self.sequence}
        for _ in range(depth):
            message = {'relay': message}
        self.evaluate('frame().postMessage(' + json.dumps(message) + ",'*');return true;")
        self.wait_for(f'return log.some(m=>m.frame==={json.dumps(name)}&&m.pong==={self.sequence});')

    def check(self, case, label, actual, expected):
        self.results.setdefault(case, {})[label] = actual
        if actual != expected:
            self.failures.append(f'{case}: {label} was {json.dumps(actual)}, expected {json.dumps(expected)}')

    def expect(self, case, label, name, ratio, root_bounds=None, kind='entries', intersection_height=None):
        """Wait until the last entry of a frame has the expected ratio, then check all fields."""
        deadline = time.monotonic() + 6
        while True:
            entries = self.entries(name, kind)
            last = entries[-1] if entries else None
            if last and abs(last['ratio'] - ratio) < .01 or time.monotonic() > deadline:
                break
            time.sleep(.03)
        summary = last and {
            'ratio': round(last['ratio'], 2),
            'intersecting': last['intersecting'],
            'rootBounds': last['rootBounds'] and [last['rootBounds']['w'], last['rootBounds']['h']],
        }
        expected = {'ratio': ratio, 'intersecting': ratio > 0, 'rootBounds': root_bounds}
        self.check(case, label, summary, expected)
        if intersection_height is not None and last:
            self.check(case, label + 'IntersectionHeight', round(last['ir']['h'], 1), intersection_height)
        return entries

    def count(self, case, label, name, expected, depth=0):
        self.settle(name, depth)
        self.check(case, label, len(self.entries(name)), expected)

    def style(self, script):
        self.evaluate(script + ';return true;')


def default_disabled(binary, directory, address):
    os.environ.pop('SERVO_EXPERIMENTAL_INTERSECTION_OBSERVER', None)
    with open(pathlib.Path(directory) / 'default.log', 'w') as log:
        engine = Engine(binary, pathlib.Path(directory) / 'default-profile', log)
        try:
            tab = engine.call('tabs')[0]['id']
            engine.call('navigate', tab, {'url': address})
            return engine.call('evaluate', tab, {'script': 'return typeof IntersectionObserver;'})
        finally:
            engine.stop()


def frame_in_other_thread(s, o):
    """Visibility, movement, partial view and parent clipping, with a same-origin control."""
    for case, origin in [('same', o['a']), ('cross', o['b'])]:
        s.load(url(o['a'], '/top', src=url(origin, '/frame', name=case)), [case])
        s.check('default', 'typeofWithOptIn', s.evaluate('return typeof IntersectionObserver;'), 'function')
        bounds = [s.viewport['w'], s.viewport['h']] if case == 'same' else None
        s.expect(case, 'initial', case, 1, bounds)
        s.count(case, 'initialEntries', case, 1)
        s.style("wrap.style.top='1200px'")
        s.expect(case, 'offscreen', case, 0, bounds)
        s.style("wrap.style.top=(innerHeight-50)+'px'")
        s.expect(case, 'partial', case, .5, bounds, intersection_height=50)
        s.style("wrap.style.top='20px'")
        s.expect(case, 'visibleAgain', case, 1, bounds)
        s.style("wrap.style.overflow='hidden';wrap.style.height='50px'")
        s.expect(case, 'clippedByParent', case, .5, bounds, intersection_height=50)


def root_margin_privacy(s, o):
    """Same-thread cross-origin frames get no rootBounds and no root margin expansion."""
    for case, origin in [('sameOriginMargin', o['a']), ('portMargin', o['d'])]:
        s.load(url(o['a'], '/top', src=url(origin, '/frame', name=case, margin='300px', target='margin-top:900px'), frame='height:2000px'), [case])
        same = origin == o['a']
        bounds = [s.viewport['w'], s.viewport['h']] if same else None
        expanded = [s.viewport['w'] + 600, s.viewport['h'] + 600] if same else None
        s.expect(case, 'withoutMargin', case, 0, bounds)
        s.expect(case, 'withMargin', case, 1 if same else 0, expanded, kind='margin')


def scroll_margin_privacy(s, o):
    """Scroll margins expand scrollports only for targets same-origin-domain with the root."""
    for case, origin in [('sameScrollMargin', o['a']), ('portScrollMargin', o['d']), ('remoteScrollMargin', o['b'])]:
        s.load(url(o['a'], '/top', src=url(origin, '/frame', name=case, scrollmargin='200px', scrollclip='1', target='margin-top:80px')), [case])
        same = origin == o['a']
        bounds = [s.viewport['w'], s.viewport['h']] if same else None
        s.expect(case, 'withoutMargin', case, 0, bounds)
        s.expect(case, 'withMargin', case, 1 if same else 0, bounds, kind='scrollMargin')


def three_sites(s, o):
    """The inner frame follows movement, scrolling and clipping of both ancestors."""
    case = 'threeSites'
    s.load(url(o['a'], '/top', body='height:3000px', src=url(o['b'], '/frame', name='middle', target='display:none', body='height:1000px', nest=url(o['c'], '/frame', name='inner'))), ['middle', 'inner'])
    s.expect(case, 'initial', 'inner', 1)
    s.count(case, 'initialEntries', 'inner', 1, depth=1)
    s.style("wrap.style.top='1200px'")
    s.expect(case, 'middleOffscreen', 'inner', 0)
    s.style("wrap.style.top='20px'")
    s.expect(case, 'middleOnscreen', 'inner', 1)
    s.style('scrollTo(0,1000)')
    s.expect(case, 'topScrolledAway', 'inner', 0)
    s.style('scrollTo(0,0)')
    s.expect(case, 'topScrolledBack', 'inner', 1)
    s.style("frame().postMessage({scroll:300},'*')")
    s.expect(case, 'middleScrolledAway', 'inner', 0)
    s.style("frame().postMessage({scroll:50},'*')")
    s.expect(case, 'middlePartlyScrolled', 'inner', .5, intersection_height=50)
    s.style("frame().postMessage({scroll:0},'*')")
    s.expect(case, 'middleScrolledBack', 'inner', 1)
    s.style("frame().postMessage({wrap:'position:absolute;left:0;top:0;overflow:hidden;height:50px'},'*')")
    s.expect(case, 'clippedByMiddle', 'inner', .5, intersection_height=50)


def same_origin_behind_cross_origin(s, o):
    """A > B > A: the inner document shares the top-level script thread but not its layout."""
    case = 'sameOriginBehindCrossOrigin'
    s.load(url(o['a'], '/top', src=url(o['b'], '/frame', name='middle', target='display:none', nest=url(o['a'], '/frame', name='inner'))), ['middle', 'inner'])
    bounds = [s.viewport['w'], s.viewport['h']]
    s.expect(case, 'initial', 'inner', 1, bounds)
    s.style("wrap.style.top='1200px'")
    s.expect(case, 'middleOffscreen', 'inner', 0, bounds)
    s.style("wrap.style.top=(innerHeight-50)+'px'")
    s.expect(case, 'middlePartial', 'inner', .5, bounds, intersection_height=50)


def mixed_local_and_remote(s, o):
    """A remote frame below a same-thread frame, and a same-thread frame below a remote frame."""
    for case, middle, inner in [('localThenRemote', o['a'], o['b']), ('remoteThenLocal', o['b'], o['b'])]:
        s.load(url(o['a'], '/top', src=url(middle, '/frame', name='middle', target='display:none', nest=url(inner, '/frame', name='inner'))), ['middle', 'inner'])
        s.expect(case, 'initial', 'inner', 1)
        s.style("wrap.style.top='1200px'")
        s.expect(case, 'middleOffscreen', 'inner', 0)
        s.style("wrap.style.top=(innerHeight-50)+'px'")
        s.expect(case, 'middlePartial', 'inner', .5, intersection_height=50)
        s.style("wrap.style.top='20px';wrap.style.overflow='hidden';wrap.style.height='25px'")
        s.expect(case, 'clippedByTop', 'inner', .25, intersection_height=25)


def hidden_frames(s, o):
    """Hidden containers report one non-intersecting initial entry."""
    for case, origin in [('hiddenSameOrigin', o['a']), ('hiddenCrossOrigin', o['b'])]:
        s.load(url(o['a'], '/top', src=url(origin, '/frame', name=case), frame='display:none'), [])
        bounds = [s.viewport['w'], s.viewport['h']] if origin == o['a'] else None
        s.expect(case, 'initial', case, 0, bounds)
        s.count(case, 'initialEntries', case, 1)
        s.style("document.getElementById('f').style.display='block'")
        s.expect(case, 'shown', case, 1, bounds)


def early_observer(s, o):
    """An observer created in <head> gets exactly one initial entry."""
    case = 'earlyObserver'
    s.load(url(o['a'], '/top', src=url(o['b'], '/frame', name='early', early='1')), ['early'])
    s.expect(case, 'initial', 'early', 1)
    s.count(case, 'initialEntries', 'early', 1)


def navigation(s, o):
    """A navigated frame keeps its container geometry without any parent change."""
    case = 'navigation'
    s.load(url(o['a'], '/top', src=url(o['b'], '/frame', name='first')), ['first'])
    s.expect(case, 'firstVisible', 'first', 1)
    s.style("frame().postMessage({navigate:" + json.dumps(url(o['c'], '/frame', name='second')) + "},'*')")
    s.expect(case, 'secondVisibleWithoutParentChange', 'second', 1)
    s.count(case, 'secondEntries', 'second', 1)
    s.style("wrap.style.top='1200px'")
    s.expect(case, 'secondOffscreen', 'second', 0)
    s.style("frame().postMessage({navigate:" + json.dumps(url(o['b'], '/frame', name='third')) + "},'*')")
    s.expect(case, 'thirdOffscreenWithoutParentChange', 'third', 0)
    s.count(case, 'thirdEntries', 'third', 1)
    s.style("wrap.style.top='20px'")
    s.expect(case, 'thirdVisible', 'third', 1)


def replaced_frame(s, o):
    """A replacement iframe is a new browsing context and never inherits old geometry."""
    case = 'replacedFrame'
    s.load(url(o['a'], '/top', src=url(o['b'], '/frame', name='old')), ['old'])
    s.expect(case, 'oldVisible', 'old', 1)
    s.style("document.getElementById('f').remove();wrap.style.top='1200px';const f=document.createElement('iframe');f.id='f';f.src=" + json.dumps(url(o['b'], '/frame', name='fresh')) + ';wrap.append(f)')
    s.expect(case, 'freshOffscreen', 'fresh', 0)
    s.count(case, 'freshEntries', 'fresh', 1)
    s.style("wrap.style.top='20px'")
    s.expect(case, 'freshVisible', 'fresh', 1)


def transformed_frames(s, o):
    """Scaled and translated containers map the visible area into frame coordinates."""
    for case, origin in [('scaledCrossThread', o['b']), ('scaledSameThread', o['d'])]:
        s.load(url(o['a'], '/top', src=url(origin, '/frame', name=case), frame='transform:scale(.5);transform-origin:0 0'), [case])
        s.expect(case, 'visible', case, 1, None)
        s.style("wrap.style.top=(innerHeight-25)+'px'")
        s.expect(case, 'quarterOfContainerVisible', case, .5, None, intersection_height=50)
    case = 'translatedCrossThread'
    s.load(url(o['a'], '/top', src=url(o['b'], '/frame', name=case), frame='transform:translateY(-70px)'), [case])
    s.expect(case, 'topCutOff', case, .5, None, intersection_height=50)


CASES = {function.__name__: function for function in [
    frame_in_other_thread, root_margin_privacy, scroll_margin_privacy, three_sites, same_origin_behind_cross_origin,
    mixed_local_and_remote,
    hidden_frames, early_observer, navigation, replaced_frame, transformed_frames,
]}


def exercise(binary, results_path=None, cases=tuple(CASES)):
    servers = [http.server.ThreadingHTTPServer((host, 0), Fixture) for host in ('127.0.0.1', '127.0.0.1', '127.0.0.2')]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    origins = {
        'a': 'http://127.0.0.1:' + str(servers[0].server_port),
        'b': 'http://localhost:' + str(servers[0].server_port),
        'c': 'http://127.0.0.2:' + str(servers[2].server_port),
        'd': 'http://127.0.0.1:' + str(servers[1].server_port),
    }
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    session = None
    try:
        with tempfile.TemporaryDirectory(prefix='servo-intersection-frames-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            disabled = default_disabled(binary, directory, url(origins['a'], '/top', src='about:blank'))
            os.environ['SERVO_EXPERIMENTAL_INTERSECTION_OBSERVER'] = '1'
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    session = Session(engine, engine.call('tabs')[0]['id'])
                    session.check('default', 'typeofWithoutOptIn', disabled, 'undefined')
                    for name in cases:
                        CASES[name](session, origins)
                    session.check('engine', 'uncertain', engine.call('status')['uncertain'], False)
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
    print('PASS: implicit-root intersections across same-thread, cross-thread and nested frames, privacy, hidden/early/navigated/replaced frames and scaled or translated containers')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    parser.add_argument('--results', type=pathlib.Path, help='Optional JSON file for observed entries')
    parser.add_argument('--cases', default=','.join(CASES), help='Comma-separated subset of: ' + ', '.join(CASES))
    arguments = parser.parse_args()
    exercise(arguments.engine_binary.resolve(), arguments.results, arguments.cases.split(','))
