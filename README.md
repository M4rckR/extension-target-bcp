# BCP Target Inspector

Extensión de Chrome (Manifest V3) para el equipo de BCP que intercepta y visualiza en tiempo real las actividades de **Adobe Target / Alloy SDK** y los eventos de **tracking (`window.digitalData`)** activos en la página actual.

---

## ¿Qué hace?

Cuando Target responde a una llamada de personalización, o una offer hace `window.digitalData.push(...)`, la extensión captura el dato completo y lo muestra en una ventana independiente con cuatro vistas:

| Pestaña | Qué muestra |
| --- | --- |
| **Actividades** | Lista de actividades A/B y XT que Target activó, con nombre, ID, experiencia asignada y link directo a la UI de Adobe Target. Cada actividad es **expandible**: si la decisión trae una offer `dom-action`, muestra `type`/`format`/`selector`/`prehidingSelector`/tamaño, un preview truncado del `content` (HTML/JS que la offer inserta), y un botón **Copiar completo** para pegar el contenido íntegro en un editor |
| **mBoxes** | Todos los mboxes encontrados en la página, clasificados en *En uso* (Target respondió), *Libres* (existen en el DOM pero sin actividad asignada) y *Alloy* (respondidos por Target pero sin elemento DOM con `data-mbox`). `__view__` (el scope del VEC) queda fuera de esta clasificación a propósito — en páginas 100% VEC (sin ningún mbox nombrado) esta pestaña avisa explícitamente que no hay mboxes en vez de sugerir que falta recargar |
| **Eventos** | Pushes crudos a `window.digitalData` capturados en vivo — la capa de tracking *antes* de que Adobe Launch los procese. A diferencia de Actividades/mBoxes, **persiste a través de la navegación**: cada evento queda etiquetado con la página donde disparó, agrupados en secciones colapsables por página para poder recorrer el sitio y revisar después dónde disparó cada cosa. Dentro de cada página, eventos consecutivos del mismo tipo (p. ej. varios `trackScroll` seguidos) se colapsan en una fila `[nombre · N]` expandible; chips arriba de la lista filtran por nombre de evento en todo el recorrido |
| **QA** | Activa/reaplica/limpia el modo QA de Target (cookie `at_qa_mode`) pegando un link de preview — con un toggle para cambiar `listedActivitiesOnly` sin volver a generar el link. Banner de alerta visible en las cuatro pestañas mientras QA está activo, detectado desde la cookie de la pestaña (no memoria propia) |

También hay un footer con el `orgId`/`edgeConfigId` de la instancia de Alloy activa en la página, para confirmar que apunta al datastream correcto.

---

## Dominios soportados

La extensión solo se activa en:

- `viabcp.com` (y subdominios, p. ej. `mitarjetabcp.viabcp.com`)

En cualquier otra pestaña el popup muestra un aviso de dominio no permitido.

---

## Instalación

1. Descarga o clona este repositorio.
2. Abre Chrome y ve a `chrome://extensions/`.
3. Activa **Modo desarrollador** (esquina superior derecha).
4. Haz clic en **Cargar descomprimida** y selecciona la carpeta del proyecto.
5. La extensión aparecerá en la barra de herramientas con su icono.

> No requiere ninguna dependencia ni paso de build. Es HTML/CSS/JS puro.

---

## Uso

1. Abre una pestaña en `viabcp.com`.
2. **Recarga la página** con la extensión activa (importante: la captura ocurre al cargar).
3. Hacé clic en el icono de la barra de herramientas — abre una ventana independiente apuntada a esa pestaña.
4. Navega entre las pestañas **Actividades**, **mBoxes**, **Eventos** y **QA**.
5. Usa **LIMPIAR** para resetear todo lo capturado (incluidos los eventos del recorrido) y volver a capturar.

### Ventana independiente

No hay popup clásico — la extensión no tiene `default_popup`, así que el icono de la barra de herramientas siempre abre (o enfoca, si ya hay una) una ventana propia que se queda abierta y sigue mostrando datos en vivo, sin cerrarse al perder el foco. Si hacés clic en el icono con la ventana ya abierta, la enfoca en vez de crear una nueva.

Esa ventana sigue apuntando a la pestaña que estaba activa cuando la abriste, no a "la pestaña activa del navegador" en cada momento — si esa pestaña navega a otra URL, o si otra pestaña de BCP pisa los datos compartidos (ver limitación abajo), la ventana muestra el aviso naranja de "Página distinta a la captura" en vez de datos desincronizados en silencio.

### Tips

