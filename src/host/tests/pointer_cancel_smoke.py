"""Check native cancellation of a human mouse press.

The dashboard cancels a press whose release it cannot observe (lost pointer capture, window
blur, a hidden page) with the `cancel` input kind, and the engine cancels a human press when an
agent reserves the tab, because the human release would be rejected afterwards. A cancelled
press must not release or activate anything: the page receives `pointercancel` and
`lostpointercapture` instead of `pointerup`, `mouseup` and `click`, the button, `:active` and
pointer capture state are cleared, and the next normal press starts a new click.

Each phase loads a fresh local page, so phases cannot affect each other. All phases run and
report their outcome before the test fails.
"""
import argparse
import http.server
import json
import os
import pathlib
import tempfile
import threading
import time

from embedded_smoke import Engine

# A control that takes pointer capture on pointerdown, at (50, 50) to (250, 250), and a
# cross-site frame at (400, 100) to (700, 300) containing a plain button that fills it.
RECORDER = '''const log=[];let pointerId=null,moveButtons=null;
const record=(target,name,text)=>target.addEventListener(name,event=>{if(event.isTrusted)log.push(text?text(event):name)});
record(control,'pointerdown',event=>'pointerdown:'+event.buttons);
for(const name of ['pointerup','pointercancel','lostpointercapture','pointerleave','mouseup'])record(control,name);
record(control,'click',event=>'click:'+event.detail);
control.addEventListener('pointerdown',event=>{pointerId=event.pointerId;if(control.dataset.capture)control.setPointerCapture(event.pointerId)});
addEventListener('pointermove',event=>{if(event.isTrusted)moveButtons=event.buttons});
const snapshot=()=>({log:log.slice(),active:control.matches(':active'),
  captured:pointerId!==null&&control.hasPointerCapture(pointerId),moveButtons});'''
FRAME = ('''<!doctype html><style>html,body{margin:0;height:100%}button{display:block;width:100%;height:100%}</style>
<button id="control">Framed control</button><script>''' + RECORDER + '''
setInterval(()=>parent.postMessage({frame:snapshot()},'*'),20);</script>''').encode()


def page(port):
    return ('''<!doctype html><style>html,body{margin:0;width:100vw;height:100vh}
#control{position:absolute;left:50px;top:50px;width:200px;height:200px}
iframe{position:absolute;left:400px;top:100px;width:300px;height:200px;border:0}</style>
<button id="control" data-capture="1">Local control</button>
<iframe src="http://localhost:''' + str(port) + '''/frame"></iframe><script>''' + RECORDER + '''
let frame=null;onmessage=event=>{if(event.data.frame)frame=event.data.frame};
window.state=()=>({top:snapshot(),frame});</script>''').encode()


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


def wait_state(engine, tab, ready, lease=None):
    """Return the page state once `ready(state)` holds, or the last state after a timeout."""
    deadline = time.monotonic() + 5
    while True:
        state = engine.call('evaluate', tab, {'script': 'return window.state();'}, lease=lease)
        if ready(state) or time.monotonic() > deadline:
            return state
        time.sleep(.05)


def human(engine, tab, kind, point=None, error=False):
    args = {'kind': kind}
    if point:
        args.update(x=point[0], y=point[1])
    return engine.call('input', tab, args, human=True, error=error)


def captured_press(engine, tab):
    human(engine, tab, 'move', (100, 100))
    human(engine, tab, 'down', (100, 100))
    time.sleep(.1)
    human(engine, tab, 'cancel')
    state = wait_state(engine, tab, lambda state: 'pointerleave' in state['top']['log'])['top']
    assert state['log'] == ['pointerdown:1', 'pointercancel', 'lostpointercapture', 'pointerleave'], state
    assert not state['active'] and not state['captured'], state
    # The cancelled button is no longer reported as pressed, and a new press starts a new click.
    human(engine, tab, 'move', (110, 110))
    human(engine, tab, 'down', (110, 110))
    human(engine, tab, 'up', (110, 110))
    state = wait_state(engine, tab, lambda state: any(entry.startswith('click') for entry in state['top']['log']))['top']
    assert state['moveButtons'] == 0, state
    assert state['log'][4:] == ['pointerdown:1', 'pointerup', 'lostpointercapture', 'mouseup', 'click:1'], state
    assert not state['active'] and not state['captured'], state


