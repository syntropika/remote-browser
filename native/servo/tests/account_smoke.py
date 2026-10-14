"""Verify owner login without bearer tokens and legacy Node account compatibility."""
import argparse
import hashlib
import http.cookiejar
import json
import pathlib
import subprocess
import tempfile
import urllib.error
import urllib.request
from unified_smoke import Runtime

class Browser:
    def __init__(self,origin):
        self.origin=origin;self.cookies=http.cookiejar.CookieJar();self.client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
    def api(self,path,body=None,expected=200,origin=True):
        headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=self.origin if origin is True else origin
        request=urllib.request.Request(self.origin+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
        try:
            response=self.client.open(request,timeout=30)
        except urllib.error.HTTPError as error:response=error
        with response:
            raw=response.read();data=json.loads(raw)
            assert response.status==expected,(response.status,data)
            return data,response.headers

def run(binary):
    with tempfile.TemporaryDirectory(prefix='servo-owner-login-') as directory:
        root=pathlib.Path(directory);runtime=Runtime(binary,root/'browser')
        browser=Browser(runtime.url.split('/#token=')[0]);secret='Synthetic password for owner tests'
        credentials={'username':'Test owner','password':secret}
        try:
            html=urllib.request.urlopen(browser.origin).read().decode()
            assert 'id="username"' in html and 'id="password"' in html and 'Access token' not in html
            assert browser.api('/api/auth/status')[0]=={'configured':False,'authenticated':False}
            browser.api('/api/profiles',expected=401)
            browser.api('/api/auth/setup',credentials,403,origin=False)
            browser.api('/api/auth/setup',credentials,403,origin='https://foreign.example')
            _,headers=browser.api('/api/auth/setup',credentials,201)
            cookie=headers.get('Set-Cookie');assert 'HttpOnly; SameSite=Strict; Path=/' in cookie and 'Max-Age=28800' in cookie
            assert browser.api('/api/auth/status')[0]=={'configured':True,'authenticated':True}
            assert browser.api('/api/profiles')[0]['profiles']
            action={'profileId':'default','op':'files','args':{}}
            browser.api('/api/action',action,403,origin=False)
            browser.api('/api/action',action)
            browser.api('/api/auth/setup',credentials,409)
            browser.api('/api/logout',{},200)
            browser.api('/api/profiles',expected=401)
            browser.api('/api/login',{'username':'test owner','password':'a wrong synthetic password'},401)
            browser.api('/api/login',credentials)
            assert browser.api('/api/auth/status')[0]['authenticated']
            record=root/'browser/dashboard-account.json';digest=hashlib.sha256(record.read_bytes()).hexdigest()
        finally:runtime.stop()
        assert secret not in ''.join(runtime.logs) and cookie.split(';')[0].split('=')[1] not in ''.join(runtime.logs)
        runtime=Runtime(binary,root/'browser');browser=Browser(runtime.url.split('/#token=')[0])
        try:
            assert browser.api('/api/auth/status')[0]=={'configured':True,'authenticated':False}
            browser.api('/api/login',credentials)
            assert hashlib.sha256(record.read_bytes()).hexdigest()==digest
        finally:runtime.stop()
        # Import the exact original Node scrypt record without plaintext migration.
        legacy=root/'legacy';legacy.mkdir();account=legacy/'dashboard-account.json'
        node="""const {randomBytes,scryptSync}=require('node:crypto');const fs=require('node:fs');const name='ＮativeUser';const salt=randomBytes(16);fs.writeFileSync(process.argv[1],JSON.stringify({version:1,id:randomBytes(16).toString('hex'),username:name,canonicalUsername:name.normalize('NFKC').toLowerCase(),algorithm:'scrypt',N:32768,r:8,p:1,salt:salt.toString('hex'),passwordHash:scryptSync('legacy synthetic password',salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}),{mode:0o600});"""
        subprocess.run(['node','-e',node,str(account)],check=True)
        legacy_digest=hashlib.sha256(account.read_bytes()).hexdigest()
        runtime=Runtime(binary,legacy);browser=Browser(runtime.url.split('/#token=')[0])
        try:
            assert browser.api('/api/auth/status')[0]['configured']
            browser.api('/api/login',{'username':'nativeuser','password':'legacy synthetic password'})
            assert browser.api('/api/profiles')[0]['profiles']
            assert hashlib.sha256(account.read_bytes()).hexdigest()==legacy_digest
            # Missing-cookie mutations and forged sessions remain unauthorized.
            anonymous=Browser(browser.origin)
            anonymous.api('/api/action',{'profileId':'default','op':'files','args':{}},401)
        finally:runtime.stop()
    print('PASS: username/password setup and login, HttpOnly sessions, logout, origin gates, persistence, credential redaction and unchanged legacy Node scrypt record')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',required=True,type=pathlib.Path);args=parser.parse_args();run(args.engine_binary.resolve())
