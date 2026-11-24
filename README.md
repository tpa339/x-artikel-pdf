# X-Artikel als PDF

Chrome-Erweiterung. Sie speichert einen X-Artikel (Langform-Artikel auf x.com) mit einem Klick als PDF. Das Format ist A5 hochkant. Das passt gut zum iPad.

## Installieren

1. Öffne `chrome://extensions`.
2. Schalte oben rechts den „Entwicklermodus“ ein.
3. Klicke auf „Entpackte Erweiterung laden“.
4. Wähle den Ordner `x-pdf/extension`.
5. Hefte das Symbol über das Puzzle-Symbol an die Symbolleiste an.

## Benutzen

1. Öffne einen X-Artikel. Beide Adressformen gehen: `x.com/<name>/status/<id>` und `x.com/<name>/article/<id>`.
2. Klicke auf das Symbol der Erweiterung. Alternative: Drücke `Alt+Shift+P`.
3. Ein neuer Tab zeigt den Artikel als Leseansicht.
4. Die Erweiterung speichert die PDF in `Downloads/X-Artikel/`.

Während der PDF-Erzeugung zeigt Chrome kurz die Leiste „… hat begonnen, diesen Browser zu debuggen“. Das ist normal. Die Erweiterung braucht diese Funktion für den PDF-Druck ohne Dialog.

Wenn der Klick auf einer falschen Seite erfolgt, zeigt die Seite eine rote Meldung mit dem Grund. Das Symbol zeigt dann ein rotes „!“.

## PDF auf das iPad bringen

- AirDrop: Klicke im Finder mit der rechten Maustaste auf die PDF und wähle „Teilen“ > „AirDrop“.
- iCloud Drive: Lege den Ordner `X-Artikel` in iCloud Drive. Öffne die Datei auf dem iPad in der App „Dateien“ oder „Bücher“.

## Grenzen

- Die Erweiterung liest nur X-Artikel (Langform). Normale Posts und Threads sind nicht unterstützt.
- Videos und GIFs erscheinen nicht in der PDF.
- Eingebettete Posts, Zitate und Code-Blöcke: Die Erweiterung behält ihren Text. Die genaue Darstellung ist an echten Artikeln nicht geprüft.
- X lädt Bilder verzögert. Die Erweiterung wartet bis zu 8 Sekunden. Fehlen danach Bilder, nennt die Leseseite die Anzahl.
- X kann den Seitenaufbau ändern. Dann findet die Erweiterung den Artikel eventuell nicht mehr.
- Die Leseansicht braucht die Artikeldaten aus der aktuellen Chrome-Sitzung. Nach einem Neustart von Chrome klickst du erneut auf das Symbol.

## Daten

Die Erweiterung sendet keine Daten an Dritte. Sie lädt nur die Bilder des Artikels von X.

## Testen

Voraussetzung: Node.js, Poppler (`pdfinfo`, `pdftotext`, `pdfimages`), Playwright-Chromium in `~/Library/Caches/ms-playwright`.

```sh
cd x-pdf/test && npm install
cd .. && node test/run.mjs
```

Erwartetes Ergebnis: `31/31 Prüfungen bestanden`. Mit `XPDF_NET=1` prüft der Test zusätzlich ein echtes Bild von X: `33/33`. Der Test liest einen nachgebauten Artikel (`test/fixture-article.html`) und erzeugt `test/last-test-output.pdf`.

Der Test ruft die Klick-Funktion direkt im Service Worker auf. Den echten Klick auf das Symbol und das Recht `activeTab` prüft er nicht. Playwright kann die Symbolleiste nicht bedienen. Prüfe den Klick von Hand auf x.com.
