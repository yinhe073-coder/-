"""Serve the public cockpit only; never contacts trading or operations services."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse, json
ROOT = Path(__file__).resolve().parent
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'")
        super().end_headers()
    def do_GET(self):
        if self.path.startswith('/api/') or self.path.split('?')[0].endswith('.json'):
            body=json.dumps({'unavailable':True,'paper':True,'error':'NO_DATA_PROVIDER_CONFIGURED','sourceTime':None}).encode()
            self.send_response(503); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        super().do_GET()
    def do_POST(self): self.send_error(405,'Public read-only distribution')
    do_PUT=do_POST
    do_DELETE=do_POST
    do_PATCH=do_POST
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8095);args=parser.parse_args()
    print(f'Public read-only cockpit: http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
