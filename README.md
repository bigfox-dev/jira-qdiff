# Jira Diff Highlighter — Server / Data Center

Rozšíření pro **Chrome i Firefox** (MV3), které na záložce **History** v detailu
tasku nahradí Jiřin plochý výpis „Original / New“ skutečným barevným diffem —
dvousloupcovým nebo sjednoceným, se zvýrazněním na úrovni slov.

Cílí na **on-premise Jiru (Server / Data Center)**.


---

## Co to umí

- **Dvouprůchodový diff** — nejdřív po řádcích (zarovnané páry starý/nový),
  pak uvnitř změněných řádků po slovech. Řádky jsou zarovnané přes CSS grid,
  takže levý a pravý sloupec drží krok i při zalomení dlouhého textu.
- **Dva pohledy** — *Side by side* a *Unified*; přepínač je přímo v liště diffu
  a volba se pamatuje.
- **Skládání beze změny** — dlouhé úseky nezměněných řádků se sbalí na
  `⋯ N unchanged lines` s rozbalením jedním klikem (počet kontextových řádků
  je nastavitelný).
- **Čtení hodnot z Jiry** — odstraní se popisek `Original:` / `New:`,
  interní `<span class="hist-value">[ … ]</span>`, `&nbsp;` výplně
  a zdvojené konce řádků (Jira posílá `<br/>` **i** skutečný newline).
- **Zpět na originál** — tlačítko *Jira original* schová widget a ukáže
  původní buňky Jiry; návrat tlačítkem *↩ Enhanced diff*.
- **Světlý i tmavý motiv** podle `prefers-color-scheme`.
- **Rozumné rozpoznání polí** — v režimu *Auto* se diff použije na každou
  víceřádkovou nebo dostatečně dlouhou hodnotu (Description, Environment,
  Acceptance Criteria, vlastní textová pole…), krátké technické změny
  (Rank, Time Spent, Worklog Id) zůstanou beze změny.

---

## Instalace

Rozšíření se nepublikuje, načítá se lokálně. Kořen repa je rovnou načtitelný
v Chrome; pro Firefox (a pro balíčky k distribuci) se buildí:

```bash
npm run build          # -> dist/chrome/ a dist/firefox/
npm run build:zip      # + dist/chrome-1.0.0.zip, dist/firefox-1.0.0.zip
```

### Chrome / Edge

1. Otevři `chrome://extensions`.
2. Zapni **Developer mode**.
3. **Load unpacked** → vyber kořen repa (nebo `dist/chrome/`).
4. Otevři svoji Jiru, klikni na ikonu rozšíření a v popupu dej **Enable**.

### Firefox

1. `npm run build`
2. Otevři `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → vyber `dist/firefox/manifest.json`.
4. Stejně jako výše: ikona rozšíření → **Enable**.

Dočasný add-on zmizí při restartu prohlížeče. Pro trvalou instalaci potřebuješ
podepsaný XPI z [addons.mozilla.org](https://addons.mozilla.org/developers/)
(nahraj `dist/firefox-1.0.0.zip`, klidně jako *unlisted* — dostaneš podepsaný
XPI jen pro sebe), nebo Firefox Developer Edition / ESR s
`xpinstall.signatures.required=false` v `about:config`.

Než budeš publikovat, přepiš `GECKO_ID` v [tools/build.js](tools/build.js) na
vlastní — je to identita add-onu na AMO.

### Proč se musí ještě klikat na Enable

On-premise Jira běží na libovolném interním hostname, takže v manifestu není
žádná pevná `matches` doména. Popup si vyžádá oprávnění pro konkrétní origin
a teprve pak zaregistruje content script (`scripting.registerContentScripts`,
`persistAcrossSessions`). Aktuálně otevřená záložka se doinjektuje hned, další
načtení už jedou samy.

Odebrání přístupu k hostu: stejný popup → **Disable** (zruší registraci
i samotné oprávnění).

---

## Nastavení (popup)

| Volba | Výchozí | Popis |
|---|---|---|
| Enhance history diffs | zapnuto | Hlavní vypínač. |
| Layout | Side by side | Dvousloupcový vs. sjednocený pohled. |
| Highlight granularity | Word | Zvýraznění po slovech nebo po znacích. |
| Collapse unchanged lines | zapnuto | Sbalování nezměněných úseků. |
| Context lines | 3 | Kolik nezměněných řádků zůstane kolem změny. |
| Ignore whitespace & `&nbsp;` noise | zapnuto | Sjednotí odsazení a sloučí prázdné řádky. |
| Which fields | Auto | *Auto* = víceřádkové/dlouhé hodnoty + jmenovaná pole, *Named only* = jen jmenovaná pole. |
| Min. length for auto | 80 | Práh délky pro režim *Auto*. |
| Field names | description, popis, environment, … | Seznam se porovnává jako podřetězec, takže funguje i na lokalizované názvy. |

Nastavení je ve `storage.sync` a projeví se okamžitě ve všech otevřených
záložkách.

---

## Struktura

```
manifest.json          MV3 pro Chrome; Firefox varianta se z něj odvozuje
background.js          registrace/odregistrace content scriptů podle oprávnění
common/settings.js     sdílené defaulty + storage vrstva (popup i content)
content/
  diff.js              Myers O(ND) + patience anchory, word/char tokenizer
  extract.js           Jira <td> -> čistý text (labely, hist-value, <br/>, &nbsp;)
  render.js            model řádků, sbalování, CSS grid, lišta widgetu
  content.js           hledání řádků historie, MutationObserver, přepínání
  styles.css           vzhled widgetu (světlý/tmavý)
