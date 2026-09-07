# `console-scripts/` — preview del mailing de Adobe Campaign Classic

Muestra el mail que se está editando en ACC, **renderizado y sincronizado en
vivo**, con un selector para alternar entre los escenarios del contenido
condicional.

Son scripts que se **pegan en la consola de DevTools**: en las laptops del banco
donde está Adobe no se pueden instalar extensiones, pero sí ejecutar JavaScript
en la consola. Con la demo andando se pide la aprobación para instalar la
extensión, y recién después se porta a una pestaña del popup.

Ninguno usa APIs `chrome.*` — son JS de página, igual que `inject.js` en el
mundo MAIN. Eso es lo que los hace portables en las dos direcciones.

> **Estado: funciona, verificado en vivo el 2026-09-07.** Nada de esta carpeta
> está integrado a la extensión todavía. Vive en la rama
> `experimental/adobe-email-designer`.

📄 **[HALLAZGOS.md](HALLAZGOS.md)** — bitácora técnica de todo lo que se averiguó
del editor. **Empezá por ahí si retomás esto después de un tiempo**: casi todo es
contraintuitivo y costó cuatro rondas de reconocimiento averiguarlo.

---

## Estructura

```
console-scripts/
├── README.md              este archivo — cómo se usa
├── HALLAZGOS.md           bitácora técnica — por qué funciona así
├── preview/               ← lo que se usa
│   ├── acc-email-preview.js     panel dentro del canvas (1 pegado)
│   └── acc-preview-pestana.js   pestaña aparte (2 pegados)
├── recon/                 diagnóstico, ya cumplieron su función
│   ├── recon.js                 ubicó el canvas entre los frames
│   ├── recon-fragmentos.js      encontró .acr-container y los estilos inline
│   ├── recon-estilos.js         separó el CSS del mail del CSS del editor
│   └── recon-condicionales.js   mapeó los bloques condicionales
├── muestras/
│   └── fuente-adobe.html        volcado real del canvas (85 KB)
└── obsoleto/                    no usar — apuntaban a Journey Optimizer
    ├── ajo-email-preview.js
    └── banco-de-pruebas.html
```

Los `recon/` quedan versionados para poder rehacer el diagnóstico rápido si
Adobe cambia el editor en un release, en vez de volver a adivinar selectores.

---

## Uso: panel dentro del canvas — `preview/acc-email-preview.js`

**Es la vía recomendada.** Un solo pegado.

**Paso obligatorio antes de pegar: cambiar el contexto de la consola.** El
desplegable está en la segunda fila de la Console, a la izquierda del buscador
*Filter*, y según la versión de Chrome dice `top` o `Main Content (...)`. Hay que
elegir el renglón **sin indentar** que diga `iframe.html` /
`acrites-ui-iframe.experience.adobe.net`. Los renglones indentados que dicen
"Extension" son mundos aislados de otras extensiones, no sirven.

Si te olvidás, el script no rompe nada: avisa por consola que no encontró
`.acr-container` y te recuerda cambiar el contexto.

Después pegar el archivo entero. **El panel se abre solo**, acoplado a la derecha
del canvas. Volver a pegarlo reemplaza la instancia anterior — no hace falta
recargar la página para probar una versión nueva.

| Control | Para qué |
| --- | --- |
| **En vivo** | Re-renderiza con cada edición (debounce 400 ms) |
| 700 / 375 | Ancho simulado del mail: escritorio o móvil |
| Ajustar | Escala el mail para que entre en el panel |
| Variantes | Muestra u oculta los selectores de escenario |
| ↻ · Copiar · ✕ | Refrescar, copiar el HTML, cerrar |

El borde izquierdo del panel se arrastra para redimensionarlo.

```js
__accPreview.refrescar()      // re-renderizar
__accPreview.estilos()        // qué CSS se llevó, qué descartó y por qué
__accPreview.variantes()      // bloques condicionales y cuál queda elegido
__accPreview.destruir()       // cortar la sincronización y sacar el panel
copy(__accPreview.html())     // copiar el HTML al portapapeles
```

---

## Uso: pestaña aparte — `preview/acc-preview-pestana.js`

> ⚠️ **El receptor va en `campaign-acc-web-ui`, NO en `top`.** La pestaña hereda
> la CSP del frame que la abrió, y la de `experience.adobe.com` restringe
> `img-src`: desde ahí el mail se ve pero **con todas las imágenes rotas**. Desde
> `cdn.experience.adobe.net` cargan bien.

**Es un solo archivo que se pega dos veces**, cambiando solo el desplegable. El
archivo detecta en qué contexto está y toma el rol que corresponde.

| Orden | Contexto de la consola | Qué pasa |
| --- | --- | --- |
| 1º | **`Main Content (campaign-acc-web-ui)`** | Abre la pestaña y se queda escuchando |
| 2º | **`iframe.html`** | Empieza a mandar el mail en cada edición |

