/* Service worker aplikácie Stavebná firma – aplikácia sa otvorí aj bez signálu.
   Údaje firmy sa sem neukladajú (tie drží aplikácia v IndexedDB), iba samotná stránka a knižnice. */
const V="sf-c8d3ca28dc";
const SHELL=["/","/manifest.webmanifest","/icon-192.png","/icon-512.png"];
const CDN=/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);
  if(r.mode==="navigate"&&u.origin===location.origin){
    /* stránka: najprv zo siete (nová verzia), bez siete z pamäte */
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put("/",cp));return res}).catch(()=>caches.match("/").then(m=>m||caches.match(r))));return}
  if(CDN.test(r.url)){
    /* knižnice s pevnou verziou: z pamäte, inak zo siete a uložiť */
    e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok||res.type==="opaque"){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res})));return}
  if(u.origin===location.origin&&/\.(png|webmanifest|svg|ico)$/.test(u.pathname)){
    e.respondWith(caches.match(r).then(m=>m||fetch(r)))}
  /* Supabase a ostatné: vždy zo siete */
});
