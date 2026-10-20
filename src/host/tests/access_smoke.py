"""Verify the dashboard opens with no credential, refuses another origin, and keeps keys for MCP."""
import argparse
import json
import pathlib
import tempfile
import urllib.error
import urllib.request
from unified_smoke import Runtime

class Browser:
    def __init__(self,origin):self.origin=origin
    def api(self,path,body=None,expected=200,origin=True):
        headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=self.origin if origin is True else origin
        request=urllib.request.Request(self.origin+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
        try:
            response=urllib.request.urlopen(request,timeout=30)
        except urllib.error.HTTPError as error:response=error
        with response:
            raw=response.read()
            # A route that no longer exists answers 404 with no body at all.
            data=json.loads(raw) if raw else {}
            assert response.status==expected,(path,response.status,data)
            return data,response.headers

def run(binary):
    with tempfile.TemporaryDirectory(prefix='browser-access-') as directory:
        root=pathlib.Path(directory);runtime=Runtime(binary,root/'browser')
        origin=runtime.url
        try:
            # The address is printed plainly: there is no token in it, and none in the bundle.
            assert '#' not in origin,origin
            html=urllib.request.urlopen(origin).read().decode()
            assert 'src="app.js"' in html
            bundle=urllib.request.urlopen(origin+'/app.js').read().decode()
            # The only Authorization in the bundle is the instruction an agent is given.
            assert bundle.count('Authorization')==1 and 'Authorization: Bearer <API_KEY>' in bundle
            assert '/api/login' not in bundle and '/api/auth' not in bundle and '/api/logout' not in bundle
            # Opening it is the whole of it: sessions, checks, files and keys, with no sign-in.
            browser=Browser(origin)
            browser.api('/api/auth/status',expected=404)
            assert browser.api('/api/profiles')[0]['profiles']
            browser.api('/api/action',{'profileId':'default','op':'files','args':{}})
            created,_=browser.api('/api/keys',{'name':'Access smoke','profileIds':['default']},201)
            secret=created['secret']
            assert browser.api('/api/keys')[0]['keys']
            # What it still refuses: a request another page made on the person's behalf.
            browser.api('/api/action',{'profileId':'default','op':'files','args':{}},403,origin='https://foreign.example')
            browser.api('/api/keys',{'name':'From a page'},403,origin='https://foreign.example')
            # A local tool sends no origin at all, and that is allowed.
            browser.api('/api/action',{'profileId':'default','op':'files','args':{}},origin=False)
            # A key is still a key: it reaches every session or one, and never several.
            browser.api('/api/keys',{'name':'Two sessions','profileIds':['default','default']},400)
            every,_=browser.api('/api/keys',{'name':'Every session'},201)
            assert every['key']['profileIds'] is None
            browser.api('/api/keys/permissions',{'id':every['key']['id'],'profileIds':['default']})
            browser.api('/api/keys/permissions',{'id':every['key']['id'],'profileIds':None})
        finally:runtime.stop()
        assert secret not in ''.join(runtime.logs)
        assert not (root/'browser/dashboard-account.json').exists()
        # A restart keeps the keys and still opens without anything to present.
        runtime=Runtime(binary,root/'browser')
        try:
            again=Browser(runtime.url)
            assert again.api('/api/profiles')[0]['profiles']
            assert len(again.api('/api/keys')[0]['keys'])==2
        finally:runtime.stop()
    print('PASS: the dashboard opens with no credential, refuses foreign origins, writes no account, and keeps API keys for MCP')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',required=True,type=pathlib.Path);args=parser.parse_args();run(args.engine_binary.resolve())