En el desplegable, el primero es el que dice `cdn.experience.adobe.net` abajo.
Arriba en la pestaña hay un contador de imágenes: **verde = todas cargaron**,
rojo = ese frame no sirve.

Si se hace al revés igual funciona: el receptor pide los datos al arrancar y
reintenta cada 3 segundos.

En la pestaña: **Escritorio / Móvil**, **Descargar .html** y los selectores de
escenario. El archivo que baja **Descargar** es el escenario que estás viendo, no
el mail con todas las ramas apiladas.

```js
__accTab.abrir()      // receptor: reabrir la pestaña si la cerraste
__accTab.enviar()     // emisor: mandar el mail ahora
__accTab.destruir()   // desmontar el rol de ese contexto
```

### Por qué dos pegados

Desde el canvas no se puede abrir ni ventana ni pestaña — para el navegador son
lo mismo, y las dos las bloquea el sandbox:

```
Blocked opening '' in a new window because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set.
```

Pero el sandbox **no** bloquea `postMessage`, y los frames de arriba no están
sandboxeados. De ahí el puente:

```
canvas (sandboxeado)          frame de arriba (sin sandbox)
  extrae el HTML  ──postMessage──►  lo escribe en la pestaña que abrió
  en cada edición
```

**Seguridad:** el emisor responde únicamente a quien le pidió, dirigido a su
origen exacto y nunca con `'*'`, y solo si ese origen es un dominio de Adobe. El
receptor descarta cualquier mensaje que no venga de
`acrites-ui-iframe.experience.adobe.net`. El único mensaje con `'*'` es el pedido
inicial, que no lleva contenido.

---

## Contenido condicional: alternar entre escenarios

El mail tiene bloques que cambian según variables del perfil — header y footer
distintos por segmento. **El editor deja todas las ramas en el DOM**, así que si
no se podan se ven apiladas (dos headers, dos footers).

Los dos scripts dejan una sola por grupo, con dos niveles de control:

- **Escenario** — un control por variable de condición. Elegir
  `CODSUBSEGMENTO = M1N` resuelve de una vez el header, el footer y todo lo que
  dependa de ella.
- **Bloques** — un control por grupo: `auto`, cada rama por su nombre, `todas`
  (para comparar) u `ocultar`.

Los nombres de escenario (`M1N · Consumo`, `X1N · Bex`) **se deducen de las
etiquetas del mail**, no están hardcodeados: el editor las escribe como
`"Header - Consumo"` y el tramo tras el guion nombra el valor. Sigue andando con
otros mails y otras variables.

Solo se parsean comparaciones simples `algo == 'valor'`. Lo que use `&&`, `||` o
algo más raro queda marcado como no evaluable y se resuelve con el selector del
bloque. `__accPreview.variantes()` muestra la tabla.

---

## Cómo extrae el mail

```
document.querySelector('.acr-container')   → el HTML del mail (outerHTML)
  + 5 de los 20 <style>                    → el responsive
  + el fondo computado del canvas          → el marco exterior
  − contenteditable, spellcheck, <script>  → marcas de edición
  − las ramas condicionales no elegidas    → deja una por grupo
```

**No toca clases ni ids** a propósito: el CSS que sí se lleva los referencia —
hay un bloque de media queries por id (`#acr-t94e`) que dejaría de aplicar.

Para la regla que separa el CSS del mail del CSS del editor, y por qué se
conserva el envoltorio exterior, ver [HALLAZGOS.md](HALLAZGOS.md) secciones 4 y
4 bis.

---

## Limitaciones conocidas

- **Sesiones largas de edición** — no se probó cómo aguanta la sincronización
  después de un rato largo editando.
- **Otros tipos de delivery** — `.acr-container` se verificó con los mails que
  había a mano; no se sabe si aplica a todos.
- **El portapapeles bajo sandbox** — hay fallback a `execCommand` y, si tampoco
  va, `copy(__accPreview.html())` desde la consola.
- El HTML extraído es **lo que renderiza el editor**, no lo que Adobe envía al
  final: los tokens de personalización vienen resueltos o vacíos, y no incluye lo
  que agregue el servidor al enviar.
- **Todo depende de detalles internos de ACC** (`.acr-container`, los prefijos
  `.acr-`/`.acd-`, la cadena de frames). Adobe puede cambiarlos en cualquier
  release; para eso están los `recon/`.

---

## Privacidad

Los `recon/` reportan **estructura, no contenido**: borran los nodos de texto y
los atributos salvo `class` e `id`, cuentan atributos `style` sin leer sus
valores, y de las hojas reportan largo y URL pero no el CSS. La excepción es
`recon-condicionales.js`, que sí muestra las condiciones porque son justamente lo
que está diagnosticando.

⚠️ **`muestras/fuente-adobe.html` es contenido real de un mailing del banco, y
este repo es público.** Sirve como fixture para probar los scripts sin acceso a
Adobe, pero conviene decidir si tiene que estar acá o si el repo debería pasar a
privado.
