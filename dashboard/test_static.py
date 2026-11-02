"""Isolated regression checks; never imports or runs trading code."""
import tempfile,pathlib,importlib.util,threading,urllib.request,urllib.error,json,shutil
with tempfile.TemporaryDirectory() as folder:
    root=pathlib.Path(folder)
    shutil.copyfile(pathlib.Path(__file__).with_name('serve.py'),root/'serve.py')
    (root/'index.html').write_text('<h1>test</h1>')
    (root/'cockpit.js').write_text('/* test */')
    (root/'private.txt').write_text('SYNTHETIC-NOT-A-SECRET')
    (root/'extra').mkdir();(root/'extra/item.txt').write_text('fixture')
    spec=importlib.util.spec_from_file_location('public_static_fixture',root/'serve.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    server=mod.ThreadingHTTPServer(('127.0.0.1',0),mod.Handler)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start();base='http://127.0.0.1:'+str(server.server_address[1]);results=[]
    try:
        cases=[('GET','/',200),('GET','/cockpit.js?v=1',200),('HEAD','/cockpit.js',200),('GET','/SOURCE-MANIFEST.json',404),('GET','/SOURCE-MANIFEST.%6ason',404),('HEAD','/SOURCE-MANIFEST.json',404),('GET','/private.txt',404),('GET','/extra/',404),('GET','/serve.py',404),('GET','/refresh.ps1',404),('GET','/../private.txt',404),('GET','/%252e%252e/private.txt',404),('POST','/api/intent',405),('PUT','/cockpit.js',405),('DELETE','/cockpit.js',405),('PATCH','/api/account',405),('OPTIONS','/',405)]
        for method,path,expected in cases:
            try:
                with urllib.request.urlopen(urllib.request.Request(base+path,method=method)) as response:status=response.status;response.read()
            except urllib.error.HTTPError as e:status=e.code
            assert status==expected,(method,path,status,expected);results.append({'method':method,'path':path,'status':status})
    finally:server.shutdown();server.server_close();worker.join(timeout=2)
print(json.dumps({'passed':len(results),'failed':0,'scope':'isolated static HTTP; no trading execution'}))
