# `console-scripts/` — prototipos que se pegan en la consola

## Para qué existe esta carpeta

En las laptops del banco donde está Adobe **no se pueden instalar extensiones**,
pero sí se puede ejecutar JavaScript pegándolo en la consola de DevTools.

Entonces cada funcionalidad nueva se prueba primero acá, como script pegable.
Con la demo andando se pide la aprobación para instalar la extensión, y recién
después el script se porta a una pestaña más del popup.

Ninguno de estos scripts usa APIs `chrome.*` — son JS de página, igual que
`inject.js` en el mundo MAIN. Eso es justamente lo que los hace portables en las
dos direcciones: lo que anda en consola después anda como `content_script`.

> **Estado: experimental.** Nada de esta carpeta está integrado a la extensión
> todavía. Vive en la rama `experimental/adobe-email-designer`.

---

## El objetivo

Detectar el canvas del mailing que se está editando y abrir una **segunda
ventana con la previsualización**, que se actualiza sola mientras se edita.

---

## Qué hay acá

📄 **[HALLAZGOS.md](HALLAZGOS.md)** — bitácora técnica de todo lo que se
averiguó del editor de ACC, con los datos medidos en vivo. Empezá por ahí si
retomás esto después de un tiempo.

| Archivo | Qué es | Cuándo se usa |
| --- | --- | --- |
| **`acc-email-preview.js`** | Preview en un panel dentro del canvas | ✅ 1 pegado, lo más simple |
| **`acc-preview-pestana.js`** | Preview en una pestaña aparte | ✅ 2 pegados, ojo con qué frame |
| `recon.js` | Reconocimiento del DOM, solo lectura | Ya cumplió — ubicó el canvas |
| `recon-fragmentos.js` | Contenedor del mail y origen de los estilos | Ya cumplió |
| `recon-estilos.js` | Cuál de los `<style>` es del mail | Ya cumplió |
| `ajo-email-preview.js` | ~~Preview~~ — **obsoleto**, apuntaba a Journey Optimizer | No usar |
| `banco-de-pruebas.html` | Maqueta local del editor equivocado | Solo servía al obsoleto |

Los tres `recon*.js` quedan versionados porque sirven para rehacer el
diagnóstico si Adobe cambia el editor en un release. Los `result-*.txt` son
salidas reales guardadas a mano; no los genera ningún script.

---

## Lo que ya se confirmó en vivo (2026-09-07)

Corriendo `recon.js` contra el editor real:

**Es Adobe Campaign Classic (ACC), no Journey Optimizer.** La página es
`experience.adobe.com/thunderbird/solutions/pixel-acrites-ui` y el driver es
`campaign-acc-web-ui/static-assets/acriteDriver.js`. El shell usa **Coral**
(`coral-dialog`, `coral-icon`…), no Spectrum Web Components.

**El canvas está cuatro niveles abajo, y cada nivel en otro dominio:**

```
top                                      experience.adobe.com
└─ Main Content (pixel-acrites-ui)       experience.adobe.com
   └─ Main Content (campaign-acc-web-ui) cdn.experience.adobe.net
      └─ iframe.html                     acrites-ui-iframe.experience.adobe.net  ← el canvas
```

Desde arriba el canvas es **cross-origin** (`.com` vs `.net`) y
`contentDocument` da `null`. No hay truco de JS que lo evite: hay que pararse en
ese frame.

**Adentro del canvas todo es legible**, y el mail está armado por **fragmentos**:
17 divs `contenteditable` con clase `acr-fragment acr-component`, de 294 px de
ancho, con 2 a 7 `<table>` cada uno, ~27 KB de HTML en total. No es un bloque
único.

**Para la extensión esto es una ventaja concreta:** un content script con
`all_frames: true` apuntando a `acrites-ui-iframe.experience.adobe.net` se
inyecta directo en ese documento. Lo que en consola obliga a cambiar el contexto
a mano, en extensión es automático.

---

## Cómo se usa (`acc-email-preview.js`)

