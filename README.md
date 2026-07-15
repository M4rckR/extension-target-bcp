# mBox Inspector — BCP Target Monitor

Extensión de Chrome (Manifest V3) para el equipo de BCP que intercepta y visualiza en tiempo real las actividades de **Adobe Target / Alloy SDK** activas en la página actual.

---

## ¿Qué hace?

Cuando Target responde a una llamada de personalización, la extensión captura el payload completo y lo muestra en un popup con dos vistas:

| Pestaña | Qué muestra |
|---|---|
| **Actividades** | Lista de actividades A/B y XT que Target activó, con nombre, ID, experiencia asignada y link directo a la UI de Adobe Target |
| **mBoxes** | Todos los mboxes encontrados en la página, clasificados en *En uso* (Target respondió), *Libres* (existen en el DOM pero sin actividad asignada) y *Alloy* (respondidos por Target pero sin elemento DOM con `data-mbox`) |

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
5. La extensión aparecerá en la barra de herramientas con el icono 🎯.

> No requiere ninguna dependencia ni paso de build. Es HTML/CSS/JS puro.

---

## Uso

1. Abre una pestaña en `viabcp.com` o `yoando.com.pe`.
2. **Recarga la página** con la extensión activa (importante: la captura ocurre al cargar).
3. Haz clic en el icono 🎯 de la barra de herramientas.
4. Navega entre las pestañas **Actividades** y **mBoxes**.
5. Usa **LIMPIAR** para resetear los datos capturados y volver a capturar.

### Tips

- El popup se actualiza en **tiempo real**: si Target dispara más respuestas después de la carga (por interacciones SPA), las verás aparecer sin necesidad de reabrir el popup.
- Si navegaste a otra ruta sin recargar, el popup mostrará un aviso naranja de "Página distinta a la captura". Recarga para sincronizar.
- Si el tipo de actividad no se pudo detectar automáticamente (A/B o XT), la extensión muestra ambos botones como hipótesis para que puedas elegir.

---

## Arquitectura

La extensión usa tres scripts que se comunican en cadena:

```
Página web (viabcp.com / yoando.com.pe)
  │
  ├─ window.__alloyMonitors  ──► inject.js  (world: MAIN)
  │    Intercepta respuestas de red de Alloy y llamadas a alloy('sendEvent')
  │    Escanea atributos [data-mbox] en el DOM (+ MutationObserver para SPAs)
  │                         │
  │              window.postMessage({ source: 'mbox-inspector', ... })
  │                         │
  │                         ▼
  └─ content.js  (world: ISOLATED)
       Actúa como puente: escucha los mensajes y los persiste en storage
                         │
                chrome.storage.local
                { requests, domMboxes, tabUrl }
                         │
                         ▼
                     popup.js
          render() → pestaña Actividades
          renderMboxes() → pestaña mBoxes
```

### ¿Por qué dos scripts?

- **`inject.js`** corre en `world: MAIN` (mismo contexto JS que la página), necesario para acceder a `window.alloy` y `window.__alloyMonitors` antes de que la página los use.
- **`content.js`** corre en el mundo aislado de Chrome y es el único que puede usar la API de Chrome (`chrome.storage`). Actúa como puente entre ambos mundos vía `postMessage`.

### Archivos

| Archivo | Rol |
|---|---|
| `manifest.json` | Configuración de la extensión (permisos, scripts, dominios) |
| `inject.js` | Captura respuestas de Alloy e intercepta `window.alloy()` |
| `content.js` | Puente postMessage → chrome.storage |
| `popup.html` | UI del popup (estructura HTML + CSS con metodología BEM) |
| `popup.js` | Lógica del popup: renderizado, tabs, live update |

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
| `tabUrl` | URL de la última página capturada (para detectar cambios de página) | — |

El botón **LIMPIAR** vacía `requests` y `domMboxes`.

---

## Versión

`v2.0.0`

---

## Autor

**Marcos Romero**
MarTech Engineer · Mesa de MarTech
Squad Tarjeta de Crédito — BCP
