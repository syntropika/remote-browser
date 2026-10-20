"""Check the values a page reads from a native pointer interaction.

A page that reacts to a click reads where inside the target it happened, how far the pointer
moved and how many times it was pressed. Each value below is what the specifications require
and what other browsers report for the same interaction.
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

PAGE = b"""<!doctype html><html><head><meta charset=utf-8><style>body{margin:0}
#target{position:absolute;left:40px;top:60px;width:160px;height:40px;border:2px solid #333;
padding:0}</style></head><body><button id=target>verify</button>
<script>
window.events = [];
const keep = (event) => ({
  type: event.type,
  offsetX: Math.round(event.offsetX), offsetY: Math.round(event.offsetY),
  movementX: event.movementX === undefined ? 'missing' : event.movementX,
  movementY: event.movementY === undefined ? 'missing' : event.movementY,
  detail: event.detail,
  coalesced: typeof event.getCoalescedEvents === 'function'
    ? event.getCoalescedEvents().length : 'missing',
  isTrusted: event.isTrusted,
});
for (const name of ['pointermove', 'pointerdown', 'pointerup', 'click'])
  document.getElementById('target').addEventListener(name, (event) => {
    if (window.events.length < 16) window.events.push(keep(event));
  });
window.measure = () => window.events;
</script></body></html>"""


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(LIBGL_ALWAYS_SOFTWARE='1', GALLIUM_DRIVER='llvmpipe')
    try:
        with tempfile.TemporaryDirectory(prefix='browser-pointer-fidelity-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': f'http://127.0.0.1:{server.server_port}/'})
                    time.sleep(1.5)
                    engine.call('take', tab, human=True)
                    for kind, x, y in (('move', 100, 70), ('move', 110, 78),
                                       ('down', 110, 78), ('up', 110, 78)):
                        engine.call('input', tab, {'kind': kind, 'x': x, 'y': y}, human=True)
                        time.sleep(.1)
                    time.sleep(.4)
                    engine.call('return', tab, human=True)
                    events = engine.call('evaluate', tab, {'script': 'return measure();'})
                finally:
                    engine.stop()
    finally:
        server.shutdown()
        server.server_close()

    by_type = {}
    for event in events:
        by_type.setdefault(event['type'], []).append(event)
    for name in ('pointermove', 'pointerdown', 'pointerup', 'click'):
        assert name in by_type, (name, list(by_type))
    # <https://drafts.csswg.org/cssom-view/#dom-mouseevent-offsetx>: relative to the padding
    # edge of the target, which is at (42, 62) here: its position plus its 2px border.
    for events_of_type in by_type.values():
        for event in events_of_type:
            assert event['isTrusted'] is True, event
    assert by_type['pointermove'][0]['offsetX'] == 58, by_type['pointermove'][0]
    assert by_type['pointermove'][0]['offsetY'] == 8, by_type['pointermove'][0]
    for name in ('pointerdown', 'pointerup', 'click'):
        for event in by_type[name]:
            assert event['offsetX'] == 68 and event['offsetY'] == 16, event
    # <https://w3c.github.io/pointerlock/#dom-mouseevent-movementx>: the step from the
    # previous motion event, and zero for an event that is not one.
    moves = by_type['pointermove']
    assert any(event['movementX'] == 10 and event['movementY'] == 8 for event in moves), moves
    for name in ('pointerdown', 'pointerup', 'click'):
        for event in by_type[name]:
            assert event['movementX'] == 0 and event['movementY'] == 0, event
    # <https://w3c.github.io/pointerevents/#dfn-attributes-and-default-actions>
    for name in ('pointerdown', 'pointerup'):
        for event in by_type[name]:
            assert event['detail'] == 0, event
            assert event['coalesced'] == 0, event
    for event in by_type['click']:
        assert event['detail'] == 1, event
    # <https://w3c.github.io/pointerevents/#dom-pointerevent-getcoalescedevents>
    for event in moves:
        assert event['coalesced'] == 1, event
    print('PASS: a native interaction reports the offset inside the target, the movement since '
          'the previous motion event, the click count and its coalesced events')
    print(json.dumps(by_type['click'][0]))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary.resolve())
