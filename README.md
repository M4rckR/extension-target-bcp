# BCP Target Inspector

Extensión de Chrome (Manifest V3) para el equipo de BCP que intercepta y visualiza en tiempo real las actividades de **Adobe Target / Alloy SDK** y los eventos de **tracking (`window.digitalData`)** activos en la página actual.

---

## ¿Qué hace?

Cuando Target responde a una llamada de personalización, o una offer hace `window.digitalData.push(...)`, la extensión captura el dato completo y lo muestra en un popup (o en una ventana independiente) con tres vistas:

| Pestaña | Qué muestra |
|---|---|
| **Actividades** | Lista de actividades A/B y XT que Target activó, con nombre, ID, experiencia asignada y link directo a la UI de Adobe Target. Cada actividad es **expandible**: si la decisión trae una offer `dom-action`, muestra `type`/`format`/`selector`/`prehidingSelector`/tamaño, un preview truncado del `content` (HTML/JS que la offer inserta), y un botón **Copiar completo** para pegar el contenido íntegro en un editor |
| **mBoxes** | Todos los mboxes encontrados en la página, clasificados en *En uso* (Target respondió), *Libres* (existen en el DOM pero sin actividad asignada) y *Alloy* (respondidos por Target pero sin elemento DOM con `data-mbox`) |
| **Eventos** | Pushes crudos a `window.digitalData` capturados en vivo — la capa de tracking *antes* de que Adobe Launch los procese. Eventos consecutivos del mismo tipo (p. ej. varios `trackScroll` seguidos) se colapsan en una fila `[nombre · N]` expandible para no tapar los que sí importan; chips arriba de la lista filtran por nombre de evento |

También hay un footer con el `orgId`/`edgeConfigId` de la instancia de Alloy activa en la página, para confirmar que apunta al datastream correcto.

---

## Dominios soportados

La extensión solo se activa en:

- `viabcp.com` (y subdominios)
- `yoando.com.pe` (y subdominios)

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

1. Abre una pestaña en `viabcp.com` o `yoando.com.pe`.
2. **Recarga la página** con la extensión activa (importante: la captura ocurre al cargar).
3. Haz clic en el icono de la barra de herramientas para abrir el popup.
4. Navega entre las pestañas **Actividades**, **mBoxes** y **Eventos**.
5. Usa **LIMPIAR** para resetear los datos capturados y volver a capturar.

### Ventana independiente

El popup se cierra apenas pierde el foco — poco práctico si querés ver eventos dispararse mientras interactuás con la página (clicks, scroll, navegación SPA). El botón **⧉** (header, junto a LIMPIAR) abre una ventana propia que se queda abierta y sigue mostrando datos en vivo. Si volvés a hacer clic en ⧉ con la ventana ya abierta, la enfoca en vez de crear una nueva.

Esa ventana sigue apuntando a la pestaña que estaba activa cuando la abriste, no a "la pestaña activa del navegador" en cada momento — si esa pestaña navega a otra URL, o si otra pestaña de BCP pisa los datos compartidos (ver limitación abajo), la ventana muestra el aviso naranja de "Página distinta a la captura" en vez de datos desincronizados en silencio.

### Tips

- El popup/ventana se actualiza en **tiempo real**: si Target o el data layer disparan más eventos después de la carga, los verás aparecer sin necesidad de reabrir nada.
- Si navegaste a otra ruta sin recargar, verás el aviso naranja de "Página distinta a la captura". Recarga para sincronizar.
- Si el tipo de actividad no se pudo detectar automáticamente (A/B o XT), la extensión muestra ambos botones como hipótesis para que puedas elegir.
- En "Eventos", los chips de filtro son efímeros: se resetean cada vez que reabrís el popup/ventana, para que un chip apagado de una sesión anterior nunca te esconda un evento nuevo sin que te des cuenta.
- El preview de `content` en "Actividades" está truncado a propósito (40 líneas o 3000 caracteres, lo que ocurra primero) — para ver el contenido completo (HTML/JS grande de una offer), usá **Copiar completo** y pegalo en tu editor.

---

## Arquitectura

Cuatro piezas que se comunican en cadena:

```
Página web (viabcp.com / yoando.com.pe)
  │
  ├─ window.__alloyMonitors  ──► inject.js  (world: MAIN, document_start)
  │    Intercepta respuestas de red de Alloy y llamadas a alloy('sendEvent')
  │    Escanea atributos [data-mbox] en el DOM (+ MutationObserver para SPAs)
  │    Hookea window.digitalData.push (defineProperty en dos capas, ver abajo)
  │                         │
  │              window.postMessage({ source: 'mbox-inspector', ... })
  │                         │
  │                         ▼
  └─ content.js  (world: ISOLATED, document_start)
       Actúa como puente: escucha los mensajes y los persiste en storage
                         │
                chrome.storage.local
      { requests, domMboxes, digitalDataEvents, instanceInfo, tabUrl }
                         │
                         ▼
                     popup.js  (popup.html, clásico o en ventana ⧉)
          render()        → pestaña Actividades (+ contenido expandible)
          renderMboxes()  → pestaña mBoxes
          renderEventos() → pestaña Eventos (agrupación + chips)

background.js (service worker)
  Solo limpia el puntero {windowId, tabId} de storage cuando se cierra la
  pestaña que la ventana independiente estaba inspeccionando. No maneja
  chrome.action.onClicked (nunca dispara mientras haya default_popup) — el
  popup clásico sigue siendo la entrada por defecto; el botón ⧉ dentro del
  popup es lo único que crea/enfoca la ventana.
```

