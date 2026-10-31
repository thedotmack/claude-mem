#!/usr/bin/env python3
"""A one-time page on a Sprite's own URL (behind Fly's sign-in) where you paste the OpenRouter key once.

It saves the key to ~/.emv/openrouter-key (readable only by the Sprite's user), never logs or echoes it, and exits so
the service can start the build (sprite-job.sh). Usage: keydrop.py [port] (default 8080, the Sprite URL's port).
"""
import html
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KEY_FILE = Path.home() / '.emv' / 'openrouter-key'
PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenRouter key</title><style>
:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px}
input{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;margin:.5rem 0}button{font:inherit;padding:.6rem 1.2rem}
</style></head><body><h1>OpenRouter key for the DeepSeek build test</h1>
<p>{msg}</p>
<form method="post"><input type="password" name="key" placeholder="sk-or-..." autocomplete="off" required autofocus>
<button type="submit">Save and start the builds</button></form>
<p>The key is saved only on this Sprite, readable only by its own user, and the builds start right after.</p></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # no request logs: nothing about the key is written anywhere
        pass

    def send_page(self, status, body):
        data = body.encode()
        self.send_response(status)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if KEY_FILE.exists() and KEY_FILE.stat().st_size:
            self.send_page(200, '<!doctype html><meta charset="utf-8"><p>The key is already saved; the builds are running.</p>')
        else:
            self.send_page(200, PAGE.replace('{msg}', 'Paste your OpenRouter key (it starts with sk-or-).'))

    def do_POST(self):
        length = min(int(self.headers.get('content-length') or 0), 4096)
        key = urllib.parse.parse_qs(self.rfile.read(length).decode(errors='replace')).get('key', [''])[0].strip()
        if not key.startswith('sk-or-') or any(c.isspace() for c in key):
            self.send_page(400, PAGE.replace('{msg}', html.escape("That doesn't look like an OpenRouter key (sk-or-...). Try again.")))
            return
        KEY_FILE.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(key)
        self.send_page(200, '<!doctype html><meta charset="utf-8"><p>Saved. The three builds are starting now; you can close this tab.</p>')
        self.server.saved = True


def main():
    if KEY_FILE.exists() and KEY_FILE.stat().st_size:
        return
    server = HTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8080), Handler)
    server.saved = False
    while not server.saved:
        server.handle_request()
    server.server_close()


if __name__ == '__main__':
    main()
