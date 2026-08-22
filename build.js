/* Assemble single-file, dependency-free HTML pages.
   Everything is inlined: an air-gapped transfer tool must not need a CDN. */
const fs = require('fs');
const p = (...a) => require('path').join(__dirname, ...a);

const QRLIB  = fs.readFileSync(p('node_modules/qrcode-generator/dist/qrcode.js'), 'utf8');
const JSQR   = fs.readFileSync(p('node_modules/jsqr/dist/jsQR.js'), 'utf8');
const CORE   = fs.readFileSync(p('core.js'), 'utf8');

function build(srcName, outName, subs) {
  let html = fs.readFileSync(p('src', srcName), 'utf8');
  for (const [token, value] of Object.entries(subs)) {
    const needle = `/*{{${token}}}*/`;
    if (!html.includes(needle)) throw new Error(`${srcName}: missing token ${needle}`);
    html = html.replace(needle, () => value);
  }
  const left = html.match(/\/\*\{\{[A-Z]+\}\}\*\//g);
  if (left) throw new Error(`${srcName}: unsubstituted tokens ${left.join(', ')}`);
  fs.mkdirSync(p('build'), {recursive: true});
  fs.writeFileSync(p('build', outName), html);
  console.log(`  ${outName.padEnd(26)} ${(html.length/1024).toFixed(0).padStart(5)} KiB`);
}

/* sender: QR encoder library runs both on the page and inside the worker */
const senderWorker = QRLIB + '\n' + fs.readFileSync(p('src/worker.body.js'), 'utf8');
build('sender.html', 'qr-bridge-v2.html', {
  QRLIB, CORE,
  WORKERSRC: 'const WORKER_SOURCE = ' + JSON.stringify(senderWorker) + ';'
});

/* receiver: jsQR runs inside the decode workers, core runs on the page */
const rxWorker = JSQR + '\n' + fs.readFileSync(p('src/rxworker.body.js'), 'utf8');
build('receiver.html', 'qr-bridge-v2-rx.html', {
  CORE,
  WORKERSRC: 'const WORKER_SOURCE = ' + JSON.stringify(rxWorker) + ';'
});

console.log('\nbuilt into build/');
