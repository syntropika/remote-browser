"""Drive the dashboard with a real browser pointer and check what the page receives.

Requires a Chrome or Chromium executable (--chrome), controlled over a private DevTools pipe.
"""
import argparse
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import time

from human_pointer_smoke import Fixture
from unified_smoke import Runtime


class Browser:
    """Minimal DevTools client over --remote-debugging-pipe."""

    def __init__(self, executable):
        self.profile = tempfile.mkdtemp(prefix='dashboard-browser-')
        commands, self.commands = os.pipe()
        self.replies, replies = os.pipe()

        def descriptors():
            # Duplicate first: dup2 onto the same number would keep close-on-exec.
            reading, writing = os.dup(commands), os.dup(replies)
            os.dup2(reading, 3)
            os.dup2(writing, 4)
        self.process = subprocess.Popen(
            [executable, '--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + self.profile,
             '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=descriptors, close_fds=False)
        os.close(commands)
        os.close(replies)
        self.sequence = 0
        self.buffer = b''
        self.session = None

    def call(self, method, params=None, timeout=20):
        self.sequence += 1
        message = {'id': self.sequence, 'method': method, 'params': params or {}}
        if self.session:
            message['sessionId'] = self.session
        os.write(self.commands, json.dumps(message).encode() + b'\0')
        deadline = time.monotonic() + timeout
        while True:
            while b'\0' in self.buffer:
                raw, self.buffer = self.buffer.split(b'\0', 1)
                reply = json.loads(raw)
                if reply.get('id') == self.sequence:
                    assert 'error' not in reply, reply
                    return reply['result']
            assert time.monotonic() < deadline, method
            self.buffer += os.read(self.replies, 65536)

    def open(self, url):
        target = self.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.session = self.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        self.call('Page.navigate', {'url': url})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True})
        return result['result'].get('value')

    def mouse(self, kind, x, y, buttons=0):
        params = {'type': kind, 'x': x, 'y': y, 'buttons': buttons, 'button': 'left' if kind != 'mouseMoved' else 'none'}
        if kind != 'mouseMoved':
            params['clickCount'] = 1
        self.call('Input.dispatchMouseEvent', params)

    def close(self):
        self.session = None
        try:
            self.call('Browser.close', timeout=5)
        except (AssertionError, OSError):
            pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        shutil.rmtree(self.profile, ignore_errors=True)


def exercise(binary, chrome):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, LIBGL_ALWAYS_SOFTWARE='1', GALLIUM_DRIVER='llvmpipe')
    with tempfile.TemporaryDirectory(prefix='browser-dashboard-pointer-') as directory:
        environment['XDG_RUNTIME_DIR'] = directory
        runtime = Runtime(binary, pathlib.Path(directory) / 'root', environment)
        browser = None
        try:
            client = runtime.client
            tab = client.call('browser_tabs', {'action': 'list'})['tabs'][0]['id']
            client.call('browser_navigate', {'tabId': tab, 'url': 'http://127.0.0.1:' + str(server.server_port)})
            read = lambda: client.call('browser_evaluate', {'tabId': tab, 'script': 'return {frame:window.frame,topMoves,topLeft};'})['value']
            deadline = time.monotonic() + 8
            while not read()['frame']['ready']:
                assert time.monotonic() < deadline, 'Cross-site frame never became ready'
                time.sleep(.05)
            browser = Browser(chrome)
            browser.open(runtime.url)
            deadline = time.monotonic() + 20
            while browser.evaluate("document.getElementById('connection')?.textContent") != 'Display connected':
                assert time.monotonic() < deadline, 'Dashboard display never connected'
                time.sleep(.1)
            rect = browser.evaluate("JSON.parse(JSON.stringify(document.getElementById('view').getBoundingClientRect()))")
            to_screen = lambda x, y: (rect['left'] + x * rect['width'] / 1024, rect['top'] + y * rect['height'] / 768)
            for step in range(9):
                browser.mouse('mouseMoved', *to_screen(100 + step * 22.5, 60 + step * 12.5))
                time.sleep(.04)
            browser.mouse('mousePressed', *to_screen(280, 160), buttons=1)
            time.sleep(.2)
            browser.mouse('mouseReleased', *to_screen(281, 160))
            browser.mouse('mouseMoved', *to_screen(600, 500))
            time.sleep(.1)
            outside = browser.evaluate('''(() => {const r=document.getElementById('view').getBoundingClientRect();
              return [[r.left-8,r.top+8],[r.right+8,r.top+8],[r.left+8,r.top-8],[r.left+8,r.bottom+8]]
                .find(([x,y])=>x>=0&&y>=0&&x<innerWidth&&y<innerHeight);})()''')
            assert outside, rect
            browser.mouse('mouseMoved', *outside)
            deadline = time.monotonic() + 8
            while True:
                result = read()
                state = result['frame']['state'] or {}
                if state.get('left') and result['topLeft']:
                    break
                notice = browser.evaluate("document.getElementById('notice').textContent")
                assert time.monotonic() < deadline, (result, notice, ''.join(runtime.logs[-10:]))
                time.sleep(.1)
            assert result['topMoves'] >= 3, result
            assert state['movesBeforeDown'] >= 3 and state['boxHover'], result
            assert state['up'] - state['down'] >= 100, result
            assert state['click'] is True and state['checked'] is True, result
            print('PASS: dashboard forwards real pointer movement, hover, press duration and leave to a cross-site frame')
        finally:
            if browser:
                browser.close()
            if runtime.process.poll() is None:
                runtime.stop()
    server.shutdown()
    server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    parser.add_argument('--chrome', required=True, help='Chrome or Chromium executable')
    arguments = parser.parse_args()
    exercise(arguments.engine_binary.resolve(), arguments.chrome)