popup/                 popup UI
tools/
  build.js             dist/chrome + dist/firefox (+ --zip), bez závislostí
  make-icons.js        generátor ikon
  serve.js             statický server pro offline fixture
test/
  fixture.html         reálná on-prem HTML struktura pro ruční kontrolu
  diff.test.mjs        unit testy diff enginu
  background.test.mjs  background proti falešným API obou prohlížečů
```

### Proč vlastní diff engine

Upstream používá `diff-match-patch`, což je znakový diff nad celým textem.
U víceřádkových popisů z toho vzniká „konfety" efekt. Tady je diff nejdřív
řádkový (aby šly řádky zarovnat vedle sebe jako na GitHubu) a teprve uvnitř
párovaných řádků slovní. Když je řádek přepsaný od základu
(> 72 % změněných znaků), zvýrazní se celý místo rozsekání na útržky.

Pro velké vstupy se Myers vypne a použijí se *patience* kotvy (unikátní
společné řádky) s rekurzivním dělením; v nejhorším případě diff degraduje na
„smazáno vše / vloženo vše" místo zamrznutí stránky.

---

## Vývoj

```bash
npm test
```

Vizuální kontrola bez Jiry — fixture obsahuje přesnou on-prem HTML strukturu
(popis, summary, environment, dlouhý popis se sbalováním, i řádky, které se
zvýrazňovat nemají):

```bash
node tools/serve.js
```

pak otevři `http://localhost:4173/test/fixture.html`. Fixture načítá stejné
skripty jako rozšíření; `chrome.*` API se automaticky obchází (`JDH_TEST_SETTINGS`).

Přegenerování ikon:

```bash
node tools/make-icons.js
```

### Jak funguje cross-browser build

Kořenový `manifest.json` je zároveň Chrome manifest i zdroj pravdy. Firefox
verzi z něj [tools/build.js](tools/build.js) odvodí patchem, takže obě nemůžou
rozejít:

| | Chrome | Firefox |
|---|---|---|
| background | `service_worker` | `scripts` (event page — MV3 service worker v Gecku není) |
| identita | — | `browser_specific_settings.gecko.id` (nutné pro `storage.sync`) |
| minimální verze | — | `strict_min_version: 128.0` |

**Pozor na jmenné prostory** — jediná netriviální nekompatibilita v kódu:

- Chrome MV3 vrací promisy z `chrome.*`.
- Firefox promisifikuje **jen** `browser.*`; jeho `chrome.*` je callback-only
  kompatibilní alias a promisy nevrací.

Proto:

- **promise-based kód** (`background.js`) musí sáhnout po
  `globalThis.browser || globalThis.chrome`,
- **callback-based kód** (`common/settings.js`, `content/content.js`,
  `popup/popup.js`) musí zůstat u `chrome.*`, protože `browser.*` by ty
  callbacky nikdy nezavolalo.

Míchat se to nesmí. `test/background.test.mjs` pouští `background.js` proti
falešným API obou prohlížečů (Firefox varianta má navíc `chrome` návnadu, která
vrací `undefined`), takže návrat k holému `chrome.` v promise kódu testy shodí.

---

## Inspirace

Nápad a UX vychází z [richiehowelll/jira-diff](https://github.com/richiehowelll/jira-diff)
(GPL-3.0), který řeší totéž pro Jira Cloud. **Není to doslovný fork** — on-prem
DOM je úplně jiný, takže extrakce, diff engine i rendering jsou napsané od
nuly a žádný upstream kód se sem nepřenášel. Pokud chceš mít projekt
formálně navázaný na upstream, změň licenci na GPL-3.0.

## Licence

MIT — viz [LICENSE](LICENSE).
