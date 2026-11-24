// Liest einen X-Artikel aus der geöffneten Seite.
// Ergebnis: ein JSON-Baum ohne HTML-Strings. Die Leseseite baut daraus sicheres DOM.
globalThis.__xpdfExtract = function () {
  const readView = document.querySelector('[data-testid="twitterArticleReadView"]');
  const rich = readView?.querySelector('[data-testid="longformRichTextComponent"]')
    || document.querySelector('[data-testid="longformRichTextComponent"]');
  if (!readView || !rich) {
    return { ok: false, reason: 'no-article' };
  }

  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'VIDEO', 'NOSCRIPT']);

  function absUrl(href) {
    try {
      const u = new URL(href, location.href);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  // Bilder von pbs.twimg.com in großer Auflösung laden.
  function imageUrl(src) {
    const u = absUrl(src);
    if (!u) return null;
    const url = new URL(u);
    if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
      const m = url.pathname.match(/^\/media\/([^./]+)(?:\.(\w+))?$/);
      if (m) {
        const format = url.searchParams.get('format') || m[2] || 'jpg';
        return `https://pbs.twimg.com/media/${m[1]}?format=${format}&name=large`;
      }
    }
    return url.href;
  }

  function isEmoji(img) {
    return /\/emoji\//.test(img.getAttribute('src') || '');
  }

  function blockTypeOf(el) {
    const cls = el.classList;
    if (el.getAttribute('role') === 'separator') return 'hr';
    if (cls.contains('longform-header-one')) return 'h1';
    if (cls.contains('longform-header-two')) return 'h2';
    if (cls.contains('longform-header-three')) return 'h3';
    if (cls.contains('longform-blockquote')) return 'blockquote';
    if (cls.contains('longform-code-block')) return 'pre';
    if (cls.contains('longform-unstyled')) return 'p';
    if ([...cls].some((c) => c.startsWith('longform-'))) return 'p';
    if (el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'LI') return el.tagName.toLowerCase();
    if (BLOCK_TAGS.has(el.tagName)) return el.tagName.toLowerCase();
    return null;
  }

  // Inline-Inhalt: Text, fett, kursiv, Links, Emoji.
  function inline(node, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.data) out.push({ t: 'text', v: node.data });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    if (el.tagName === 'IMG') {
      if (isEmoji(el)) out.push({ t: 'text', v: el.alt || '' });
      return;
    }
    if (el.tagName === 'BR') {
      out.push({ t: 'br' });
      return;
    }
    const kids = [];
    el.childNodes.forEach((c) => inline(c, kids));
    const style = el.getAttribute('style') || '';
    let wrapped = kids;
    if (/font-weight:\s*(bold|[6-9]00)/.test(style) || el.tagName === 'STRONG' || el.tagName === 'B') {
      wrapped = [{ t: 'strong', c: wrapped }];
    }
    if (/font-style:\s*italic/.test(style) || el.tagName === 'EM' || el.tagName === 'I') {
      wrapped = [{ t: 'em', c: wrapped }];
    }
    if (el.tagName === 'CODE') wrapped = [{ t: 'code', c: wrapped }];
    if (el.tagName === 'A') {
      const href = absUrl(el.getAttribute('href'));
      if (href && !/\/media\/\d+/.test(href)) wrapped = [{ t: 'a', href, c: wrapped }];
    }
    out.push(...wrapped);
  }

  function hasText(nodes) {
    return nodes.some((n) => (n.t === 'text' ? n.v.trim() : n.c && hasText(n.c)));
  }

  // Abschnitt mit Bild (und evtl. Bildunterschrift) oder eingebettetem Post.
  function section(el, out) {
    const imgs = [...el.querySelectorAll('img')].filter((i) => !isEmoji(i) && !i.closest('[data-testid^="UserAvatar"]'));
    const embed = el.querySelector('[data-testid="tweet"], [data-testid="simpleTweet"]');
    if (embed) {
      const link = [...embed.querySelectorAll('a[href*="/status/"]')].map((a) => absUrl(a.getAttribute('href'))).find(Boolean);
      const text = embed.querySelector('[data-testid="tweetText"]')?.innerText || embed.innerText;
      out.push({ t: 'embed', text: text.trim().slice(0, 2000), href: link || null });
      return;
    }
    if (imgs.length) {
      const capNodes = [];
      const capRoot = el.querySelector('[data-testid="longformRichTextComponent"]');
      if (capRoot) {
        capRoot.childNodes.forEach((c) => inline(c, capNodes));
      } else {
        // Kein eigener Textbereich: übrigen Text des Abschnitts als Unterschrift behalten.
        const rest = el.innerText.trim();
        if (rest) capNodes.push({ t: 'text', v: rest });
      }
      out.push({
        t: 'figure',
        imgs: imgs.map((i) => ({ src: imageUrl(i.getAttribute('src')), alt: i.alt || '' })).filter((i) => i.src),
        caption: hasText(capNodes) ? capNodes : null,
      });
      return;
    }
    if (el.querySelector('[role="separator"]')) {
      out.push({ t: 'hr' });
      return;
    }
    // Unbekannter Abschnitt: Text behalten, damit nichts verloren geht.
    const text = el.innerText.trim();
    if (text) out.push({ t: 'p', c: [{ t: 'text', v: text }] });
  }

  function blocks(node, out) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    if (el.tagName === 'SECTION') {
      section(el, out);
      return;
    }
    const type = blockTypeOf(el);
    if (type === 'hr') {
      out.push({ t: 'hr' });
      return;
    }
    if (type === 'ul' || type === 'ol') {
      const items = [];
      [...el.children].forEach((li) => {
        const c = [];
        li.childNodes.forEach((n) => inline(n, c));
        items.push({ t: 'li', c, depth: Number((li.className.match(/depth(\d)/) || [])[1] || 0) });
      });
      out.push({ t: type, items });
      return;
    }
    if (type) {
      const c = [];
      el.childNodes.forEach((n) => inline(n, c));
      if (type === 'pre') {
        out.push({ t: 'pre', v: el.innerText });
      } else if (hasText(c)) {
        out.push({ t: type, c });
      }
      return;
    }
    // Wrapper-Div: in die Kinder gehen.
    if (el.children.length) {
      [...el.children].forEach((k) => blocks(k, out));
    } else if (el.textContent.trim()) {
      // Unbekanntes Blatt: Text behalten.
      out.push({ t: 'p', c: [{ t: 'text', v: el.textContent }] });
    }
  }

  const body = [];
  const root = rich.querySelector('[data-contents="true"]') || rich.firstElementChild || rich;
  [...root.children].forEach((k) => blocks(k, body));

  // Kopf: Titelbild, Titel, Autor, Datum. Diese Teile liegen außerhalb des Textbereichs.
  const titleEl = readView.querySelector('[data-testid="twitter-article-title"]');
  const title = (titleEl?.innerText || document.title || 'X-Artikel').trim();
  let cover = null;
  const firstPhoto = readView.querySelector('[data-testid="tweetPhoto"] img');
  if (firstPhoto && !rich.contains(firstPhoto) && titleEl
      && (firstPhoto.compareDocumentPosition(titleEl) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    cover = imageUrl(firstPhoto.getAttribute('src'));
  }

  const pathHandle = (location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(status|article)\//) || [])[1];
  const avatar = readView.querySelector('[data-testid^="UserAvatar-Container-"]')
    || document.querySelector('[data-testid="primaryColumn"] [data-testid^="UserAvatar-Container-"]');
  const handle = avatar?.dataset.testid.replace('UserAvatar-Container-', '') || pathHandle || '';
  let name = '';
  const userName = readView.querySelector('[data-testid="User-Name"]')
    || readView.closest('article[data-testid="tweet"]')?.querySelector('[data-testid="User-Name"]');
  if (userName) {
    name = userName.innerText.split('\n')[0].trim();
  } else if (handle) {
    const a = [...document.querySelectorAll(`[data-testid="primaryColumn"] a[href="/${handle}"], [data-testid="twitterArticleReadView"] a[href="/${handle}"]`)]
      .find((x) => x.innerText.trim() && !x.innerText.trim().startsWith('@'));
    name = a?.innerText.trim().split('\n')[0] || '';
  }
  const timeEl = readView.querySelector('time')
    || readView.closest('article[data-testid="tweet"]')?.querySelector('time')
    || document.querySelector('[data-testid="primaryColumn"] time');
  const time = timeEl?.getAttribute('datetime') || null;

  // Bildplatzhalter ohne Bild: X lädt das Bild noch.
  const pendingMedia = [...readView.querySelectorAll('[data-testid="tweetPhoto"]')].filter((p) => !p.querySelector('img')).length;

  if (!body.length) return { ok: false, reason: 'empty', pendingMedia };

  return {
    ok: true,
    pendingMedia,
    article: { title, cover, author: { name, handle }, time, url: location.href.split('?')[0], body, missingMedia: pendingMedia },
  };
};
