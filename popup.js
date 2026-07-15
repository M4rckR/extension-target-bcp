const ALLOWED_DOMAINS = ["viabcp.com", "yoando.com.pe"];
const TENANT = "bcp";

// Umbral de truncado del preview de "content" en la pestaña Actividades — se
// corta por lo que se cumpla primero. Calibrado con datos reales de
// viabcp.com (dom-action de 1.4–6.6 KB / 42–233 líneas, mediana ~4 KB /
// ~117 líneas): 40 líneas cubre "un vistazo" para el caso típico, y el tope
// de caracteres protege contra un blob minificado en una sola línea gigante,
// que un corte solo por líneas no detectaría. Nombradas acá porque si algún
// día aparece una offer más grande, se ajustan en un solo lugar.
const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_CHARS = 3000;

/** Verifica que la URL pertenezca a un dominio autorizado. */
function isAllowedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_DOMAINS.some((d) => hostname.endsWith(d));
  } catch (e) {
    return false;
  }
}

/** Muestra un mensaje de bloqueo cuando el dominio activo no está permitido. */
function showBlocked() {
  document.getElementById("list").innerHTML = `
    <div class="empty-state">
      <span class="empty-state__icon">🚫</span>
      <p class="empty-state__text">Esta extensión solo funciona en<br>
      <strong>viabcp.com</strong> y <strong>yoando.com.pe</strong></p>
    </div>`;
  document.getElementById("count").textContent = "—";
  document.getElementById("page-url").textContent = "Dominio no permitido";
  document.querySelector(".url-bar__indicator").style.background = "#e34850";
}

/**
 * Resuelve qué pestaña hay que inspeccionar: si este documento se abrió como
 * ventana independiente (?tabId= en la URL, ver createInspectorWindow), esa
 * pestaña puntual — aunque ya no sea la activa del navegador. Si no hay
 * ?tabId=, el comportamiento de siempre del popup clásico: la pestaña activa
 * de la ventana actual.
 */
function getInspectedTab(callback) {
  const paramTabId = new URLSearchParams(location.search).get("tabId");
  if (paramTabId) {
    chrome.tabs.get(Number(paramTabId), (tab) => {
      if (chrome.runtime.lastError) {
        callback(null);
        return;
      }
      callback(tab);
    });
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
    callback(tabs[0] || null),
  );
}

/** Muestra un aviso cuando la pestaña que la ventana independiente inspeccionaba ya se cerró. */
function showTabClosed() {
  document.getElementById("list").innerHTML = `
    <div class="empty-state">
      <span class="empty-state__icon">🗙</span>
      <p class="empty-state__text">La pestaña que esta ventana estaba<br>
      inspeccionando ya se cerró.</p>
    </div>`;
  document.getElementById("count").textContent = "—";
  document.getElementById("page-url").textContent = "Pestaña cerrada";
  document.querySelector(".url-bar__indicator").style.background = "#e34850";
}

/**
 * Muestra un aviso cuando la pestaña activa es distinta a la página capturada.
 * Ocurre si el usuario navega sin recargar la extensión.
 */
function showStale(tabUrl) {
  document.getElementById("list").innerHTML = `
    <div class="empty-state">
      <span class="empty-state__icon">🔄</span>
      <p class="empty-state__text">Página distinta a la captura.<br>
      Recarga <strong>${(() => {
        try {
          return new URL(tabUrl).hostname;
        } catch (e) {
          return tabUrl;
        }
      })()}</strong> para capturar.</p>
    </div>`;
  document.getElementById("count").textContent = "—";
  document.querySelector(".url-bar__indicator").style.background = "#ff7800";
}

/**
 * Convierte un scope de Alloy a etiqueta visual.
 * '__view__' es VEC (Visual Experience Composer); el resto son mboxes con nombre.
 */
function formatScope(scope) {
  if (scope === "__view__") return { label: "VEC", type: "vec" };
  const name = scope.length > 20 ? scope.slice(0, 18) + "…" : scope;
  return { label: name, type: "mbox" };
}

/**
 * Construye la URL de la actividad en la UI de Adobe Target.
 * Requiere conocer el tipo (AB o XT) y el ID de la actividad.
 */
function getTargetUrl(actType, actId) {
  if (!actType || !actId || actId === "?") return null;
  const type = actType === "AB" ? "ab_manual" : "experience_targeting";
  return `https://experience.adobe.com/#/@${TENANT}/target/activities/activity-details/${type}/${actId}/overview`;
}

