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

// ── 4. Capturar digitalData.push (eventos crudos de tracking) ───────────────
// Las offers de Target hacen `window.digitalData = window.digitalData || [];
// window.digitalData.push({...})`. En viabcp.com digitalData es en realidad
// una instancia de Adobe Client Data Layer (ACDL): tiene .push/.getState/
// .addEventListener propios, no es un array plano. ACDL se inicializa async
// (vía Launch) y en ese momento pisa `.push` con su propia función — si solo
// envolviéramos `.push` una vez, ese pisado posterior de ACDL borraría
// nuestro hook sin avisar. Por eso hookeamos en dos capas:
//   A) un accessor en window.digitalData → detecta cuando se (re)asigna el
//      array completo (pasa una sola vez, al inicializar ACDL).
//   B) un accessor en la propiedad .push de ESE array → detecta tanto los
//      pushes de las offers como el momento en que ACDL reemplaza .push,
//      y envuelve esa nueva función en vez de perder el hook.
// Corre en document_start, antes que cualquier script de la página, así que
// llegamos siempre primero sin importar si digitalData ya existe o no.
//
// Es exclusivamente observacional: nunca se altera el array real, nunca se
// atrapan errores de la llamada real (si la offer o ACDL tiran, deben seguir
// tirando igual que sin esta extensión), y todo el bloque está en un
// try/catch — si algo falla, se degrada a "no capturamos eventos" sin tocar
// el resto de inject.js ni el comportamiento de la página.
try {
  const DL_NAME = "digitalData";

  function wrapPush(realPush) {
    if (typeof realPush !== "function" || realPush.__mboxWrapped) return realPush;
    const wrapped = function (...args) {
      try {
        window.postMessage({
          source: "mbox-inspector",
          type: "digitalDataPush",
          payload: args.length === 1 ? args[0] : args,
          timestamp: Date.now(),
          timeSincePageLoad: window.performance ? window.performance.now() : null,
        }, "*");
      } catch (e) {
        // nunca dejar que un fallo de captura afecte la llamada real
      }
      return realPush.apply(this, args);
    };
    wrapped.__mboxWrapped = true;
    return wrapped;
  }

  function hookPushProperty(arr) {
    if (!arr || arr.__mboxPushHooked) return;
    try {
      let current = wrapPush(typeof arr.push === "function" ? arr.push : Array.prototype.push);
      Object.defineProperty(arr, "push", {
        configurable: true,
        enumerable: false,
        get() { return current; },
        set(fn) { current = wrapPush(fn); },
      });
      Object.defineProperty(arr, "__mboxPushHooked", { value: true, enumerable: false });
    } catch (e) {
      // digitalData no permitió instrumentar .push (p.ej. no configurable) — no capturamos.
    }
  }

  let currentDL = window[DL_NAME];
  if (currentDL) hookPushProperty(currentDL);

  Object.defineProperty(window, DL_NAME, {
    configurable: true,
    enumerable: true,
    get() { return currentDL; },
    set(value) {
      currentDL = value;
      hookPushProperty(currentDL);
    },
  });
} catch (e) {
  // window.digitalData no se pudo instrumentar — la extensión sigue funcionando
  // normalmente, solo sin la pestaña de Eventos.
}

} // fin guard __mboxInspectorInjected
