# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BCP Target Inspector** — a Chrome extension (Manifest V3) that intercepts Adobe Target / Alloy SDK personalization responses on `viabcp.com` (and subdomains) and renders them in the popup: which A/B and XT activities fired, and which mboxes are in use vs. free.

There is **no build, no dependencies, and no tests**. It is plain HTML/CSS/JS loaded as an unpacked extension.

## Running / developing

1. `chrome://extensions/` → enable **Modo desarrollador** → **Cargar descomprimida** → select this folder.
2. Reload the extension icon (↻) in `chrome://extensions/` after **every** change to `inject.js`, `content.js`, `manifest.json`, or `background.js`. Edits to `popup.html`/`popup.js` just require closing and reopening the inspector window (click the toolbar icon again) — no `default_popup` means there's no popup to reopen, only the window.
3. Capture normally happens on **page load**. For a tab that was already open before the extension was (re)loaded, the empty state has a **"Capturar ahora"** button that reinjects `inject.js`/`content.js` on demand via `chrome.scripting.executeScript` — no page reload needed for that case.

## Reference material in this repo (not our code)

Two unpacked-extension folders live alongside the real source, for research only — neither is `require`d, built, or shipped:

- **`referencia/`** — Adobe's own official "Experience Platform Debugger" extension, unpacked, gitignored. Kept in case work ever needs network-level capture (`chrome.debugger` or `webRequest`) — the one thing its hooks cover that ours don't, since `inject.js` only sees what Alloy chooses to expose via `window.__alloyMonitors`/`postMessage`, not raw network traffic. Do not assume anything under `referencia/` is this project's code, and do not edit it.
- **`referencia2/`** — was Jose Perez's separate minimal extension ("Adobe Target QA Helper"), his idea, that only did `at_qa_mode` cookie set/clear via `document.cookie`. Fully analyzed and ported into this project's QA tab (see "QA mode" below) with fixes (input validation, no `<all_urls>`, no unused `cookies` permission) — nothing left to port. Was never committed to git (always untracked, deleted after this project's QA tab absorbed it); if it reappears, it's someone re-adding reference material, not a merge conflict to resolve.

## Architecture: four scripts, one-way data flow, window-only UI

Data flows one direction across two JavaScript worlds because of a Chrome constraint: only isolated-world scripts can touch `chrome.*` APIs, but only main-world scripts can see the page's `window.alloy`. There is no `default_popup` — `background.js` is the only entry point, opening `popup.html` in an independent `chrome.windows.create` window instead.

```
inject.js  (world: MAIN, run_at: document_start)
  ├─ Registers a hook in window.__alloyMonitors → catches every Alloy network response
  │    + onInstanceConfigured → orgId/edgeConfigId/edgeDomain for the active instance
  ├─ Monkey-patches window.alloy() to read decisionScopes before they're sent
  ├─ Scans [data-mbox] DOM nodes (+ MutationObserver, 200ms debounce, for SPAs)
  ├─ Hooks window.digitalData.push (two-layer defineProperty, see inject.js comments)
  ├─ Reads the at_qa_mode cookie once per load (document.cookie, no "cookies" permission)
  └─ Wrapped in a window.__mboxInspectorInjected guard — safe to reinject on demand
       │  window.postMessage({ source: 'mbox-inspector', type, ... })
       ▼
content.js (world: ISOLATED, run_at: document_start)
  ├─ Only script with chrome.storage access; pure postMessage → storage bridge
  ├─ On load: if hostname+pathname changed vs. stored tabUrl, wipes requests/domMboxes/
  │    instanceInfo — NOT digitalDataEvents, which persists across navigation on purpose
  │    (each entry carries its own pageUrl; see "Event persistence" below)
  └─ Wrapped in a window.__mboxInspectorContentActive guard — safe to reinject on demand
       │  chrome.storage.local: { requests[≤50], domMboxes[], digitalDataEvents[≤500],
       │                          instanceInfo, tabUrl, qaMode }
       ▼
popup.js  (popup.html, mounted only inside the independent window)
  ├─ render()             → "Actividades" tab
  ├─ renderMboxes()       → "mBoxes" tab
  ├─ renderEventos()      → "Eventos" tab, grouped by page of the crawl (see below)
  ├─ renderQaTab() / renderQaBanner() → "QA" tab + alert banner on all 4 tabs
  ├─ renderInstanceInfo() → footer: orgId/edgeConfigId of the page's Alloy instance
  └─ chrome.storage.onChanged → live re-render of the active tab

background.js (service worker)
  ├─ chrome.action.onClicked → creates the inspector window (first click) or
  │    focuses the existing one (chrome.windows.get/update) — only entry point
  └─ chrome.tabs.onRemoved → clears the {windowId, tabId} pointer in storage
       when the tab the window was inspecting gets closed
```

Message types (`content.js` switches on `event.data.type`): `alloyResponse` (full payload, unshifted onto `requests`, capped at 50), `domMboxes` (union-merged into `domMboxes`), `decisionScopes` (also merged into `domMboxes`, `__view__` filtered out), `instanceInfo` (orgId/edgeConfigId/edgeDomain, overwrites the single stored value), `qaMode` (overwrites the single stored value every load — see "QA mode" below), `digitalDataPush` (unshifted onto `digitalDataEvents` with `pageUrl` attached, capped at 500).

### Event persistence (`digitalDataEvents` survives navigation)

Unlike `requests`/`domMboxes` (a snapshot of the *current* page, reset on every navigation), `digitalDataEvents` is a *log of the crawl* — each entry keeps the `pageUrl` it fired on, and `content.js`'s page-change reset deliberately skips this key. `popup.js`'s `renderEventos()` re-groups the flat list by consecutive `pageUrl` runs (`groupEventsByPage`), rendering one collapsible `.event-page` section per page visited (most recent expanded, older ones collapsed) — each section internally reuses the pre-existing consecutive-same-event-name grouping (`groupConsecutiveEvents`/`.event-group`) unchanged, so there is never a 3-level nested-toggle tree: collapsing a page hides everything under it in one click. Entries from before this persistence model shipped won't have `pageUrl` — `formatPageLabel` falls back to a "Página desconocida" bucket for those instead of breaking the grouping; no real migration was needed since this is a single-developer local tool.

Cap is 500 (not 50 like `requests`): measured live against viabcp.com, a typical push (`trackScroll`/`trackAction`) is ~60-120B of raw JSON; with the `{payload,time,timeSincePageLoad,pageUrl}` wrapper each stored entry is ~300-500B, so 500 entries ≈ 250KB — a small fraction of the 10MB `chrome.storage.local` quota (no `unlimitedStorage` permission requested or needed). The number is sized to comfortably cover a 30-50 page crawl, not to avoid hitting quota.

`digitalDataEvents` is still wiped by the **LIMPIAR** button and by all three QA mode transitions (Activar/Aplicar cambio/Salir) — those are explicit "start over" actions, unlike an ordinary navigation within the same crawl.

**Known limitation:** storage isn't partitioned by `tabId` (a content script can't cheaply learn its own tab ID — that requires a `chrome.runtime.sendMessage` round-trip to the service worker, which doesn't exist here). Two BCP tabs open at once will interleave events into one timeline instead of two separate crawls. `requests`/`domMboxes` have the same root issue but it's contained to one page at a time; for persisted events it can span the whole crawl. Not solved — deliberately deferred, see README's "Limitación conocida".

### QA mode (`at_qa_mode` cookie, `.tabs__item--qa`)

Sets/reapplies/clears Adobe Target's preview cookie by writing `document.cookie` via `chrome.scripting.executeScript` on the inspected tab (not the popup's own — `getInspectedTab`), then reloading it. `inject.js` detects the cookie itself on every page load (regardless of who set it — this extension, another one, or a stale session) and reports `{active, config}` via the `qaMode` message; the banner in `popup.js` renders off that, never off "did we set it this session." The payload carries no field identifying *which* returned decision is the forced one (checked `decisionProvider`/`strategies`/`characteristics`/`meta` — identical shape on forced vs. non-forced), so there's deliberately no per-activity "forced" badge in the Actividades tab — that would be a promise the client-side code can't keep.

