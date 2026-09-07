/**
 * Adobe Campaign Classic — Preview externa del mailing
 * ----------------------------------------------------
 * Abre una segunda ventana con la previsualización del mail que se está
 * editando, sincronizada en vivo mientras se edita.
 *
 * Reemplaza a `ajo-email-preview.js`, que apuntaba a Journey Optimizer y
 * buscaba el canvas por heurística entre iframes. Los tres reconocimientos
 * (`recon.js`, `recon-fragmentos.js`, `recon-estilos.js`) mostraron que en ACC
 * no hace falta adivinar nada:
 *
 *   - El canvas es el documento del iframe `acrites-ui-iframe`, no un iframe
 *     anidado dentro de él.
 *   - El mail entero vive en `div.acr-container`, hijo directo de <body>
 *     (85 191 de los 85 304 caracteres del documento).
 *   - El HTML del DOM es el HTML del mail: ~40% de los elementos traen estilos
 *     inline y las clases son de email (`mobile-full`, `table-radius`).
 *   - El CSS responsive NO está en el contenedor: vive en <style> sueltos del
 *     documento, mezclado con el del editor. Ver `estilosDelMail()`.
 *
 * IMPORTANTE: se pega en la consola con el contexto puesto en
 * `iframe.html` / `acrites-ui-iframe.experience.adobe.net`, no en `top`.
 * El desplegable está en la segunda fila de la Console, a la izquierda del
 * buscador Filter.
 *
 * A diferencia de la versión anterior no inyecta ningún panel en la página:
 * todos los controles viven en la ventana de preview, para no meter nodos
 * dentro de la superficie de edición del mail.
 *
 * API en window.__accPreview:
 *   .abrir()      abre (o reenfoca) la ventana de preview
 *   .refrescar()  re-renderiza a mano
 *   .estilos()    qué <style> se llevó y cuáles descartó, y por qué
 *   .destruir()   corta la sincronización y cierra la ventana
 */