/**
 * Detecta si una actividad es A/B o XT a partir del nombre y la experiencia.
 * Heurística: experiencia "B" → A/B. Palabras "A/B" o "AB" en el nombre → A/B.
 * Palabras "XT" en el nombre → XT.
 *
 * Es heurística porque el payload de personalization:decisions (Web SDK/Alloy)
 * no trae un campo de tipo de actividad — verificado contra Adobe Experience
 * Platform Debugger (extensión oficial de Adobe): su UI no referencia
 * personalization/decisionScopes/scopeDetails en ningún lado; toda su lógica
 * de tipo de actividad depende del sistema legado de trazas de at.js
 * (___target_traces), que no aplica a integraciones vía Web SDK como esta.
 */
function detectType(name, expName) {
  if (expName) {
    const e = expName.trim().toUpperCase();
    if (
      e === "B" ||
      e === "EXPERIENCIA B" ||
      e === "EXPERIENCE B" ||
      e.endsWith(" B")
    )
      return "AB";
  }
  if (!name) return null;
  const n = name.toUpperCase();
  if (/A\/B/.test(n)) return "AB";
  if (/(^|[\s\-_])AB([\s\-_]|$)/.test(n)) return "AB";
  if (/(^|[\s\-_])XT([\s\-_]|$)/.test(n)) return "XT";
  return null;
}

/** Extrae nombre, ID, experiencia y tipo de actividad desde el payload de Alloy. */
function getActivityInfo(d) {
  const meta = d.items?.[0]?.meta;
  const actName = meta?.["activity.name"] || d.scopeDetails?.activity?.name;
  const actId = d.scopeDetails?.activity?.id || "?";
  const expName = meta?.["experience.name"] || d.scopeDetails?.experience?.name;
  const expId = d.scopeDetails?.experience?.id;
  const exp = expName || (expId !== undefined ? `Exp. ${expId}` : null);
  return {
    name: actName || null,
    id: actId,
    exp,
    actType: detectType(actName, expName),
  };
}

/** Extrae type/format/selector/prehidingSelector/content del primer item de una decisión, si existe. */
function getDomActionData(d) {
  const data = d.items?.[0]?.data;
  if (!data) return null;
  return {
    type: data.type ?? null,
    format: data.format ?? null,
    selector: data.selector ?? null,
    prehidingSelector: data.prehidingSelector ?? null,
    content: typeof data.content === "string" ? data.content : null,
  };
}

/** Formatea un tamaño en caracteres a un indicador legible (B/KB) — de un vistazo, no una medición exacta en bytes UTF-8. */
function formatContentSize(len) {
  if (len < 1024) return `${len} B`;
  return `${(len / 1024).toFixed(1)} KB`;
}

/**
 * Trunca el content ANTES de escaparlo (nunca al revés) para que el costo de
 * escapeHtml + inserción en el DOM sea siempre chico, sin importar el tamaño
 * real del payload guardado. Corta por líneas (MAX_PREVIEW_LINES) o por
 * caracteres (MAX_PREVIEW_CHARS) — lo que se cumpla primero: el de líneas
 * cubre el caso típico (contenido con saltos de línea reales), el de
 * caracteres protege contra un blob minificado en una sola línea gigante,
 * que el corte por líneas no alcanzaría a detectar.
 */
function truncatePreview(content) {
  const lines = content.split("\n");
  let preview = content;
  let truncatedByLines = false;
  let truncatedByChars = false;

  if (lines.length > MAX_PREVIEW_LINES) {
    preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    truncatedByLines = true;
  }
  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.slice(0, MAX_PREVIEW_CHARS);
    truncatedByChars = true;
  }

  return {
    preview,
    truncated: truncatedByLines || truncatedByChars,
    truncatedByChars,
    totalLines: lines.length,
    previewLines: preview.split("\n").length,
  };
}

/**
 * Bloque expandible con metadata (type/format/selector/prehidingSelector/tamaño)
 * y preview truncado del content de una decisión dom-action. `idx` es la
 * posición de la decisión en lastRenderedDecisions, para que el botón
 * "Copiar completo" pueda tomar el content ORIGINAL sin escapar por índice,
 * sin tener que reinyectar el string completo en un atributo HTML.
 */
