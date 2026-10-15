"""Exercise cancellation and acknowledged five-second handoffs without action replay."""
import argparse,pathlib,tempfile,time
from unified_smoke import Runtime

def run(binary):
    with tempfile.TemporaryDirectory(prefix='servo-handoff-') as directory:
        runtime=Runtime(binary,pathlib.Path(directory));client=runtime.client;dashboard=runtime.dashboard
        def wait_prompt(tab):
            for _ in range(50):
                state=dashboard.action('handoff_status')
                if state['requests']:return next(item for item in state['requests'] if item['tabId']==tab)
                time.sleep(.1)
            raise AssertionError('Missing human handoff')
        try:
            tab=client.call('browser_tabs',{'action':'open'})['tabId']
            lease=client.call('browser_tabs',{'action':'reserve','agentName':'Test agent','tabId':tab,'task':'handoff test'})['leaseId']
            dashboard.action('take',tab);dashboard.action('handoff_status')
            pending=client.begin('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'window.handoffCounter=(window.handoffCounter||0)+1;return window.handoffCounter;'})
            prompt=wait_prompt(tab);dashboard.action('handoff_ack',tab,{'id':prompt['id']});dashboard.action('handoff_cancel',tab,{'id':prompt['id']})
            message=client.messages.get(timeout=5);assert message['id']==pending and message['result']['isError']
            dashboard.action('return',tab)
            assert client.call('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'return window.handoffCounter||0;'})['value']==0
            dashboard.action('take',tab);dashboard.action('handoff_status')
            pending=client.begin('browser_evaluate',{'tabId':tab,'leaseId':lease,'script':'window.handoffCounter=(window.handoffCounter||0)+1;return window.handoffCounter;'})
            prompt=wait_prompt(tab);start=time.monotonic()
            for _ in range(12):
                dashboard.action('handoff_status');dashboard.action('handoff_ack',tab,{'id':prompt['id']});time.sleep(.5)
                state=dashboard.action('handoff_status')
                if not state['requests']:break
            assert time.monotonic()-start>=4.5
            assert client.finish(pending)['value']==1
            assert any(t['id']==tab and t['owner']=='agent' for t in dashboard.action('tabs'))
            client.call('browser_tabs',{'action':'release','tabId':tab,'leaseId':lease})
        finally:runtime.stop()
    print('PASS: cancellation executes zero actions; acknowledged five-second handoff executes once and retains the client reservation')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine-binary',type=pathlib.Path,required=True);args=parser.parse_args();run(args.engine_binary.resolve())
