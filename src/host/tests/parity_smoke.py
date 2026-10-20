"""Real-engine restoration of native history, clipboard, media and download workflows."""
import argparse,base64,http.server,json,pathlib,subprocess,tempfile,threading,time,urllib.parse,urllib.request
from unified_smoke import Runtime
class Fixture(http.server.BaseHTTPRequestHandler):
    posts=0;ones=0
    def do_GET(self):
        if self.path.startswith('/attachment'):
            self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Disposition','attachment; filename="automatic.txt"');self.end_headers();self.wfile.write(b'automatic authenticated GET');return
        if self.path.startswith('/plain'):
            self.send_response(200);self.send_header('Content-Type','text/plain');self.end_headers();self.wfile.write(b'download attribute response');return
        if self.path.startswith('/one'):Fixture.ones+=1
        body=('''<!doctype html><title>'''+('Two' if self.path.startswith('/two') else 'One')+'''</title><h1>Native feature fixture</h1><input id="notes"><a download="attribute.txt" href="/plain">Download attribute</a><form method="post" action="/export"><input name="payload" value="single original POST"><button>Export</button></form>''').encode()
        self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Set-Cookie','native_export=synthetic; HttpOnly; Path=/');self.end_headers();self.wfile.write(body)
    def do_POST(self):
        assert self.path=='/export';Fixture.posts+=1
        body=self.rfile.read(int(self.headers['Content-Length']));assert b'single+original+POST' in body;assert 'native_export=synthetic' in self.headers.get('Cookie','')
        self.send_response(200);self.send_header('Content-Type','text/plain');self.send_header('Content-Disposition','attachment; filename="post-export.txt"');self.end_headers();self.wfile.write(b'export from the single original POST')
    def log_message(self,*args):pass

def run(binary):
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
    with tempfile.TemporaryDirectory(prefix='browser-parity-') as directory:
        runtime=Runtime(binary,pathlib.Path(directory));client=runtime.client;dashboard=runtime.dashboard
        def control(action,**args):return client.call('browser_control',{'tabId':tab,'action':action,**args})
        def files():return client.call('browser_files',{'action':'list'})['files']
        def wait_file(suffix):
            for attempt in range(100):
                found=next((file for file in files() if file['id'].endswith(suffix)),None)
                if found:return found
                time.sleep(.1)
            raise AssertionError('Download missing: '+suffix)
        try:
            assert 'browser_control' in [tool['name'] for tool in client.request('tools/list',{})['tools']]
            tab=client.call('browser_tabs',{'action':'open'})['tabId'];client.call('browser_navigate',{'tabId':tab,'url':origin+'/one'})
            client.call('browser_navigate',{'tabId':tab,'url':origin+'/two'});control('back');assert client.call('browser_snapshot',{'tabId':tab})['title']=='One'
            control('forward');assert client.call('browser_snapshot',{'tabId':tab})['title']=='Two'
            control('back');before=Fixture.ones;control('reload');assert Fixture.ones==before+1
            control('clipboard_write',text='Native clipboard text');assert control('clipboard_read')['text']=='Native clipboard text'
            client.call('browser_evaluate',{'tabId':tab,'script':"document.getElementById('notes').focus();return true;"});control('clipboard_paste')
            assert client.call('browser_evaluate',{'tabId':tab,'script':"return document.getElementById('notes').value;"})['value']=='Native clipboard text'
            client.call('browser_evaluate',{'tabId':tab,'script':"document.getElementById('notes').select();return true;"});control('clipboard_copy');assert control('clipboard_read')['text']=='Native clipboard text'
            image=control('save_screenshot',name='fixture.png');assert pathlib.Path(image['path']).read_bytes().startswith(b'\x89PNG')
            query=urllib.parse.urlencode({'profileId':'default','fileId':image['id'],'preview':'true'});request=urllib.request.Request(dashboard.origin+'/api/files/content?'+query,headers={'Range':'bytes=0-7'})
            with urllib.request.urlopen(request) as response:assert response.status==206 and response.read()==b'\x89PNG\r\n\x1a\n'
            control('record_start',name='fixture.mp4',maxSeconds=2);time.sleep(2.5);recording=control('record_status');assert recording['file']['id']=='recordings/fixture.mp4'
            data=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-print_format','json','-show_streams',recording['file']['path']]));assert data['streams'][0]['codec_name']=='h264'
            client.call('browser_navigate',{'tabId':tab,'url':origin+'/attachment'});saved=wait_file('automatic.txt');assert pathlib.Path(saved['path']).read_bytes()==b'automatic authenticated GET'
            client.call('browser_navigate',{'tabId':tab,'url':origin+'/one'});client.call('browser_evaluate',{'tabId':tab,'script':"document.querySelector('a').click();return true;"});saved=wait_file('attribute.txt');assert pathlib.Path(saved['path']).read_bytes()==b'download attribute response'
            client.call('browser_navigate',{'tabId':tab,'url':origin+'/one'});client.call('browser_evaluate',{'tabId':tab,'script':"document.querySelector('form').requestSubmit();return true;"});saved=wait_file('post-export.txt');assert pathlib.Path(saved['path']).read_bytes()==b'export from the single original POST';assert Fixture.posts==1
            client.call('browser_navigate',{'tabId':tab,'url':origin+'/one'});client.call('browser_evaluate',{'tabId':tab,'script':"const a=document.createElement('a');a.download='blob.txt';a.href=URL.createObjectURL(new Blob(['blob download']));document.body.append(a);a.click();return true;"});saved=wait_file('blob.txt');assert pathlib.Path(saved['path']).read_bytes()==b'blob download'
            for file in files():client.call('browser_files',{'action':'delete','fileId':file['id']})
            assert not files()
        finally:
            runtime.stop();server.shutdown()

    print('PASS: native history/reload, clipboard copy/paste, saved PNG and byte ranges, playable MP4, automatic GET/download attribute/blob, single authenticated POST export and cleanup')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',type=pathlib.Path,required=True);args=parser.parse_args();run(args.engine_binary.resolve())
