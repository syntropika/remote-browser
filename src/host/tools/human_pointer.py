"""Deliver a human-equivalent pointer interaction through the dashboard.

A real Chrome instance opens the owner dashboard and produces ordinary pointer events over
the view canvas. The dashboard's own JavaScript forwards them to the engine exactly as it
forwards the operator's hand, so the page receives genuine movement, hover, press duration
and release. Nothing is injected into the page and no identity is altered.
"""
import json
import math
import os
import random
import shutil
import subprocess
import tempfile
import time


class Browser:
    """Minimal DevTools client over --remote-debugging-pipe."""

    def __init__(self, executable, width=1280, height=900, headless=True):
        self.profile = tempfile.mkdtemp(prefix='live-dashboard-browser-')
        commands, self.commands = os.pipe()
        self.replies, replies = os.pipe()

        def descriptors():
            reading, writing = os.dup(commands), os.dup(replies)
            os.dup2(reading, 3)
            os.dup2(writing, 4)

        arguments = [executable, '--remote-debugging-pipe', '--user-data-dir=' + self.profile,
                     '--no-first-run', '--no-default-browser-check',
                     f'--window-size={width},{height}', 'about:blank']
        if headless:
            arguments.insert(1, '--headless=new')
        self.process = subprocess.Popen(
            arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=descriptors, close_fds=False)
        os.close(commands)
        os.close(replies)
        self.sequence = 0
        self.buffer = b''
        self.session = None

    def call(self, method, params=None, timeout=30):
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
        params = {'type': kind, 'x': x, 'y': y, 'buttons': buttons,
                  'button': 'left' if kind != 'mouseMoved' else 'none'}
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


def wait_for_display(browser, timeout=40):
    deadline = time.monotonic() + timeout
    while browser.evaluate("document.getElementById('connection')?.textContent") != 'Display connected':
        assert time.monotonic() < deadline, 'Dashboard display never connected'
        time.sleep(.2)
    return browser.evaluate(
        "JSON.parse(JSON.stringify(document.getElementById('view').getBoundingClientRect()))")


def mapper(rect, width=1024, height=768):
    return lambda x, y: (rect['left'] + x * rect['width'] / width,
                         rect['top'] + y * rect['height'] / height)


def travel(browser, to_screen, start, end, seconds=.8, jitter=1.4, rng=random):
    """Move the pointer along an eased, slightly imperfect path, as a hand does."""
    steps = max(8, int(seconds / .018))
    points = []
    for step in range(1, steps + 1):
        progress = step / steps
        eased = 3 * progress ** 2 - 2 * progress ** 3
        wobble = math.sin(progress * math.pi) * jitter
        x = start[0] + (end[0] - start[0]) * eased + rng.uniform(-wobble, wobble)
        y = start[1] + (end[1] - start[1]) * eased + rng.uniform(-wobble, wobble)
        points.append((x, y))
        browser.mouse('mouseMoved', *to_screen(x, y))
        time.sleep(rng.uniform(.012, .026))
    return points


def press(browser, to_screen, point, hold=None, rng=random):
    """Press and release at one point, with a human press duration and a tiny slip."""
    hold = hold if hold is not None else rng.uniform(.07, .13)
    browser.mouse('mousePressed', *to_screen(*point), buttons=1)
    time.sleep(hold)
    release = (point[0] + rng.uniform(-.8, .8), point[1] + rng.uniform(-.8, .8))
    browser.mouse('mouseReleased', *to_screen(*release))
    return {'holdSeconds': round(hold, 3), 'point': [round(point[0], 1), round(point[1], 1)],
            'release': [round(release[0], 1), round(release[1], 1)]}


def interact(browser, rect, target, seed=None, approach=(380, 210)):
    """Approach the target, settle on it, press once, then drift away."""
    rng = random.Random(seed)
    to_screen = mapper(rect)
    record = {'approach': list(approach), 'target': [round(target[0], 1), round(target[1], 1)]}
    browser.mouse('mouseMoved', *to_screen(*approach))
    time.sleep(.25)
    midpoint = ((approach[0] + target[0]) / 2 + rng.uniform(-40, 40),
                (approach[1] + target[1]) / 2 + rng.uniform(-30, 30))
    travel(browser, to_screen, approach, midpoint, seconds=.45, jitter=2.2, rng=rng)
    travel(browser, to_screen, midpoint, (target[0] + rng.uniform(-2, 2), target[1] + rng.uniform(-2, 2)),
           seconds=.55, jitter=1.1, rng=rng)
    hover = rng.uniform(.35, .7)
    time.sleep(hover)
    record['hoverSeconds'] = round(hover, 3)
    # Settle onto the exact target with a few slow moves, as a hand does before pressing.
    travel(browser, to_screen, (target[0] + 2, target[1] + 2), target, seconds=.2, jitter=.4, rng=rng)
    time.sleep(rng.uniform(.08, .2))
    record['press'] = press(browser, to_screen, target, rng=rng)
    time.sleep(rng.uniform(.3, .6))
    travel(browser, to_screen, target, (target[0] + rng.uniform(60, 160), target[1] + rng.uniform(40, 120)),
           seconds=.5, jitter=1.5, rng=rng)
    return record
