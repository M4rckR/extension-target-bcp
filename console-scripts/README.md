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
| **`acc-email-preview.js`** | **La funcionalidad: preview del mail en otra ventana** | **Es el que se usa** |
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

Después pegar el archivo entero. **La ventana de preview se abre sola** —
`window.open` desde una evaluación de consola cuenta como gesto de usuario, así
que el bloqueador de popups no la corta.

No inyecta ningún panel en la página: todos los controles viven en la ventana de
preview, para no meter nodos dentro de la superficie de edición del mail.

| Control de la ventana | Para qué |
| --- | --- |
| **En vivo** | Re-renderiza con cada edición (debounce 400 ms) |
| Escritorio / Móvil | 700 px / 375 px |
| Refrescar | Re-renderizar a mano |
| Copiar HTML | El HTML completo al portapapeles |
| Descargar .html | Bajarlo como archivo |

Desde consola:

```js
__accPreview.abrir()      // reabrir o reenfocar la ventana
__accPreview.refrescar()  // re-renderizar
__accPreview.estilos()    // tabla: qué CSS se llevó, qué descartó y por qué
__accPreview.destruir()   // cortar la sincronización y cerrar
```

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

- **`acc-email-preview.js` todavía no se probó contra el editor real.** Pasó
  `node --check` y está construido sobre tres reconocimientos hechos en vivo,
  pero el render de la preview en sí no se vio funcionar nunca.
- **CSP de Adobe.** La preview se arma en una ventana `about:blank`, que hereda
  la CSP de la página que la abrió. Si Adobe restringe estilos inline, el mail
  podría verse sin estilos — para eso está **Descargar .html**, que abierto
  desde el disco no tiene CSP encima. Sin probar todavía.
- **Bloqueador de popups.** La ventana se abre desde la evaluación de consola,
  que cuenta como gesto de usuario. Si igual se bloqueara, queda
  `__accPreview.abrir()`.
- **Imágenes con ruta relativa.** Se agrega un `<base href>` apuntando al
  documento del canvas para que sigan resolviendo, pero si el editor las sirve
  desde un origen con restricciones de referrer podrían no cargar en la preview.
- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía al
  final: los tokens de personalización vienen resueltos o vacíos, y no incluye
  lo que agregue el servidor al enviar.
