"""Exercise local files, native upload, authenticated downloads and cleanup."""
import argparse
import base64
import http.server
import json
import os
import pathlib
import tempfile
import threading
import urllib.parse
from unified_smoke import Runtime

PAYLOAD = b'local file workspace\x00\xff\n'
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path == '/private':
            if 'workspace_session=valid' not in self.headers.get('Cookie',''):
                self.send_response(401); self.end_headers(); return
            data=PAYLOAD; content='application/octet-stream'
        elif self.path == '/large':
            data=b'x'*(20*1024*1024+1); content='application/octet-stream'
        elif self.path == '/no-cors':
            data=PAYLOAD; content='application/octet-stream'
        else:
            data=b'''<!doctype html><title>Files test</title><input id="file" type="file" multiple><input id="text"><button id="upload">Submit file</button><pre id="result"></pre><script>document.getElementById('upload').onclick=async()=>{const body=new FormData();body.append('file',document.getElementById('file').files[0]);const response=await fetch('/upload',{method:'POST',body});document.getElementById('result').textContent=await response.text();};</script>''';content='text/html'
        self.send_response(200); self.send_header('Content-Type',content); self.send_header('Content-Length',str(len(data))); self.send_header('Set-Cookie','workspace_session=valid; HttpOnly; SameSite=Lax'); self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_POST(self):
        data=self.rfile.read(int(self.headers['Content-Length']))
        result=json.dumps({'received':PAYLOAD in data}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(result)));self.end_headers();self.wfile.write(result)

