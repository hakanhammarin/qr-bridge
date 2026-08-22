const qrcode=require('qrcode-generator'), jsQR=require('jsqr').default||require('jsqr');
const C=require('./core.js'), crypto=require('crypto');

function render(qr, scale, quiet){
  const n=qr.getModuleCount(), size=(n+quiet*2)*scale;
  const d=new Uint8ClampedArray(size*size*4).fill(255);
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){ if(!qr.isDark(r,c))continue;
    for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){
      const px=((r+quiet)*scale+y)*size+((c+quiet)*scale+x); 
      d[px*4]=0;d[px*4+1]=0;d[px*4+2]=0; } }
  return {data:d,size};
}

let fail=0;
console.log('  full chain: bytes -> packet+CRC -> base45 -> QR alnum -> pixels -> jsQR -> bytes\n');
console.log('  ver-EC  symbolB  chars  modules  px@scale3  decoded  bytes-match');
for(const [ver,ec,capChars] of [[27,'M',1637],[33,'M',2369],[33,'L',3009],[40,'M',3391],[40,'L',4296]]){
  const maxBytes=Math.floor(capChars/3)*2;
  const symbolSize=maxBytes-C.OVERHEAD-((maxBytes-C.OVERHEAD)%2);
  const payload=crypto.randomBytes(symbolSize);
  const pkt=C.packPacket(C.T_DATA,42,0x12345678,payload);
  const str=C.b45encode(pkt);
  const qr=qrcode(ver,ec); qr.addData(str,'Alphanumeric'); qr.make();
  const {data,size}=render(qr,3,4);
  const res=jsQR(data,size,size);
  let match=false, dec=!!res;
  if(res){
    try{ const back=C.unpackPacket(C.b45decode(res.data));
      match = !!back && back.blockIdx===42 && back.seed===0x12345678 &&
              Buffer.compare(Buffer.from(back.payload),payload)===0;
    }catch(e){ match=false; }
  }
  if(!match) fail++;
  console.log(`  v${ver}-${ec}  ${String(symbolSize).padStart(7)}  ${String(str.length).padStart(5)}  ${String(qr.getModuleCount()).padStart(7)}  ${String(size).padStart(9)}  ${String(dec).padStart(7)}  ${match}`);
}
console.log(fail?`\n${fail} FAILED`:'\nQR ROUND-TRIP OK — base45+alphanumeric survives a real encode/decode');
process.exit(fail?1:0);
