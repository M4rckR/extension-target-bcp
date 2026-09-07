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

## Qué hay acá

| Archivo | Qué es | Cuándo se usa |
| --- | --- | --- |
| `recon.js` | Reconocimiento de solo lectura del DOM | **Primero**, para mapear la página |
| `ajo-email-preview.js` | La funcionalidad: preview del mailing en otra ventana | Después, ya sabiendo dónde está el canvas |
| `banco-de-pruebas.html` | Maqueta local que imita al editor | Para probar sin acceso a Adobe |

---

## El objetivo: preview del mailing

Detectar el canvas del mailing que se está editando en el **Adobe Email
Designer** y abrir una **segunda ventana con la previsualización**, que se
actualiza sola mientras se edita.

El problema de fondo: **Adobe no publica un selector estable para el canvas**, y
los nombres de clase cambian entre releases. Además la UI está hecha con
Spectrum Web Components, así que buena parte del árbol vive dentro de **shadow
roots** — un `querySelectorAll` sobre `document` no ve el iframe del canvas.

Por eso el orden de trabajo es: reconocer primero, construir después.

---

## Orden de uso

### Paso 1 — Reconocer el DOM (`recon.js`)

Con el mailing abierto en el editor, pegar `recon.js` en la consola y después:

```js
copy(__recon)
```

Deja en el portapapeles un JSON con el inventario de iframes (id, clase, título,
tamaño, si son legibles o cross-origin, cuántas tablas e imágenes tienen), los
contenedores `contenteditable`, y los custom elements de la página.

**No modifica nada**: no escribe en el DOM, no hace pedidos de red, no abre
ventanas.

**Reporta estructura, no contenido.** El esqueleto que genera borra todos los
nodos de texto y todos los atributos salvo `class` e `id`, y le corta el query
string a los `src`. O sea: no salen el texto del mailing, ni URLs de imágenes,
ni `alt`, ni datos de clientes. Aun así conviene revisar el output antes de
compartirlo.

### Paso 2 — Probar la preview (`ajo-email-preview.js`)

Pegar en la consola con el mailing abierto. Aparece un panel abajo a la derecha.

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
__ajoEmailPreview.diagnostico()  // qué iframes vio y por qué eligió el que eligió
__ajoEmailPreview.escanear()     // re-detectar
__ajoEmailPreview.refrescar()    // re-renderizar
__ajoEmailPreview.destruir()     // sacar todo de la página
```

**Cómo detecta el canvas hoy:** como no hay selector confiable, no adivina uno —
recorre shadow roots e iframes anidados same-origin y **puntúa** candidatos por
rasgos que un email siempre tiene y el chrome del editor no: volumen de HTML,
cantidad de `<table>`/`<td>`, imágenes, y si el iframe es grande y visible. Resta
si el id/clase/título huele a `toolbar`, `nav`, `panel`, `icon`.

Es una heurística provisoria: **la idea es reemplazarla por un selector directo**
en cuanto el `recon.js` diga cuál es el iframe correcto.

---

## Cuando no se puede probar contra Adobe

`banco-de-pruebas.html` es una maqueta local que reproduce las tres cosas que
hacen difícil la detección: el canvas es un iframe, vive dentro de un shadow
root, y compite con otros iframes de chrome del editor que no deben ganar el
puntaje.

Se abre en el navegador y se le pega el script encima. No pide nada a la red (la
imagen es un `data:` URI), así que anda en una máquina con todo bloqueado.

**No es Adobe:** valida la mecánica — traversal de shadow DOM, puntaje, render
en la ventana, sincronización en vivo — **no** los selectores reales. Que ande
acá no garantiza que ande en el editor.

---

## Limitaciones conocidas

- **Iframes cross-origin.** Si el canvas está en un iframe de otro origen no se
  puede leer desde el frame principal: es la same-origin policy del navegador, no
  un bug. Se resuelve cambiando el selector de contexto de la consola (el
  desplegable que dice `top`, arriba a la izquierda) al frame del editor y
  volviendo a pegar el script. El panel avisa cuando detecta este caso.
- **CSP de `experience.adobe.com`.** La preview se arma en una ventana
  `about:blank`, que hereda la CSP de la página que la abrió. Si Adobe tiene una
  CSP restrictiva sobre estilos inline, el mail podría verse sin estilos — para
  ese caso está **Descargar .html**, que abierto desde el disco no tiene ninguna
  CSP encima. **Sin acceso al editor real no se pudo comprobar si pasa.**
- **Bloqueador de popups.** La ventana se abre desde un click del panel, así que
  hay gesto de usuario y no debería bloquearse. Si igual pasa, el panel lo avisa.
- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía al
  final: los tokens de personalización ya vienen resueltos o vacíos, y no incluye
  lo que agregue el servidor al enviar.
- **Nada de esto está verificado contra el Email Designer real.** Los scripts
  pasaron `node --check` y la maqueta local, nada más.
