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
// — todos los call sites de abajo pasan por acá, así que la guarda de
// contexto vive en un solo lugar en vez de repetirse en cada handler. Si el
// contexto ya no es válido, no-opean en silencio (resuelven con un valor
// vacío/nada) en vez de llamar chrome.* y tirar.
//
// chrome.storage.local.get/set devuelven Promise nativamente si se omite el
// callback (soportado desde Chrome 96) — se usa esa forma para poder
// encadenarlas en enqueueStorageTask de abajo sin promisificar a mano.
function safeStorageGet(keys) {
  if (!isExtensionContextValid()) return Promise.resolve({});
  return chrome.storage.local.get(keys);
}

function safeStorageSet(items) {
  if (!isExtensionContextValid()) return Promise.resolve();
  return chrome.storage.local.set(items);
}

// ── Cola de escrituras serializadas ──────────────────────────────────────────
// Todo handler que hace lectura-modificación-escritura (get → mergear/unshift
// → set) sobre chrome.storage.local tiene la misma carrera: si dos mensajes
// llegan casi juntos (dos digitalData.push seguidos, varias respuestas de
// Alloy en ráfaga), el segundo get() puede resolver ANTES de que el primer
// set() haya terminado — ambos leen el mismo array base, y el set() que
// aterriza último pisa por completo al que aterrizó primero. Confirmado con
// logs con timestamp contra un mock de chrome.storage.local con latencia
// real (setTimeout, no microtask instantáneo): en 2 de 3 corridas el segundo
// get() arrancaba antes de que el primer set() hubiera resuelto, y el evento
// más viejo desaparecía del todo — reproduce exactamente la pérdida de
// "NameA" reportada en vivo (dos trackPromotionClick seguidos, sobrevive
// siempre el último).
//
// Se encolan como tareas: cada una es la unidad completa get→modificar→set,
// y no arranca hasta que la anterior terminó (haya tenido éxito o no) —
// mismo mecanismo para las cuatro escrituras racy (alloyResponse, domMboxes,
// decisionScopes, digitalDataPush) y para el reset de página de abajo, en
// vez de reimplementarlo en cada handler. Es una sola cola global, no una
// por clave de storage: el volumen de mensajes acá es bajísimo (unos pocos
// por segundo como mucho), así que serializar operaciones sobre claves
// distintas entre sí no tiene costo real, y evita la complejidad de
// coordinar colas separadas por clave.
let storageQueue = Promise.resolve();

function enqueueStorageTask(task) {
  const result = storageQueue.then(task);
  // La cadena interna nunca debe quedar rechazada — si no, todas las tareas
  // encoladas después de una que falla se saltean en cascada. El resultado
  // que se devuelve sí refleja el éxito/fracaso real de ESTA tarea.
  storageQueue = result.catch(() => {});
  return result;
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
//
// También pasa por la cola: es un get→set igual que los handlers de abajo, y
// si un mensaje de inject.js llega antes de que este chequeo termine (poco
// probable pero posible — content.js recién inyectado, mensaje casi
// inmediato), sin la cola ese handler podría leer el estado viejo antes del
// reset, o el reset podría pisar una escritura recién hecha.
enqueueStorageTask(async () => {
  const data = await safeStorageGet("tabUrl");
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
    await safeStorageSet({
      requests: [],
      domMboxes: [],
      instanceInfo: null,
      tabUrl: window.location.href,
    });
  } else {
    await safeStorageSet({ tabUrl: window.location.href });
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

  // Respuesta de Target: payload completo con decisiones de personalización.
  // get→modificar→set — pasa por la cola (ver arriba): si Alloy dispara
  // varias respuestas juntas, es el caso más probable de perder decisions
  // por la misma carrera que perdía eventos de digitalData.
  if (event.data.type === "alloyResponse") {
    const payload = event.data.payload;
    if (!payload) return;
    enqueueStorageTask(async () => {
      const data = await safeStorageGet("requests");
      const requests = data.requests || [];
      requests.unshift({
        payload,
        url: window.location.href,
        time: new Date().toISOString(),
      });
      await safeStorageSet({ requests: requests.slice(0, 50) });
    });
  }

  // Mboxes encontrados en el DOM con atributo [data-mbox]. get→merge→set,
  // misma carrera potencial que arriba si domMboxes/decisionScopes llegan
  // casi juntos — ambos tocan la misma clave "domMboxes".
  if (event.data.type === "domMboxes") {
    const incoming = event.data.mboxes || [];
    enqueueStorageTask(async () => {
      const data = await safeStorageGet("domMboxes");
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      await safeStorageSet({ domMboxes: merged });
    });
  }

  // Scopes pedidos por la página al llamar alloy('sendEvent', { decisionScopes })
  // Se guardan junto a los domMboxes para cruzar qué scopes existen vs. cuáles respondió Target
  if (event.data.type === "decisionScopes") {
    const incoming = (event.data.scopes || []).filter((s) => s !== "__view__");
    enqueueStorageTask(async () => {
      const data = await safeStorageGet("domMboxes");
      const merged = [...new Set([...(data.domMboxes || []), ...incoming])];
      await safeStorageSet({ domMboxes: merged });
    });
  }

  // Config de la instancia de Alloy: orgId, datastream/edge config, edge
  // domain. Es un set() puro (sin get previo) — pisa el valor anterior
  // completo, no lo mergea, así que no tiene la carrera read-modify-write de
  // arriba y no necesita pasar por la cola.
  if (event.data.type === "instanceInfo") {
    safeStorageSet({ instanceInfo: event.data.payload });
  }

  // Estado de la cookie at_qa_mode, detectado por inject.js en cada carga de
  // página (ver ahí el porqué de leerla en world: MAIN). Se sobreescribe
  // completo en cada load — no se mergea con el reset de "cambio de página"
  // de arriba porque la cookie sigue aplicando aunque el usuario navegue a
  // otra ruta del mismo dominio (path=/). Igual que instanceInfo, es un
  // set() puro sin get previo: no necesita la cola.
  if (event.data.type === "qaMode") {
    safeStorageSet({ qaMode: event.data.payload });
  }

  // Push crudo a window.digitalData (Adobe Client Data Layer), capturado
  // antes de que Launch lo procese — ver hookPushProperty en inject.js.
  // pageUrl queda fijo en la página donde disparó, aunque digitalDataEvents
  // persista más allá de esa página (ver detección de cambio de página
  // arriba). get→modificar→set — la carrera original reportada.
  if (event.data.type === "digitalDataPush") {
    const entry = {
      payload: event.data.payload,
      time: new Date(event.data.timestamp).toISOString(),
      timeSincePageLoad: event.data.timeSincePageLoad,
      pageUrl: window.location.href,
    };
    enqueueStorageTask(async () => {
      const data = await safeStorageGet("digitalDataEvents");
      const events = data.digitalDataEvents || [];
      events.unshift(entry);
      await safeStorageSet({ digitalDataEvents: events.slice(0, MAX_DIGITAL_DATA_EVENTS) });
    });
  }
}

window.addEventListener("message", handleInjectedMessage);

} // fin guard __mboxInspectorContentActive
