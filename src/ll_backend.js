/* Lemon Lyfe standalone backend: game codes + Firebase (Firestore, anonymous sign-in).
   Exposes the same small storage API the game used inside Claude:
   db.doc(path) -> {get,set,update(deep merge),delete,onSnapshot,acquire}
   db.collection(path) -> {where(f,'==',v)...get(), onSnapshot}
   Everything for one game lives under games/<CODE>/... ; each doc stores its JSON in field "j"
   (Firestore can't hold nested arrays, which the game state uses).
   ?mock=1 swaps Firebase for a localStorage backend, for testing on one machine. */
window.LL=(()=>{
  const FB='https://www.gstatic.com/firebasejs/13.1.0/';
  const qs=new URLSearchParams(location.search),MOCK=qs.has('mock');
  const ALPH='ABCDEFGHJKMNPQRSTUVWXYZ23456789',clean=s=>(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
  let code=clean(qs.get('g')),raw=null,uid=null;
  const LAST='ll-last-game';
  const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
  const clone=o=>o==null?o:JSON.parse(JSON.stringify(o));
  const isObj=o=>o&&typeof o==='object'&&!Array.isArray(o);
  function merge(a,b){const r=isObj(a)?{...a}:{};for(const k of Object.keys(b)){r[k]=isObj(b[k])&&isObj(r[k])?merge(r[k],b[k]):clone(b[k])}return r}

  /* ---------- raw backends: path is relative to the game ---------- */
  async function firebaseRaw(){
    const cfg=window.LL_FIREBASE;if(!cfg)throw new Error('Firebase is not set up yet');
    const [A,Au,F]=await Promise.all([import(FB+'firebase-app.js'),import(FB+'firebase-auth.js'),import(FB+'firebase-firestore.js')]);
    const app=A.initializeApp(cfg),auth=Au.getAuth(app);
    if(!auth.currentUser)await Au.signInAnonymously(auth);
    uid=auth.currentUser.uid;
    const fs=F.getFirestore(app);
    const ref=p=>F.doc(fs,'games',code,...p.split('/')),col=p=>F.collection(fs,'games',code,...p.split('/'));
    const val=s=>s.exists()?JSON.parse(s.data().j):null,wrap=o=>({j:JSON.stringify(o),t:Date.now()});
    return{
      get:async p=>val(await F.getDoc(ref(p))),
      set:(p,o)=>F.setDoc(ref(p),wrap(o)),
      del:p=>F.deleteDoc(ref(p)),
      listen:(p,cb,err)=>F.onSnapshot(ref(p),s=>cb(val(s)),err),
      list:async p=>(await F.getDocs(col(p))).docs.map(d=>({id:d.id,obj:JSON.parse(d.data().j)})),
      listenCol:(p,cb,err)=>F.onSnapshot(col(p),q=>cb(q.docs.map(d=>({id:d.id,obj:JSON.parse(d.data().j)}))),err),
      txn:(p,fn)=>F.runTransaction(fs,async t=>{const s=await t.get(ref(p));const r=fn(val(s));if(r.write!==undefined)t.set(ref(p),wrap(r.write));return r.ret})};
  }
  function mockRaw(){
    let id=store.get('llmock-uid');if(!id||qs.has('fresh')){id='m'+Math.random().toString(36).slice(2,9);if(!qs.has('fresh'))store.set('llmock-uid',id)}
    uid=qs.get('as')||id;
    const K=p=>'llmock:'+code+':'+p,subs=[];
    const read=p=>{const v=store.get(K(p));return v?JSON.parse(v):null};
    const keysUnder=p=>{const pre=K(p)+'/',r=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith(pre)&&!k.slice(pre.length).includes('/'))r.push(k)}return r};
    const listOf=p=>keysUnder(p).map(k=>({id:k.slice(K(p).length+1),obj:JSON.parse(localStorage.getItem(k))}));
    const fire=()=>subs.forEach(s=>s());
    addEventListener('storage',e=>{if(e.key&&e.key.startsWith('llmock:'))fire()});
    const later=f=>setTimeout(f,0);
    return{
      get:async p=>read(p),
      set:async(p,o)=>{store.set(K(p),JSON.stringify(o));later(fire)},
      del:async p=>{try{localStorage.removeItem(K(p))}catch(e){}later(fire)},
      listen:(p,cb)=>{let last;const f=()=>{const v=store.get(K(p));if(v!==last){last=v;cb(v?JSON.parse(v):null)}};subs.push(f);later(()=>{last=undefined;f()});return()=>{}},
      list:async p=>listOf(p),
      listenCol:(p,cb)=>{let last;const f=()=>{const l=listOf(p),s=JSON.stringify(l);if(s!==last){last=s;cb(l)}};subs.push(f);later(f);return()=>{}},
      txn:async(p,fn)=>{const r=fn(read(p));if(r.write!==undefined){store.set(K(p),JSON.stringify(r.write));later(fire)}return r.ret}};
  }

  /* ---------- the API the game expects ---------- */
  function makeDb(R){
    const snap=o=>({exists:o!=null,data:()=>clone(o)==null?undefined:clone(o)});
    const docs=l=>({docs:l.map(x=>({id:x.id,data:()=>clone(x.obj)}))});
    return{
      doc:p=>({
        get:async()=>snap(await R.get(p)),
        set:o=>R.set(p,clone(o)),
        update:o=>R.txn(p,cur=>({write:merge(cur||{},o)})),
        delete:()=>R.del(p),
        onSnapshot:(cb,err)=>R.listen(p,o=>cb(snap(o)),err),
        acquire:async({holder,ttlMs})=>({acquired:await R.txn(p,cur=>{const now=Date.now();if(cur&&cur.exp>now&&cur.holder!==holder)return{ret:false};return{write:{holder,exp:now+(ttlMs||20000)},ret:true}})})}),
      collection:p=>{const q=f=>({where:(k,op,v)=>q([...f,[k,v]]),
        get:async()=>docs((await R.list(p)).filter(x=>f.every(([k,v])=>x.obj&&x.obj[k]===v))),
        onSnapshot:(cb,err)=>R.listenCol(p,l=>cb(docs(l)),err)});return q([])}};
  }

  /* ---------- landing: start or join a game ---------- */
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const newCode=()=>Array.from({length:5},()=>ALPH[Math.floor(Math.random()*ALPH.length)]).join('');
  const linkFor=c=>location.origin+location.pathname+'?g='+c+(MOCK?'&mock=1':'');
  function go(c){code=c;store.set(LAST,c);const u=new URL(location.href);u.searchParams.set('g',c);history.replaceState(null,'',u)}
  function landing(){
    return new Promise(resolve=>{
      const app=document.getElementById('app'),last=clean(store.get(LAST));
      const draw=(msg='')=>{app.innerHTML=`<div class="panel llland">
        <h2>Lemon Lyfe</h2><p class="muted">Kid crews, lemonade stands and turf wars. Start a game and send your friends the link, or join theirs.</p>
        ${last?`<div class="row"><button class="btn primary" data-ll="cont">Continue game ${esc(last)}</button></div>`:''}
        <div class="row"><button class="btn ${last?'':'primary'}" data-ll="new">Start a new game</button></div>
        <div class="field"><label for="ll-code">Join with a game code</label><div class="row" style="flex-wrap:nowrap"><input id="ll-code" class="llcode" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="ABCDE"><button class="btn" data-ll="join">Join</button></div></div>
        ${msg?`<p class="llmsg" role="status">${esc(msg)}</p>`:''}</div>`};
      draw();
      const onClick=async e=>{const b=e.target.closest('[data-ll]');if(!b||!app.contains(b))return;const a=b.dataset.ll;
        if(a==='new'){app.removeEventListener('click',onClick);go(newCode());resolve()}
        else if(a==='cont'){app.removeEventListener('click',onClick);go(last);resolve()}
        else if(a==='join'){const c=clean(document.getElementById('ll-code').value);if(c.length<4)return draw('Type the code your friend sent you.');
          code=c;const R=raw;let ok=false;try{ok=!!(await R.get('game/state'))}catch(x){}
          if(!ok){code='';return draw(`No game found with the code ${c}. Check it and try again.`)}
          app.removeEventListener('click',onClick);go(c);resolve()}};
      app.addEventListener('click',onClick);
      app.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='ll-code'){const b=app.querySelector('[data-ll="join"]');if(b)b.click()}});
    });
  }

  /* ---------- invite box shown in the lobby ---------- */
  let copied=0;
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-ll="share"],[data-ll="switch"]');if(!b)return;
    if(b.dataset.ll==='switch'){location.href=location.pathname+(MOCK?'?mock=1':'');return}
    const url=linkFor(code),text=`Join my Lemon Lyfe game! Code ${code}`;
    if(navigator.share){try{await navigator.share({title:'Lemon Lyfe',text,url});return}catch(x){if(x&&x.name==='AbortError')return}}
    try{await navigator.clipboard.writeText(url);copied=Date.now();b.textContent='Link copied!';setTimeout(()=>{b.textContent='Invite friends'},2200)}
    catch(x){prompt('Copy this link and send it to your friends:',url)}});
  const inviteHTML=()=>code?`<div class="panel llinvite"><div><span class="small muted">Game code</span><div class="llbig">${esc(code)}</div></div><div class="llbtns"><button class="btn primary" data-ll="share">Invite friends</button><button class="linkbtn small" data-ll="switch">Switch game</button></div></div>`:'';

  const css=document.createElement('style');
  css.textContent=`.llinvite{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .llbig{font-family:var(--mono,monospace);font-size:26px;font-weight:600;letter-spacing:.12em}
  .llbtns{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  .llland h2{font-family:var(--display,inherit);font-size:30px;margin:4px 0 6px}
  .llland .row .btn{flex:1}
  .llcode{flex:1;min-width:0;font:inherit;font-family:var(--mono,monospace);font-size:20px;letter-spacing:.12em;text-transform:uppercase;padding:10px 12px;border:2px solid var(--line,#ccc);border-radius:12px;background:var(--surface,#fff);color:var(--ink,#111)}
  .llmsg{color:var(--bad,#c2372f);font-weight:700;margin:10px 0 0}`;
  document.head.appendChild(css);

  async function connect(){
    raw=MOCK?mockRaw():await firebaseRaw();
    if(!code)await landing();else store.set(LAST,code);
    return{db:makeDb(raw),uid};
  }
  function fail(e){const app=document.getElementById('app'),c=String(e&&(e.code||e.message)||'');
    const msg=/network|offline|unavailable/i.test(c)?'Check your internet connection and reload the page.'
      :/admin-restricted|operation-not-allowed/i.test(c)?'Guest sign-in is switched off in Firebase (Authentication → Sign-in method → Anonymous).'
      :/permission/i.test(c)?'The database rules are blocking the game. Check the Firestore rules were published.'
      :/not set up/i.test(c)?'This copy of the game is not connected to a database yet.':'Something went wrong. Reload the page to try again.';
    if(app)app.innerHTML=`<div class="panel"><h2>Can't reach the game</h2><p class="muted">${esc(msg)}</p><p class="small muted">${esc(c)}</p></div>`}
  return{connect,fail,inviteHTML,code:()=>code};
})();
