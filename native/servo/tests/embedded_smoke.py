"""Verify independent embedded Servo views, profile isolation and session persistence."""
import argparse
import base64
import http.server
import json
import pathlib
import queue
import subprocess
import tempfile
import threading
import time
from smoke import PAGE, reference

WELCOME = b'<!doctype html><html><head><title>Welcome</title></head><body data-authenticated="true"><h1>Signed in</h1></body></html>'
class Fixture(http.server.BaseHTTPRequestHandler):
    slow_started = threading.Event()
    def do_GET(self):
        if self.path == '/slow':
            self.slow_started.set()
            time.sleep(2)
        body = WELCOME if self.path in ('/welcome', '/short') else PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        if self.path == '/short':
            self.send_header('Set-Cookie', 'auth_marker=synthetic; HttpOnly; Max-Age=60; Path=/')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
class Engine:
    def __init__(self, binary, directory, log):
        self.process = subprocess.Popen([str(binary), "--engine-profile", str(directory)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        self.sequence = 0
        self.messages = queue.Queue()
        self.saved = {}
        threading.Thread(target=self.read, daemon=True).start()
    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
    def send(self, op, tab=None, args=None, lease=None, human=False):
        self.sequence += 1
        message = {'id':self.sequence, 'op':op, 'tabId':tab, 'leaseId':lease, 'human':human, 'args':args or {}}
        self.process.stdin.write(json.dumps(message)+'\n')
        self.process.stdin.flush()
        return self.sequence
    def receive(self, expected, error=False):
        deadline = time.monotonic() + 18
        while expected not in self.saved:
            message = self.messages.get(timeout=max(.01, deadline-time.monotonic()))
            self.saved[message['id']] = message
        message = self.saved.pop(expected)
        assert ('error' in message) == error, message
        return message.get('value',message.get('error'))
    def call(self, op, tab=None, args=None, lease=None, human=False, error=False):
        return self.receive(self.send(op,tab,args,lease,human),error)
    def stop(self):
        if self.process.poll() is None:
            self.call('shutdown')
            self.process.stdin.close()
            self.process.wait(timeout=10)
        assert self.process.returncode == 0

def exercise(binary):
    fixture = http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=fixture.serve_forever,daemon=True).start()
    origin = 'http://127.0.0.1:'+str(fixture.server_port)
    with tempfile.TemporaryDirectory(prefix='embedded-servo-') as temporary:
        with open(pathlib.Path(temporary)/'engine.log','w+') as log:
            engines=[]
            try:
                first=Engine(binary,pathlib.Path(temporary)/'profile-a',log);engines.append(first)
                second=Engine(binary,pathlib.Path(temporary)/'profile-b',log);engines.append(second)
                root=next(tab['id'] for tab in first.call('tabs') if tab['active'])
                a=first.call('open');b=first.call('open')
                lease_a=first.call('reserve',a,{'task':'agent a'})['leaseId']
                lease_b=first.call('reserve',b,{'task':'agent b'})['leaseId']
                first.call('navigate',a,{'url':origin},lease_a)
                first.call('navigate',b,{'url':origin},lease_b)
                page_a=first.call('snapshot',a,lease=lease_a)
                page_b=first.call('snapshot',b,lease=lease_b)
                first.call('fill',a,{'reference':reference(page_a,'Email'),'text':'a@example.test'},lease_a)
                first.call('fill',b,{'reference':reference(page_b,'Email'),'text':'b@example.test'},lease_b)
                first.call('click',a,{'reference':reference(page_b,'Sign in')},lease_a,error=True)
                value=first.call('evaluate',a,{'script':"return document.querySelector('#email').value;"},lease_a)
                assert value=='a@example.test',value
                assert first.call('evaluate',b,{'script':"return document.querySelector('#email').value;"},lease_b)=='b@example.test'
                listing=first.call('tabs')
                assert next(tab['id'] for tab in listing if tab['active'])==root
                assert lease_a not in json.dumps(listing)
                first.call('input',a,{'kind':'key','key':'x'},human=True,error=True)
                first.call('navigate',a,{'url':origin+'/welcome'},human=True,error=True)
                first.call('view',a,human=True)
                image=first.call('screenshot',a,human=True)
                assert base64.b64decode(image).startswith(b'\x89PNG\r\n\x1a\n')
                # Loading one tab leaves the other usable before its response arrives.
                Fixture.slow_started.clear()
                slow=first.send('navigate',a,{'url':origin+'/slow'},lease_a)
                assert Fixture.slow_started.wait(3)
                observation=first.send('screenshot',a,human=True)
                assert next(tab for tab in first.call('tabs') if tab['id']==a)['busy']
                fast=first.send('evaluate',b,{'script':'return 42;'},lease_b)
                assert first.receive(fast)==42
                assert slow not in first.saved,'Slow operation completed before the other tab'
                first.call('evaluate',a,{'script':'return 1;'},lease_a,error=True)
                takeover=first.send('take',a,human=True)
                first.receive(slow)
                first.receive(observation)
                first.receive(takeover)
                first.call('navigate',a,{'url':origin},lease_a,error=True)
                first.call('navigate',a,{'url':origin},human=True)
                first.call('return',a,human=True)
                lease_a=first.call('reserve',a,{'task':'agent a resumed'})['leaseId']
                first.call('navigate',a,{'url':origin+'/short'},lease_a)
                policy={'origin':origin,'cookieNames':['auth_marker'],'authenticatedSelector':'[data-authenticated]','loginSelector':'#login','warningSeconds':3600}
                health=first.call('health',a,policy,lease_a)
                assert health['state']=='expiring' and health['secondsRemaining']<=60,health
                assert 'synthetic' not in json.dumps(health)
                assert first.call('evaluate',a,{'script':'return document.cookie;'},lease_a)==''
                first.call('evaluate',a,{'script':"document.cookie='persistent=account-a; Max-Age=3600; Path=/'; localStorage.setItem('account','a'); return true;"},lease_a)
                other=next(tab['id'] for tab in second.call('tabs') if tab['active'])
                second.call('navigate',other,{'url':origin})
                assert 'persistent=' not in second.call('evaluate',other,{'script':'return document.cookie;'})
                assert second.call('evaluate',other,{'script':"return localStorage.getItem('account');"}) is None
                first.call('close',b,lease=lease_b)
                assert len(first.call('tabs'))==2
                first.stop()
                restarted=Engine(binary,pathlib.Path(temporary)/'profile-a',log);engines.append(restarted)
                tab=next(tab['id'] for tab in restarted.call('tabs') if tab['active'])
                restarted.call('navigate',tab,{'url':origin})
                cookies=restarted.call('evaluate',tab,{'script':'return document.cookie;'})
                assert 'persistent=account-a' in cookies,cookies
                assert restarted.call('evaluate',tab,{'script':"return localStorage.getItem('account');"})=='a'
                print('PASS: real embedded Servo, background views, native input, independent references, concurrent tabs, reserved human input, takeover, profile isolation, credential metadata and persistence across restart')
            except Exception:
                log.seek(0);print(log.read()[-6000:]);raise
            finally:
                for engine in engines:
                    if engine.process.poll() is None:
                        try:engine.stop()
                        except Exception:engine.process.kill();engine.process.wait()
    fixture.shutdown();fixture.server_close()
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary',required=True,type=pathlib.Path)
    args=parser.parse_args()
    exercise(args.engine_binary.resolve())