function renderActivityContent(domAction, idx) {
  const fields = [
    ["type", domAction.type],
    ["format", domAction.format],
    ["selector", domAction.selector],
    ["prehidingSelector", domAction.prehidingSelector],
  ].filter(([, v]) => v != null);

  const hasContent = typeof domAction.content === "string";
  if (fields.length === 0 && !hasContent) return "";
  if (hasContent) fields.push(["tamaño", formatContentSize(domAction.content.length)]);

  const metaHtml = fields
    .map(([k, v]) => `<span class="activity__content-field"><b>${escapeHtml(k)}</b> ${escapeHtml(String(v))}</span>`)
    .join("");

  let bodyHtml = "";
  if (hasContent) {
    const { preview, truncated, truncatedByChars, totalLines, previewLines } = truncatePreview(domAction.content);
    const note = !truncated
      ? ""
      : truncatedByChars
        ? `Mostrando los primeros ${MAX_PREVIEW_CHARS} caracteres de ${domAction.content.length}.`
        : `Mostrando ${previewLines} de ${totalLines} líneas.`;

    bodyHtml = `
      <pre class="raw-pre">${escapeHtml(preview)}</pre>
      ${note ? `<div class="activity__content-note">${note}</div>` : ""}
      <button class="btn-copy-content" data-idx="${idx}">Copiar completo</button>
    `;
  }

  return `
    <details class="activity__content">
      <summary class="raw-summary">Ver contenido</summary>
      <div class="activity__content-meta">${metaHtml}</div>
      ${bodyHtml}
    </details>
  `;
}

// Última lista de decisiones renderizada en "Actividades" — referencia para
// que el botón "Copiar completo" tome el content original por índice sin
// tener que reinyectar el string completo en un atributo HTML.
let lastRenderedDecisions = [];

/**
 * Renderiza la pestaña "Actividades".
 * Lee requests del storage, deduplica por activity.id y genera el listado.
 */
