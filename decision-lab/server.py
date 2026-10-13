#!/usr/bin/env python3
"""Local Decision Lab. Provider credentials never leave this process."""
import argparse
import json
import mimetypes
import os
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from server.providers import execute_decision, catalog, ProviderError

ROOT = Path(__file__).parent
PUBLIC = ROOT / 'public'
LIMIT = threading.BoundedSemaphore(6)
CREDENTIAL_KEYS = frozenset({'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GPU_API_KEY'})


class CredentialsFileError(ValueError):
    """Safe startup error that never includes file contents or credential values."""


def load_credentials_file(path):
    """Load only credential keys from a private file, before accepting requests.

    Open relative to a verified directory descriptor and verify the opened file,
    so replacing a path with a symlink cannot bypass the permission checks.
    """
    path = Path(path).expanduser()
    parent_fd = file_fd = None
    try:
        parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent = os.fstat(parent_fd)
        if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise CredentialsFileError('Credentials directory must be owned by the current user with mode 0700')
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise CredentialsFileError('Credentials file must be a regular file owned by the current user with mode 0600')
        if info.st_size > 65_536:
            raise CredentialsFileError('Credentials file exceeds the allowed size')
        with os.fdopen(file_fd, 'rb') as stream:
            file_fd = None
            raw = stream.read(65_537)
        if len(raw) > 65_536:
            raise CredentialsFileError('Credentials file exceeds the allowed size')
    except OSError:
        raise CredentialsFileError('Cannot securely open credentials file and its private directory; symlinks are not allowed') from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if parent_fd is not None:
            os.close(parent_fd)

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise CredentialsFileError('Credentials JSON must not contain duplicate keys')
            result[key] = value
        return result

    try:
        credentials = json.loads(raw, object_pairs_hook=unique_object)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise CredentialsFileError('Credentials file must contain a valid JSON object') from None
    if not isinstance(credentials, dict) or not set(credentials).issubset(CREDENTIAL_KEYS):
        raise CredentialsFileError('Credentials JSON must contain only supported credential keys')
    if any(not isinstance(value, str) or any(character in value for character in '\x00\r\n') for value in credentials.values()):
        raise CredentialsFileError('Credential values must be strings without NUL or line breaks')
    try:
        for value in credentials.values():
            os.fsencode(value)
    except UnicodeEncodeError:
        raise CredentialsFileError('Credential values must be valid environment strings') from None
    # Validate the whole document before changing the environment.
    os.environ.update(credentials)

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
            include_request = payload.get('includeRequest', False)
            if not isinstance(include_request, bool):
                raise ValueError('includeRequest must be a boolean.')
            include_response = payload.get('includeResponse', False)
            if not isinstance(include_response, bool):
                raise ValueError('includeResponse must be a boolean.')
            if not LIMIT.acquire(blocking=False):
                return self.send(429, {'error': 'All six inference slots are in use. Try again shortly.'})
            try:
                result = execute_decision(payload.get('provider', 'clef'), payload.get('state'), payload.get('questions'),
                                          timeout=40, include_request=include_request, include_response=include_response)
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
    parser.add_argument('--credentials-file', type=Path,
                        help='Optional private JSON credentials file; never pass credential values on the command line')
    args = parser.parse_args()
    if args.credentials_file is not None:
        try:
            load_credentials_file(args.credentials_file)
        except CredentialsFileError as error:
            parser.error(str(error))
    print(f'Decision Lab: http://localhost:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
