const HOST="192.168.190.223",PORT=3095,TOKEN=process.env.DSH_TOKEN;
const sid="9d0faf26-781d-4f8d-8546-fa613054e693";
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
console.log("=== 队员会话的工具调用 ===");
for (const rec of recs) {
  const ev=rec.event; if(ev.type!=="tool/call") continue;
  const n = ev.data?.name;
  const a = JSON.stringify(ev.data?.arguments ?? "").slice(0,120);
  console.log(`seq=${ev.seq} | ${n} | ${a}`);
}
console.log("\n=== deliverables ===");
for (const rec of recs) if(rec.event?.type==="deliverables/presented") console.log(JSON.stringify(rec.event.data).slice(0,300));
setTimeout(()=>process.exit(0),150);
