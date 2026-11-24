// Klick auf das Symbol: Artikel auslesen, Leseseite öffnen. Die Leseseite erzeugt die PDF.

const REASONS = {
  'not-x': 'Diese Seite ist nicht x.com. Öffne zuerst einen X-Artikel.',
  'no-article': 'Auf dieser Seite ist kein X-Artikel. Öffne den Artikel selbst (nicht die Timeline) und versuche es erneut.',
  empty: 'Der Artikel ist leer oder noch nicht geladen. Warte kurz und versuche es erneut.',
  'no-access': 'Chrome erlaubt der Erweiterung keinen Zugriff auf diese Seite.',
};

async function showError(tab, reason, detail) {
  const text = REASONS[reason] || `Unbekannter Fehler: ${detail || reason}`;
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828', tabId: tab.id });
  await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
  await chrome.action.setTitle({ title: `X-Artikel als PDF – Fehler: ${text}`, tabId: tab.id });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [text],
      func: (msg) => {
        document.getElementById('xpdf-toast')?.remove();
        const el = document.createElement('div');
        el.id = 'xpdf-toast';
        el.textContent = `X-Artikel als PDF: ${msg}`;
        Object.assign(el.style, {
          position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
          background: '#c62828', color: '#fff', padding: '12px 18px', borderRadius: '10px',
          font: '15px/1.4 -apple-system, system-ui, sans-serif', maxWidth: '520px', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        });
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 7000);
      },
    });
  } catch {
    // Seite erlaubt keine Skripte (z. B. chrome://). Das Badge und der Titel zeigen den Fehler.
  }
}

async function clearError(tab) {
  await chrome.action.setBadgeText({ text: '', tabId: tab.id });
  await chrome.action.setTitle({ title: 'X-Artikel als PDF speichern', tabId: tab.id });
}

async function handleActionClick(tab) {
  let host = '';
  try {
    host = new URL(tab.url || tab.pendingUrl || '').hostname;
  } catch {
    // Kein URL-Zugriff: der Inhalt entscheidet unten.
  }
  if (host && !/(^|\.)(x|twitter)\.com$/.test(host)) {
    await showError(tab, 'not-x');
    return;
  }

  let result;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
    // X lädt Bilder verzögert. Bis zu 8 s warten, bis alle Platzhalter ein Bild haben.
    const start = Date.now();
    const looksLikeArticle = /\/(status|article)\//.test(tab.url || '');
    for (;;) {
      const [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.__xpdfExtract(),
      });
      result = r;
      const elapsed = Date.now() - start;
      const waitMedia = result?.pendingMedia > 0 && elapsed < 8000;
      const waitLoad = !result?.ok && looksLikeArticle && elapsed < 3000;
      if (!waitMedia && !waitLoad) break;
      await new Promise((res) => setTimeout(res, 400));
    }
  } catch (err) {
    await showError(tab, 'no-access', err.message);
    return;
  }

  if (!result?.ok) {
    await showError(tab, result?.reason || 'empty');
    return;
  }

  await clearError(tab);
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`article:${id}`]: result.article });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`reader.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

// Für den Testlauf ansprechbar.
globalThis.handleActionClick = handleActionClick;
chrome.action.onClicked.addListener(handleActionClick);
