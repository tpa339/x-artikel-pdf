// Testlauf: Erweiterung in Chromium laden, Artikel aus dem Nachbau auslesen, PDF erzeugen und prüfen.
// Aufruf: node test/run.mjs   (aus dem Ordner x-pdf)
import { chromium } from 'playwright-core';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'xpdf-'));
const downloadDir = path.join(tmp, 'downloads');
fs.mkdirSync(downloadDir);

// Kopie der Erweiterung mit Host-Recht für x.com: ersetzt im Test den activeTab-Zugriff nach dem Klick.
const testExtDir = path.join(tmp, 'extension');
fs.cpSync(extDir, testExtDir, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(testExtDir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['https://x.com/*'];
fs.writeFileSync(path.join(testExtDir, 'manifest.json'), JSON.stringify(mf));

function chromiumPath() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort();
  const dir = dirs.at(-1);
  return path.join(base, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

// Einfaches einfarbiges PNG erzeugen (Rasterbild, damit pdfimages es zählt).
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x += 1) { row[1 + x * 3] = (r + x) & 255; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/img/')) {
    const name = req.url.slice(5).replace('.png', '');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png(600, 350, name === 'cover' ? [57, 73, 171] : [0, 137, 123]));
    return;
  }
  if (req.url.startsWith('/testuser/status/456')) {
    // Wie bei X: Bildplatzhalter zuerst leer, Bilder erscheinen nach 1,5 s.
    const html = fs.readFileSync(path.join(here, 'fixture-article.html'), 'utf8').replace('</body>', `<script>
      const held = [...document.querySelectorAll('[data-testid="tweetPhoto"] img')].map((img) => [img.parentNode, img]);
      held.forEach(([p, img]) => img.remove());
      setTimeout(() => held.forEach(([p, img]) => p.append(img)), 1500);
    </script></body>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.url.startsWith('/testuser/status/') || req.url.startsWith('/plain')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/plain')
      ? '<!doctype html><title>Timeline</title><main><p>Kein Artikel hier</p></main>'
      : fs.readFileSync(path.join(here, 'fixture-article.html')));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` – ${detail}` : ''}`);
}

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  executablePath: chromiumPath(),
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  acceptDownloads: true,
  downloadsPath: downloadDir,
  args: ['--headless=new', `--disable-extensions-except=${testExtDir}`, `--load-extension=${testExtDir}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('Service Worker geladen', !!extId, extId);

  // 1) Auslesen am Nachbau
  const page = await ctx.newPage();
  await page.goto(`${base}/testuser/status/123`);
  await page.addScriptTag({ path: path.join(extDir, 'extractor.js') });
  const r = await page.evaluate(() => globalThis.__xpdfExtract());
  const a = r.article;
  const types = a?.body.map((b) => b.t) || [];
  const flat = JSON.stringify(a);
  check('Artikel erkannt', r.ok === true);
  check('Titel', a?.title === 'Ein Test-Artikel über Drohnen', a?.title);
  check('Autor und Handle', a?.author.name === 'Test Autor' && a?.author.handle === 'testuser', JSON.stringify(a?.author));
  check('Datum', a?.time === '2026-02-08T14:30:47.000Z');
  check('Titelbild', a?.cover === `${base}/img/cover.png`, a?.cover);
  check('Blocktypen', ['h2', 'figure', 'p', 'ul', 'ol', 'hr', 'figure', 'blockquote', 'embed'].every((t) => types.includes(t)), types.join(','));
  check('Bild in großer Auflösung', flat.includes('https://pbs.twimg.com/media/HAgojBoXQAA390X?format=jpg&name=large'));
  check('Fett und Link', flat.includes('"t":"strong"') && flat.includes('https://arxiv.org/abs/2601.22401'));
  check('Emoji als Text', flat.includes('🥇'));
  check('Listen-Ebene', a?.body.find((b) => b.t === 'ul')?.items[1].depth === 1);
  check('Bildunterschrift', a?.body.filter((b) => b.t === 'figure')[1]?.caption?.length > 0);
  check('Unbekannte Blöcke bleiben erhalten', flat.includes('Unbekannter Blocktyp') && flat.includes('Unbekannter Abschnitt'));
  check('Reaktionszahlen nicht im Text', !flat.includes('"306"'));
  check('Letzter Absatz', flat.includes('ENDE-MARKER'));

  // 2) Fehlerfall: Seite ohne Artikel
  await page.goto(`${base}/plain`);
  await page.addScriptTag({ path: path.join(extDir, 'extractor.js') });
  const neg = await page.evaluate(() => globalThis.__xpdfExtract());
  check('Seite ohne Artikel meldet Grund', neg.ok === false && neg.reason === 'no-article', JSON.stringify(neg));

  // 3) Leseseite und PDF. Ersetzt das pbs-Bild durch ein lokales, damit der Test ohne Netz läuft.
  const article = JSON.parse(flat.replace('https://pbs.twimg.com/media/HAgojBoXQAA390X?format=jpg&name=large', `${base}/img/figure.png`));
  await sw.evaluate(async (art) => chrome.storage.session.set({ 'article:test': art }), article);
  const reader = await ctx.newPage();
  const dl = ctx.waitForEvent('page').catch(() => null);
  const downloadPromise = reader.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await reader.goto(`chrome-extension://${extId}/reader.html?id=test`);
  await reader.waitForFunction(() => document.documentElement.dataset.pdf, null, { timeout: 30000 });
  const state = await reader.evaluate(() => document.documentElement.dataset.pdf);
  const status = await reader.textContent('#status');
  check('PDF-Status', state === 'saved', status);
  void dl;

  // Datei finden: entweder als Playwright-Download oder im Download-Verlauf von Chrome.
  let pdfPath = null;
  const download = await downloadPromise;
  if (download) {
    pdfPath = path.join(tmp, 'out.pdf');
    await download.saveAs(pdfPath);
    // Playwright benennt Downloads um. Darum den Namen prüfen, den die Erweiterung an Chrome übergibt.
    const intended = await reader.evaluate(() => fileName(article));
    check('Dateiname', intended === 'X-Artikel/testuser - Ein Test-Artikel über Drohnen.pdf', intended);
  } else {
    const items = await sw.evaluate(async () => {
      for (let i = 0; i < 50; i += 1) {
        const list = await chrome.downloads.search({});
        if (list.length && list[0].state === 'complete') return list;
        await new Promise((r) => setTimeout(r, 200));
      }
      return chrome.downloads.search({});
    });
    pdfPath = items[0]?.filename || null;
    check('Dateiname', !!pdfPath && pdfPath.endsWith('Ein Test-Artikel über Drohnen.pdf'), pdfPath);
  }

  if (pdfPath && fs.existsSync(pdfPath)) {
    fs.copyFileSync(pdfPath, path.join(here, 'last-test-output.pdf'));
    const info = execFileSync('pdfinfo', [pdfPath]).toString();
    const pages = Number((info.match(/Pages:\s+(\d+)/) || [])[1]);
    const size = (info.match(/Page size:\s+(.*)/) || [])[1];
    check('PDF hat Seiten', pages >= 1, `${pages} Seiten, ${size}`);
    check('Seitenformat A5', /\(A5\)/.test(size || ''), size);
    const text = execFileSync('pdftotext', [pdfPath, '-']).toString();
    check('PDF-Text enthält Titel und Ende', text.includes('Ein Test-Artikel') && text.includes('ENDE-MARKER'));
    check('PDF ohne Bedienleiste', !text.includes('PDF speichern'));
    const imgs = execFileSync('pdfimages', ['-list', pdfPath]).toString().trim().split('\n').length - 2;
    check('PDF enthält Bilder', imgs >= 3, `${imgs} Bilder`);
  } else {
    check('PDF-Datei vorhanden', false, String(pdfPath));
  }

  // 4) Leseseite ohne Daten zeigt Grund
  const empty = await ctx.newPage();
  await empty.goto(`chrome-extension://${extId}/reader.html?id=fehlt`);
  await empty.waitForSelector('#bar.error');
  check('Fehlende Daten: Meldung mit Grund', (await empty.textContent('#status')).includes('Artikel nicht gefunden'));

  // 5) Klickpfad über den Service Worker: x.com wird aus dem Nachbau bedient.
  await ctx.route('https://x.com/**', async (route) => {
    const u = new URL(route.request().url());
    const res = await fetch(`${base}${u.pathname}`);
    await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/html' }, body: Buffer.from(await res.arrayBuffer()) });
  });
  // Beim echten Klick liefert activeTab die Adresse mit. Im Test setzen wir sie selbst.
  const clickOn = async (url, pg) => sw.evaluate(async ({ u, active }) => {
    let [tab] = await chrome.tabs.query({ url: u });
    if (!tab && active) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = { ...tab, url: u };
    await globalThis.handleActionClick(tab);
    return { badge: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
  }, { u: url, active: !!pg });

  const xPage = await ctx.newPage();
  await xPage.goto('https://x.com/testuser/status/123');
  const readerOpened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/reader.html'), timeout: 15000 });
  const clickRes = await clickOn('https://x.com/testuser/status/123');
  const r2 = await readerOpened;
  await r2.waitForFunction(() => document.documentElement.dataset.pdf, null, { timeout: 30000 });
  check('Klick: Leseseite öffnet und speichert', (await r2.evaluate(() => document.documentElement.dataset.pdf)) === 'saved', await r2.textContent('#status'));
  check('Klick: Titel in Leseseite', (await r2.textContent('h1.title')) === 'Ein Test-Artikel über Drohnen');
  check('Klick: kein Fehler-Badge', clickRes.badge === '', JSON.stringify(clickRes));

  // Verzögerte Bilder: Die Erweiterung wartet, bis alle Bilder da sind.
  await xPage.goto('https://x.com/testuser/status/456');
  const lazyOpened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/reader.html'), timeout: 15000 });
  await clickOn('https://x.com/testuser/status/456');
  const r5 = await lazyOpened;
  await r5.waitForFunction(() => document.documentElement.dataset.pdf, null, { timeout: 30000 });
  const lazyImgs = await r5.evaluate(() => document.querySelectorAll('main img').length);
  const lazyStatus = await r5.textContent('#status');
  check('Verzögerte Bilder: alle in der Leseseite', lazyImgs === 3 && !lazyStatus.includes('fehlen'), `${lazyImgs} Bilder; ${lazyStatus}`);

  await xPage.goto('https://x.com/plain');
  const negRes = await clickOn('https://x.com/plain');
  const toast = await xPage.textContent('#xpdf-toast').catch(() => null);
  check('Klick auf x.com ohne Artikel: Meldung mit Grund', !!toast && toast.includes('kein X-Artikel') && negRes.badge === '!', toast || JSON.stringify(negRes));

  const other = await ctx.newPage();
  await other.goto(`${base}/plain`);
  await other.bringToFront();
  const otherRes = await clickOn(`${base}/plain`, other);
  check('Klick auf fremder Seite: Badge und Grund', otherRes.badge === '!' && otherRes.title.includes('nicht x.com'), JSON.stringify(otherRes));

  // 6) Titel mit Emoji, Tilde, Schrägstrich und unsichtbaren Zeichen
  const hard = { ...article, title: '🥇 Top ~ 👨‍💻 Papers: Teil 1/2​ of the Week 🚀🚀🚀 '.repeat(3) };
  await sw.evaluate(async (art) => chrome.storage.session.set({ 'article:hard': art }), hard);
  const r3 = await ctx.newPage();
  await r3.goto(`chrome-extension://${extId}/reader.html?id=hard`);
  await r3.waitForFunction(() => document.documentElement.dataset.pdf, null, { timeout: 30000 });
  check('Schwieriger Titel: PDF gespeichert', (await r3.evaluate(() => document.documentElement.dataset.pdf)) === 'saved', `${await r3.textContent('#status')}`);

  // 7) Optional mit Netz: echtes Bild von pbs.twimg.com
  if (process.env.XPDF_NET) {
    await sw.evaluate(async (art) => chrome.storage.session.set({ 'article:net': art }), a);
    const r4 = await ctx.newPage();
    const dlNet = r4.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await r4.goto(`chrome-extension://${extId}/reader.html?id=net`);
    await r4.waitForFunction(() => document.documentElement.dataset.pdf, null, { timeout: 60000 });
    const st = await r4.textContent('#status');
    check('Netz: echtes X-Bild geladen', !st.includes('Bildern fehlen') && st.includes('Gespeichert'), st);
    const d = await dlNet;
    if (d) {
      const p4 = path.join(tmp, 'net.pdf');
      await d.saveAs(p4);
      const n = execFileSync('pdfimages', ['-list', p4]).toString().trim().split('\n').length - 2;
      check('Netz: PDF enthält 3 Rasterbilder', n >= 3, `${n} Bilder`);
    }
  }
} finally {
  await ctx.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
process.exit(failed ? 1 : 0);
