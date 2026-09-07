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

| Archivo | Qué es | Cuándo se usa |
| --- | --- | --- |
| `recon.js` | Reconocimiento del DOM, solo lectura | **Paso 1** — ubicar el canvas |
| `recon-fragmentos.js` | Segundo reconocimiento: contenedor y estilos | **Paso 2** — ya dentro del canvas |
| `ajo-email-preview.js` | La funcionalidad: preview en otra ventana | Paso 3 — cuando se sepa dónde extraer |
| `banco-de-pruebas.html` | Maqueta local que imita un editor | Para probar sin acceso a Adobe |

Los `result-recon*.txt` son salidas reales guardadas a mano; no los genera
ningún script.

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

## Orden de uso

### Paso 1 — Ubicar el canvas (`recon.js`)

Con el mail abierto en el editor, pegar en la consola y después `copy(__recon)`.

Devuelve el inventario de iframes (id, clase, título, tamaño, si son legibles o
cross-origin, cuántas tablas e imágenes tienen), los contenedores
`contenteditable` y los custom elements.

### Paso 2 — Ubicar el contenedor y los estilos (`recon-fragmentos.js`)

**Antes de pegarlo hay que cambiar el contexto de la consola.** El desplegable
está en la segunda fila de la Console, a la izquierda del buscador *Filter*, y
según la versión de Chrome dice `top` o `Main Content (...)`. Hay que elegir el
renglón **sin indentar** que diga `iframe.html` /
`acrites-ui-iframe.experience.adobe.net` — los renglones indentados que dicen
"Extension" son mundos aislados de otras extensiones, no sirven.

Después pegar y `copy(__recon3)`. Contesta las dos preguntas que definen si la
preview es viable:

1. **¿Cuál es el contenedor** que envuelve a los 17 fragmentos? Es lo que hay
   que clonar; los fragmentos sueltos no alcanzan.
2. **¿Los estilos son inline o del editor?** Si el mail trae sus estilos en
   atributos `style`, la preview sale fiel. Si dependen de la hoja CSS del
   editor, al sacar el HTML afuera se ve sin estilos y hay que buscar el HTML
   fuente en otro lado — por eso también revisa textareas e inputs ocultos
   grandes, donde las apps suelen guardar el HTML crudo.

### Paso 3 — La preview (`ajo-email-preview.js`)

Pegar en la consola con el mail abierto. Aparece un panel abajo a la derecha.

| Control del panel | Para qué |
| --- | --- |
| Estado (verde/rojo) | Si detectó el canvas y con qué puntaje |
| Desplegable | Elegir otro candidato a mano si eligió mal |
| **Abrir preview** | Abre la ventana con el mailing |
| Re-escanear | Volver a buscar (si cambiaste de mail sin recargar) |
| Diagnóstico | Vuelca a consola todo lo que encontró |
| Sincronizar mientras edito | Refresca con cada edición (debounce 400 ms) |

En la ventana de preview: **Escritorio / Móvil** (700 px / 375 px),
**Refrescar**, **Copiar HTML** y **Descargar .html**.

Desde consola:

```js
__ajoEmailPreview.diagnostico()  // qué vio y por qué eligió lo que eligió
__ajoEmailPreview.escanear()     // re-detectar
__ajoEmailPreview.refrescar()    // re-renderizar
__ajoEmailPreview.destruir()     // sacar todo de la página
```

> ⚠️ **Este script todavía apunta al editor equivocado.** Fue escrito antes de
> los reconocimientos, asumiendo Journey Optimizer con el canvas en un iframe
> legible: busca iframes y los puntúa por heurística. En ACC el canvas no es un
> iframe sino los fragmentos de este documento, así que **no va a detectar
> nada**. Queda tal cual a propósito, para reescribir la detección de una sola
> vez cuando estén los resultados del paso 2.

---

## Privacidad

Los dos `recon` reportan **estructura, no contenido**: borran los nodos de texto
y todos los atributos salvo `class` e `id`, cuentan atributos `style` sin leer
sus valores, de las hojas de estilo reportan largo y URL pero no el CSS, de los
campos de texto solo el largo, y a los `src` les cortan el query string. No
salen el texto del mailing, URLs de imágenes, `alt` ni datos de clientes.

Aun así conviene revisar el output antes de compartirlo: **el repo es público**.

---

## Probar sin acceso a Adobe

`banco-de-pruebas.html` es una maqueta local que imita un editor: canvas en un
iframe, dentro de un shadow root, rodeado de otros iframes que compiten. Se abre
en el navegador y se le pega el script encima. No pide nada a la red (la imagen
es un `data:` URI), así que anda en una máquina con todo bloqueado.

**No es Adobe, y encima imita la estructura equivocada** — la escribí asumiendo
Journey Optimizer. Sirve para validar mecánica general (traversal, render en la
ventana, sincronización), no el caso real de ACC.

---

## Limitaciones conocidas

- **Nada está verificado contra el editor real todavía.** Los scripts pasaron
  `node --check`; los `recon` además corrieron en vivo, `ajo-email-preview.js`
  no.
- **CSP de Adobe.** La preview se arma en una ventana `about:blank`, que hereda
  la CSP de la página que la abrió. Si Adobe restringe estilos inline, el mail
  podría verse sin estilos — para eso está **Descargar .html**, que abierto
  desde el disco no tiene CSP encima. Sin probar todavía.
- **Bloqueador de popups.** La ventana se abre desde un click del panel, así que
  hay gesto de usuario y no debería bloquearse. Si igual pasa, el panel avisa.
- El HTML extraído sería **lo que renderiza el editor**, no lo que Adobe envía
  al final: los tokens de personalización vienen resueltos o vacíos, y no
  incluye lo que agregue el servidor al enviar.
