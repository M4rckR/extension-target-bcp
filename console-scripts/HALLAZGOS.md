# Hallazgos — Adobe Campaign Classic, editor de mails

Bitácora técnica de lo que se averiguó sobre el editor de ACC mientras se
construía la preview del mailing. Todo lo de acá **se midió en vivo** contra el
editor real el **2026-09-07**, salvo donde diga explícitamente lo contrario.

Existe para poder retomar el trabajo sin volver a hacer los reconocimientos.

---

## 1. Qué producto es

No es Journey Optimizer. Es **Adobe Campaign Classic (ACC)**, servido dentro del
shell de Experience Cloud.

| | |
| --- | --- |
| Página | `experience.adobe.com/thunderbird/solutions/pixel-acrites-ui` |
| Driver | `cdn.experience.adobe.net/solutions/campaign-acc-web-ui/static-assets/acriteDriver.js` |
| Librería de UI del shell | **Coral** (`coral-dialog`, `coral-icon`, `coral-wait`…) |
| Librería dentro del canvas | ninguna — DOM plano, 0 custom elements |

`acrites` / `acrite` / `acd` son los prefijos internos de Adobe para este
editor. Aparecen por todos lados: `pixel-acrites-ui`, `acriteDriver.js`,
`acd-plugin-*.css`, y las clases `.acr-*` del DOM.

---

## 2. Dónde está el canvas: cuatro frames, tres dominios

```
top                                        experience.adobe.com
└─ Main Content (pixel-acrites-ui)         experience.adobe.com
   └─ Main Content (campaign-acc-web-ui)   cdn.experience.adobe.net
      └─ iframe.html                       acrites-ui-iframe.experience.adobe.net  ← el canvas
```

El canvas es
`https://acrites-ui-iframe.experience.adobe.net/solutions/pixel-acrites-iframe/iframe.html`,
y desde arriba aparece como un único `<iframe title="IFrameRichText">` de
678×698.

**Es cross-origin** (`experience.adobe.com` vs `experience.adobe.net`):
`contentDocument` devuelve `null` desde el frame padre. No hay truco de JS que
lo evite.

### Cómo pararse ahí en DevTools

El desplegable de contexto está en la **segunda fila de la Console**, a la
izquierda del buscador *Filter*. Según la versión de Chrome dice `top` o
`Main Content (...)`.

Hay que elegir el renglón **sin indentar** que diga `iframe.html` /
`acrites-ui-iframe.experience.adobe.net`. Los renglones indentados que dicen
"Extension" son mundos aislados de otras extensiones instaladas, no sirven.

---

## 3. Cómo está armado el mail dentro del canvas

Adentro del canvas **no hay más iframes**: el documento *es* la superficie de
edición.

| | |
| --- | --- |
| Contenedor | **`div.acr-container`**, hijo directo de `<body>` |
| Tamaño | 294 × 2434 px |
| HTML | 85 191 caracteres — **el 99,9% del `<body>`** (85 304) |
| Composición | 131 `<table>`, 17 `<img>`, 774 elementos |
| Estilos inline | **305 de 774 elementos** traen atributo `style` (~40%) |
| `<style>` adentro | **0** — el CSS no está en el contenedor |
| Clase del `<body>` | `acr-tpl-mode` |

El mail se compone de **fragmentos**: divs `contenteditable` con clase
`acr-fragment acr-component`, uno por bloque (header, texto, botón, imagen,
pie). Se contaron 17 en un mail y 24 en otro — la cantidad varía por mail, y el
contenedor los agarra a todos igual.

**El HTML del DOM es el HTML del mail**, no una representación interna del
editor. Lo confirman los estilos inline y las clases, que son convenciones de
email responsive:

```
mobile-full (51) · mobile-margen (20) · mobile-height-auto (8) · table-radius (7)
mobile-show · mobile-textcenter · mobile-textleft · image-global-responsive
mobile-img-full · is-highlight · divider-mso-hidden · icono-responsive-50
```

De las 20 clases más frecuentes **solo una es del editor** (`acr-tmp-component`,
3 apariciones).

También se descartó que el HTML crudo esté guardado en algún campo del
formulario: `textarea` y `input[type=hidden]` grandes dieron **cero**.

---

## 4. El CSS: cuál es del mail y cuál del editor

El CSS responsive **no está en el contenedor**. Vive en 20 `<style>` sueltos del
documento, mezclado con el del editor. Las 13 hojas externas
(`acd-plugin-*.css`, `appIframe*.css`) son **todas del editor**.

### La regla que los separa

Descartar un `<style>` si cumple **cualquiera** de estas:

1. Contiene selectores `.acr-*` / `.acd-*` → canvas, grid, dark mode, plugins.
2. Contiene nombres de **CSS Modules con hash** (`colorPicker__wrapper___3urhm`)
   → los paneles de la UI del editor. Regex: `/___[A-Za-z0-9_-]{4,}/`.

De lo que sobrevive, conservar lo que defina **al menos 2 clases que el mail usa
de verdad**, o lo que traiga **`@media`** — por esta segunda vía entra el
responsive por id, que no define clases pero sí afecta al mail.

Deduplicar por contenido exacto: el editor emite el bloque responsive **dos
veces, idéntico byte a byte**.

### Resultado medido: de 20 `<style>`, se llevan 5 (~10 KB)

