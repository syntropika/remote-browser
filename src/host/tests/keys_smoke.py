"""Verify keys managed from the dashboard address authorize HTTP MCP, and revocation lasts."""
import argparse,hashlib,json,pathlib,queue,socket,subprocess,tempfile,threading,urllib.error,urllib.request
from access_smoke import Browser
from unified_smoke import Client
from http_smoke import Http

class Runtime:
    def __init__(self,binary,root,seed):
        self.root=root;self.logs=[];urls=queue.Queue()
        token=root/'seed';token.write_text(seed);token.chmod(0o600)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        self.process=subprocess.Popen([str(binary),'--profile-root',str(root/'browser'),'--dashboard-port','0','--mcp-http-port',str(port),'--mcp-http-token-file',str(token)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def read():
            for line in self.process.stderr:
                self.logs.append(line)
                if line.startswith('Remote Browser dashboard: '):urls.put(line.removeprefix('Remote Browser dashboard: ').strip())
        threading.Thread(target=read,daemon=True).start()
        self.stdio=Client(self.process);self.stdio.request('initialize',INIT);self.stdio.send({'jsonrpc':'2.0','method':'notifications/initialized'})
        self.url=urls.get(timeout=20);self.origin=self.url;self.http=Http(f'http://127.0.0.1:{port}',seed)
    def stop(self):
        self.process.stdin.close();self.process.wait(timeout=15);assert self.process.returncode==0
INIT={'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'keys-smoke','version':'1'}}
def run(binary):
    with tempfile.TemporaryDirectory(prefix='browser-key-test-') as directory:
        root=pathlib.Path(directory);seed='synthetic-existing-integration-secret'
        # The original Node registry schema, including a named key and its digest.
        registry=root/'browser/api-keys.json';registry.parent.mkdir();registry.write_text(json.dumps({'version':1,'keys':[{'id':'ab'*16,'name':'Existing integration','prefix':'legacy','legacy':True,'createdAt':'2026-01-01T00:00:00.000Z','lastUsedAt':None,'hash':hashlib.sha256(seed.encode()).hexdigest()}]}));registry.chmod(0o600)
        runtime=Runtime(binary,root,seed);owner=Browser(runtime.origin)
        try:
            assert owner.api('/api/keys')[0]['keys'][0]['id']=='ab'*16
            owner.api('/api/keys',{'name':'No origin'},403,origin=False)
            owner.api('/api/keys',{'name':'Wrong origin'},403,origin='https://foreign.example')
            owner.api('/api/keys',{'name':'bad\u200bname'},400)
            created=owner.api('/api/keys',{'name':' Work laptop '},201)[0];secret=created['secret'];identifier=created['key']['id'];assert created['key']['name']=='Work laptop'
            active=Http(runtime.http.origin,secret);active.request('initialize',INIT);assert len(active.request('tools/list',{})['result']['tools'])==16
            profile=owner.api('/api/profiles',{'name':'Restricted profile'})[0]['id']
            limited=owner.api('/api/keys',{'name':'Restricted key','profileIds':[profile]},201)[0]
            limited_http=Http(runtime.http.origin,limited['secret']);limited_http.request('initialize',INIT)
            assert [item['id'] for item in limited_http.call('browser_profiles',{'action':'list'})['profiles']]==[profile]
            limited_http.call('browser_tabs',{'action':'list','profileId':'default'},error=True)
            limited_http.call('browser_profiles',{'action':'create','name':'Denied'},error=True)
            # A key belongs to MCP: the dashboard has no sign-in to present it to.
            Browser(runtime.origin).api('/api/login/key',{'secret':limited['secret']},404)
            tab=limited_http.call('browser_tabs',{'action':'open','profileId':profile})['tabId']
            lease=limited_http.call('browser_tabs',{'action':'reserve','agentName':'Agent one','profileId':profile,'tabId':tab,'task':'limited client'})['leaseId']
            active.call('browser_evaluate',{'profileId':profile,'tabId':tab,'leaseId':lease,'script':'return 42;'},error=True)
            active.call('browser_tabs',{'action':'renew','profileId':profile,'tabId':tab,'leaseId':lease},error=True)
            active.call('browser_tabs',{'action':'release','profileId':profile,'tabId':tab,'leaseId':lease},error=True)
            assert limited_http.call('browser_evaluate',{'profileId':profile,'tabId':tab,'leaseId':lease,'script':'return 42;'})['value']==42
            second=limited_http.call('browser_tabs',{'action':'open','profileId':profile})['tabId']
            second_lease=limited_http.call('browser_tabs',{'action':'reserve','profileId':profile,'tabId':second,'agentName':'Agent two','task':'second task'})['leaseId']
            limited_http.call('browser_evaluate',{'profileId':profile,'tabId':second,'leaseId':lease,'script':'return 9;'},error=True)
            assert limited_http.call('browser_evaluate',{'profileId':profile,'tabId':second,'leaseId':second_lease,'script':'return 9;'})['value']==9
            reservations=limited_http.call('browser_tabs',{'action':'list','profileId':profile})['tabs']
            assert next(item for item in reservations if item['id']==tab)['reservation']['agentName']=='Agent one'
            assert next(item for item in reservations if item['id']==second)['reservation']['agentName']=='Agent two'
            limited_http.call('browser_tabs',{'action':'reserve','profileId':profile,'tabId':tab,'agentName':'Agent two','task':'conflict'},error=True)
            owner.api('/api/keys/permissions',{'id':limited['key']['id'],'profileIds':['default']})
            limited_http.call('browser_tabs',{'action':'list','profileId':profile},error=True)
            owner.api('/api/keys/permissions',{'id':limited['key']['id'],'profileIds':[]},400)
            # A key reaches one session or every session, never a handful.
            owner.api('/api/keys/permissions',{'id':limited['key']['id'],'profileIds':['default',profile]},400)
            owner.api('/api/keys',{'name':'Two sessions','profileIds':['default',profile]},400)
            owner.api('/api/keys/permissions',{'id':limited['key']['id'],'profileIds':['missing']},400)
            owner.api('/api/keys/revoke',{'id':limited['key']['id']})
            limited_http.request('tools/list',{},expected=401)
            listing=owner.api('/api/keys')[0];assert secret not in json.dumps(listing) and 'hash' not in json.dumps(listing)
            assert next(key for key in listing['keys'] if key['id']==identifier)['lastUsedAt']
            assert secret not in registry.read_text()
            owner.api('/api/keys/revoke',{'id':identifier});active.request('tools/list',{},expected=401)
            owner.api('/api/keys/revoke',{'id':'ab'*16});runtime.http.request('tools/list',{},expected=401)
            assert owner.api('/api/keys')[0]['keys']==[]
        finally:runtime.stop()
        assert secret not in ''.join(runtime.logs) and seed not in ''.join(runtime.logs)
        restored=Runtime(binary,root,seed)
        try:
            owner=Browser(restored.origin);assert owner.api('/api/keys')[0]['keys']==[]
            restored.http.request('initialize',INIT,expected=401)
            Http(restored.http.origin,secret).request('initialize',INIT,expected=401)
            registry.write_text('{}');restored.http.request('initialize',INIT,expected=503);owner.api('/api/keys',expected=503)
        finally:restored.stop()
    print('PASS: local key creation/list/revocation, one session or every session, Origin enforcement, compatible registry, one-time secrets, last use, HTTP authentication, restart and fail-closed corruption')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',type=pathlib.Path,required=True);args=parser.parse_args();run(args.engine_binary.resolve())
