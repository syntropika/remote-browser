"""Verify the embedded executable through MCP and the authenticated dashboard."""
import argparse
import http.server
import json
import pathlib
import queue
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from embedded_smoke import Fixture
from smoke import Mcp

class Client(Mcp):
    def __init__(self, process):
        super().__init__(process)
        self.saved = {}
    def begin(self, name, arguments):
        self.sequence += 1
        self.send({'jsonrpc':'2.0','id':self.sequence,'method':'tools/call','params':{'name':name,'arguments':arguments}})
        return self.sequence
    def finish(self, identifier):
        while identifier not in self.saved:
            message = self.messages.get(timeout=20)
            assert 'eof' not in message and 'invalid_stdout' not in message, message
            self.saved[message['id']] = message
        message = self.saved.pop(identifier)
        assert 'error' not in message and not message['result'].get('isError'), message
        return message['result']['structuredContent']

class Dashboard:
    def __init__(self, url):
        self.origin,self.token = url.split('/#token=')
    def api(self, path, body=None, expected=200, token=True, origin=None):
        headers = {'Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+self.token
        if origin: headers['Origin']=origin
        request=urllib.request.Request(self.origin+path,data=json.dumps(body).encode() if body else None,headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=20) as response:
                status=response.status;data=json.load(response)
        except urllib.error.HTTPError as error:
            status=error.code;data=json.load(error)
        assert status==expected,(status,data)
        return data
    def action(self, op, tab=None, args=None, profile='default', expected=200):
        return self.api('/api/action',{'profileId':profile,'op':op,'tabId':tab,'args':args or {}},expected)

class Runtime:
    def __init__(self,binary,root):
        self.process=subprocess.Popen([str(binary),'--profile-root',str(root),'--dashboard-port','0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.logs=[]; urls=queue.Queue()
        def read():
            for line in self.process.stderr:
                self.logs.append(line)
                if line.startswith('Servo dashboard: '):urls.put(line.removeprefix('Servo dashboard: ').strip())
        threading.Thread(target=read,daemon=True).start()
        self.client=Client(self.process)
        self.client.request('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'unified-smoke','version':'1'}})
        self.client.send({'jsonrpc':'2.0','method':'notifications/initialized'})
        self.url=urls.get(timeout=20)
        self.dashboard=Dashboard(self.url)
    def stop(self):
        self.process.stdin.close();self.process.wait(timeout=10)
        assert self.process.returncode==0,''.join(self.logs[-30:])


def exercise(binary,hold):
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin='http://127.0.0.1:'+str(server.server_port)
    with tempfile.TemporaryDirectory(prefix='servo-unified-') as directory:
        runtime=Runtime(binary,pathlib.Path(directory));client=runtime.client;dashboard=runtime.dashboard
        try:
            assert len(client.request('tools/list',{})['tools'])==12
            dashboard.api('/api/profiles',token=False,expected=401)
            dashboard.api('/api/profiles',origin='https://foreign.example',expected=403)
            a=client.call('browser_tabs',{'action':'open'})['tabId']
            b=client.call('browser_tabs',{'action':'open'})['tabId']
            lease=client.call('browser_tabs',{'action':'reserve','tabId':a,'task':'agent a'})['leaseId']
            lease_b=client.call('browser_tabs',{'action':'reserve','tabId':b,'task':'agent b'})['leaseId']
            client.call('browser_navigate',{'tabId':b,'leaseId':lease_b,'url':origin})
            Fixture.slow_started.clear()
            slow=client.begin('browser_navigate',{'tabId':a,'leaseId':lease,'url':origin+'/slow'})
            assert Fixture.slow_started.wait(3)
            fast=client.begin('browser_evaluate',{'tabId':b,'leaseId':lease_b,'script':'return 42;'})
            assert client.finish(fast)['value']==42
            assert slow not in client.saved
            client.finish(slow)
            dashboard.action('view',a)
            assert dashboard.action('screenshot',a)
            dashboard.action('input',a,{'kind':'key','key':'x'},expected=409)
            dashboard.action('take',a)
            client.call('browser_evaluate',{'tabId':a,'leaseId':lease,'script':'return 1;'},expect_error=True)
            dashboard.action('navigate',a,{'url':origin})
            dashboard.action('return',a)
            client.call('browser_evaluate',{'tabId':a,'leaseId':lease,'script':'return 1;'},expect_error=True)
            created=client.call('browser_profiles',{'action':'create','name':'Account two'})
            extra=dashboard.api('/api/profiles',{'name':'Account three'})
            assert len(dashboard.api('/api/profiles')['profiles'])==3
            other=client.call('browser_tabs',{'action':'list','profileId':created['id']})['tabs'][0]['id']
            client.call('browser_navigate',{'profileId':created['id'],'tabId':other,'url':origin})
            client.call('browser_evaluate',{'profileId':created['id'],'tabId':other,'script':"document.cookie='persisted=two; Max-Age=3600; Path=/'; return true;"})
            policy={'origin':origin,'cookieNames':['persisted'],'authenticatedSelector':None,'loginSelector':'#login','warningSeconds':3600}
            dashboard.api('/api/policies',{'profileId':created['id'],'policy':policy})
            assert client.call('browser_session_health',{'profileId':created['id'],'tabId':other,'policy':policy})['state']=='reauthRequired'
            if hold:
                print('DASHBOARD '+runtime.url,flush=True)
                print('FIXTURE '+origin,flush=True)
                print('RESERVED_TAB '+b,flush=True)
                input('Press Enter to complete the UI inspection.\n')
            runtime.stop()
            runtime=Runtime(binary,pathlib.Path(directory));client=runtime.client;dashboard=runtime.dashboard
            assert len(client.call('browser_profiles',{'action':'list'})['profiles'])>=3
            assert dashboard.api('/api/policies',{'profileId':created['id']})['policies']==[policy]
            other=client.call('browser_tabs',{'action':'list','profileId':created['id']})['tabs'][0]['id']
            client.call('browser_navigate',{'profileId':created['id'],'tabId':other,'url':origin})
            assert 'persisted=two' in client.call('browser_evaluate',{'profileId':created['id'],'tabId':other,'script':'return document.cookie;'})['value']
            default=client.call('browser_tabs',{'action':'list'})['tabs'][0]['id']
            client.call('browser_navigate',{'tabId':default,'url':origin})
            assert 'persisted=two' not in client.call('browser_evaluate',{'tabId':default,'script':'return document.cookie;'})['value']
            print('PASS: unified executable, concurrent MCP calls, three isolated profiles, dashboard authorization, input gates, takeover, persisted catalog, policies and cookies')
        finally:
            if runtime.process.poll() is None:runtime.stop()
    server.shutdown();server.server_close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary',required=True,type=pathlib.Path)
    parser.add_argument('--hold-ui',action='store_true')
    args=parser.parse_args()
    exercise(args.engine_binary.resolve(),args.hold_ui)