**Paso obligatorio antes de pegar: cambiar el contexto de la consola.** El
desplegable está en la segunda fila de la Console, a la izquierda del buscador
*Filter*, y según la versión de Chrome dice `top` o `Main Content (...)`. Hay
que elegir el renglón **sin indentar** que diga `iframe.html` /
`acrites-ui-iframe.experience.adobe.net` — los renglones indentados que dicen
"Extension" son mundos aislados de otras extensiones, no sirven.

Si te olvidás, el script no rompe nada: avisa por consola que no encontró
`.acr-container` y te recuerda cambiar el contexto.

Después pegar el archivo entero. **El panel se abre solo**, acoplado a la
derecha del canvas.

Volver a pegar el script **reemplaza** la instancia anterior: se desmonta sola.
No hace falta recargar la página ni llamar a `destruir()` a mano para probar una
versión nueva.

| Control del panel | Para qué |
| --- | --- |
| **En vivo** | Re-renderiza con cada edición (debounce 400 ms) |
| 700 / 375 | Ancho simulado del mail: escritorio o móvil |
| Ajustar | Escala el mail para que entre en el panel, en vez de scroll horizontal |
| ↻ | Re-renderizar a mano |
| Copiar | El HTML completo al portapapeles |
| ✕ | Cerrar y cortar la sincronización |

El borde izquierdo del panel se arrastra para ensancharlo o angostarlo.

Desde consola:

```js
__accPreview.refrescar()      // re-renderizar
__accPreview.estilos()        // tabla: qué CSS se llevó, qué descartó y por qué
__accPreview.destruir()       // cortar la sincronización y sacar el panel
copy(__accPreview.html())     // copiar el HTML del mail al portapapeles
```

---

## Preview en una pestaña aparte (`acc-preview-pestana.js`)

> ⚠️ **El receptor va en `campaign-acc-web-ui`, NO en `top`.** La pestaña hereda
> la CSP del frame que la abrió, y la de `experience.adobe.com` restringe
> `img-src`: desde ahí el mail se ve pero **con todas las imágenes rotas**.
> Desde `cdn.experience.adobe.net` cargan bien. Verificado en vivo; ver la
> sección 5 bis de [HALLAZGOS.md](HALLAZGOS.md).

### Por qué se pega dos veces

Desde el canvas no se puede abrir ni ventana ni pestaña — para el navegador son
lo mismo, y las dos las bloquea el sandbox:

```
Blocked opening '' in a new window because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set.
```

Pero el sandbox **no** bloquea `postMessage`, y el frame `top`
(`experience.adobe.com`) no está sandboxeado. De ahí el puente:

```
canvas (sandboxeado)            top (sin sandbox)
  extrae el HTML  ──postMessage──►  lo escribe en la pestaña que abrió
  en cada edición
```

**Es un solo archivo.** Detecta solo en qué contexto está y toma el rol que
corresponde, así no hay que acordarse de qué script va en qué lado.

### Los dos pasos

| Orden | Contexto de la consola | Qué pasa |
| --- | --- | --- |
| 1º | **`Main Content (campaign-acc-web-ui)`** | Abre la pestaña y se queda escuchando |
| 2º | **`iframe.html`** | Empieza a mandar el mail en cada edición |

En el desplegable, el primero es el que dice `cdn.experience.adobe.net` abajo.
Arriba en la pestaña aparece un contador de imágenes: **verde = todas cargaron**,
rojo = ese frame no sirve, probá otro.

Pegar **el mismo archivo** en los dos, cambiando solo el desplegable. Si se hace
al revés igual funciona: el receptor pide los datos al arrancar y reintenta cada
3 segundos.

En la pestaña: **Escritorio / Móvil** y **Descargar .html**.

```js
__accTab.abrir()      // receptor: reabrir la pestaña si la cerraste
__accTab.enviar()     // emisor: mandar el mail ahora
__accTab.destruir()   // desmontar el rol de ese contexto
```

### Seguridad del puente

El emisor manda el HTML dirigido **exclusivamente** a `experience.adobe.com`,
nunca con `'*'`, así ningún otro frame de la página puede leerlo. El receptor
descarta cualquier mensaje que no venga de
`acrites-ui-iframe.experience.adobe.net`. El único mensaje que sí va con `'*'`
es el pedido inicial del receptor, que no lleva contenido.