### ¿Por qué dos scripts en la página?

- **`inject.js`** corre en `world: MAIN` (mismo contexto JS que la página), necesario para acceder a `window.alloy`, `window.__alloyMonitors` y `window.digitalData` antes de que la página los use.
- **`content.js`** corre en el mundo aislado de Chrome y es el único que puede usar `chrome.storage`. Actúa como puente entre ambos mundos vía `postMessage`.

### Captura de `window.digitalData.push()`

En viabcp.com, `digitalData` es una instancia de **Adobe Client Data Layer (ACDL)**, no un array plano — tiene `.push`/`.getState`/`.addEventListener` propios, y ACDL se inicializa de forma asíncrona (vía Launch) reemplazando `.push` después de que la página carga. Por eso el hook es de **dos capas**, ambas con `Object.defineProperty` (nunca un `Proxy` recursivo genérico, no hace falta acá):

1. Un accessor en `window.digitalData` → detecta cuando se (re)asigna el array completo.
2. Un accessor en la propiedad `.push` de ese array → captura tanto los pushes de las offers como el momento en que ACDL reemplaza `.push`, envolviendo esa nueva función en vez de perder el hook.

Todo el bloque corre en `document_start` (antes que cualquier script de la página) y está envuelto en `try/catch`: si algo falla, se degrada a "no capturamos eventos" sin tocar el resto de `inject.js` ni el comportamiento real del data layer — es puramente observacional, nunca altera ni interrumpe la llamada real.

### Ventana independiente (`background.js` + botón ⧉)

No hay `chrome.action.onClicked` en `background.js` a propósito: esa API nunca dispara mientras el manifest tenga `default_popup` configurado, así que el popup clásico queda intacto como entrada rápida. La ventana se crea/enfoca desde un botón **dentro** del popup (`chrome.windows.create`/`update`/`get`, sin permisos nuevos), y `background.js` se limita a limpiar el puntero de storage cuando se cierra la pestaña inspeccionada — el popup no puede hacer esa limpieza porque se cierra solo al perder el foco (justo lo que pasa al abrir la ventana).

> **Limitación conocida:** el storage no está particionado por pestaña — `requests`, `domMboxes`, `digitalDataEvents`, `tabUrl` son claves únicas y globales. Si tenés dos pestañas de BCP abiertas a la vez, se pisan datos entre sí. No resuelto todavía (quedaría para una fase futura); mientras tanto, el aviso de "página distinta a la captura" avisa cuando esto pasa en vez de mostrar datos desincronizados en silencio.

### Archivos

| Archivo | Rol |
|---|---|
| `manifest.json` | Configuración de la extensión (permisos, scripts, dominios, background) |
| `inject.js` | Captura respuestas de Alloy, intercepta `window.alloy()` y `window.digitalData.push()` |
| `content.js` | Puente postMessage → chrome.storage |
| `background.js` | Service worker mínimo: limpieza del puntero de la ventana independiente |
| `popup.html` | UI (estructura HTML + CSS con metodología BEM), reusada tal cual para el popup clásico y la ventana independiente |
| `popup.js` | Lógica: renderizado de las 3 pestañas, tabs, live update, ventana independiente |

---

## Cómo agregar un dominio nuevo

1. En `manifest.json`, agrega el dominio a `host_permissions` y a los dos bloques `matches` de `content_scripts`:
   ```json
   "*://*.nuevo-dominio.com/*"
   ```
2. En `popup.js`, agrega el dominio al array `ALLOWED_DOMAINS`:
   ```js
   const ALLOWED_DOMAINS = ["viabcp.com", "yoando.com.pe", "nuevo-dominio.com"];
   ```
3. Recarga la extensión en `chrome://extensions/`.

---

## Datos que se almacenan

Todo se guarda localmente en `chrome.storage.local` (solo en tu navegador, nunca sale del equipo):

| Clave | Contenido | Límite |
|---|---|---|
| `requests` | Últimas respuestas de Target (payload completo + URL + timestamp) | 50 entradas |
| `domMboxes` | Nombres de mboxes encontrados en el DOM o pedidos vía `decisionScopes` | Sin límite |
| `digitalDataEvents` | Pushes crudos a `window.digitalData` (payload + timestamp + tiempo desde carga) | 50 entradas |
| `instanceInfo` | orgId/edgeConfigId/edgeDomain de la instancia de Alloy activa | — |
| `inspectorWindow` | Puntero `{windowId, tabId}` de la ventana independiente abierta, si hay una | — |
| `tabUrl` | URL de la última página capturada (para detectar cambios de página) | — |

El botón **LIMPIAR** vacía `requests`, `domMboxes` y `digitalDataEvents`.

---

## Versión

`v2.0.0`

---

## Autor

**Marcos Romero**
MarTech Engineer · Mesa de MarTech
Squad Tarjeta de Crédito — BCP
