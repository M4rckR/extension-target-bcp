// ── 0. Guard de idempotencia ──────────────────────────────────────────────────
// Permite reinyectar este script a demanda (botón "Capturar ahora" del popup,
// vía chrome.scripting.executeScript) en una pestaña que ya estaba abierta
// antes de recargar la extensión, sin duplicar el hook de Alloy ni el
// MutationObserver si el script ya corre en esta página.
if (window.__mboxInspectorInjected) {
  // ya activo en esta página — no-op
} else {
window.__mboxInspectorInjected = true;

// ── 1. Alloy Monitors ────────────────────────────────────────────────────────
// Alloy expone window.__alloyMonitors para interceptar su ciclo de red.
// Este script corre en world: MAIN (mismo contexto que la página), por eso
// puede leer y modificar window.alloy antes de que la página lo use.
window.__alloyMonitors = window.__alloyMonitors || [];
window.__alloyMonitors.push({
  // Se ejecuta cada vez que Alloy recibe una respuesta de la red de Adobe Edge.
  // data.parsedBody contiene el payload completo con las decisiones de personalización.
  onNetworkResponse(data) {
    window.postMessage({ source: 'mbox-inspector', type: 'alloyResponse', payload: data.parsedBody }, '*');
  },
  // Se ejecuta una vez por instancia de Alloy configurada (alloy('configure', {...})).
  // Da orgId, datastream/edge config y dominio de Edge — sirve para confirmar
  // que la página está apuntando al datastream correcto (patrón tomado de
  // alloyHooks.js de Adobe Experience Platform Debugger).
  onInstanceConfigured(data) {
    window.postMessage({
      source: 'mbox-inspector',
      type: 'instanceInfo',
      payload: {
        namespace: data.instanceName,
        orgId: data.config?.orgId,
        edgeConfigId: data.config?.datastreamId ?? data.config?.edgeConfigId,
        edgeDomain: data.config?.edgeDomain,
      },
    }, '*');
  },
});

// ── 2. Interceptar alloy() para capturar decisionScopes ──────────────────────
// Envuelve la función global alloy() para leer los decisionScopes antes de
// que el SDK los envíe a Adobe Edge. Esto permite saber qué mboxes/scopes
// pidió la página, aunque Target no les responda con contenido.
function interceptAlloy() {
  const originalAlloy = window.alloy;
  if (!originalAlloy || originalAlloy.__mboxIntercepted) return;
  window.alloy = function(command, options, ...rest) {
    if (command === 'sendEvent' && Array.isArray(options?.decisionScopes)) {
      window.postMessage({ source: 'mbox-inspector', type: 'decisionScopes', scopes: options.decisionScopes }, '*');
    }
    return originalAlloy.call(this, command, options, ...rest);
  };
  window.alloy.__mboxIntercepted = true;
}

// Intento inmediato (si Alloy ya cargó antes que este script)
interceptAlloy();

// Fallback: polling cada 50ms hasta que Alloy aparezca, máximo 10 segundos
if (!window.alloy) {
  const t = setInterval(() => { if (window.alloy) { interceptAlloy(); clearInterval(t); } }, 50);
  setTimeout(() => clearInterval(t), 10000);
}

// ── 3. Escanear atributos data-mbox del DOM ───────────────────────────────────
// Busca elementos con [data-mbox] para reportar qué mboxes existen en la página,
// independientemente de si Target les asignó una actividad o no.
function scanDomMboxes() {
  const nodes  = document.querySelectorAll('[data-mbox]');
  const mboxes = [...new Set([...nodes].map(n => n.getAttribute('data-mbox')).filter(Boolean))];
  if (mboxes.length > 0) window.postMessage({ source: 'mbox-inspector', type: 'domMboxes', mboxes }, '*');
}

// Primer escaneo al cargar el DOM
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', scanDomMboxes); }
else { scanDomMboxes(); }

// Re-escaneo con debounce cuando el DOM cambia (SPAs que renderizan dinámicamente)
let scanTimer = null;
const observer = new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(scanDomMboxes, 200); });
observer.observe(document.documentElement, { childList: true, subtree: true });

} // fin guard __mboxInspectorInjected
