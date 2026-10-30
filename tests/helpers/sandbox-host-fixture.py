"""Synthetic Unix bridge using the production handler and actual isolated Docker runtime."""
import importlib.util
import os
from pathlib import Path
import signal
import sys
import threading

scripts = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(scripts))
from sandbox_runtime import SandboxRuntime, SandboxError
module = importlib.util.spec_from_file_location('sandbox_host', scripts / 'host-sandbox.py')
host = importlib.util.module_from_spec(module)
module.loader.exec_module(host)
runtime = SandboxRuntime(installation=sys.argv[2])
server = host.Server(sys.argv[1], host.Handler)
server.runtime = runtime
server.sandbox_error = SandboxError
server.enabled = lambda: True
runtime.recover()
def stop(*_):
    threading.Thread(target=server.shutdown, daemon=True).start()
signal.signal(signal.SIGTERM, stop)
try:
    print('READY', flush=True)
    server.serve_forever(poll_interval=0.1)
finally:
    runtime.close()
    server.server_close()
    if os.path.exists(sys.argv[1]): os.unlink(sys.argv[1])
