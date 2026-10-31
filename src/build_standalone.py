"""Build the standalone (Firebase-backed) Lemon Lyfe site from the Claude artifact source.
Usage: python3 build_standalone.py [firebase_config.json]
Writes standalone/index.html. The artifact source stays untouched."""
import sys, os, json
D = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(D, 'sugar-corners.html')).read()
cfg = 'null'
if len(sys.argv) > 1:
    cfg = json.dumps(json.load(open(sys.argv[1])))

def rep(old, new, n=1):
    global src
    c = src.count(old)
    if c != n:
        print('COUNT', c, 'for', old[:120]); sys.exit(1)
    src = src.replace(old, new)

# ---- boot: Firebase (or the in-memory test backend) instead of Claude's storage ----
rep("""  const c=window.claude;
  if(c&&c.use){try{[db,userCap]=await Promise.all([c.use('db'),c.use('user')])}catch(e){}}
  if(userCap){me=realMe=await userCap.id();const cw=await userCap.can('data.write');if(cw===false)canWrite=false}""",
"""  try{const be=await LL.connect();db=be.db;me=realMe=be.uid}catch(e){console.warn(e);LL.fail(e);return}""")
# ---- wording ----
rep("""<h2>Open this in Claude to play</h2><p class="muted">The game keeps its board in shared storage, which only works when the page is opened from Claude.</p>""",
    """<h2>Can't reach the game</h2><p class="muted">Check your connection and reload the page.</p>""")
rep("Sign in to Claude to host or join.", "Connecting…")
rep("Share this page with friends as Editors so they can join.", "Send friends your invite link so they can join.")
# ---- lobby: invite box with the game code ----
rep("app.innerHTML=html+(tab==='rules'?`<div class=\"row\"><button class=\"btn\" data-act=\"tab\" data-tab=\"board\">← Back to the lobby</button></div>`+rulesView():lobbyView());return}",
    "app.innerHTML=html+(tab==='rules'?`<div class=\"row\"><button class=\"btn\" data-act=\"tab\" data-tab=\"board\">← Back to the lobby</button></div>`+rulesView():LL.inviteHTML()+lobbyView());return}")
# ---- placeholder ad breaks off by default for friend testing (?ads=1 turns them on) ----
rep("adsOn=()=>{try{return localStorage.getItem('sc-ads')!=='0'}catch(e){return true}};",
    "adsOn=()=>{if(/[?&]ads=1/.test(location.search))return true;try{return localStorage.getItem('sc-ads')==='1'}catch(e){return false}};")

shim = open(os.path.join(D, 'll_backend.js')).read()
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="theme-color" content="#f7d538">'
        '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%8D%8B%3C/text%3E%3C/svg%3E">'
        '<style>[hidden]{display:none!important}body{margin:0}</style></head><body>')
out = head + f'<script>window.LL_FIREBASE={cfg};</script><script>{shim}</script>' + src + '</body></html>'
open(os.path.join(D, '..', 'index.html'), 'w').write(out)  # writes the site's index.html
print('ok', len(out)//1024, 'KB', 'config' if cfg != 'null' else 'NO CONFIG (test backend only)')
