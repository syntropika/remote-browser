"""Verify real CEF browser cleanup on protocol shutdown and closed standard input."""
import argparse
import pathlib
import tempfile

from embedded_smoke import Engine


def exercise(binary):
    with tempfile.TemporaryDirectory(prefix='browser-shutdown-') as directory:
        root = pathlib.Path(directory)
        with (root / 'engine.log').open('w+') as log:
            for mode in ['shutdown', 'eof']:
                engine = Engine(binary, root / 'profile', log)
                try:
                    first = engine.call('tabs')[0]['id']
                    assert engine.call('evaluate', first, {'script': 'return 42;'}) == 42
                    closing = engine.call('open')
                    engine.call('open')
                    engine.call('close', closing, human=True)
                    if mode == 'shutdown':
                        engine.stop()
                    else:
                        engine.process.stdin.close()
                        engine.process.wait(timeout=10)
                        assert engine.process.returncode == 0, engine.process.returncode
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-6000:])
                    raise
                finally:
                    if engine.process.poll() is None:
                        engine.process.kill()
                        engine.process.wait()
    print('PASS: multiple browser views close cleanly on shutdown and EOF; the same profile restarts successfully.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    args = parser.parse_args()
    exercise(args.engine_binary.resolve())
