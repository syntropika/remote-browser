"""Verify HTTP and stdio share profiles, leases and human ownership."""
import argparse,json,os,pathlib,queue,socket,subprocess,tempfile,threading,urllib.error,urllib.request
from unified_smoke import Client,Dashboard

class Http:
    def __init__(self,origin,token):self.origin=origin;self.token=token;self.sequence=0
    def request(self,method,params,authorized=True,origin=None,expected=200):
        self.sequence+=1
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'}
        if authorized:headers['Authorization']='Bearer '+self.token
        if origin:headers['Origin']=origin
        request=urllib.request.Request(self.origin+'/mcp',data=json.dumps({'jsonrpc':'2.0','id':self.sequence,'method':method,'params':params}).encode(),headers=headers)
        try:response=urllib.request.urlopen(request,timeout=20)
        except urllib.error.HTTPError as error:response=error
        with response:
            raw=response.read();assert response.status==expected,(response.status,raw[:500])
            return json.loads(raw) if expected==200 else None
    def call(self,name,args,error=False):
        data=self.request('tools/call',{'name':name,'arguments':args})['result'];assert bool(data.get('isError'))==error,data
        return data.get('structuredContent',data)

def run(binary):
    with tempfile.TemporaryDirectory(prefix='browser-http-test-') as directory:
        root=pathlib.Path(directory);secret='synthetic-http-integration-secret-only';token=root/'token';token.write_text(secret);token.chmod(0o600)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        process=subprocess.Popen([str(binary),'--profile-root',str(root/'browser'),'--dashboard-port','0','--mcp-http-port',str(port),'--mcp-http-token-file',str(token)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        logs=[];urls=queue.Queue()
        def read():
            for line in process.stderr:
                logs.append(line)
                if line.startswith('Remote Browser dashboard: '):urls.put(line.removeprefix('Remote Browser dashboard: ').strip())
        threading.Thread(target=read,daemon=True).start()
        stdio=Client(process);stdio.request('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'http-smoke','version':'1'}});stdio.send({'jsonrpc':'2.0','method':'notifications/initialized'})
        dashboard=Dashboard(urls.get(timeout=20));http=Http(f'http://127.0.0.1:{port}',secret)
        try:
            init={'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'http-smoke','version':'1'}}
            http.request('initialize',init,authorized=False,expected=401)
            http.request('initialize',init,origin='https://foreign.example',expected=403)
            assert 'result' in http.request('initialize',init)
            assert len(http.request('tools/list',{})['result']['tools'])==16
            tab=stdio.call('browser_tabs',{'action':'open'})['tabId']
            assert any(t['id']==tab for t in http.call('browser_tabs',{'action':'list'})['tabs'])
            lease=http.call('browser_tabs',{'action':'reserve','agentName':'Test agent','tabId':tab,'task':'shared HTTP lease'})['leaseId']
            stdio.call('browser_evaluate',{'tabId':tab,'script':'return 42;'},expect_error=True)
            stdio.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'return 42;'},expect_error=True)
            assert http.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'return 84;'})['value']==84
            dashboard.action('take',tab)
            http.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'return 42;'},error=True)
            assert http.call('browser_profiles',{'action':'list'})['profiles'][0]['id']=='default'
        finally:process.stdin.close();process.wait(timeout=15)
        assert process.returncode==0,''.join(logs[-10:])
        assert secret not in ''.join(logs)
    print('PASS: authenticated HTTP MCP, origin validation, discovery, shared stdio tabs/leases, human takeover and secret redaction')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',required=True,type=pathlib.Path);args=parser.parse_args();run(args.engine_binary.resolve())