(() => {
  "use strict";

  const NS = "__accPreview";

  // ── 0. Guard de idempotencia ───────────────────────────────────────────────
  if (window[NS]) {
    window[NS].abrir();
    console.log("[ACC Preview] Ya estaba activo — ventana reenfocada.");
    return;
  }

  const SEL_CONTENEDOR = ".acr-container";
  const ANCHOS = { escritorio: 700, movil: 375 };

  const estado = {
    ventana: null,
    observer: null,
    timerSync: null,
    timerSalud: null,
    autoSync: true,
    ancho: ANCHOS.escritorio,
  };

  const contenedor = () => document.querySelector(SEL_CONTENEDOR);

  // ── 1. Qué <style> son del mail y cuáles del editor ────────────────────────
  // El documento del canvas mezcla las dos cosas. Los del editor se delatan por
  // dos rasgos, cualquiera de los dos alcanza para descartarlos:
  //
  //   a) Selectores .acr-* / .acd-*  → canvas, grid, dark mode, plugins.
  //   b) Nombres de CSS Modules con hash (colorPicker__wrapper___3urhm) →
  //      los paneles de la UI del editor.
  //
  // De lo que queda, se conserva lo que defina clases que el mail realmente usa
  // o lo que traiga media queries (el responsive por id, `#acr-t94e`, entra por
  // esta segunda vía: no define clases pero sí afecta al mail).
  //
  // Se deduplica por contenido exacto: el editor emite el bloque responsive dos
  // veces, idéntico byte a byte.
  const RE_EDITOR = /\.acr-|\.acd-/;
  const RE_MODULO_CSS = /___[A-Za-z0-9_-]{4,}/;

  /** Clases que el mail usa de verdad, ignorando las marcas del editor. */
  function clasesDelMail() {
    const cont = contenedor();
    const usadas = new Set();
    if (!cont) return usadas;
    for (const el of cont.querySelectorAll("*")) {
      const cn = el.className;
      if (cn && cn.split) {
        for (const k of cn.split(/\s+/)) if (k && !k.startsWith("acr-")) usadas.add(k);
      }
    }
    return usadas;
  }

  /** Clasifica cada <style> del documento. `llevar: true` = va a la preview. */
  function clasificarEstilos() {
    const usadas = clasesDelMail();
    const vistos = new Set();

    return [...document.querySelectorAll("style")].map((s, i) => {
      const t = s.textContent || "";
      let hits = 0;
      for (const c of usadas) if (t.includes("." + c)) hits++;
      const media = /@media/.test(t);

      let motivo;
      if (!t) motivo = "vacío";
      else if (RE_EDITOR.test(t)) motivo = "editor (.acr-/.acd-)";
      else if (RE_MODULO_CSS.test(t)) motivo = "editor (CSS module)";
      else if (hits < 2 && !media) motivo = "no aporta al mail";
      else if (vistos.has(t)) motivo = "duplicado exacto";
      else motivo = null;

      if (!motivo) vistos.add(t);

      return { i, len: t.length, clasesDelMail: hits, media, llevar: !motivo, motivo, css: t };
    });
  }

  const estilosDelMail = () =>
    clasificarEstilos()
      .filter((e) => e.llevar)
      .map((e) => e.css);

  // ── 2. Extracción del HTML ─────────────────────────────────────────────────
  // Limpieza deliberadamente mínima: se sacan las marcas de edición
  // (contenteditable, spellcheck) y los <script>, y nada más. NO se tocan
  // clases ni ids: el CSS que sí nos llevamos los referencia — el bloque de
  // media queries por id (#acr-t94e…) dejaría de aplicar si los borráramos.
  // Las clases acr-* que quedan son inocuas porque la hoja que las estilaba es
  // justamente una de las que se descarta.
  function extraer() {
    const cont = contenedor();
    if (!cont) return null;

    let copia;
    try {
      copia = cont.cloneNode(true);
    } catch (e) {
      return null;
    }

    for (const el of copia.querySelectorAll("[contenteditable]")) el.removeAttribute("contenteditable");
    for (const el of copia.querySelectorAll("[spellcheck]")) el.removeAttribute("spellcheck");
    for (const el of copia.querySelectorAll("script")) el.remove();

    // <base> para que las imágenes con ruta relativa sigan resolviendo.
    const base = String(document.baseURI || location.href).replace(/"/g, "&quot;");
    const css = estilosDelMail().join("\n\n");

    return (
      "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n" +
      '<base href="' + base + '">\n' +
      "<style>\n" + css + "\n</style>\n" +
      "</head>\n<body style=\"margin:0\">\n" + copia.innerHTML + "\n</body>\n</html>"
    );
  }

  // ── 3. Ventana de preview ──────────────────────────────────────────────────
  // El mail se renderiza dentro de un <iframe srcdoc> y no directo en el body
  // de la ventana, para que su CSS (que incluye reglas sobre `body`) no se
  // mezcle con el de la barra de herramientas.
  const SHELL = `<head>
<meta charset="utf-8">
<title>Preview del mailing — ACC</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f1f5f9; color:#1e293b; display:flex; flex-direction:column; height:100vh; }
  .barra { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1e293b; color:#fff; flex:none; }
  .barra__titulo { font-weight:600; margin-right:auto; font-size:12px; }
  .barra button { font:inherit; font-size:12px; padding:5px 10px; border:0; border-radius:5px;
                  background:#475569; color:#fff; cursor:pointer; }
  .barra button:hover { background:#64748b; }
  .barra button[data-activo="si"] { background:#4f46e5; }
  .barra label { font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer; }
  .barra__estado { font-size:11px; opacity:.75; }
  .lienzo { flex:1; overflow:auto; display:flex; justify-content:center; padding:16px; }
  iframe { background:#fff; border:1px solid #cbd5e1; border-radius:4px; height:100%;
           box-shadow:0 1px 4px rgba(0,0,0,.08); }
</style>
</head>
<body>
  <div class="barra">
    <span class="barra__titulo">Preview del mailing</span>
    <span class="barra__estado" id="estado"></span>
    <label><input type="checkbox" id="auto" checked> En vivo</label>
    <button id="escritorio" data-activo="si">Escritorio</button>
    <button id="movil">Móvil</button>
    <button id="refrescar">Refrescar</button>
    <button id="copiar">Copiar HTML</button>
    <button id="descargar">Descargar .html</button>
  </div>
  <div class="lienzo"><iframe id="vista" width="700"></iframe></div>
</body>`;

  function abrir() {
    if (estado.ventana && !estado.ventana.closed) {
      estado.ventana.focus();
      refrescar();
      return true;
    }

    const w = window.open("", "acc-email-preview", "width=840,height=940");
    if (!w) {
      console.warn(
        "[ACC Preview] El navegador bloqueó la ventana. Permití popups para este sitio " +
        "y volvé a llamar a __accPreview.abrir()."
      );
      return false;
    }
    estado.ventana = w;
    w.document.documentElement.innerHTML = SHELL;

    const $ = (id) => w.document.getElementById(id);
    $("refrescar").onclick = () => refrescar();
    $("escritorio").onclick = () => fijarAncho(ANCHOS.escritorio);
    $("movil").onclick = () => fijarAncho(ANCHOS.movil);
    $("auto").onchange = (e) => {
      estado.autoSync = e.target.checked;
      if (estado.autoSync) arrancarSync();
      else pararSync();
    };
    $("copiar").onclick = () => {
      const html = extraer();
      if (!html) return;
      w.navigator.clipboard.writeText(html).then(
        () => ($("estado").textContent = "HTML copiado"),
        () => ($("estado").textContent = "No se pudo copiar")
      );
    };
    $("descargar").onclick = () => {
      const html = extraer();
      if (!html) return;
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const a = w.document.createElement("a");
      a.href = url;
      a.download = "mailing-preview.html";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };

    refrescar();
    arrancarSync();
    return true;
  }

  function fijarAncho(px) {
    estado.ancho = px;
    const w = estado.ventana;
    if (!w || w.closed) return;
    w.document.getElementById("vista").width = px;
    w.document.getElementById("escritorio").dataset.activo = px === ANCHOS.escritorio ? "si" : "no";
    w.document.getElementById("movil").dataset.activo = px === ANCHOS.movil ? "si" : "no";
  }

  function refrescar() {
    const w = estado.ventana;
    if (!w || w.closed) return;

    const est = w.document.getElementById("estado");
    const html = extraer();
    if (!html) {
      if (est) est.textContent = "No se encontró " + SEL_CONTENEDOR;
      return;
    }

    const vista = w.document.getElementById("vista");
    vista.srcdoc = html;
    vista.width = estado.ancho;
    if (est) {
      est.textContent =
        new Date().toLocaleTimeString("es-PE") + " · " + Math.round(html.length / 1024) + " KB";
    }
  }

  // ── 4. Sincronización en vivo ──────────────────────────────────────────────
  // Se observa SOLO el contenedor del mail, no el body: así los nodos que el
  // editor mete fuera de él (paneles, overlays) no disparan re-render.
  function arrancarSync() {
    pararSync();
    if (!estado.autoSync) return;

    const cont = contenedor();
    if (!cont) return;

    try {
      estado.observer = new MutationObserver(() => {
        clearTimeout(estado.timerSync);
        estado.timerSync = setTimeout(refrescar, 400);
      });
      estado.observer.observe(cont, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    } catch (e) {
      console.warn("[ACC Preview] No se pudo observar el contenedor:", e.message);
    }

    // Si el editor reemplaza el contenedor entero (cambiar de mail, deshacer
    // masivo), el observer queda apuntando a un nodo huérfano: hay que
    // re-enganchar sobre el nuevo.
    clearInterval(estado.timerSalud);
    estado.timerSalud = setInterval(() => {
      if (estado.ventana && estado.ventana.closed) return pararSync();
      const actual = contenedor();
      if (actual && estado.observer && !actual.isConnected) {
        arrancarSync();
        refrescar();
      }
    }, 2000);
  }

  function pararSync() {
    if (estado.observer) estado.observer.disconnect();
    estado.observer = null;
    clearTimeout(estado.timerSync);
    clearInterval(estado.timerSalud);
  }

  // ── 5. Arranque ────────────────────────────────────────────────────────────
  function destruir() {
    pararSync();
    if (estado.ventana && !estado.ventana.closed) estado.ventana.close();
    delete window[NS];
    console.log("[ACC Preview] Desmontado.");
  }

  /** Diagnóstico: qué <style> se lleva, cuáles descarta y por qué. */
  function estilos() {
    const filas = clasificarEstilos().map((e) => ({
      i: e.i,
      len: e.len,
      clasesDelMail: e.clasesDelMail,
      media: e.media,
      llevar: e.llevar,
      motivo: e.motivo || "",
    }));
    console.table(filas);
    return filas;
  }

  window[NS] = { abrir, refrescar, estilos, destruir, estado };

  if (!contenedor()) {
    console.warn(
      "[ACC Preview] No se encontró " + SEL_CONTENEDOR + " en este documento.\n" +
      "¿Está la consola en el contexto `iframe.html` / `acrites-ui-iframe...`? " +
      "Si dice `top` o `Main Content`, cambialo y volvé a pegar el script."
    );
  } else {
    // window.open desde una evaluación de consola cuenta como gesto de usuario,
    // así que el popup no se bloquea. Si igual pasara, queda __accPreview.abrir().
    abrir();
    console.log(
      "[ACC Preview] Activo. Controles en la ventana de preview.\n" +
      "__accPreview.estilos() muestra qué CSS se llevó y qué descartó."
    );
  }
})();