- La ventana se actualiza en **tiempo real**: si Target o el data layer disparan más eventos después de la carga, los verás aparecer sin necesidad de reabrir nada.
- Si navegaste a otra ruta sin recargar, verás el aviso naranja de "Página distinta a la captura" en Actividades/mBoxes. Recarga para sincronizar esas dos — **Eventos no se ve afectado**, ese sigue acumulando a través de la navegación (ver "Datos que se almacenan").
- Si el tipo de actividad no se pudo detectar automáticamente (A/B o XT), la extensión muestra ambos botones como hipótesis para que puedas elegir.
- En "Eventos", los chips de filtro son efímeros: se resetean cada vez que reabrís la ventana, para que un chip apagado de una sesión anterior nunca te esconda un evento nuevo sin que te des cuenta. La sección de la página más reciente del recorrido arranca expandida; las anteriores, colapsadas.
- El preview de `content` en "Actividades" está truncado a propósito (40 líneas o 3000 caracteres, lo que ocurra primero) — para ver el contenido completo (HTML/JS grande de una offer), usá **Copiar completo** y pegalo en tu editor.

---

## Arquitectura

Cuatro piezas que se comunican en cadena:

```text
Página web (viabcp.com)
  │
  ├─ window.__alloyMonitors  ──► inject.js  (world: MAIN, document_start)
  │    Intercepta respuestas de red de Alloy y llamadas a alloy('sendEvent')
  │    Escanea atributos [data-mbox] en el DOM (+ MutationObserver para SPAs)
  │    Hookea window.digitalData.push (defineProperty en dos capas, ver abajo)
  │    Detecta la cookie at_qa_mode en cada carga (document.cookie, sin permiso "cookies")
  │                         │
  │              window.postMessage({ source: 'mbox-inspector', ... })
  │                         │
  │                         ▼
  └─ content.js  (world: ISOLATED, document_start)
       Actúa como puente: escucha los mensajes y los persiste en storage
                         │
                chrome.storage.local
   { requests, domMboxes, digitalDataEvents, instanceInfo, tabUrl, qaMode }
   requests/domMboxes/instanceInfo: se resetean al navegar a otra página.
   digitalDataEvents: NO — persiste a través de la navegación (pageUrl por evento).
                         │
                         ▼
                     popup.js  (popup.html, solo en ventana independiente)
          render()        → pestaña Actividades (+ contenido expandible)
          renderMboxes()  → pestaña mBoxes
          renderEventos() → pestaña Eventos (agrupada por página del recorrido)
          renderQaTab() / renderQaBanner() → pestaña QA + banner en las 4 pestañas

background.js (service worker)
  chrome.action.onClicked crea o enfoca la ventana independiente (único
  entry point — no hay default_popup en el manifest). Limpia el puntero
  {windowId, tabId} de storage cuando se cierra la pestaña que la ventana
  estaba inspeccionando.
```

### ¿Por qué dos scripts en la página?

- **`inject.js`** corre en `world: MAIN` (mismo contexto JS que la página), necesario para acceder a `window.alloy`, `window.__alloyMonitors` y `window.digitalData` antes de que la página los use.
- **`content.js`** corre en el mundo aislado de Chrome y es el único que puede usar `chrome.storage`. Actúa como puente entre ambos mundos vía `postMessage`.

### Captura de `window.digitalData.push()`

En viabcp.com, `digitalData` es una instancia de **Adobe Client Data Layer (ACDL)**, no un array plano — tiene `.push`/`.getState`/`.addEventListener` propios, y ACDL se inicializa de forma asíncrona (vía Launch) reemplazando `.push` después de que la página carga. Por eso el hook es de **dos capas**, ambas con `Object.defineProperty` (nunca un `Proxy` recursivo genérico, no hace falta acá):

1. Un accessor en `window.digitalData` → detecta cuando se (re)asigna el array completo.
2. Un accessor en la propiedad `.push` de ese array → captura tanto los pushes de las offers como el momento en que ACDL reemplaza `.push`, envolviendo esa nueva función en vez de perder el hook.

Todo el bloque corre en `document_start` (antes que cualquier script de la página) y está envuelto en `try/catch`: si algo falla, se degrada a "no capturamos eventos" sin tocar el resto de `inject.js` ni el comportamiento real del data layer — es puramente observacional, nunca altera ni interrumpe la llamada real.

### Ventana independiente (`background.js`, único entry point)

El manifest no tiene `default_popup`, así que `chrome.action.onClicked` dispara en cada click del icono (esa API nunca dispara mientras haya `default_popup` configurado — por eso se sacó). `background.js` crea la ventana la primera vez (`chrome.windows.create`, apuntando a `popup.html?tabId=<pestaña activa>`) y la enfoca las siguientes (`chrome.windows.get`/`update`), guardando el puntero `{windowId, tabId}` en storage. También limpia ese puntero cuando se cierra la pestaña que la ventana estaba inspeccionando — la ventana no puede hacer esa limpieza de forma confiable en su propio cierre.

`popup.html`/`popup.js` no cambiaron de rol: siguen siendo la UI, ahora montada exclusivamente dentro de esa ventana en vez de además servir como popup clásico.

