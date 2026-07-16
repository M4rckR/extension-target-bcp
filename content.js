// ── Guard de idempotencia ──────────────────────────────────────────────────────
// Permite reinyectar este script a demanda (botón "Capturar ahora" del popup,
// vía chrome.scripting.executeScript) sin registrar dos veces el listener de
// postMessage, lo que duplicaría cada request capturado.
if (!window.__mboxInspectorContentActive) {
window.__mboxInspectorContentActive = true;

// digitalDataEvents guarda hasta esta cantidad, más viejo primero afuera
// (mismo mecanismo unshift+slice que requests). Medido en vivo contra
// viabcp.com: un push típico (trackScroll/trackAction) pesa ~60-120B de
// JSON crudo; con el wrapper {payload,time,timeSincePageLoad,pageUrl} cada
// entrada persistida ronda ~300-500B. 500 entradas ≈ 250KB, una fracción
// chica de los 10MB de cuota de chrome.storage.local (sin unlimitedStorage)
// — el límite real no es cuota, es cubrir cómodamente un recorrido de
// 30-50 páginas.
const MAX_DIGITAL_DATA_EVENTS = 500;

// ── Guarda de contexto de extensión invalidado ───────────────────────────────
// Recargar la extensión en chrome://extensions NO mata los content scripts ya
// inyectados en pestañas que estaban abiertas — quedan huérfanos: siguen
// corriendo (el listener de postMessage sigue registrado, es JS normal), pero
// su contexto de extensión ya no es válido. inject.js (world MAIN, sin acceso
// a chrome.*) no se entera de nada de esto y sigue posteando mensajes
// normalmente después de cada respuesta de Alloy o push a digitalData. Sin
// esta guarda, cada uno de esos mensajes terminaba llamando chrome.storage.*
// y tirando "Extension context invalidated" — ruido de desarrollo (la página
// nunca se rompe, Target/Alloy siguen andando igual), pero ensuciaba el panel
// de errores de chrome://extensions.
//
// chrome.runtime.id es la forma correcta de detectarlo: pasa a `undefined`
// cuando el contexto se invalida, y LEERLO nunca tira (a diferencia de llamar
// un método como chrome.storage.local.get(), que sí tira si el contexto ya
// no es válido). `chrome` en sí no debería poder faltar en un content script,
// pero se encadena con ?. de todos modos — es una lectura, no cuesta nada.
function isExtensionContextValid() {
  return !!chrome?.runtime?.id;
}

// Único lugar donde se llama chrome.storage.local.get/set en todo el archivo
// — todos los call sites de abajo pasan por acá, así que la guarda vive en un
// solo lugar en vez de repetirse en cada handler. Si el contexto ya no es
// válido, no-opean en silencio: no hay nada que leer/escribir para un content
// script huérfano.
function safeStorageGet(keys, callback) {
  if (!isExtensionContextValid()) return;
  chrome.storage.local.get(keys, callback);
}

function safeStorageSet(items) {
  if (!isExtensionContextValid()) return;
  chrome.storage.local.set(items);
}

// ── Detección de cambio de página ────────────────────────────────────────────
// Compara la URL guardada en storage con la URL actual (hostname + path).
// Si cambiaron, limpia requests/domMboxes/instanceInfo — son una foto del
// estado actual de la página, no un flujo, y acumularlos entre páginas
// confundiría cuál actividad es de dónde.
//
// digitalDataEvents NO se resetea acá a propósito: persiste a través de la
// navegación (ver abajo, donde cada entrada se etiqueta con pageUrl) para
// poder recorrer el sitio y después revisar el recorrido completo — dónde
// disparó cada push. Sí se limpia con LIMPIAR y con las transiciones de QA
// (Activar/Aplicar cambio/Salir, ver popup.js clearCapturedData), porque
// esos son "empezar de nuevo" explícitos, a diferencia de una navegación
// normal dentro del mismo recorrido.
safeStorageGet("tabUrl", (data) => {
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
    // Nueva página — limpiar la foto del estado actual, incluyendo el
    // orgId/edgeConfigId de la página anterior. digitalDataEvents queda afuera.
    safeStorageSet({
      requests: [],
      domMboxes: [],
      instanceInfo: null,
      tabUrl: window.location.href,
    });
  } else {
    safeStorageSet({ tabUrl: window.location.href });
  }
});

