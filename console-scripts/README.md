# Scripts de consola

Pruebas de concepto que se **pegan en la consola de DevTools**, sin instalar nada.

Existen porque en las laptops del banco donde está Adobe no se pueden instalar
extensiones, pero sí se puede ejecutar JS en la consola. La idea es demostrar
que la funcionalidad anda; con esa demo en la mano se pide la aprobación de la
extensión, y después el script se porta a una pestaña más del popup.

Ninguno usa APIs `chrome.*` — son JS de página, igual que `inject.js` en el
mundo MAIN. Eso es justamente lo que los hace portables en las dos direcciones.

---

## `ajo-email-preview.js` — preview externo del mailing

**Qué hace:** detecta el canvas del mailing que estás editando en el Adobe Email
Designer y abre una segunda ventana con la previsualización, que se actualiza
sola mientras editás.

### Cómo se usa

1. Abrí el mailing en el Email Designer.
2. DevTools (`F12` o `Cmd+Opt+I`) → pestaña **Console**.
3. Pegá el archivo entero → Enter.
   - La primera vez Chrome/Edge pide escribir **`allow pasting`** antes de dejarte pegar.
4. Aparece un panel abajo a la derecha → botón **Abrir preview**.

### El panel

| Control | Para qué |
| --- | --- |
| Estado (verde/rojo) | Si detectó el canvas y con qué puntaje |
| Desplegable | Elegir otro candidato a mano si eligió mal |
| Abrir preview | Abre la ventana con el mailing |
| Re-escanear | Volver a buscar (útil si cambiaste de mail sin recargar) |
| Diagnóstico | Vuelca a consola todo lo que encontró |
| Sincronizar mientras edito | Refresca la preview con cada edición (debounce 400 ms) |

En la ventana de preview: **Escritorio / Móvil** (700 px / 375 px), **Refrescar**,
**Copiar HTML** y **Descargar .html**.

### API en consola

```js
__ajoEmailPreview.diagnostico()  // qué iframes vio y por qué eligió el que eligió
__ajoEmailPreview.escanear()     // re-detectar
__ajoEmailPreview.refrescar()    // re-renderizar la preview
__ajoEmailPreview.destruir()     // sacar todo de la página
```

---

## Cómo está hecha la detección (y por qué así)

No hay un selector estable y documentado para el canvas del Email Designer, y
los nombres de clase de Adobe cambian entre releases. Así que el script **no
adivina un selector**: puntúa candidatos por rasgos que un email siempre tiene y
el chrome del editor no.

Recorre el árbol atravesando **shadow roots** (la UI de Adobe Experience Cloud
está hecha con Spectrum Web Components, así que un `querySelectorAll` sobre
`document` no ve el iframe del canvas) y baja a los **iframes anidados** que
sean same-origin. Después puntúa: volumen de HTML, cantidad de `<table>`/`<td>`
(los mails son tablas de maquetación), imágenes, y si el iframe es grande y
visible. Resta si el id/clase/título huele a `toolbar`, `nav`, `panel`, `icon`.

**Esto está verificado contra la maqueta local, no contra Adobe.** Es una
heurística: puede elegir mal en el editor real. Para eso está el desplegable
(elegís a mano) y el diagnóstico (me lo pasás y ajusto el puntaje).

---

## Flujo de trabajo cuando no se puede probar contra Adobe

Si estás en una máquina sin acceso al Email Designer:

1. **Acá (máquina personal):** abrí `banco-de-pruebas.html` en el navegador y
   pegá el script. Sirve para confirmar que la mecánica anda — traversal de
   shadow DOM, puntaje, render en la ventana, sincronización en vivo. La maqueta
   no pide nada a la red (la imagen es un `data:` URI), así que funciona con
   todo bloqueado.
2. **En la laptop del banco:** pegá el script en el Email Designer real y corré:
   ```js
   __ajoEmailPreview.diagnostico()
   copy(__ajoEmailPreviewDump)
   ```
   Eso deja en el portapapeles un JSON con los iframes que encontró, sus
   tamaños, ids, clases y cuáles quedaron bloqueados por same-origin. Con eso se
   ajusta el puntaje sin necesidad de tener acceso al editor.

### `banco-de-pruebas.html`

Maqueta local que reproduce las tres cosas que hacen difícil la detección:
el canvas es un iframe, vive dentro de un shadow root, y compite con otros
iframes de chrome del editor que no deben ganar. **No es Adobe** — valida la
mecánica, no los selectores reales.

---

## Limitaciones conocidas

- **Iframes cross-origin.** Si el canvas está en un iframe de otro origen, no se
  puede leer desde el frame principal: es la same-origin policy del navegador, no
  un bug del script. Se resuelve cambiando el selector de contexto de la consola
  (el desplegable que dice `top`, arriba a la izquierda) al frame del editor y
  volviendo a pegar el script. El panel avisa cuando detecta este caso.
- **CSP de `experience.adobe.com`.** La preview se arma en una ventana
  `about:blank`, que hereda la CSP de la página que la abrió. Si Adobe tiene una
  CSP restrictiva sobre estilos inline, el mail podría verse sin estilos. Para
  ese caso está **Descargar .html**: el archivo abierto desde el disco no tiene
  ninguna CSP encima. **Sin acceso al editor real no se pudo comprobar si esto
  llega a pasar** — si el mail sale sin estilos, es esto.
- **Bloqueador de popups.** La ventana se abre desde un click del panel, así que
  hay gesto de usuario y no debería bloquearse. Si igual pasa, el panel lo avisa
  en rojo.
- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía
  finalmente: los tokens de personalización ya vienen resueltos o vacíos, y no
  incluye lo que agregue el servidor al enviar.
