#!/usr/bin/env python3
"""Local Decision Lab. Provider credentials never leave this process."""
import argparse
import json
import mimetypes
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from server.providers import execute_decision, catalog, ProviderError

ROOT = Path(__file__).parent
PUBLIC = ROOT / 'public'
LIMIT = threading.BoundedSemaphore(6)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if args and '/api/decide' in str(args[0]):
            return
        super().log_message(format, *args)

    def send(self, status, data, mime='application/json'):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        route = urlparse(self.path).path
        if route == '/api/health':
            return self.send(200, {'ok': True, 'service': 'Decision Lab', 'providers': catalog()})
        if route == '/api/models':
            return self.send(200, {'providers': catalog()})
        path = (PUBLIC / ('index.html' if route == '/' else route.lstrip('/'))).resolve()
        if not path.is_relative_to(PUBLIC.resolve()) or not path.is_file():
            return self.send(404, {'error': 'Not found'})
        self.send(200, path.read_bytes(), mimetypes.guess_type(path)[0] or 'application/octet-stream')

    def do_POST(self):
        if urlparse(self.path).path != '/api/decide':
            return self.send(404, {'error': 'Not found'})
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send(403, {'error': 'Cross-origin requests are disabled.'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(415, {'error': 'Use application/json.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 1_500_000:
                return self.send(413, {'error': 'Request size must be between 1 and 1,500,000 bytes.'})
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Expected a JSON object.')
            if not LIMIT.acquire(blocking=False):
                return self.send(429, {'error': 'All six inference slots are in use. Try again shortly.'})
            try:
                result = execute_decision(payload.get('provider', 'clef'), payload.get('state'), payload.get('questions'), timeout=40)
                return self.send(200, result)
            finally:
                LIMIT.release()
        except ProviderError as exc:
            self.send(getattr(exc, 'status', 502), {'error': str(exc)})
        except (ValueError, KeyError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except Exception:
            self.send(500, {'error': 'Unexpected server error. See the server terminal.'})
            raise

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    print(f'Decision Lab: http://localhost:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