def run(binary):
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
    other=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=other.serve_forever,daemon=True).start()
    origin='http://127.0.0.1:'+str(server.server_port)
    with tempfile.TemporaryDirectory(prefix='browser-files-test-') as directory:
        root=pathlib.Path(directory);env=dict(os.environ,REMOTE_BROWSER_FILES_ROOT=str(root/'shared'))
        runtime=Runtime(binary,root/'browser',env);client=runtime.client;dash=runtime.dashboard
        try:
            def files(action,**kwargs):return client.call('browser_files',{'action':action,**kwargs})
            tab=client.call('browser_tabs',{'action':'open'})['tabId']
            lease=client.call('browser_tabs',{'action':'reserve','agentName':'Test agent','tabId':tab,'task':'files smoke'})['leaseId']
            client.call('browser_navigate',{'tabId':tab,'leaseId':lease,'url':origin})
            info=files('list');assert pathlib.Path(info['root'])==root/'shared/default',info
            staged=files('stage',name='test.bin',offset=0,data=base64.b64encode(PAYLOAD).decode())
            assert pathlib.Path(staged['path']).read_bytes()==PAYLOAD
            client.call('browser_files',{'action':'stage','name':'test.bin','offset':0,'data':'eA=='},expect_error=True)
            snapshot=client.call('browser_snapshot',{'tabId':tab,'leaseId':lease})
            reference=next(e['reference'] for e in snapshot['elements'] if e['type']=='file')
            text_ref=next(e['reference'] for e in snapshot['elements'] if e['tag']=='input' and e['type']!='file')
            client.call('browser_upload',{'tabId':tab,'leaseId':lease,'reference':text_ref,'fileIds':['uploads/test.bin']},expect_error=True)
            assert client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':"return document.getElementById('text').value;"})['value']==''
            snapshot=client.call('browser_snapshot',{'tabId':tab,'leaseId':lease})
            reference=next(e['reference'] for e in snapshot['elements'] if e['type']=='file')

            client.call('browser_upload',{'tabId':tab,'reference':reference,'fileIds':['uploads/test.bin']},expect_error=True)
            client.call('browser_upload',{'tabId':tab,'leaseId':lease,'reference':reference,'fileIds':['uploads/test.bin']})
            selected=client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':"return {name:document.getElementById('file').files[0].name,size:document.getElementById('file').files[0].size};"})['value']
            assert selected=={'name':'test.bin','size':len(PAYLOAD)},selected
            client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':"document.getElementById('upload').click();return true;"})
            import time
            for _ in range(30):
                result=client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':"return document.getElementById('result').textContent;"})['value']
                if result:break
                time.sleep(.1)
            assert json.loads(result)['received'],result
            downloaded=client.call('browser_download',{'tabId':tab,'leaseId':lease,'url':'/private','name':'private.bin'})
            assert pathlib.Path(downloaded['path']).read_bytes()==PAYLOAD
            assert base64.b64decode(files('read',fileId='downloads/private.bin',offset=0)['data'])==PAYLOAD
            blob=client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':"return URL.createObjectURL(new Blob(['blob download']));"})['value']
            blob_file=client.call('browser_download',{'tabId':tab,'leaseId':lease,'url':blob,'name':'blob.txt'})
            assert pathlib.Path(blob_file['path']).read_bytes()==b'blob download'
            files('delete',fileId='downloads/blob.txt')
            chunk=b'a'*32768
            files('stage',name='chunks.bin',offset=0,data=base64.b64encode(chunk).decode())
            files('stage',name='chunks.bin',offset=len(chunk),data=base64.b64encode(PAYLOAD).decode())
            assert base64.b64decode(files('read',fileId='uploads/chunks.bin',offset=len(chunk))['data'])==PAYLOAD
            files('delete',fileId='uploads/chunks.bin')

            client.call('browser_download',{'tabId':tab,'leaseId':lease,'url':'/private','name':'private.bin'},expect_error=True)
            client.call('browser_download',{'tabId':tab,'leaseId':lease,'url':'/large','name':'large.bin'},expect_error=True)
            client.call('browser_download',{'tabId':tab,'leaseId':lease,'url':f'http://127.0.0.1:{other.server_port}/no-cors','name':'cors.bin'},expect_error=True)
            client.call('browser_files',{'action':'delete','fileId':'uploads/../../outside'},expect_error=True)
            profile=client.call('browser_profiles',{'action':'create','name':'Other account'})['id']
            assert files('list',profileId=profile)['files']==[]
            client.call('browser_files',{'action':'delete','profileId':profile,'fileId':'uploads/test.bin'},expect_error=True)
            # A native file chooser can be observed and completed on the same tab.
            snapshot=client.call('browser_snapshot',{'tabId':tab,'leaseId':lease})
            reference=next(e['reference'] for e in snapshot['elements'] if e['type']=='file')
            dash.action('take',tab)
            dash.action('input',tab,{'kind':'click','x':20,'y':15})
            for _ in range(30):
                if files('list')['pickers']:break
                time.sleep(.1)
            assert files('list')['pickers'], 'Native picker did not open'
            client.call('browser_files',{'action':'choose','tabId':tab,'leaseId':lease,'fileIds':['uploads/test.bin']},expect_error=True)
            dash.action('choose_files',tab,{'fileIds':['uploads/test.bin']})
            assert not files('list')['pickers']
            files('delete',fileId='uploads/test.bin'); files('delete',fileId='downloads/private.bin')
            assert files('list')['files']==[]
            assert not pathlib.Path(staged['path']).exists() and not pathlib.Path(downloaded['path']).exists()
            assert not client.call('browser_status',{})['uncertain']
            print('PASS: isolated local folders, staged upload and form submission, authenticated download, limits, CORS, native picker, reservations, reads and deletion')
        finally:runtime.stop()
        archived=''.join(runtime.logs)
        assert str(root/'shared') not in archived and 'uploads/test.bin' not in archived and base64.b64encode(PAYLOAD).decode() not in archived
        runtime=Runtime(binary,root/'browser',env)
        try:assert runtime.client.call('browser_files',{'action':'list'})['files']==[]
        finally:runtime.stop()
    server.shutdown();other.shutdown()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',required=True,type=pathlib.Path);args=parser.parse_args();run(args.engine_binary.resolve())
