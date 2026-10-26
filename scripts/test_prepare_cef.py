"""Check verified CEF downloads, cache reuse and rejection before installation."""
import hashlib
import http.server
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("prepare_cef", Path(__file__).with_name("prepare-cef.py"))
cef = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cef)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name) / "cache"
        self.requests = 0
        case = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                case.requests += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(case.payload)))
                self.end_headers()
                self.wfile.write(case.payload)

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}/cef.tar.gz"

    def archive(self, extra=None):
        files = {
            "Release/libcef.so": b"native fixture",
            "Resources/resources.pak": b"resources",
            "Resources/icudtl.dat": b"icu",
            "Resources/locales/en-US.pak": b"locale",
            "include/cef_api_versions.h": b"headers",
            "cmake/cef_variables.cmake": b"cmake",
            "libcef_dll/wrapper.cc": b"wrapper",
            "CMakeLists.txt": b"cmake project",
            "LICENSE.txt": b"license",
            "CREDITS.html": b"credits",
        }
        if extra:
            files.update(extra)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as stream:
            for name, content in files.items():
                member = tarfile.TarInfo("cef_fixture/" + name)
                member.size = len(content)
                stream.addfile(member, io.BytesIO(content))
        self.payload = data.getvalue()
        return {
            "url": self.url, "sha256": hashlib.sha256(self.payload).hexdigest(),
            "fileName": "cef_fixture.tar.gz", "archiveRoot": "cef_fixture",
            "sha1": hashlib.sha1(self.payload).hexdigest(),
            "librarySha256": hashlib.sha256(files["Release/libcef.so"]).hexdigest(),
        }

    def test_real_download_flat_layout_and_offline_cache_reuse(self):
        asset = self.archive()
        runtime = cef.prepare(asset, self.cache)
        self.assertEqual((runtime / "libcef.so").read_bytes(), b"native fixture")
        self.assertTrue((runtime / "locales/en-US.pak").is_file())
        self.assertTrue((runtime / "cmake/cef_variables.cmake").is_file())
        self.assertEqual(json.loads((runtime / "archive.json").read_text())["name"], asset["fileName"])
        self.payload = b"The server no longer has the archive"
        self.assertEqual(cef.prepare(asset, self.cache), runtime)
        self.assertEqual(self.requests, 1)
        (runtime / "libcef.so").write_bytes(b"damaged cache")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            cef.prepare(asset, self.cache)

    def test_bad_download_never_becomes_a_runtime(self):
        asset = self.archive()
        self.payload = b"truncated or replaced download"
        with self.assertRaisesRegex(ValueError, "download checksum mismatch"):
            cef.prepare(asset, self.cache)
        self.assertFalse((self.cache / asset["sha256"]).exists())
        self.assertFalse(list(self.cache.glob(".prepare-*")))

    def test_unsafe_archive_is_rejected_even_with_matching_checksum(self):
        asset = self.archive({"../../outside": b"unexpected"})
        with self.assertRaisesRegex(ValueError, "unexpected path"):
            cef.prepare(asset, self.cache)
        self.assertFalse((self.cache / asset["sha256"]).exists())
        self.assertFalse((self.cache / "outside").exists())


if __name__ == "__main__":
    unittest.main()