function render(currentTabUrl) {
  chrome.storage.local.get(["requests", "tabUrl"], (data) => {
    const requests = data.requests || [];
    const tabUrl = data.tabUrl || "";
    const list = document.getElementById("list");
    const count = document.getElementById("count");
    const pageUrl = document.getElementById("page-url");
    const ts = document.getElementById("ts");

    // Si el usuario navegó a otra página, los datos en storage no corresponden
    try {
      const currentHost =
        new URL(currentTabUrl).hostname + new URL(currentTabUrl).pathname;
      const savedHost = new URL(tabUrl).hostname + new URL(tabUrl).pathname;
      if (currentHost !== savedHost && requests.length > 0) {
        showStale(currentTabUrl);
        return;
      }
    } catch (e) {}

    if (requests.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="empty-state__icon">📡</span><p class="empty-state__text">Sin capturas aún.<br>Recarga la página con la extensión activa.</p><button class="btn-inject">Capturar ahora</button></div>`;
      count.textContent = "0 ACT";
      return;
    }

    try {
      const url = new URL(requests[0].url);
      pageUrl.textContent = url.hostname + url.pathname;
    } catch (e) {}

    ts.textContent =
      "Última: " + new Date(requests[0].time).toLocaleTimeString("es-PE");

    // Aplana todas las decisiones de personalización de todos los requests capturados
    const allDecisions = requests.flatMap(
      (r) =>
        r.payload?.handle
          ?.filter((h) => h.type === "personalization:decisions")
          ?.flatMap((h) => h.payload) || [],
    );

    // Muestra una sola fila por actividad (pueden llegar duplicadas en múltiples requests)
    const seen = new Set();
    const unique = allDecisions.filter((d) => {
      const id = d.scopeDetails?.activity?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    count.textContent = `${unique.length} ACT`;

    lastRenderedDecisions = unique;

    list.innerHTML = unique
      .map((d, idx) => {
        const scope = formatScope(d.scope);
        const { name, id, exp, actType } = getActivityInfo(d);
        const displayName = name || `Actividad ${id}`;
        const shortName =
          displayName.length > 55
            ? displayName.slice(0, 53) + "…"
            : displayName;
        const targetUrl = getTargetUrl(actType, id);
        // Si no se pudo detectar el tipo, se ofrecen ambos links como hipótesis
        const urlAB = !actType ? getTargetUrl("AB", id) : null;
        const urlXT = !actType ? getTargetUrl("XT", id) : null;
        const domAction = getDomActionData(d);

        return `
        <div class="activity" title="${displayName}">
          ${targetUrl ? `<a class="activity__link" href="${targetUrl}" target="_blank">` : `<div class="activity__link--plain">`}
            <span class="scope-tag scope-tag--${scope.type}">${scope.label}</span>
            <div class="activity__name">${shortName}</div>
            <div class="activity__meta">
              <span class="activity__id">#${id}</span>
              ${actType ? `<span class="activity__separator">·</span><span class="activity__type activity__type--${actType.toLowerCase()}">${actType}</span>` : ""}
              ${exp ? `<span class="activity__separator">·</span><span class="activity__experience">${exp}</span>` : ""}
              ${targetUrl ? `<span class="activity__separator">·</span><span class="activity__open-hint">Abrir en Target ↗</span>` : ""}
            </div>
          ${targetUrl ? `</a>` : `</div>`}
          ${
            urlAB
              ? `
            <div class="activity__guesses">
              <a href="${urlAB}" target="_blank" class="guess-btn guess-btn--ab">A/B ↗</a>
              <a href="${urlXT}" target="_blank" class="guess-btn guess-btn--xt">XT ↗</a>
            </div>`
              : ""
          }
          ${domAction ? renderActivityContent(domAction, idx) : ""}
        </div>
      `;
      })
      .join("");
  });
}

// Click delegado en "Copiar completo" (bloque de contenido expandido de una
// actividad): copia el content ORIGINAL sin escapar al portapapeles — la
// vista de arriba está truncada y escapada solo para mostrar, nunca es la fuente.
document.getElementById("list").addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-copy-content");
  if (!btn) return;
  const decision = lastRenderedDecisions[Number(btn.dataset.idx)];
  const content = decision?.items?.[0]?.data?.content;
  if (typeof content !== "string") return;
  navigator.clipboard
    .writeText(content)
    .then(() => {
      const original = btn.textContent;
      btn.textContent = "Copiado ✓";
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    })
    .catch(() => {});
});

// ── Botón LIMPIAR ─────────────────────────────────────────────────────────────
document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.local.set({ requests: [], domMboxes: [], digitalDataEvents: [] }, () => {
    getInspectedTab((tab) => render(tab?.url || ""));
  });
});

/**
 * Botón "Capturar ahora" (en los estados vacíos): reinyecta inject.js y
 * content.js en la pestaña activa vía chrome.scripting.executeScript.
 * Soluciona el caso de una pestaña que ya estaba abierta antes de recargar
 * la extensión (los content_scripts del manifest solo se inyectan en cargas
 * de página nuevas). inject.js/content.js tienen guards de idempotencia
 * para que esto sea seguro aunque ya estén activos.
 */
document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("btn-inject")) return;
  getInspectedTab((tab) => {
    const tabId = tab?.id;
    if (!tabId) return;
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["inject.js"] });
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  });
});

/**
 * Botón "Abrir en ventana independiente" (⧉, header). Si ya hay una ventana
 * abierta y sigue viva, la enfoca; si no, crea una nueva apuntando a la
 * pestaña inspeccionada actual (?tabId=) y guarda su {windowId, tabId} en
 * storage — background.js limpia ese puntero cuando esa pestaña se cierra.
 */
function createInspectorWindow() {
  getInspectedTab((tab) => {
    if (!tab) return;
    const url = `${chrome.runtime.getURL("popup.html")}?tabId=${tab.id}`;
    chrome.windows.create({ url, type: "popup", width: 520, height: 720 }, (win) => {
      const tabId = win?.tabs?.[0]?.id;
      if (tabId) chrome.storage.local.set({ inspectorWindow: { windowId: win.id, tabId } });
    });
  });
}

document.getElementById("open-window")?.addEventListener("click", () => {
  chrome.storage.local.get("inspectorWindow", (data) => {
    const w = data.inspectorWindow;
    if (!w) {
      createInspectorWindow();
      return;
    }
    chrome.windows.get(w.windowId, () => {
      if (chrome.runtime.lastError) {
        createInspectorWindow();
      } else {
        chrome.windows.update(w.windowId, { focused: true });
      }
    });
  });
});

/** Muestra orgId/edgeConfigId de la instancia de Alloy en el footer (si ya se capturó). */
function renderInstanceInfo() {
  chrome.storage.local.get("instanceInfo", (data) => {
    const el = document.getElementById("edge-info");
    const info = data.instanceInfo;
    if (!info) {
      el.textContent = "v2.0 · BCP Target Inspector";
      el.title = "";
      return;
    }
    const shortEdge = info.edgeConfigId ? info.edgeConfigId.slice(0, 8) : "?";
    el.textContent = `ds:${shortEdge}`;
    el.title = `orgId: ${info.orgId || "?"} · edgeDomain: ${info.edgeDomain || "?"}`;
  });
}

// ── Carga inicial: verificar dominio y renderizar ─────────────────────────────
// Si este documento se abrió como ventana independiente (?tabId= en la URL),
// marcarlo para que el CSS relaje el ancho fijo y el tope de altura de las listas.
if (new URLSearchParams(location.search).has("tabId")) {
  document.body.classList.add("window-mode");
}

getInspectedTab((tab) => {
  if (!tab) {
    showTabClosed();
    return;
  }
  if (!isAllowedDomain(tab.url)) {
    showBlocked();
  } else {
    render(tab.url);
    renderInstanceInfo();
  }
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tabs__item").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tabs__item")
      .forEach((t) => t.classList.remove("tabs__item--active"));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("panel--active"));
    tab.classList.add("tabs__item--active");
    document
      .getElementById(`panel-${tab.dataset.tab}`)
      .classList.add("panel--active");
    if (tab.dataset.tab === "mboxes") renderMboxes();
    if (tab.dataset.tab === "eventos") renderEventos();
  });
});

/**
 * Renderiza la pestaña "mBoxes".
 * Cruza los mboxes encontrados en el DOM con los que Target respondió,
 * y los clasifica en: En uso / Libres / Solo Alloy.
 */
function renderMboxes() {
  chrome.storage.local.get(["requests", "domMboxes"], (data) => {
    const requests = data.requests || [];
    const domMboxes = data.domMboxes || [];

    // Construye un mapa scope → nombre de actividad a partir de las respuestas de Target
    const activeMboxes = new Map();
    requests.forEach((r) => {
      const decisions =
        r.payload?.handle
          ?.filter((h) => h.type === "personalization:decisions")
          ?.flatMap((h) => h.payload) || [];
      decisions.forEach((d) => {
        if (d.scope && d.scope !== "__view__") {
          const meta = d.items?.[0]?.meta;
          const name =
            meta?.["activity.name"] || d.scopeDetails?.activity?.name || null;
          if (!activeMboxes.has(d.scope)) activeMboxes.set(d.scope, name);
        }
      });
    });

    const activeSet = new Set(activeMboxes.keys());
    const domSet = new Set(domMboxes);

    // En uso  = Target respondió con contenido para ese scope
    // Libres  = están en el DOM con data-mbox pero Target no les asignó nada
    // Total   = todos los encontrados en el DOM
    const enUso = activeSet.size;
    const total = domSet.size;
    const libres = [...domSet].filter((m) => !activeSet.has(m)).length;

    document.getElementById("stat-active").textContent = enUso;
    document.getElementById("stat-free").textContent = libres;
    document.getElementById("stat-total").textContent = total;

    const allMboxes = new Set([...domSet, ...activeSet]);

    if (allMboxes.size === 0) {
      document.getElementById("mbox-list").innerHTML =
        `<div class="empty-state"><span class="empty-state__icon">📦</span><p class="empty-state__text">Sin datos aún.<br>Recarga la página con la extensión activa.</p><button class="btn-inject">Capturar ahora</button></div>`;
      return;
    }

    // Ocultar contadores de Libres y Total si no hay datos del DOM
    const hasDOM = domSet.size > 0;
    document.querySelector(".stats__item--free").style.display = hasDOM
      ? ""
      : "none";
    document.querySelector(".stats__item--total").style.display = hasDOM
      ? ""
      : "none";
    document.querySelector(".stats__item--active").style.gridColumn = hasDOM
      ? ""
      : "1 / -1";

    // Orden: activos primero, luego libres; alfabético dentro de cada grupo
    const sorted = [...allMboxes].sort((a, b) => {
      const aA = activeSet.has(a),
        bA = activeSet.has(b);
      if (aA && !bA) return -1;
      if (!aA && bA) return 1;
      return a.localeCompare(b);
    });

    document.getElementById("mbox-list").innerHTML = sorted
      .map((mbox) => {
        const isActive = activeSet.has(mbox);
        const isInDom = domSet.has(mbox);
        const actName = activeMboxes.get(mbox);
        const onlyAlloy = isActive && !isInDom;

        let pillClass, pillLabel;
        if (isActive && isInDom) {
          pillClass = "status-badge--active";
          pillLabel = "En uso";
        } else if (onlyAlloy) {
          pillClass = "status-badge--alloy";
          pillLabel = "Alloy";
        } else {
          pillClass = "status-badge--free";
          pillLabel = "Libre";
        }

        return `
        <div class="mbox-row">
          <div class="mbox-row__info">
            <div class="mbox-row__name">${mbox}</div>
            ${actName ? `<div class="mbox-row__activity">↳ ${actName}</div>` : ""}
          </div>
          <div class="mbox-row__status">
            <span class="status-badge ${pillClass}">${pillLabel}</span>
          </div>
        </div>
      `;
      })
      .join("");
  });
}

/** Escapa HTML para interpolar valores del payload crudo de digitalData sin XSS. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Extrae un resumen legible de un push a digitalData: el campo `event` como
 * tag, y el primer objeto anidado con `.name` (patrón "promotion", "product",
 * etc.) como título + el resto de sus campos como metadata. Si el payload no
 * sigue ese patrón, no hay resumen — el payload crudo siempre se muestra
 * completo abajo, sin depender de esta heurística.
 */
function getEventSummary(payload) {
  const eventName =
    (payload && typeof payload === "object" && typeof payload.event === "string"
      ? payload.event
      : null) || "push";

  let subject = null;
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload)) {
      if (key === "event") continue;
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.name === "string") {
        subject = value;
        break;
      }
    }
  }

  const title = subject?.name || null;
  const meta = subject
    ? Object.entries(subject)
        .filter(([k]) => k !== "name")
        .map(([, v]) => v)
        .filter((v) => typeof v === "string" || typeof v === "number")
    : [];

  return { eventName, title, meta };
}

// Estado de los chips de filtro por event name. Efímero a propósito: vive
// solo en memoria mientras el popup está abierto (nunca se escribe a
// chrome.storage), para que un chip apagado en una sesión anterior no
// esconda eventos nuevos sin que el usuario se dé cuenta. Solo se le agregan
// claves (nunca se resetea a vacío) para no perder el toggle del usuario
// cuando llegan eventos nuevos mientras el popup sigue abierto.
const eventFilterState = new Map();

/** Renderiza una sola ocurrencia de evento (nombre, hora, resumen y payload crudo colapsable). */
function renderEventRow(e) {
  const { eventName, title, meta } = getEventSummary(e.payload);
  const time = new Date(e.time).toLocaleTimeString("es-PE");
  const sincePageLoad =
    typeof e.timeSincePageLoad === "number"
      ? `+${(e.timeSincePageLoad / 1000).toFixed(1)}s`
      : "";
  const rawJson = (() => {
    try {
      return JSON.stringify(e.payload, null, 2);
    } catch (err) {
      return String(e.payload);
    }
  })();

  return `
    <div class="event-row">
      <div class="event-row__header">
        <span class="event-tag">${escapeHtml(eventName)}</span>
        <span class="event-row__time">${time}${sincePageLoad ? " · " + sincePageLoad : ""}</span>
      </div>
      ${title ? `<div class="event-row__title">${escapeHtml(title)}</div>` : ""}
      ${meta.length ? `<div class="event-row__meta">${meta.map(escapeHtml).join(" · ")}</div>` : ""}
      <details class="event-row__raw">
        <summary class="raw-summary">Payload</summary>
        <pre class="raw-pre">${escapeHtml(rawJson)}</pre>
      </details>
    </div>
  `;
}

/**
 * Agrupa corridas de eventos consecutivos con el mismo event name (sin otro
 * event name distinto en el medio) — p.ej. scroll,scroll,view,scroll da dos
 * grupos de scroll (2 y 1), no uno de 3, para no perder el orden temporal.
 * `events` viene más reciente primero; cada grupo preserva ese mismo orden.
 */
function groupConsecutiveEvents(events) {
  const groups = [];
  events.forEach((e) => {
    const key = getEventSummary(e.payload).eventName;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(e);
    else groups.push({ key, items: [e] });
  });
  return groups;
}

/**
 * Renderiza la pestaña "Eventos": pushes crudos a window.digitalData
 * capturados por inject.js (ver hookPushProperty), más recientes primero.
 * Arriba de la lista genera un chip por cada event name presente en los
 * datos capturados (con su conteo); por default todos están activos.
 * Corridas consecutivas del mismo event name (p.ej. varios trackScroll
 * seguidos) se colapsan en una fila expandible; los eventos que no se
 * repiten seguido se muestran expandidos directamente, sin click extra.
 */
function renderEventos() {
  chrome.storage.local.get("digitalDataEvents", (data) => {
    const events = data.digitalDataEvents || [];
    const list = document.getElementById("event-list");
    const filters = document.getElementById("event-filters");

    if (events.length === 0) {
      filters.innerHTML = "";
      list.innerHTML = `<div class="empty-state"><span class="empty-state__icon">🛰️</span><p class="empty-state__text">Sin eventos aún.<br>Interactuá con la página para ver los pushes de digitalData.</p><button class="btn-inject">Capturar ahora</button></div>`;
      return;
    }

    // Conteo por event name + alta de nombres nuevos en el filtro (default: activo)
    const counts = new Map();
    events.forEach((e) => {
      const key = getEventSummary(e.payload).eventName;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!eventFilterState.has(key)) eventFilterState.set(key, true);
    });

    filters.innerHTML = [...counts.entries()]
      .map(([key, count]) => {
        const active = eventFilterState.get(key);
        return `<button class="event-filter${active ? " event-filter--active" : ""}" data-event="${escapeHtml(key)}">${escapeHtml(key)} · ${count}</button>`;
      })
      .join("");

    const visible = events.filter((e) => eventFilterState.get(getEventSummary(e.payload).eventName));

    if (visible.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="empty-state__icon">🔇</span><p class="empty-state__text">Todos los eventos están filtrados.<br>Activá algún chip arriba para verlos.</p></div>`;
      return;
    }

    list.innerHTML = groupConsecutiveEvents(visible)
      .map((g) => {
        if (g.items.length === 1) return renderEventRow(g.items[0]);

        // items[0] es el más reciente del grupo (visible viene más reciente primero)
        const newest = new Date(g.items[0].time).toLocaleTimeString("es-PE");
        const oldest = new Date(g.items[g.items.length - 1].time).toLocaleTimeString("es-PE");
        const timeLabel = oldest === newest ? newest : `${oldest} → ${newest}`;

        return `
        <div class="event-group">
          <div class="event-group__header">
            <span class="event-tag">${escapeHtml(g.key)} · ${g.items.length}</span>
            <span class="event-row__time">${timeLabel}</span>
            <span class="event-group__chevron">▸</span>
          </div>
          <div class="event-group__items">
            ${g.items.map(renderEventRow).join("")}
          </div>
        </div>
      `;
      })
      .join("");
  });
}