def frame_press(engine, tab):
    human(engine, tab, 'move', (550, 200))
    human(engine, tab, 'down', (550, 200))
    # The pointer leaves the frame while pressed; the cancellation must still reach the frame.
    human(engine, tab, 'move', (300, 400))
    human(engine, tab, 'cancel')
    state = wait_state(engine, tab, lambda state: 'pointercancel' in (state['frame'] or {}).get('log', []))
    frame = state['frame']
    # the engine routes a pressed mouse by hit test, so the frame already saw the pointer leave.
    assert frame['log'][0] == 'pointerdown:1' and frame['log'].count('pointercancel') == 1, state
    assert not any(entry in ('pointerup', 'mouseup') or entry.startswith('click') for entry in frame['log']), state
    assert not frame['active'], state
    assert 'pointercancel' not in state['top']['log'], state
    human(engine, tab, 'move', (560, 210))
    human(engine, tab, 'down', (560, 210))
    human(engine, tab, 'up', (560, 210))
    state = wait_state(engine, tab, lambda state: any(entry.startswith('click') for entry in state['frame']['log']))
    frame = state['frame']
    assert frame['log'].count('pointerdown:1') == 2 and frame['log'][-2:] == ['mouseup', 'click:1'], state
    assert frame['log'].count('pointercancel') == 1, state


def reserved_press(engine, tab):
    human(engine, tab, 'move', (100, 100))
    human(engine, tab, 'down', (100, 100))
    lease = engine.call('reserve', tab, {'task': 'local fixture agent'})['leaseId']
    # Reservation checks still apply to the human release, so the engine cancelled the press.
    human(engine, tab, 'up', (100, 100), error=True)
    state = wait_state(engine, tab, lambda state: 'lostpointercapture' in state['top']['log'], lease=lease)['top']
    engine.call('release', tab, lease=lease)
    assert state['log'][:3] == ['pointerdown:1', 'pointercancel', 'lostpointercapture'], state
    assert not any(entry in ('pointerup', 'mouseup') or entry.startswith('click') for entry in state['log']), state
    assert not state['active'] and not state['captured'], state
    human(engine, tab, 'move', (110, 110))
    human(engine, tab, 'down', (110, 110))
    human(engine, tab, 'up', (110, 110))
    state = wait_state(engine, tab, lambda state: any(entry.startswith('click') for entry in state['top']['log']))['top']
    assert state['log'].count('pointerdown:1') == 2 and state['log'][-1] == 'click:1', state


def idle_cancel(engine, tab):
    human(engine, tab, 'move', (100, 100))
    human(engine, tab, 'down', (100, 100))
    human(engine, tab, 'up', (100, 100))
    human(engine, tab, 'cancel')
    state = wait_state(engine, tab, lambda state: 'pointerleave' in state['top']['log'])['top']
    assert 'pointercancel' not in state['log'] and state['log'][-1] == 'pointerleave', state
    assert state['log'].count('click:1') == 1, state


PHASES = [captured_press, frame_press, reserved_press, idle_cancel]


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    outcomes = {}
    try:
        with tempfile.TemporaryDirectory(prefix='browser-pointer-cancel-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    for phase in PHASES:
                        engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(server.server_port)})
                        wait_state(engine, tab, lambda state: state['frame'] is not None)
                        try:
                            phase(engine, tab)
                            outcomes[phase.__name__] = 'pass'
                        except AssertionError as error:
                            outcomes[phase.__name__] = 'FAIL ' + str(error)[:600]
                        print(phase.__name__, outcomes[phase.__name__], flush=True)
                    assert not engine.call('status')['uncertain']
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()
    assert all(outcome == 'pass' for outcome in outcomes.values()), json.dumps(outcomes, indent=1)
    print('PASS: cancelled human presses fire pointercancel without release or click, clear button and capture '
          'state in pressed and cross-site frames, and later presses click normally')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
