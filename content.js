// ── Guard de idempotencia ──────────────────────────────────────────────────────
// Permite reinyectar este script a demanda (botón "Capturar ahora" del popup,
// vía chrome.scripting.executeScript) sin registrar dos veces el listener de
// postMessage, lo que duplicaría cada request capturado.
if (!window.__mboxInspectorContentActive) {
window.__mboxInspectorContentActive = true;

// ── Detección de cambio de página ────────────────────────────────────────────
// Compara la URL guardada en storage con la URL actual (hostname + path).
// Si cambiaron, limpia todos los datos capturados para que el popup no
// muestre información de una página anterior.
chrome.storage.local.get("tabUrl", (data) => {
  const prevUrl = data.tabUrl || "";
  let prevPath = "";
  let currPath = "";
  try {
    prevPath = new URL(prevUrl).hostname + new URL(prevUrl).pathname;
  } catch (e) {}
  try {
    currPath =
      new URL(window.location.href).hostname +
      new URL(window.location.href).pathname;
  } catch (e) {}

  if (prevPath !== currPath) {
    // Nueva página — limpiar todo, incluyendo el orgId/edgeConfigId de la página anterior
    chrome.storage.local.set({
      requests: [],
      domMboxes: [],
      instanceInfo: null,
      tabUrl: window.location.href,
    });
  } else {
    chrome.storage.local.set({ tabUrl: window.location.href });
  }
});

// ── Puente inject.js → storage ───────────────────────────────────────────────
// inject.js corre en world: MAIN (contexto de la página) y no tiene acceso a
// la API de Chrome. Este content script actúa como puente: escucha mensajes
// de inject.js vía postMessage y los persiste en chrome.storage.local.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "mbox-inspector") return;

  // Respuesta de Target: payload completo con decisiones de personalización
  if (event.data.type === "alloyResponse") {
    const payload = event.data.payload;
    if (!payload) return;
    chrome.storage.local.get("requests", (data) => {
      const requests = data.requests || [];
      requests.unshift({
        payload,
        url: window.location.href,
        time: new Date().toISOString(),
      });
      chrome.storage.local.set({ requests: requests.slice(0, 50) });
    });
  }

  // Mboxes encontrados en el DOM con atributo [data-mbox]
  if (event.data.type === "domMboxes") {
    const incoming = event.data.mboxes || [];
    chrome.storage.local.get("domMboxes", (data) => {
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      chrome.storage.local.set({ domMboxes: merged });
    });
  }

  // Scopes pedidos por la página al llamar alloy('sendEvent', { decisionScopes })
  // Se guardan junto a los domMboxes para cruzar qué scopes existen vs. cuáles respondió Target
  if (event.data.type === "decisionScopes") {
    const incoming = (event.data.scopes || []).filter((s) => s !== "__view__");
    chrome.storage.local.get("domMboxes", (data) => {
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      chrome.storage.local.set({ domMboxes: merged });
    });
  }

  // Config de la instancia de Alloy: orgId, datastream/edge config, edge domain.
  // Útil para confirmar que la página apunta al datastream correcto.
  if (event.data.type === "instanceInfo") {
    chrome.storage.local.set({ instanceInfo: event.data.payload });
  }
});

} // fin guard __mboxInspectorContentActive
