const HOST="192.168.190.223",PORT=3095,TOKEN=process.env.DSH_TOKEN;
const sid="session-15983b7b-4b2f-4d6c-b6ff-5d2b4acdd331";
const r=await fetch(`http://${HOST}:${PORT}/?token=`+encodeURIComponent(TOKEN),{redirect:"manual",headers:{Host:`${HOST}:${PORT}`}});
const cookie=(r.headers.getSetCookie?.()??[]).map(s=>s.split(";")[0]).join("; ");
const ws=new WebSocket(`ws://${HOST}:${PORT}/api/remote.mux`,{headers:{Cookie:cookie}});
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;setTimeout(rej,8000);});
const id="t"+Math.random().toString(36).slice(2,8); let snap;
ws.onmessage=(e)=>{try{const f=JSON.parse(e.data);if(f.streamId===id&&f.type==="item"&&snap===undefined)snap=f.value;}catch{}};
ws.send(JSON.stringify({type:"open",streamId:id,endpoint:"session/follow",payload:{args:{request:{address:{kind:"session",sessionId:sid}}}}}));
const dl=Date.now()+15000; while(snap===undefined&&Date.now()<dl) await new Promise(r2=>setTimeout(r2,200));
ws.close();
const recs=(snap?.records??[]).sort((a,b)=>a.event.seq-b.event.seq);
console.log("总记录:", recs.length);
console.log("\n=== deliverables/presented ===");
for (const rec of recs) if(rec.event?.type==="deliverables/presented") console.log(JSON.stringify(rec.event.data).slice(0,400));
console.log("\n=== user/message ===");
for (const rec of recs) {
  const ev=rec.event; if(ev.type!=="user/message") continue;
  const c=ev.data?.content;
  const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(x=>x.type==="text").map(x=>x.text).join(""):"");
  console.log(`seq=${ev.seq} | ${t.slice(0,80).replace(/\n/g," ")}`);
}
setTimeout(()=>process.exit(0),150);