| # | Bytes | Qué es | ¿Va? |
| --- | --- | --- | --- |
| 0 | 4743 | Reset de clientes de correo: `.ReadMsgBody`, `.ExternalClass`, `.yshortcuts`, `.vb-outer` | ✅ |
| 1–9 | 102–2817 | CSS Modules de los paneles: `colorPicker__`, `global__panel___`, `imageField__`, `textSettings__`… | ❌ editor |
| 10 | 1864 | `body`, `td`, `.acr-fragment`, `.divider-container` — estilos del canvas | ❌ editor |
| 11 | 215 | `.acr-grid-table`, `.acr-grid-column` | ❌ editor |
| 12 | 109 | `body`, `#acr-body` | ❌ editor |
| 13 | 345 | `.acr-dark-img`, `.acr-container` — dark mode | ❌ editor |
| 14 | 362 | `.structure__table`, `.colspan1`, `.is-mobile-hidden` | ✅ |
| 15 | 122 | `.acr-dark-img`, `.acr-light-img` | ❌ editor |
| 16 | 394 | Media queries por id: `#acr-t94e`, `#acr-4kp7`… | ✅ |
| 17 | 4234 | Responsive: `.mobile-w0`, `.mobile-hide`, `.mobile-show`, `.mobile-textcenter` | ✅ |
| 18 | 4234 | **Idéntico al 17** | ❌ duplicado |
| 19 | 704 | Más responsive: `.mobile-full`, `.mobile-textleft` | ✅ |

> ⚠️ El bloque 16 apunta a **ids** (`#acr-t94e`). Por eso la extracción **no
> debe borrar ids ni clases** del HTML: se perdería ese responsive. La limpieza
> tiene que quedarse en `contenteditable`, `spellcheck` y `<script>`.

---

## 5. El canvas está sandboxeado

El iframe del canvas tiene el atributo `sandbox` **sin `allow-popups`**.
Verificado en vivo:

```
Blocked opening '' in a new window because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set.
```

No es el bloqueador de popups ni falta de gesto de usuario. **`window.open` es
imposible desde adentro del canvas**, y no hay forma de saltarlo desde el código
de la página. Por eso la preview terminó siendo un panel acoplado.

Consecuencias probables del mismo sandbox, no verificadas una por una:

- La **Clipboard API** puede estar bloqueada (hay fallback a
  `textarea + execCommand`, y como último recurso `copy(__accPreview.html())`
  desde la consola, que corre del lado de DevTools y no está sujeto al sandbox).
- Las **descargas de archivo** probablemente también (`allow-downloads`), por eso
  no hay botón de descargar.
- Un `<iframe srcdoc>` creado adentro **hereda el sandbox**. Para HTML y CSS
  estáticos no es problema.

---

## 6. Qué significa esto para la extensión

Los dos obstáculos que frenan al script de consola **no existen en una
extensión**. Sirven como argumento concreto en el pedido de aprobación:

| Obstáculo | En consola | En extensión |
| --- | --- | --- |
| Canvas cross-origin | Hay que cambiar el contexto de DevTools a mano | Content script con `all_frames: true` se inyecta solo |
| `window.open` bloqueado por sandbox | Imposible — solo panel acoplado | `chrome.windows.create` desde el service worker, ajeno al sandbox del frame |

Cambios de manifiesto que haría falta cuando se porte:

```jsonc
"host_permissions": ["*://acrites-ui-iframe.experience.adobe.net/*"],
"content_scripts": [{
  "matches": ["*://acrites-ui-iframe.experience.adobe.net/*"],
  "all_frames": true
}]
```

Ojo con la trampa documentada en `CLAUDE.md`: la lista de dominios está
duplicada en `manifest.json` y en `ALLOWED_DOMAINS` de `popup.js`, y las dos
tienen que quedar sincronizadas.

Dato para el pedido: en ese navegador ya hay extensiones instaladas del mismo
rubro — **Adobe Experience Platform Debugger**, Tagbird, Launch and DTM Switch,
Automation 360. Hay precedente de aprobación para herramientas de Adobe.

---

## 7. Estado: qué está verificado y qué no

### Verificado en vivo

- Los tres reconocimientos (`recon.js`, `recon-fragmentos.js`,
  `recon-estilos.js`) — todos los datos de este documento salen de ahí.
- Que `.acr-container` se detecta correctamente desde el script de preview: el
  log imprime "Activo" solo si la encuentra.
- Que `window.open` está bloqueado por el sandbox.

### Sin verificar

- **Que el mail se vea bien en el panel.** El render nunca se llegó a ver
  funcionar: la primera corrida murió en `window.open`, y la segunda reusó por
  error la instancia vieja (bug del guard, ya corregido).
- Si el portapapeles funciona dentro del sandbox.
- Si las imágenes con ruta relativa resuelven bien con el `<base href>`.

### Lo que sigue

1. Correr `acc-email-preview.js` y ver si el mail se renderiza bien.
2. Si sale sin estilos o le faltan bloques → `__accPreview.estilos()` y revisar
   la clasificación de la sección 4.
3. Con eso andando, portarlo a una pestaña del popup de la extensión.

---

## 8. Limitaciones de fondo

- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía al
  final: los tokens de personalización vienen resueltos o vacíos, y no incluye
  lo que agregue el servidor al enviar.
- Todo esto depende de detalles internos de ACC (`.acr-container`, los prefijos
  `.acr-`/`.acd-`, la estructura de frames). Adobe puede cambiarlos en cualquier
  release. Los tres `recon*.js` quedan versionados justamente para poder rehacer
  el diagnóstico rápido cuando eso pase.