All three transitions (Activar/Aplicar cambio/Salir) clear `requests`/`domMboxes`/`digitalDataEvents` **before** triggering the cookie write + reload (chained through the storage-clear's own callback), not after — reloading first would leave a window where the new page's `inject.js` starts writing while the clear is still in flight, dropping the first capture.

#### Anatomía de la cookie `at_qa_mode`

Un link de preview de Target trae los datos como query params; `parseQaLink` (`popup.js`) los traduce a la cookie que Target realmente lee:

| Query param del link | Campo en la cookie | Notas |
| --- | --- | --- |
| `at_preview_token` | `token` | obligatorio |
| `at_preview_index` (`"N"` o `"N_M"`) | `previewIndexes: [{ activityIndex: N, experienceIndex: M }]` | obligatorio; `experienceIndex` solo si vino el `_M` |
| `at_preview_listed_activities_only` (`"true"`/`"false"`) | `listedActivitiesOnly` | booleano, default `false` si falta |
| `at_preview_evaluate_as_true_audience_ids` (CSV) | `evaluateAsTrueAudienceIds: [...]` | opcional, se omite el campo entero si no vino |

La cookie final es `at_qa_mode=<encodeURIComponent(JSON.stringify(qaData))>; path=/` — ver `cookieValueFromQaConfig`. `activityIndex`/`experienceIndex` son posiciones dentro del orden que usa el admin de Target para esa preview, no IDs — no son mapeables a `activity.id`/`experience.id` del lado del cliente (por eso no hay badge "forzada", ver arriba).

`listedActivitiesOnly`, confirmado en vivo contra viabcp.com con el mismo `previewIndex` (activityIndex 1, experienceIndex 2) sobre el scope `__view__`:

| `listedActivitiesOnly` | Decisions devueltas | Qué significa |
| --- | --- | --- |
| *(sin cookie QA)* | 4 (baseline real de la página) | comportamiento normal, sin preview |
| `false` | 4 — la forzada con su experiencia overrideada + las otras 3 tal cual el baseline | conviven: útil para ver la actividad forzada en su contexto real |
| `true` | 1 — solo la forzada | aislada: suprime todo lo demás, útil para debug sin ruido |

#### Por qué `document.cookie` alcanza — sin permiso `cookies`, sin tocar la request

Escribir `at_qa_mode` con `document.cookie` (world MAIN, sin ningún otro cableado) es suficiente para que Target la reciba, porque Alloy mismo se encarga de reenviarla al edge. Verificado contra el código fuente real de Alloy/Web SDK — [`adobe/alloy`](https://github.com/adobe/alloy), commit [`669172c`](https://github.com/adobe/alloy/commit/669172c164b3f4a86f4527a7ce23686c6ec03b41), Apache-2.0 — no el bundle minificado:

- [`packages/core/src/core/injectShouldTransferCookie.js`](https://github.com/adobe/alloy/blob/669172c164b3f4a86f4527a7ce23686c6ec03b41/packages/core/src/core/injectShouldTransferCookie.js) construye el predicado que decide qué cookies del navegador viajan al payload que se manda al edge:

  ```js
  export default ({ orgId, targetMigrationEnabled }) =>
    (name) => {
      return (
        isNamespacedCookieName(orgId, name) ||
        name === AT_QA_MODE ||
        (targetMigrationEnabled && name === MBOX)
      );
    };
  ```

- `AT_QA_MODE = "at_qa_mode"` / `MBOX = "mbox"` están en [`packages/core/src/constants/legacyCookies.js`](https://github.com/adobe/alloy/blob/669172c164b3f4a86f4527a7ce23686c6ec03b41/packages/core/src/constants/legacyCookies.js).
- El predicado se usa en [`packages/core/src/core/createCookieTransfer.js`](https://github.com/adobe/alloy/blob/669172c164b3f4a86f4527a7ce23686c6ec03b41/packages/core/src/core/createCookieTransfer.js) → `cookiesToPayload()` hace `Object.keys(cookies).filter(shouldTransferCookie)` y mete las que califican en `state.entries` del payload saliente (cuando el endpoint no es first-party).

`at_qa_mode` matchea por nombre exacto **incondicionalmente** — a diferencia de `mbox` "pelado" (legado, sin namespace), que solo se transfiere si `targetMigrationEnabled` está activo. Por eso alcanza con setear la cookie del lado del cliente: Alloy la va a levantar y reenviar sola en la próxima request, sin flags ni configuración adicional.

El snippet minificado originalmente citado (bundle de Launch que carga viabcp.com en producción, `assets.adobedtm.com/.../launch-bbe39001f4e4.min.js`) usa la misma lógica con identificadores cortos (`Za`/`Ja`/`Xa`/`Ya` en vez de `injectShouldTransferCookie`/`legacyCookies`/`AT_QA_MODE`/`MBOX`) — no se volvió a descargar ese bundle en esta verificación, pero la correspondencia con el código fuente de arriba es 1:1 (mismos tres cortocircuitos, mismo orden, misma condición sobre `targetMigrationEnabled`).

### On-demand reinjection (`chrome.scripting`, `.btn-inject` in the popup)

`manifest.json` declares the `scripting` permission. Both `inject.js` and `content.js` are idempotency-guarded (`window.__mboxInspectorInjected` / `window.__mboxInspectorContentActive`) specifically so the "Capturar ahora" button can call `chrome.scripting.executeScript` to inject them into a tab that was already open before the extension was loaded/reloaded — Chrome only auto-injects `content_scripts` into *new* page loads matching the manifest, not retroactively into already-open tabs. Without the guard, clicking the button on an already-active page would double-register the Alloy monitor and the postMessage listener, duplicating captured entries.

This was scoped deliberately narrow: no `webNavigation` permission, no SPA-route auto-detection — that's what Adobe's own "Experience Platform Debugger" extension does (persistent app window + `chrome.webNavigation.onHistoryStateUpdated` + on-demand `scripting.executeScript`), but it's overkill here and would widen the permission footprint on banking domains for a corner case (a tab open before extension reload). Alloy's monitor hooks already keep firing for the page's lifetime once registered, so ordinary SPA navigation within an already-injected page needs no extra handling. `background.js` exists (for the window-management entry point above), just not for this.

### Payload shape the popup parses

Personalization decisions live at `payload.handle[].payload` where `handle[].type === "personalization:decisions"`. Per decision `d`:

- `d.scope` — mbox name, or `__view__` (VEC / Visual Experience Composer).
- `d.scopeDetails.activity.{id,name}` and `d.scopeDetails.experience.{id,name}`.
- `d.items[0].meta["activity.name"]` / `["experience.name"]` — preferred source, with `scopeDetails` as fallback (see `getActivityInfo`).

Activities are deduplicated by `activity.id` before rendering.

### A/B vs. XT detection (`detectType`)

Adobe's payload does not label activity type, so `popup.js` infers it heuristically: experience name of "B" ⇒ AB; `A/B` or standalone `AB` token in the name ⇒ AB; standalone `XT` token ⇒ XT. When detection fails, `render()` shows **both** AB and XT links as guesses. The type maps to the Target UI URL segment (`ab_manual` vs `experience_targeting`) under tenant `bcp` — see `getTargetUrl`.

This is a hard limitation of the `personalization:decisions` payload, not a gap in this extension: cross-checked against Adobe's own "Experience Platform Debugger" extension, whose 4MB UI bundle contains zero references to `personalization`, `decisionScopes`, or `scopeDetails` — its activity-type logic only exists for the legacy at.js trace system (`___target_traces`), which doesn't apply to Web SDK/Alloy integrations like this one. Don't spend time hunting for a hidden type field in the payload; there isn't one.

### mBox classification (`renderMboxes`)

Cross-references the DOM set (`domMboxes`) against the responded set (scopes Target answered):

- **En uso** — in DOM *and* Target responded.
- **Libre** — in DOM, no Target response.
- **Alloy** — Target responded but no `[data-mbox]` element (e.g. VEC/decisionScope-only).

**"mbox" vs. "decision scope" — same concept, two names.** viabcp.com runs Web SDK (Alloy), where Adobe renamed the legacy "mbox" to "decision scope" — they're the same thing under different SDKs/eras. BCP's own front-end still uses the `mbox` convention in the DOM (`[data-mbox]`), while Alloy requests/responds in terms of scopes. This extension straddles both worlds on purpose: `domMboxes` is what we scan from the DOM (the `mbox` side), and `decisionScopes`/`scope` in the Alloy payload is what Target actually requested/answered (the "decision scope" side). The **Alloy** category above exists specifically for scopes Target answered that have no matching `[data-mbox]` element, and `__view__` is the special scope the VEC (Visual Experience Composer) uses. Don't "unify" this terminology later — collapsing it loses the distinction the classification logic depends on.

**Every public page tested on viabcp.com so far is 100% VEC** (`__view__`, zero `[data-mbox]` elements) — checked the home page and `/promociones/abre-tu-cuenta`. `renderMboxes()` deliberately excludes `__view__` from the classification above, so on those pages `allMboxes` is always empty even though `requests` has real activities. `renderMboxes()` distinguishes the two empty cases instead of showing one generic "recargá" message for both: `requests.length === 0` ("Sin datos aún, recargá") vs. `requests.length > 0` but nothing fit the mbox classification ("esta página no usa mboxes nombrados — todo corre por VEC, mirá Actividades"). The tab is being kept for now specifically because authenticated/transactional flows (Banca por Internet) weren't tested and are a plausible place for named mbox targeting — if it turns out to always be empty in practice, removing `renderMboxes`/`domMboxes`/the DOM scan in `inject.js`/the panel is a deliberate separate follow-up, not bundled with unrelated changes.

## Gotchas

- `popup.js` hard-codes DOM IDs/classes it expects from `popup.html`: `#list`, `#count`, `#page-url`, `#ts`, `#mbox-list`, `#clear`, `.stat-*`, `.tabs__item[data-tab]`, `.panel`, `.url-bar__indicator`. Renaming in the HTML silently breaks rendering.
- The allowed-domain list is duplicated in **two** places that must stay in sync: `ALLOWED_DOMAINS` in `popup.js` (gates the popup) and the `manifest.json` `host_permissions` + both `content_scripts.matches` blocks (gates injection).
- `popup.html` CSS uses BEM naming; keep it consistent when adding UI.
- `content.js` never calls `chrome.storage.local.get`/`.set` directly — always through `safeStorageGet`/`safeStorageSet`, which no-op if `chrome.runtime.id` is `undefined` (extension context invalidated, e.g. the extension got reloaded while this content script was still injected in an already-open tab — `inject.js` has no `chrome.*` bindings so it keeps posting messages regardless, and the orphaned `content.js` would otherwise throw "Extension context invalidated" on every one). Adding a new `chrome.storage.local` call site directly instead of through the wrappers reintroduces that noise. `popup.js`/`background.js` don't need this: they run as extension pages/the service worker, which get torn down (not orphaned) when the extension reloads.

## Adding a new domain

1. `manifest.json`: add `"*://*.newdomain.com/*"` to `host_permissions` and to **both** `content_scripts[].matches` arrays.
2. `popup.js`: add `"newdomain.com"` to `ALLOWED_DOMAINS`.
3. Reload the extension in `chrome://extensions/`.
