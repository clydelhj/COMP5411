"""Serve the project on loopback and open the 1 m terrain-data entry page."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser


# Bind to loopback only and let the operating system choose an available port.
root = Path(__file__).resolve().parents[1]
server = ThreadingHTTPServer(
    ("127.0.0.1", 0),
    partial(SimpleHTTPRequestHandler, directory=str(root)),
)
url = f"http://127.0.0.1:{server.server_port}/index-1m.html"
print(
    f"Terrain viewer: {url}\nKeep this window open. Press Ctrl+C to stop.",
    flush=True,
)

webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
