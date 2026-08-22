const C=require('./core.js'), crypto=require('crypto');
const SS=1560;
function needed(K,trials){ // packets delivered before decode completes
  let acc=[];
  for(let t=0;t<trials;t++){
    const block=crypto.randomBytes(K*SS);
    const enc=C.LTEncoder(block,K*SS>=1?SS:SS), dec=C.LTDecoder(enc.K,SS,block.length);
    let d=0;
    for(let i=0;i<K*3&&!dec.done;i++){ const s=((i*2654435761)^(t*97531))>>>0; d++; dec.add(s,enc.encode(s)); }
    if(!dec.done){acc.push(Infinity);continue}
    if(Buffer.compare(Buffer.from(dec.assemble()),block)!==0) throw new Error('mismatch K='+K);
    acc.push(d/enc.K);
  }
  acc.sort((a,b)=>a-b);
  return {mean:acc.reduce((a,b)=>a+b)/acc.length, p50:acc[Math.floor(acc.length*0.5)], p95:acc[Math.min(acc.length-1,Math.floor(acc.length*0.95))], max:acc[acc.length-1]};
}
console.log(' blockMiB      K    mean    p50    p95    max   <- LT packets needed, as multiple of K');
for(const K of [340,673,1345,2690,5378,10756]){
  const r=needed(K, K>6000?12:30);
  console.log(`${(K*SS/1048576).toFixed(2).padStart(9)} ${String(K).padStart(6)}  ${r.mean.toFixed(3)}  ${r.p50.toFixed(3)}  ${r.p95.toFixed(3)}  ${r.max.toFixed(3)}`);
}
