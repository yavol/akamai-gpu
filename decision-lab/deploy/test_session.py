import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import session


class SessionTests(unittest.TestCase):
    def test_config_preserves_auth_websockets_and_uses_loopback_notebook(self):
        config = session.make_config(Path("/private/example runtime"))
        self.assertIn("listen 8090;", config)
        self.assertNotIn("listen 8080;", config)
        self.assertIn("proxy_pass http://127.0.0.1:8080/api/me;", config)
        self.assertIn("proxy_pass http://127.0.0.1:8080;", config)
        self.assertIn("auth_request /_decision_lab_auth;", config)
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", config)
        self.assertIn("absolute_redirect off;", config)
        self.assertIn('pid "/private/example runtime/nginx.pid";', config)
        commands = session.child_commands(Path("/app"), Path("/nginx"), Path("/runtime"))
        self.assertEqual(commands["app"][-4:], ["--host", "127.0.0.1", "--port", "8081"])

    def test_supervisor_starts_restarts_and_stops_only_its_children(self):
        script = Path(session.__file__).resolve()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app, prefix = root / "app", root / "runtime"
            app.mkdir()
            (app / "server.py").write_text("import time\ntime.sleep(60)\n")
            nginx = root / "nginx"
            nginx.write_text(f"#!{sys.executable}\nimport sys,time\nif '-t' not in sys.argv: time.sleep(60)\n")
            nginx.chmod(0o700)
            environment = dict(os.environ, OPENROUTER_API_KEY="test-credential-marker")
            run = lambda *args: subprocess.run([sys.executable, str(script), *args], text=True,
                                               capture_output=True, timeout=15, env=environment)
            try:
                started = run("start", "--prefix", str(prefix), "--app-dir", str(app), "--nginx", str(nginx),
                              "--gpu-endpoint", "http://private-test-endpoint/v1/systemone")
                self.assertEqual(started.returncode, 0, started.stderr)
                state = json.loads(started.stdout)
                self.assertTrue(state["running"])
                self.assertEqual(set(state["children"]), {"app", "gateway"})
                os.kill(state["children"]["app"]["pid"], signal.SIGTERM)
                deadline = time.monotonic() + 6
                while time.monotonic() < deadline:
                    state = session.status(prefix)
                    if state["children"]["app"]["restarts"] >= 1 and state["children"]["app"]["running"]:
                        break
                    time.sleep(0.1)
                self.assertGreaterEqual(state["children"]["app"]["restarts"], 1)
                self.assertTrue(state["children"]["app"]["running"])
                duplicate = run("start", "--prefix", str(prefix), "--app-dir", str(app), "--nginx", str(nginx),
                                "--gpu-endpoint", "http://private-test-endpoint/v1/systemone")
                self.assertNotEqual(duplicate.returncode, 0)
                for path in prefix.rglob("*"):
                    if path.is_file():
                        content = path.read_text()
                        self.assertNotIn("test-credential-marker", content)
                        self.assertNotIn("private-test-endpoint", content)
                stopped = run("stop", "--prefix", str(prefix))
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                self.assertFalse(session.status(prefix)["running"])
            finally:
                run("stop", "--prefix", str(prefix))


if __name__ == "__main__":
    unittest.main()
