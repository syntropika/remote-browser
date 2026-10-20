"""Keep page-controlled tab metadata from breaking the native profile transport."""
import argparse
import http.server
import pathlib
import tempfile
import threading
import time
from embedded_smoke import Fixture
from unified_smoke import Runtime


def exercise(binary):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    try:
        with tempfile.TemporaryDirectory(prefix='browser-metadata-') as directory:
            runtime = Runtime(binary, pathlib.Path(directory))
            client = runtime.client
            try:
                tab = client.call('browser_tabs', {'action': 'list'})['tabs'][0]['id']
                client.call('browser_navigate', {'tabId': tab, 'url': origin})
                client.call('browser_evaluate', {
                    'tabId': tab,
                    'script': "document.title='metadata-'+ 'x'.repeat(9*1024*1024);return true;",
                })
                for _ in range(20):
                    listing = client.call('browser_tabs', {'action': 'list'})['tabs']
                    item = next(item for item in listing if item['id'] == tab)
                    if (item['title'] or '').startswith('metadata-'):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('Engine did not report the fixture title')
                assert len(item['title'].encode()) <= 4096, 'Page title exceeded its byte budget'
                client.call('browser_evaluate', {
                    'tabId': tab,
                    'script': "document.title='unicode-'+ '\U0001f4a1\"'.repeat(2048);location.hash='u'.repeat(128*1024);return true;",
                })
                for _ in range(20):
                    listing = client.call('browser_tabs', {'action': 'list'})['tabs']
                    item = next(item for item in listing if item['id'] == tab)
                    if (item['title'] or '').startswith('unicode-') and '#' in (item['url'] or ''):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('Engine did not report the fixture URL')
                assert len(item['title'].encode()) <= 4096
                assert len(item['url'].encode()) <= 16384, 'Page URL exceeded its byte budget'
                assert client.call('browser_evaluate', {'tabId': tab, 'script': 'return 42;'})['value'] == 42
                assert not client.call('browser_status', {})['uncertain']
                assert runtime.dashboard.action('tabs')
                print('PASS: oversized titles, escaped Unicode, long URLs, subsequent automation and dashboard access')
            finally:
                runtime.stop()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    args = parser.parse_args()
    exercise(args.engine_binary.resolve())
