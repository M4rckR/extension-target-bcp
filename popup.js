const ALLOWED_DOMAINS = ["viabcp.com", "yoando.com.pe"];
const TENANT = "bcp";

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

    list.innerHTML = unique
      .map((d) => {
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
        </div>
      `;
      })
      .join("");
  });
}

// ── Botón LIMPIAR ─────────────────────────────────────────────────────────────
document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.local.set({ requests: [], domMboxes: [] }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      render(tabs[0]?.url || "");
    });
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
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["inject.js"] });
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
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
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || "";
  if (!isAllowedDomain(url)) {
    showBlocked();
  } else {
    render(url);
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

// ── Live update: re-renderiza cuando cambia el storage ───────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.instanceInfo) renderInstanceInfo();

  const activeTab = document.querySelector(".tabs__item--active")?.dataset?.tab;
  if (!activeTab) return;
  if (activeTab === "mboxes" && (changes.requests || changes.domMboxes))
    renderMboxes();
  if (activeTab === "actividades" && changes.requests) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      render(tabs[0]?.url || ""),
    );
  }
});