> **Limitación conocida:** el storage no está particionado por pestaña. `requests`, `domMboxes`, `instanceInfo` y `tabUrl` son claves únicas y globales — si tenés dos pestañas de BCP abiertas a la vez, se pisan datos entre sí durante esa página (mitigado por el aviso de "página distinta a la captura", que avisa en vez de mostrar datos desincronizados en silencio).
>
> `digitalDataEvents` tiene el mismo problema pero **más grave**, porque ahora persiste a través de la navegación: si dos pestañas de BCP están abiertas mientras recorrés el sitio, sus eventos se entreveran en un solo timeline en vez de reflejar dos recorridos separados — no hay aviso para este caso, porque no hay un cambio de página que lo dispare. No resuelto todavía; requeriría que cada evento supiera su propio `tabId` (hoy no es trivial: un content script no conoce su `tabId` vía el canal `postMessage` que usa inject.js, haría falta un round-trip nuevo por `chrome.runtime.sendMessage` al service worker).

### Archivos

| Archivo | Rol |
| --- | --- |
| `manifest.json` | Configuración de la extensión (permisos, scripts, dominios, background) |
| `inject.js` | Captura respuestas de Alloy, intercepta `window.alloy()` y `window.digitalData.push()`, detecta la cookie `at_qa_mode` |
| `content.js` | Puente postMessage → chrome.storage |
| `background.js` | Service worker: `chrome.action.onClicked` crea/enfoca la ventana independiente (único entry point), limpieza del puntero al cerrarse la pestaña inspeccionada |
| `popup.html` | UI (estructura HTML + CSS con metodología BEM), montada solo dentro de la ventana independiente |
| `popup.js` | Lógica: renderizado de las 4 pestañas, tabs, live update |

---

## Cómo agregar un dominio nuevo

1. En `manifest.json`, agrega el dominio a `host_permissions` y a los dos bloques `matches` de `content_scripts`:

   ```json
   "*://*.nuevo-dominio.com/*"
   ```

2. En `popup.js`, agrega el dominio al array `ALLOWED_DOMAINS`:

   ```js
   const ALLOWED_DOMAINS = ["viabcp.com", "nuevo-dominio.com"];
   ```

3. Recarga la extensión en `chrome://extensions/`.

---

## Datos que se almacenan

Todo se guarda localmente en `chrome.storage.local` (solo en tu navegador, nunca sale del equipo):

| Clave | Contenido | Límite | ¿Sobrevive a navegar de página? |
| --- | --- | --- | --- |
| `requests` | Últimas respuestas de Target (payload completo + URL + timestamp) | 50 entradas | No — foto del estado actual |
| `domMboxes` | Nombres de mboxes encontrados en el DOM o pedidos vía `decisionScopes` | Sin límite | No — foto del estado actual |
| `digitalDataEvents` | Pushes crudos a `window.digitalData` (payload + timestamp + tiempo desde carga + `pageUrl` de origen) | 500 entradas | **Sí** — es un recorrido, no una foto (ver "Datos que se almacenan" abajo) |
| `instanceInfo` | orgId/edgeConfigId/edgeDomain de la instancia de Alloy activa | — | No |
| `qaMode` | Estado de la cookie `at_qa_mode` detectado en la pestaña, o `{active:false}` | — | Se recalcula en cada carga de página |
| `inspectorWindow` | Puntero `{windowId, tabId}` de la ventana independiente abierta, si hay una | — | — |
| `tabUrl` | URL de la última página capturada (para detectar cambios de página) | — | — |

`digitalDataEvents` usa 500 como límite porque, a diferencia de `requests`/`domMboxes`, tiene que cubrir un recorrido completo por el sitio en vez de una sola página: medido en vivo, un push típico (`trackScroll`/`trackAction`) pesa ~60-120B de JSON crudo, y cada entrada persistida (con el wrapper + `pageUrl`) ronda ~300-500B — 500 entradas son ~250KB, una fracción chica de los 10MB de cuota de `chrome.storage.local` (la extensión no pide `unlimitedStorage`), y alcanza cómodo para 30-50 páginas de recorrido.

El botón **LIMPIAR**, y las transiciones de modo QA (Activar/Aplicar cambio/Salir, pestaña QA), vacían `requests`, `domMboxes` y `digitalDataEvents` — las tres, incluido el recorrido de eventos: son un "empezar de nuevo" explícito, a diferencia de navegar dentro del mismo recorrido.

---

## Versión

`v2.0.0`

---

## Autor

**Marcos Romero**
MarTech Engineer · Mesa de MarTech
Squad Tarjeta de Crédito — BCP

### Colaboradores

**Jose Perez** — idea original de la pestaña QA (activar/reaplicar/limpiar el modo preview de Target desde la extensión). El análisis de la cookie `at_qa_mode` y la implementación portada a este proyecto (ver `referencia2/` en "Reference material" de CLAUDE.md) partieron de esa idea.
