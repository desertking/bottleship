"""Package the pinned source using the same paths as the local test builder."""
import hashlib,json,os,re,shutil,subprocess,time
from pathlib import Path
SOURCE='8dfafc9005137f24c0a90c05138fb0b77799a278'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==SOURCE
ref=SOURCE[:8];prefix='/spieltests/_engine/'+ref+'/'
root=Path.cwd();out=root.parent/'artifact'/'_engine'/ref
out.parent.mkdir(parents=True,exist_ok=True)
env=dict(os.environ,CF_PAGES_COMMIT_SHA=ref)
subprocess.run(['node','node_modules/vite/bin/vite.js','build','--base',prefix,'--outDir',str(out),'--emptyOutDir'],env=env,check=True)
for item in (root/'public').iterdir():
    if item.name in ('covers','apps','_headers','reference'):continue
    if item.is_dir():shutil.copytree(item,out/item.name,dirs_exist_ok=True)
    else:shutil.copy2(item,out/item.name)
paths=['v86.wasm','games-catalog.json','deployment.json','gog-overrides.json','dxt-kernel.wasm','dxt-kernel-simd.wasm','video-decoder.wasm','unpack-buffered.wasm','unpack-streaming.wasm','bios/seabios.bin','bios/vgabios.bin']
for js in (out/'assets').glob('*.js'):
    data=js.read_text();new=data
    for p in paths:
        for q in ('"',"'",'`'):new=new.replace(q+'/'+p,q+prefix+p)
    if new!=data:js.write_text(new)
built=(out/'index.html').read_text()
entry=re.search(r'<script[^>]+type="module"[^>]+src="([^"]+)"',built).group(1)
css=[c for c in re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"',built) if c.startswith(prefix)]
assert len(css)==1
(out/'index.html').unlink()
(out/'.htaccess').write_text('Options -Indexes\nAddType application/wasm .wasm\nAddType application/javascript .mjs .js\n<IfModule mod_headers.c>\n Header always set Document-Isolation-Policy "isolate-and-credentialless"\n Header always set Cross-Origin-Embedder-Policy "require-corp"\n Header always set Cross-Origin-Resource-Policy "same-origin"\n Header always set X-Content-Type-Options "nosniff"\n Header always set X-Robots-Tag "noindex, nofollow"\n Header unset Cache-Control\n Header always set Cache-Control "public, max-age=31536000, immutable"\n</IfModule>\n<FilesMatch "\\.(wasm|bin)$">\n SetOutputFilter None\n SetEnv no-brotli 1\n SetEnv no-gzip 1\n</FilesMatch>\n')
meta={'ref':ref,'commit':ref,'variant':None,'entry':entry,'css':css[0],'v86sha256':hashlib.sha256((out/'v86.wasm').read_bytes()).hexdigest(),'built':time.strftime('%Y-%m-%d %H:%M:%S'),'sourceCommit':SOURCE,'ciRun':os.environ.get('GITHUB_RUN_ID')}
(out/'engine.json').write_text(json.dumps(meta,indent=1))
(out.parent.parent/'built-vector-tempo.json').write_text(json.dumps(meta,indent=2))
print(json.dumps(meta))