> En la extensión nada de esto hace falta: `chrome.tabs.create` desde el service
> worker no está sujeto al sandbox del frame, y un content script con
> `all_frames: true` ya corre dentro del canvas. El puente existe solo porque
> desde la consola no hay otra manera.

### Cómo extrae

```
document.querySelector('.acr-container')   → el HTML del mail
  + los <style> que pasan el filtro        → el responsive
  − contenteditable, spellcheck, <script>  → marcas de edición
```

La limpieza es mínima a propósito: **no toca clases ni ids**, porque el CSS que
sí se lleva los referencia — el bloque de media queries por id (`#acr-t94e`…)
dejaría de aplicar si se borraran. Las clases `acr-*` que quedan son inocuas,
porque la hoja que las estilaba es justamente una de las descartadas.

### Cómo separa el CSS del mail del CSS del editor

El documento del canvas mezcla los dos. Los del editor se delatan por dos
rasgos, y cualquiera de los dos alcanza para descartarlos:

1. Selectores `.acr-*` / `.acd-*` — canvas, grid, dark mode, plugins.
2. Nombres de CSS Modules con hash (`colorPicker__wrapper___3urhm`) — los
   paneles de la UI.

De lo que queda se conserva lo que defina al menos dos clases que el mail usa de
verdad, o lo que traiga `@media` (por ahí entra el responsive por id, que no
define clases pero sí afecta al mail). Se deduplica por contenido exacto: el
editor emite el bloque responsive dos veces, idéntico byte a byte.

Medido en vivo, de 20 `<style>` se lleva 5 (~10 KB): el reset de clientes de
correo (`.ReadMsgBody`, `.ExternalClass`, `.yshortcuts`), dos bloques
`mobile-*`, uno de `.structure__table`/`.colspan1` y el de media queries por id.
Las 13 hojas externas son todas del editor (`acd-plugin-*`, `appIframe`) y no
van. `__accPreview.estilos()` muestra la clasificación completa.

---

## Privacidad

Los tres `recon` reportan **estructura, no contenido**: borran los nodos de texto
y todos los atributos salvo `class` e `id`, cuentan atributos `style` sin leer
sus valores, de las hojas de estilo reportan largo y URL pero no el CSS, de los
campos de texto solo el largo, y a los `src` les cortan el query string. No
salen el texto del mailing, URLs de imágenes, `alt` ni datos de clientes.

Aun así conviene revisar el output antes de compartirlo: **el repo es público**.

---

## Lo obsoleto

`ajo-email-preview.js` y `banco-de-pruebas.html` se escribieron **antes** de los
reconocimientos, asumiendo Journey Optimizer con el canvas en un iframe legible:
el script busca iframes y los puntúa por heurística, y la maqueta imita esa
estructura. En ACC nada de eso aplica. Quedan solo como registro; **no usarlos**.

---

## Limitaciones conocidas

- **El render de la preview todavía no se vio funcionar.** De lo que hay,
  corrieron en vivo los tres `recon` y la detección de `.acr-container` (el
  script imprime "Activo" solo si la encuentra). El panel y el render en sí
  pasaron `node --check` y nada más.
- **El frame está sandboxeado**, y eso puede afectar más cosas además de
  `window.open`: la Clipboard API puede estar bloqueada (hay fallback a
  `execCommand`, y si tampoco va queda `copy(__accPreview.html())` desde la
  consola) y las descargas de archivo probablemente también, por eso no hay
  botón de descargar.
- **El mail se renderiza en un `<iframe srcdoc>` dentro del frame sandboxeado**,
  así que hereda su sandbox. Para HTML y CSS estáticos no es problema, pero si
  el mail dependiera de algo más podría verse distinto.
- **Imágenes con ruta relativa.** Se agrega un `<base href>` apuntando al
  documento del canvas para que sigan resolviendo, pero si el editor las sirve
  desde un origen con restricciones de referrer podrían no cargar.
- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía al
  final: los tokens de personalización vienen resueltos o vacíos, y no incluye
  lo que agregue el servidor al enviar.
