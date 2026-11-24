// Leseseite: baut den Artikel als sauberes HTML auf und speichert ihn als PDF.

const $ = (id) => document.getElementById(id);
const bar = $('bar');
const statusEl = $('status');
const doc = $('doc');

let article = null;
let lastDownloadId = null;
let imageNote = '';

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  bar.className = `no-print ${kind}`;
}

function safeHref(href) {
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// Inline-Knoten aus dem JSON-Baum in DOM umwandeln. Text nur über textContent.
function renderInline(nodes, parent) {
  for (const n of nodes || []) {
    if (n.t === 'text') {
      parent.append(document.createTextNode(n.v));
    } else if (n.t === 'br') {
      parent.append(document.createElement('br'));
    } else if (n.t === 'strong' || n.t === 'em' || n.t === 'code') {
      const el = document.createElement(n.t);
      renderInline(n.c, el);
      parent.append(el);
    } else if (n.t === 'a') {
      const href = safeHref(n.href);
      const el = document.createElement(href ? 'a' : 'span');
      if (href) el.href = href;
      renderInline(n.c, el);
      parent.append(el);
    }
  }
}

function renderBlock(b) {
  switch (b.t) {
    case 'p': case 'h1': case 'h2': case 'h3': case 'h4': case 'blockquote': {
      // Überschriften im Text eine Stufe tiefer als der Titel.
      const tag = b.t === 'h1' ? 'h2' : b.t === 'h2' ? 'h2' : b.t;
      const el = document.createElement(tag);
      renderInline(b.c, el);
      return el;
    }
    case 'pre': {
      const el = document.createElement('pre');
      el.textContent = b.v;
      return el;
    }
    case 'ul': case 'ol': {
      const el = document.createElement(b.t);
      for (const item of b.items) {
        const li = document.createElement('li');
        if (item.depth) li.className = `d${Math.min(item.depth, 2)}`;
        renderInline(item.c, li);
        el.append(li);
      }
      return el;
    }
    case 'hr':
      return document.createElement('hr');
    case 'figure': {
      const fig = document.createElement('figure');
      for (const im of b.imgs) {
        const src = safeHref(im.src);
        if (!src) continue;
        const img = document.createElement('img');
        img.src = src;
        img.alt = im.alt || '';
        fig.append(img);
      }
      if (b.caption) {
        const cap = document.createElement('figcaption');
        renderInline(b.caption, cap);
        fig.append(cap);
      }
      return fig;
    }
    case 'embed': {
      const el = document.createElement('div');
      el.className = 'embed';
      el.textContent = b.text;
      const href = safeHref(b.href);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = href;
        el.append(a);
      }
      return el;
    }
    default:
      return null;
  }
}

function render(a) {
  document.title = a.title;
  const cover = safeHref(a.cover);
  if (cover) {
    const img = document.createElement('img');
    img.className = 'cover';
    img.src = cover;
    img.alt = '';
    doc.append(img);
  }
  const h1 = document.createElement('h1');
  h1.className = 'title';
  h1.textContent = a.title;
  doc.append(h1);

  const by = document.createElement('p');
  by.className = 'byline';
  const parts = [];
  if (a.author?.name) parts.push(a.author.name);
  if (a.author?.handle) parts.push(`@${a.author.handle}`);
  if (a.time) {
    const d = new Date(a.time);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }));
  }
  by.textContent = parts.join(' · ');
  doc.append(by);

  for (const b of a.body) {
    const el = renderBlock(b);
    if (el) doc.append(el);
  }

  const src = document.createElement('p');
  src.className = 'source';
  src.append('Quelle: ');
  const link = document.createElement('a');
  link.href = safeHref(a.url) || '#';
  link.textContent = a.url;
  src.append(link);
  doc.append(src);
}

// Auf alle Bilder warten, sonst fehlen sie in der PDF.
async function waitForImages(timeoutMs = 20000) {
  const imgs = [...doc.querySelectorAll('img')];
  let failed = 0;
  await Promise.all(imgs.map((img) => Promise.race([
    img.decode().catch(() => { failed += 1; }),
    new Promise((r) => setTimeout(() => { if (!img.complete) failed += 1; r(); }, timeoutMs)),
  ])));
  return { total: imgs.length, failed };
}

// Dateiname ohne Zeichen, die Chrome oder das Dateisystem ablehnen.
function fileName(a, strict = false) {
  const clean = (s) => {
    let t = String(s || '').normalize('NFC')
      .replace(/[\\/:*?"<>|~\u0000-\u001f\u007f]+/g, ' ')
      .replace(/[\u200b\u200d\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, '');
    if (strict) t = t.replace(/[^\p{L}\p{N} _-]+/gu, ' ');
    t = t.replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    return Array.from(t).slice(0, 80).join('').trim();
  };
  const title = clean(a.title) || 'X-Artikel';
  const handle = clean(a.author?.handle);
  return `X-Artikel/${handle ? `${handle} - ` : ''}${title}.pdf`;
}

async function startDownload(url) {
  try {
    return { id: await chrome.downloads.download({ url, filename: fileName(article), conflictAction: 'uniquify' }), name: fileName(article) };
  } catch {
    // Zweiter Versuch mit stark vereinfachtem Namen: Der Titel darf die PDF nicht verhindern.
    const name = fileName(article, true);
    try {
      return { id: await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' }), name };
    } catch (err) {
      throw new Error(`Chrome konnte die Datei nicht speichern (${err.message}).`);
    }
  }
}

function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}

async function printToPdf() {
  const tab = await chrome.tabs.getCurrent();
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(`Chrome hat den PDF-Druck abgelehnt (${err.message}). Schließe offene Entwicklertools für diesen Tab oder nutze „Drucken …“.`);
  }
  try {
    const { data } = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    return data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function savePdf() {
  $('btn-pdf').disabled = true;
  try {
    setStatus('PDF wird erzeugt …');
    const data = await printToPdf();
    const blob = base64ToBlob(data);
    const url = URL.createObjectURL(blob);
    const { id: downloadId, name } = await startDownload(url);
    lastDownloadId = downloadId;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`Gespeichert in „Downloads/${name}“ (${Math.round(blob.size / 1024)} KB).${imageNote}`, 'done');
    $('btn-show').hidden = false;
    document.documentElement.dataset.pdf = 'saved';
  } catch (err) {
    setStatus(`PDF nicht gespeichert: ${err.message}`, 'error');
    document.documentElement.dataset.pdf = 'error';
  } finally {
    $('btn-pdf').disabled = false;
  }
}

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  const key = `article:${id}`;
  const stored = id ? await chrome.storage.session.get(key) : {};
  article = stored[key];
  if (!article) {
    setStatus('Artikel nicht gefunden: Die Daten gehen beim Schließen von Chrome verloren. Öffne den Artikel auf x.com und klicke erneut auf das Symbol.', 'error');
    return;
  }
  render(article);
  $('btn-print').disabled = false;
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-pdf').addEventListener('click', savePdf);
  $('btn-show').addEventListener('click', () => {
    if (lastDownloadId !== null) chrome.downloads.show(lastDownloadId);
  });

  setStatus('Bilder werden geladen …');
  const { total, failed } = await waitForImages();
  if (article.missingMedia) {
    imageNote += ` Achtung: ${article.missingMedia} Bilder fehlen, weil X sie beim Klick noch nicht geladen hatte. Klicke auf x.com erneut auf das Symbol.`;
  }
  if (failed) {
    imageNote += ` Achtung: ${failed} von ${total} Bildern fehlen, weil sie nicht geladen wurden (Netzwerk oder X blockiert).`;
  }
  await savePdf();
}

main();
