/* Does the receiver's second-chance contrast stretch actually recover frames,
   or is it decoration? Render a real code, crush its contrast the way glare and
   panel dimming do, and compare decode success with and without the retry. */
const qrcode = require('qrcode-generator');
const jsQR = require('jsqr').default || require('jsqr');
const C = require('./core.js');
const crypto = require('crypto');

/* the exact stretch() the worker runs */
function stretch(buf, w, h) {
  var n = w*h, hist = new Uint32Array(256), i, p, v;
  for (i=0,p=0;i<n;i++,p+=4) hist[(buf[p]*0.299+buf[p+1]*0.587+buf[p+2]*0.114)|0]++;
  var lo=0,hi=255,acc=0,loT=n*0.02,hiT=n*0.98;
  for (i=0;i<256;i++){acc+=hist[i];if(acc>=loT){lo=i;break;}}
  acc=0; for (i=0;i<256;i++){acc+=hist[i];if(acc>=hiT){hi=i;break;}}
  if (hi-lo<8 || (lo<12&&hi>243)) return null;
  var out=new Uint8ClampedArray(buf.length),k=255/(hi-lo);
  for (i=0,p=0;i<n;i++,p+=4){
    v=(buf[p]*0.299+buf[p+1]*0.587+buf[p+2]*0.114-lo)*k;
    v=v<0?0:v>255?255:v;
    out[p]=out[p+1]=out[p+2]=v; out[p+3]=255;
  }
  return out;
}

function render(ver, ec, scale, {gain, lift, noise}) {
  const sym = Math.floor({27:1637,20:970}[ver]/3)*2 - C.OVERHEAD;
  const pkt = C.packPacket(C.T_DATA, 1, 12345, crypto.randomBytes(sym - sym%2));
  const q = qrcode(ver, ec); q.addData(C.b45encode(pkt), 'Alphanumeric'); q.make();
  const n = q.getModuleCount(), quiet = 4, full = n + quiet*2, size = full*scale;
  const d = new Uint8ClampedArray(size*size*4);
  for (let r = 0; r < full; r++) for (let c = 0; c < full; c++) {
    const dark = r>=quiet && c>=quiet && r<quiet+n && c<quiet+n && q.isDark(r-quiet, c-quiet);
    let v = dark ? lift : 255;
    v = (v-128)*gain + 128;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const px = ((r*scale+y)*size + c*scale+x)*4;
      const nv = Math.max(0, Math.min(255, v + (Math.random()-0.5)*2*noise));
      d[px]=d[px+1]=d[px+2]=nv; d[px+3]=255;
    }
  }
  return {d, size};
}

console.log('  contrast condition                 raw jsQR   with stretch   recovered');
console.log('  ' + '-'.repeat(70));
let recovered = 0, rawOk = 0, trials = 0;
const conds = [
  ['normal (0 lift, gain 1.0)',        {gain:1.00, lift:0,   noise:4}],
  ['mild glare (lift 90)',             {gain:1.00, lift:90,  noise:4}],
  ['heavy glare (lift 150)',           {gain:1.00, lift:150, noise:4}],
  ['panel dimmed (gain 0.35)',         {gain:0.35, lift:0,   noise:4}],
  ['dim + glare (gain 0.5, lift 120)', {gain:0.50, lift:120, noise:3}],
  ['very flat (gain 0.18)',            {gain:0.18, lift:0,   noise:2}],
];
for (const [label, opt] of conds) {
  let raw = 0, str = 0; const N = 12;
  for (let t = 0; t < N; t++) {
    const {d, size} = render(27, 'M', 4, opt);
    const a = jsQR(d, size, size, {inversionAttempts:'dontInvert'});
    if (a) raw++;
    else { const s2 = stretch(d, size, size); if (s2 && jsQR(s2, size, size, {inversionAttempts:'dontInvert'})) str++; }
  }
  trials += N; rawOk += raw; recovered += str;
  console.log('  ' + label.padEnd(34) + `${raw}/${N}`.padStart(8) + `${raw+str}/${N}`.padStart(15) + `${str}`.padStart(12));
}
console.log('  ' + '-'.repeat(70));
console.log(`  raw ${rawOk}/${trials}, stretch recovered a further ${recovered} frames ` +
            `(+${(100*recovered/trials).toFixed(0)}% of all attempts)`);
process.exit(recovered > 0 ? 0 : 1);
