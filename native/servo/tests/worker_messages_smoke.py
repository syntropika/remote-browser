"""Verify real dedicated-worker message fields and window origin isolation offline."""
import argparse
import http.server
import json
import pathlib
import tempfile
import threading
import time
from embedded_smoke import Engine

WORKER = b'''onmessage = event => {
  const fields = {origin:event.origin,sourceNull:event.source===null,trusted:event.isTrusted,ports:event.ports.length,value:event.data.value};
  if(event.ports.length) event.ports[0].postMessage('port received');
  if(event.data.nested) {
    const child = new Worker('worker.js');
    child.onmessage = reply => {postMessage({fields,child:reply.data,childReplyOrigin:reply.origin});child.terminate()};
    child.postMessage({value:'nested payload'});
  } else postMessage({fields});
};'''
PAGE = ('''<!doctype html><meta charset="utf-8"><title>Worker message fixture</title><script>
const results=window.workerResults={};
const workerSource=''' + json.dumps(WORKER.decode()) + ''';
function fields(event){return {origin:event.origin,sourceNull:event.source===null,trusted:event.isTrusted,ports:event.ports.length}}
function spawn(name,source,immediate=false,transfer=false,nested=false){
  const worker=new Worker(source);
  worker.onmessage=event=>{results[name]={reply:fields(event),data:event.data};worker.terminate();if(source.startsWith('blob:')&&!immediate)URL.revokeObjectURL(source)};
  worker.onerror=event=>{results[name]={error:String(event.message)};worker.terminate()};
  if(immediate)URL.revokeObjectURL(source);
  const ports=[];
  if(transfer){const channel=new MessageChannel();channel.port1.onmessage=event=>{results.transferredPort={...fields(event),value:event.data}};ports.push(channel.port2)}
  worker.postMessage({value:name,nested},ports);
}
spawn('external','/worker.js');
spawn('blob',URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})));
spawn('revokedBlob',URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})),true);
spawn('transfer','/worker.js',false,true);
spawn('nested','/worker.js',false,false,true);
const frame=document.createElement('iframe');
addEventListener('message',event=>{
 if(event.data==='window fixture')results.window={origin:event.origin,sourceSelf:event.source===window,trusted:event.isTrusted};
 if(event.data==='cross-origin fixture')results.frame={origin:event.origin,matchesSource:event.source===frame.contentWindow,trusted:event.isTrusted};
});
postMessage('window fixture',location.origin);
document.documentElement.append(frame);frame.src=location.origin.replace('127.0.0.1','localhost')+'/frame';
</script>''').encode()


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = WORKER if self.path == '/worker.js' else (
            b'<script>parent.postMessage("cross-origin fixture","*")</script>'
            if self.path == '/frame' else PAGE)
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript' if self.path == '/worker.js' else 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    try:
        with tempfile.TemporaryDirectory(prefix='servo-worker-messages-') as directory:
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': origin})
                    results = {}
                    deadline = time.monotonic() + 8
                    expected = {'external', 'blob', 'revokedBlob', 'transfer', 'nested', 'transferredPort', 'window', 'frame'}
                    while time.monotonic() < deadline:
                        results = engine.call('evaluate', tab, {'script': 'return window.workerResults || {};'})
                        if expected <= results.keys():
                            break
                        time.sleep(.02)
                    assert expected <= results.keys(), results
                    for name in ('external', 'blob', 'revokedBlob', 'transfer', 'nested'):
                        result = results[name]
                        assert 'error' not in result, result
                        incoming = result['data']['fields']
                        assert incoming['origin'] == '', (name, 'incoming origin', incoming)
                        assert incoming['sourceNull'] and incoming['trusted'], incoming
                        assert incoming['value'] == name, incoming
                        assert incoming['ports'] == (1 if name == 'transfer' else 0), incoming
                        assert result['reply'] == {'origin': '', 'sourceNull': True, 'trusted': True, 'ports': 0}, result
                    nested = results['nested']['data']
                    assert nested['child']['fields'] == {'origin': '', 'sourceNull': True, 'trusted': True, 'ports': 0, 'value': 'nested payload'}, nested
                    assert nested['childReplyOrigin'] == '', nested
                    assert results['transferredPort'] == {'origin': '', 'sourceNull': True, 'trusted': True, 'ports': 0, 'value': 'port received'}, results
                    assert results['window'] == {'origin': origin, 'sourceSelf': True, 'trusted': True}, results
                    assert results['frame'] == {'origin': origin.replace('127.0.0.1', 'localhost'), 'matchesSource': True, 'trusted': True}, results
                finally:
                    engine.stop()
        print('PASS: worker message origins, trusted events, blob revocation, transferred ports, nested workers and window origin isolation')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-binary', type=pathlib.Path, required=True)
    exercise(parser.parse_args().engine_binary.resolve())