// Click delegado en los chips de filtro: togglea el estado en memoria y
// vuelve a renderizar (chips + lista). El listener vive en el contenedor,
// que nunca se reemplaza entero — solo su innerHTML — así que alcanza con
// registrarlo una vez.
document.getElementById("event-filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".event-filter");
  if (!chip) return;
  const key = chip.dataset.event;
  eventFilterState.set(key, !eventFilterState.get(key));
  renderEventos();
});

// Click delegado para expandir/colapsar un grupo de eventos consecutivos.
// Es un toggle puro de DOM (sin estado guardado): cada re-render de la
// lista arranca colapsada de nuevo, igual que el <details> de cada payload.
document.getElementById("event-list").addEventListener("click", (e) => {
  const header = e.target.closest(".event-group__header");
  if (!header) return;
  header.closest(".event-group").classList.toggle("event-group--expanded");
});

// ── Live update: re-renderiza cuando cambia el storage ───────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.instanceInfo) renderInstanceInfo();

  const activeTab = document.querySelector(".tabs__item--active")?.dataset?.tab;
  if (!activeTab) return;
  if (activeTab === "mboxes" && (changes.requests || changes.domMboxes))
    renderMboxes();
  if (activeTab === "eventos" && changes.digitalDataEvents) renderEventos();
  if (activeTab === "actividades" && changes.requests) {
    getInspectedTab((tab) => render(tab?.url || ""));
  }
});
