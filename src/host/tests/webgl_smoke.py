"""Verify native WebGL shader compilation, rendering and pixel readback."""
import argparse
import http.server
import os
import pathlib
import tempfile
import threading

from embedded_smoke import Engine

PAGE = b'''<!doctype html><canvas width="32" height="32"></canvas><script>
window.result={available:typeof WebGLRenderingContext==='function'};
try {
    const gl=document.querySelector('canvas').getContext('webgl');
    result.context=!!gl;
    if(gl){
        function shader(type,source){
            const shader=gl.createShader(type);
            gl.shaderSource(shader,source);gl.compileShader(shader);
            if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Shader compilation failed');
            return shader;
        }
        const program=gl.createProgram();
        gl.attachShader(program,shader(gl.VERTEX_SHADER,
            'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}'));
        gl.attachShader(program,shader(gl.FRAGMENT_SHADER,
            'precision mediump float;void main(){gl_FragColor=vec4(0.125,0.25,0.5,1.0);}'));
        gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Shader linking failed');
        gl.useProgram(program);
        const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
        const position=gl.getAttribLocation(program,'position');
        gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        gl.viewport(0,0,32,32);gl.drawArrays(gl.TRIANGLES,0,3);
        const pixel=new Uint8Array(4);
        gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        result.pixel=Array.from(pixel);result.error=gl.getError();result.done=true;
    }
}catch(error){result.failure=error.name+': '+error.message}
</script>'''


def exercise(binary):
    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)

        def log_message(self, *args):
            pass

    fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
    os.environ['GALLIUM_DRIVER'] = 'llvmpipe'
    try:
        with tempfile.TemporaryDirectory(prefix='browser-webgl-') as directory:
            os.environ['XDG_RUNTIME_DIR'] = directory
            with open(pathlib.Path(directory) / 'engine.log', 'w') as log:
                engine = Engine(binary, pathlib.Path(directory) / 'profile', log)
                try:
                    tab = engine.call('tabs')[0]['id']
                    engine.call('navigate', tab, {'url': 'http://127.0.0.1:' + str(fixture.server_port)})
                    result = engine.call('evaluate', tab, {'script': 'return window.result;'})
                    assert result.get('available') and result.get('context') and result.get('done'), result
                    assert result['error'] == 0, result
                    assert len(result['pixel']) == 4, result
                    assert all(abs(actual - expected) <= 1 for actual, expected in zip(result['pixel'], [32, 64, 128, 255])), result
                    print('PASS: native WebGL shaders compile, render and return expected pixels')
                finally:
                    try:
                        engine.stop()
                    except Exception:
                        engine.process.kill()
                        engine.process.wait()
    finally:
        fixture.shutdown()
        fixture.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-binary', required=True, type=pathlib.Path)
    exercise(parser.parse_args().engine_binary)
