# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**mBox Inspector** — a Chrome extension (Manifest V3) that intercepts Adobe Target / Alloy SDK personalization responses on BCP sites (`viabcp.com`, `yoando.com.pe`) and renders them in the popup: which A/B and XT activities fired, and which mboxes are in use vs. free.

There is **no build, no dependencies, and no tests**. It is plain HTML/CSS/JS loaded as an unpacked extension.

## Running / developing

1. `chrome://extensions/` → enable **Modo desarrollador** → **Cargar descomprimida** → select this folder.
2. Reload the extension icon (↻) in `chrome://extensions/` after **every** change to `inject.js`, `content.js`, or `manifest.json`. Popup-only edits (`popup.html`/`popup.js`) just require reopening the popup.
3. Capture normally happens on **page load**. For a tab that was already open before the extension was (re)loaded, the popup's empty state has a **"Capturar ahora"** button that reinjects `inject.js`/`content.js` on demand via `chrome.scripting.executeScript` — no page reload needed for that case.

## Architecture: the three-script chain

Data flows one direction across two JavaScript worlds because of a Chrome constraint: only isolated-world scripts can touch `chrome.*` APIs, but only main-world scripts can see the page's `window.alloy`.

```
inject.js  (world: MAIN, run_at: document_start)
  ├─ Registers a hook in window.__alloyMonitors → catches every Alloy network response
  │    + onInstanceConfigured → orgId/edgeConfigId/edgeDomain for the active instance
  ├─ Monkey-patches window.alloy() to read decisionScopes before they're sent
  ├─ Scans [data-mbox] DOM nodes (+ MutationObserver, 200ms debounce, for SPAs)
  └─ Wrapped in a window.__mboxInspectorInjected guard — safe to reinject on demand
       │  window.postMessage({ source: 'mbox-inspector', type, ... })
       ▼
content.js (world: ISOLATED, run_at: document_start)
  ├─ Only script with chrome.storage access; pure postMessage → storage bridge
  ├─ On load: if hostname+pathname changed vs. stored tabUrl, wipes captured data
  └─ Wrapped in a window.__mboxInspectorContentActive guard — safe to reinject on demand
       │  chrome.storage.local: { requests[≤50], domMboxes[], instanceInfo, tabUrl }
       ▼
popup.js
  ├─ render()             → "Actividades" tab
  ├─ renderMboxes()       → "mBoxes" tab
  ├─ renderInstanceInfo() → footer: orgId/edgeConfigId of the page's Alloy instance
  └─ chrome.storage.onChanged → live re-render of the active tab
```

Message types (`content.js` switches on `event.data.type`): `alloyResponse` (full payload, unshifted onto `requests`, capped at 50), `domMboxes` (union-merged into `domMboxes`), `decisionScopes` (also merged into `domMboxes`, `__view__` filtered out), `instanceInfo` (orgId/edgeConfigId/edgeDomain, overwrites the single stored value — see below).

### On-demand reinjection (`chrome.scripting`, `.btn-inject` in the popup)

`manifest.json` declares the `scripting` permission. Both `inject.js` and `content.js` are idempotency-guarded (`window.__mboxInspectorInjected` / `window.__mboxInspectorContentActive`) specifically so the popup's "Capturar ahora" button can call `chrome.scripting.executeScript` to inject them into a tab that was already open before the extension was loaded/reloaded — Chrome only auto-injects `content_scripts` into *new* page loads matching the manifest, not retroactively into already-open tabs. Without the guard, clicking the button on an already-active page would double-register the Alloy monitor and the postMessage listener, duplicating captured entries.

This was scoped deliberately narrow: no background service worker, no `webNavigation` permission, no SPA-route auto-detection — that's what Adobe's own "Experience Platform Debugger" extension does (persistent app window + `chrome.webNavigation.onHistoryStateUpdated` + on-demand `scripting.executeScript`), but it's overkill here and would widen the permission footprint on banking domains for a corner case (a tab open before extension reload). Alloy's monitor hooks already keep firing for the page's lifetime once registered, so ordinary SPA navigation within an already-injected page needs no extra handling.

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

## Gotchas

- `popup.js` hard-codes DOM IDs/classes it expects from `popup.html`: `#list`, `#count`, `#page-url`, `#ts`, `#mbox-list`, `#clear`, `.stat-*`, `.tabs__item[data-tab]`, `.panel`, `.url-bar__indicator`. Renaming in the HTML silently breaks rendering.
- The allowed-domain list is duplicated in **two** places that must stay in sync: `ALLOWED_DOMAINS` in `popup.js` (gates the popup) and the `manifest.json` `host_permissions` + both `content_scripts.matches` blocks (gates injection).
- `popup.html` CSS uses BEM naming; keep it consistent when adding UI.

## Adding a new domain

1. `manifest.json`: add `"*://*.newdomain.com/*"` to `host_permissions` and to **both** `content_scripts[].matches` arrays.
2. `popup.js`: add `"newdomain.com"` to `ALLOWED_DOMAINS`.
3. Reload the extension in `chrome://extensions/`.
