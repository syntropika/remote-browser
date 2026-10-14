"""Verify owner-managed keys authorize HTTP MCP and revocation survives restarts."""
import argparse,hashlib,json,pathlib,queue,socket,subprocess,tempfile,threading,urllib.error,urllib.request
from account_smoke import Browser
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
                if line.startswith('Servo dashboard: '):urls.put(line.removeprefix('Servo dashboard: ').strip())
        threading.Thread(target=read,daemon=True).start()
        self.stdio=Client(self.process);self.stdio.request('initialize',INIT);self.stdio.send({'jsonrpc':'2.0','method':'notifications/initialized'})
        self.url=urls.get(timeout=20);self.origin=self.url.split('/#token=')[0];self.http=Http(f'http://127.0.0.1:{port}',seed)
    def stop(self):
        self.process.stdin.close();self.process.wait(timeout=15);assert self.process.returncode==0
INIT={'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'keys-smoke','version':'1'}}
def run(binary):
    with tempfile.TemporaryDirectory(prefix='servo-key-test-') as directory:
        root=pathlib.Path(directory);seed='synthetic-existing-integration-secret';credentials={'username':'Test owner','password':'Synthetic owner password for keys'}
        # The original Node registry schema, including a named key and its digest.
        registry=root/'browser/api-keys.json';registry.parent.mkdir();registry.write_text(json.dumps({'version':1,'keys':[{'id':'ab'*16,'name':'Existing integration','prefix':'legacy','legacy':True,'createdAt':'2026-01-01T00:00:00.000Z','lastUsedAt':None,'hash':hashlib.sha256(seed.encode()).hexdigest()}]}));registry.chmod(0o600)
        runtime=Runtime(binary,root,seed);owner=Browser(runtime.origin)
        try:
            owner.api('/api/keys',expected=401);owner.api('/api/auth/setup',credentials,201)
            assert owner.api('/api/keys')[0]['keys'][0]['id']=='ab'*16
            owner.api('/api/keys',{'name':'No origin'},403,origin=False)
            owner.api('/api/keys',{'name':'Wrong origin'},403,origin='https://foreign.example')
            owner.api('/api/keys',{'name':'bad\u200bname'},400)
            created=owner.api('/api/keys',{'name':' Work laptop '},201)[0];secret=created['secret'];identifier=created['key']['id'];assert created['key']['name']=='Work laptop'
            active=Http(runtime.http.origin,secret);active.request('initialize',INIT);assert len(active.request('tools/list',{})['result']['tools'])==15
            listing=owner.api('/api/keys')[0];assert secret not in json.dumps(listing) and 'hash' not in json.dumps(listing)
            assert next(key for key in listing['keys'] if key['id']==identifier)['lastUsedAt']
            assert secret not in registry.read_text()
            request=urllib.request.Request(runtime.origin+'/api/keys',headers={'Authorization':'Bearer '+secret})
            try:urllib.request.urlopen(request);raise AssertionError('Bearer managed keys')
            except urllib.error.HTTPError as error:assert error.code==401
            owner.api('/api/keys/revoke',{'id':identifier});active.request('tools/list',{},expected=401)
            owner.api('/api/keys/revoke',{'id':'ab'*16});runtime.http.request('tools/list',{},expected=401)
            assert owner.api('/api/keys')[0]['keys']==[]
        finally:runtime.stop()
        assert secret not in ''.join(runtime.logs) and seed not in ''.join(runtime.logs)
        restored=Runtime(binary,root,seed)
        try:
            owner=Browser(restored.origin);owner.api('/api/login',credentials);assert owner.api('/api/keys')[0]['keys']==[]
            restored.http.request('initialize',INIT,expected=401)
            Http(restored.http.origin,secret).request('initialize',INIT,expected=401)
            registry.write_text('{}');restored.http.request('initialize',INIT,expected=503);owner.api('/api/keys',expected=503)
        finally:restored.stop()
    print('PASS: owner-only key creation/list/revocation, Origin enforcement, compatible registry, one-time secrets, last use, HTTP authentication, restart and fail-closed corruption')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',type=pathlib.Path,required=True);args=parser.parse_args();run(args.engine_binary.resolve())