// ── Puente inject.js → storage ───────────────────────────────────────────────
// inject.js corre en world: MAIN (contexto de la página) y no tiene acceso a
// la API de Chrome. Este content script actúa como puente: escucha mensajes
// de inject.js vía postMessage y los persiste en chrome.storage.local.
//
// Handler con nombre (no arrow function inline) para poder desregistrarlo:
// si detecta el contexto invalidado, se saca a sí mismo del todo en vez de
// seguir chequeando en cada mensaje futuro — un content script huérfano no
// tiene nada más que hacer, la página eventualmente navega o se recarga y
// ahí entra un content.js nuevo con contexto válido.
function handleInjectedMessage(event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "mbox-inspector") return;

  if (!isExtensionContextValid()) {
    window.removeEventListener("message", handleInjectedMessage);
    return;
  }

  // Respuesta de Target: payload completo con decisiones de personalización
  if (event.data.type === "alloyResponse") {
    const payload = event.data.payload;
    if (!payload) return;
    safeStorageGet("requests", (data) => {
      const requests = data.requests || [];
      requests.unshift({
        payload,
        url: window.location.href,
        time: new Date().toISOString(),
      });
      safeStorageSet({ requests: requests.slice(0, 50) });
    });
  }

  // Mboxes encontrados en el DOM con atributo [data-mbox]
  if (event.data.type === "domMboxes") {
    const incoming = event.data.mboxes || [];
    safeStorageGet("domMboxes", (data) => {
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      safeStorageSet({ domMboxes: merged });
    });
  }

  // Scopes pedidos por la página al llamar alloy('sendEvent', { decisionScopes })
  // Se guardan junto a los domMboxes para cruzar qué scopes existen vs. cuáles respondió Target
  if (event.data.type === "decisionScopes") {
    const incoming = (event.data.scopes || []).filter((s) => s !== "__view__");
    safeStorageGet("domMboxes", (data) => {
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      safeStorageSet({ domMboxes: merged });
    });
  }

  // Config de la instancia de Alloy: orgId, datastream/edge config, edge domain.
  // Útil para confirmar que la página apunta al datastream correcto.
  if (event.data.type === "instanceInfo") {
    safeStorageSet({ instanceInfo: event.data.payload });
  }

  // Estado de la cookie at_qa_mode, detectado por inject.js en cada carga de
  // página (ver ahí el porqué de leerla en world: MAIN). Se sobreescribe
  // completo en cada load — no se mergea con el reset de "cambio de página"
  // de arriba porque la cookie sigue aplicando aunque el usuario navegue a
  // otra ruta del mismo dominio (path=/).
  if (event.data.type === "qaMode") {
    safeStorageSet({ qaMode: event.data.payload });
  }

  // Push crudo a window.digitalData (Adobe Client Data Layer), capturado
  // antes de que Launch lo procese — ver hookPushProperty en inject.js.
  // pageUrl queda fijo en la página donde disparó, aunque digitalDataEvents
  // persista más allá de esa página (ver detección de cambio de página arriba).
  if (event.data.type === "digitalDataPush") {
    const entry = {
      payload: event.data.payload,
      time: new Date(event.data.timestamp).toISOString(),
      timeSincePageLoad: event.data.timeSincePageLoad,
      pageUrl: window.location.href,
    };
    safeStorageGet("digitalDataEvents", (data) => {
      const events = data.digitalDataEvents || [];
      events.unshift(entry);
      safeStorageSet({ digitalDataEvents: events.slice(0, MAX_DIGITAL_DATA_EVENTS) });
    });
  }
}

window.addEventListener("message", handleInjectedMessage);

} // fin guard __mboxInspectorContentActive
