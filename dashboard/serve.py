"""Loopback-only static allowlist for the public read-only cockpit."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
import argparse, json
ROOT = Path(__file__).resolve().parent
ALLOWED = set(['/cockpit.css', '/cockpit.js', '/hengpan-scan.js', '/live-focus.css', '/manual-market.js', '/manual-minute-chart.js', '/manual-minute-engine.js', '/manual-minute-signals.css', '/manual-minute-signals.js', '/manual-portfolio.js', '/manual-tabs.js', '/needle-paper.js', '/needle-research.css', '/needle-research.js', '/quant-bridge.js', '/readiness-strip.js', '/redesign.css', '/redesign.js', '/style.css', '/启动实盘.css', '/启动实盘.js', '/工作流.js', '/index.html', '/public-readonly.js'])
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
        super().end_headers()
    def list_directory(self,path): self.send_error(404); return None
    def serve_public(self,head=False):
        route=unquote(urlsplit(self.path).path)
        if route=='/':route='/index.html'
        if '%' in route or '\\' in route or route not in ALLOWED:
            self.send_error(404,'Not a public static asset');return
        target=(ROOT/route.lstrip('/')).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file():self.send_error(404);return
        body=target.read_bytes();self.send_response(200)
        self.send_header('Content-Type',self.guess_type(str(target)))
        self.send_header('Content-Length',str(len(body)));self.end_headers()
        if not head:self.wfile.write(body)
    def do_GET(self):self.serve_public()
    def do_HEAD(self):self.serve_public(head=True)
    def do_POST(self):self.send_error(405,'Public read-only distribution')
    do_PUT=do_POST
    do_DELETE=do_POST
    do_PATCH=do_POST
    do_OPTIONS=do_POST
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8095);args=p.parse_args()
    print(f'Public read-only cockpit: http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
