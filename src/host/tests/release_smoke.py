"""Verify that releasing a reserved tab closes it, while the last tab and a taken tab stay."""
import argparse
import pathlib
import tempfile
from unified_smoke import Runtime

def run(binary):
    with tempfile.TemporaryDirectory(prefix='browser-release-') as directory:
        runtime=Runtime(binary,pathlib.Path(directory)/'browser');client=runtime.client
        try:
            tabs=lambda:[tab['id'] for tab in client.call('browser_tabs',{'action':'list'})['tabs']]
            def reserve(tab,task):
                return client.call('browser_tabs',{'action':'reserve','tabId':tab,'agentName':'Release smoke','task':task})['leaseId']
            start=tabs()
            # An agent's own tab goes when the agent is finished with it.
            opened=client.call('browser_tabs',{'action':'open'})['tabId']
            assert opened in tabs(),tabs()
            client.call('browser_tabs',{'action':'release','tabId':opened,'leaseId':reserve(opened,'release')})
            assert opened not in tabs(),f'the released tab stayed open: {tabs()}'
            assert tabs()==start,(tabs(),start)
            # The engine always keeps one tab, so releasing the only one leaves it open.
            alone=tabs()[0]
            client.call('browser_tabs',{'action':'release','tabId':alone,'leaseId':reserve(alone,'last')})
            assert tabs()==[alone],tabs()
            # A tab the person took over is theirs, so releasing the lease leaves it alone.
            held=client.call('browser_tabs',{'action':'open'})['tabId']
            lease=reserve(held,'human')
            runtime.dashboard.action('take',tab=held)
            client.call('browser_tabs',{'action':'release','tabId':held,'leaseId':lease})
            assert held in tabs(),f'a tab under human control was closed: {tabs()}'
            print('PASS: releasing closes an agent tab, keeps the last one and keeps one a person took over')
        finally:runtime.stop()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',required=True,type=pathlib.Path);args=parser.parse_args();run(args.engine_binary.resolve())
