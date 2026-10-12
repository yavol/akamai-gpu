#!/usr/bin/env python3
"""Temporary loopback browser-QA relay, preserving verified upstream TLS.

Use only when Chromium cannot use the managed environment CA. requests retains
the configured HTTPS proxy and CA trust. This does not disable certificate
verification, change browser trust, persist credentials, or expose a public port.
"""
import argparse
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import requests


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--prefix',default='/decision-lab/')
    args=parser.parse_args()
    target=urlsplit(os.environ['WORKSHOP_JUPYTER_URL'])
    if target.scheme!='https' or target.username or target.password or target.query:
        raise SystemExit('WORKSHOP_JUPYTER_URL must be a credential-free HTTPS origin.')
    origin=f'{target.scheme}://{target.netloc}'
    token=os.environ['WORKSHOP_JUPYTER_TOKEN']

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):self.relay()
        def do_POST(self):self.relay()
        def relay(self):
            if not self.path.startswith(args.prefix):
                self.send_error(404);return
            if self.headers.get('Origin') and urlsplit(self.headers['Origin']).netloc!=self.headers.get('Host'):
                self.send_error(403);return
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<=length<=1_500_000:self.send_error(413);return
                headers={'Authorization':'token '+token,'Origin':origin}
                if self.headers.get('Content-Type'):headers['Content-Type']=self.headers['Content-Type']
                response=requests.request(self.command,origin+self.path,headers=headers,
                    data=self.rfile.read(length) if length else None,timeout=60,allow_redirects=False)
                self.send_response(response.status_code)
                for name in ['Content-Type','Content-Disposition','Content-Security-Policy','X-Content-Type-Options']:
                    if name in response.headers:self.send_header(name,response.headers[name])
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Length',str(len(response.content)))
                self.end_headers();self.wfile.write(response.content)
            except (requests.RequestException,ValueError):self.send_error(502,'Verified upstream request failed')

    print(f'Temporary verified-TLS QA relay: http://127.0.0.1:{args.port}{args.prefix}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()

if __name__=='__main__':main()
