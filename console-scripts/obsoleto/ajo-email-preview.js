/**
 * Adobe Email Designer — Preview externo (script de consola)
 * ---------------------------------------------------------
 * Prueba de concepto de lo que después será una pestaña de la extensión:
 * detecta el canvas del mailing que se está editando y abre una segunda
 * ventana con la previsualización, sincronizada con lo que se edita.
 *
 * Se pega en la consola de DevTools porque en las laptops del banco no se
 * pueden instalar extensiones, pero sí ejecutar JS en la consola. No usa
 * ninguna API chrome.* — es JS de página, igual que inject.js del mundo MAIN.
 *
 * Uso:
 *   1. Abrir el mailing en el Email Designer.
 *   2. DevTools → Console → pegar este archivo entero → Enter.
 *      (Chrome pide escribir "allow pasting" la primera vez.)
 *   3. Aparece un panel abajo a la derecha → "Abrir preview".
 *
 * API que queda en window.__ajoEmailPreview:
 *   .panel()        vuelve a mostrar el panel si lo cerraste
 *   .escanear()     re-detecta candidatos
 *   .diagnostico()  vuelca a consola lo que encontró (para reportar fallos)
 *   .destruir()     saca todo de la página
 */
(() => {
  "use strict";

  const NS = "__ajoEmailPreview";

  // ── 0. Guard de idempotencia ───────────────────────────────────────────────
  // Mismo criterio que inject.js: pegar el script dos veces en la misma página
  // no debe duplicar paneles, observers ni ventanas.
  if (window[NS]) {
    window[NS].panel();
    console.log("[AJO Preview] Ya estaba activo en esta página — panel reabierto.");
    return;
  }

  // ── 1. Estado ──────────────────────────────────────────────────────────────
  const estado = {
    candidatos: [],   // resultado del último escaneo, ordenados por puntaje
    elegido: null,    // candidato en uso
    ventana: null,    // ventana de preview (window.open)
    observer: null,   // MutationObserver sobre el documento del canvas
    autoSync: true,
    ancho: 700,       // 700 = escritorio, 375 = móvil
    limpiar: true,    // sacar artefactos del editor del HTML extraído
    hostPanel: null,
    timerSync: null,
    timerSalud: null,
  };

  const ANCHOS = { escritorio: 700, movil: 375 };

  // ── 2. Recorrido del DOM: shadow roots + iframes ───────────────────────────
  // La UI de Adobe Experience Cloud está hecha con Spectrum Web Components, así
  // que buena parte del árbol vive dentro de shadow roots: un querySelectorAll
  // plano sobre document NO ve el iframe del canvas. Hay que abrir cada
  // shadowRoot a mano, y además bajar a los iframes que sí sean same-origin.

  /** Devuelve document + todos los shadow roots alcanzables desde él. */
  function raicesDe(raiz, profundidad = 0, acc = []) {
    if (profundidad > 10 || acc.indexOf(raiz) !== -1) return acc;
    acc.push(raiz);
    let elementos;
    try {
      elementos = raiz.querySelectorAll("*");
    } catch (e) {
      return acc;
    }
    for (const el of elementos) {
      if (el.shadowRoot) raicesDe(el.shadowRoot, profundidad + 1, acc);
    }
    return acc;
  }

  /**
   * Junta todos los <iframe> alcanzables desde un documento, incluyendo los que
   * están dentro de shadow roots y los anidados dentro de otros iframes
   * accesibles. Marca cuáles no se pueden leer (cross-origin) en vez de
   * tirar el error: esa información es justamente la que sirve para diagnosticar.
   */
  function juntarIframes(doc, ruta, salida, profundidad) {
    if (profundidad > 4) return;
    for (const raiz of raicesDe(doc)) {
      let marcos;
      try {
        marcos = raiz.querySelectorAll("iframe, frame");
      } catch (e) {
        continue;
      }
      for (const el of marcos) {
        let subdoc = null;
        let error = null;
        try {
          subdoc = el.contentDocument;
          if (!subdoc) error = "contentDocument nulo (probablemente cross-origin)";
        } catch (e) {
          error = "bloqueado por same-origin policy: " + e.message;
        }

        const rect = el.getBoundingClientRect();
        salida.push({
          el,
          doc: subdoc,
          ruta,
          accesible: !!subdoc,
          error,
          id: el.id || "",
          clase: typeof el.className === "string" ? el.className : "",
          titulo: el.getAttribute("title") || "",
          src: el.getAttribute("src") || "(sin src)",
          ancho: Math.round(rect.width),
          alto: Math.round(rect.height),
        });

        if (subdoc) {
          juntarIframes(subdoc, ruta + " › iframe" + (el.id ? "#" + el.id : ""), salida, profundidad + 1);
        }
      }
    }
  }

  // ── 3. Puntaje: cuál de todos los iframes es el mailing ────────────────────
  // No hay un selector estable publicado para el canvas del Email Designer, y
  // Adobe cambia los nombres de clase entre releases. En vez de adivinar uno,
  // se puntúa por rasgos que un email SIEMPRE tiene y el chrome del editor no:
  // mucho HTML, tablas de maquetación, imágenes, y un iframe grande y visible.
  function puntuar(c) {
    if (!c.accesible || !c.doc || !c.doc.body) return -1;

    let html = "";
    try {
      html = c.doc.documentElement.outerHTML || "";
    } catch (e) {
      return -1;
    }
    if (html.length < 200) return -1; // iframe vacío / placeholder

    let p = 0;
    p += Math.min(html.length / 200, 400);                        // volumen de contenido
    p += Math.min(c.doc.querySelectorAll("table").length, 20) * 25; // emails = tablas
    p += Math.min(c.doc.querySelectorAll("img").length, 20) * 8;
    p += Math.min(c.doc.querySelectorAll("td").length, 40) * 3;
    if (c.ancho > 250 && c.alto > 250) p += 200;                  // visible y grande
    if (c.ancho === 0 || c.alto === 0) p -= 150;                  // oculto

    const señas = (c.id + " " + c.clase + " " + c.titulo + " " + c.src).toLowerCase();
    if (/design|canvas|preview|render|content|body|email|message/.test(señas)) p += 150;
    if (/toolbar|panel|nav|menu|icon|sidebar/.test(señas)) p -= 100;

    return Math.round(p);
  }

  /** Re-escanea la página y deja estado.candidatos ordenado de mejor a peor. */
  function escanear() {
    const salida = [];
    juntarIframes(document, "documento principal", salida, 0);
    for (const c of salida) c.puntaje = puntuar(c);
    salida.sort((a, b) => b.puntaje - a.puntaje);
    estado.candidatos = salida;

    // Si el elegido sigue vivo se respeta la elección, pero apuntando al
    // candidato NUEVO: el objeto viejo guarda una referencia a contentDocument
    // que queda obsoleta si el editor renavegó ese iframe, y seguiríamos
    // extrayendo de un documento muerto sin darnos cuenta.
    const frescoDelElegido =
      estado.elegido && estado.elegido.el.isConnected
        ? salida.find((c) => c.el === estado.elegido.el && c.puntaje > 0)
        : null;

    estado.elegido = frescoDelElegido || salida.find((c) => c.puntaje > 0) || null;
    return salida;
  }

  // ── 4. Extracción del HTML del mailing ─────────────────────────────────────
  /**
   * Saca el HTML del canvas listo para renderizar fuera del editor:
   *  - <base> para que las rutas relativas (imágenes del DAM) sigan resolviendo
   *  - opcionalmente limpia los rastros del editor (contenteditable, scripts)
   * La limpieza es deliberadamente conservadora: sacar de más corre el riesgo de
   * romper el layout del mail, que es justo lo que se quiere previsualizar.
   */
  function extraerHtml() {
    if (!estado.elegido || !estado.elegido.doc) return null;
    const doc = estado.elegido.doc;

    let copia;
    try {
      copia = doc.documentElement.cloneNode(true);
    } catch (e) {
      return null;
    }

    if (estado.limpiar) {
      for (const el of copia.querySelectorAll("[contenteditable]")) {
        el.removeAttribute("contenteditable");
      }
      for (const el of copia.querySelectorAll("[spellcheck]")) {
        el.removeAttribute("spellcheck");
      }
      // Los scripts del editor no tienen sentido en la preview y pueden
      // intentar hablar con un editor que en esa ventana no existe.
      for (const el of copia.querySelectorAll("script")) el.remove();
    }

    // Base: la del documento del canvas si la tiene, si no la de la página.
    const base = (doc.baseURI || location.href).replace(/"/g, "&quot;");
    let cabeza = copia.querySelector("head");
    if (!cabeza) {
      cabeza = doc.createElement("head");
      copia.insertBefore(cabeza, copia.firstChild);
    }
    if (!cabeza.querySelector("base")) {
      cabeza.insertAdjacentHTML("afterbegin", '<base href="' + base + '">');
    }

    return "<!DOCTYPE html>\n" + copia.outerHTML;
  }

  // ── 5. Ventana de preview ──────────────────────────────────────────────────
  // El mailing se renderiza dentro de un <iframe srcdoc> y no escribiendo
  // directo en el document de la ventana, para que los estilos del email no se
  // mezclen con los de la barra de herramientas de la preview.
  // Se inyecta con documentElement.innerHTML (no document.write, que está
  // deprecado): por eso el string arranca en <head> y no en <!DOCTYPE html>.
  const SHELL = `<head>
<meta charset="utf-8">
<title>Preview del mailing</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f1f5f9; color:#1e293b; display:flex; flex-direction:column; height:100vh; }
  .barra { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1e293b; color:#fff; flex:none; }
  .barra__titulo { font-weight:600; margin-right:auto; font-size:12px; letter-spacing:.02em; }
  .barra button { font:inherit; font-size:12px; padding:5px 10px; border:0; border-radius:5px;
                  background:#475569; color:#fff; cursor:pointer; }
  .barra button:hover { background:#64748b; }
  .barra button[data-activo="si"] { background:#4f46e5; }
  .barra__estado { font-size:11px; opacity:.7; margin-left:4px; }
  .lienzo { flex:1; overflow:auto; display:flex; justify-content:center; padding:16px; }
  iframe { background:#fff; border:1px solid #cbd5e1; border-radius:4px; height:100%;
           box-shadow:0 1px 4px rgba(0,0,0,.08); }
</style>
</head>
<body>
  <div class="barra">
    <span class="barra__titulo">Preview del mailing</span>
    <span class="barra__estado" id="estado"></span>
    <button id="escritorio" data-activo="si">Escritorio</button>
    <button id="movil">Móvil</button>
    <button id="refrescar">Refrescar</button>
    <button id="copiar">Copiar HTML</button>
    <button id="descargar">Descargar .html</button>
  </div>
  <div class="lienzo"><iframe id="vista" width="700"></iframe></div>
</body>`;

  function abrirPreview() {
    // window.open desde un click del panel: hay gesto de usuario, así que el
    // bloqueador de popups no lo corta (sí lo cortaría si se abriera sola).
    if (estado.ventana && !estado.ventana.closed) {
      estado.ventana.focus();
      refrescar();
      return true;
    }

    const w = window.open("", "ajo-email-preview", "width=840,height=940");
    if (!w) {
      pintarPanel("No se pudo abrir la ventana: el navegador bloqueó el popup. Permitilo para este sitio y reintentá.");
      return false;
    }
    estado.ventana = w;
    w.document.documentElement.innerHTML = SHELL;

    const $ = (id) => w.document.getElementById(id);
    $("refrescar").onclick = () => refrescar();
    $("escritorio").onclick = () => fijarAncho(ANCHOS.escritorio);
    $("movil").onclick = () => fijarAncho(ANCHOS.movil);
    $("copiar").onclick = () => {
      const html = extraerHtml();
      if (!html) return;
      w.navigator.clipboard.writeText(html).then(
        () => ($("estado").textContent = "HTML copiado"),
        () => ($("estado").textContent = "No se pudo copiar")
      );
    };
    $("descargar").onclick = () => {
      const html = extraerHtml();
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

    // El editor puede haber re-renderizado y reemplazado el iframe del canvas.
    if (!estado.elegido || !estado.elegido.el.isConnected) escanear();

    const html = extraerHtml();
    const est = w.document.getElementById("estado");
    if (!html) {
      if (est) est.textContent = "Sin canvas detectado";
      return;
    }
    const vista = w.document.getElementById("vista");
    vista.srcdoc = html;
    vista.width = estado.ancho;
    if (est) {
      est.textContent = new Date().toLocaleTimeString("es-PE") + " · " + Math.round(html.length / 1024) + " KB";
    }
    pintarPanel();
  }

  // ── 6. Sincronización con lo que se edita ──────────────────────────────────
  // Un MutationObserver sobre el documento del canvas: cada edición dispara un
  // refresco con debounce de 400ms (el mismo patrón del scan de inject.js, con
  // más holgura porque acá re-renderizar es más caro que postear un mensaje).
  function arrancarSync() {
    pararSync();
    if (!estado.autoSync || !estado.elegido || !estado.elegido.doc) return;
    try {
      estado.observer = new MutationObserver(() => {
        clearTimeout(estado.timerSync);
        estado.timerSync = setTimeout(refrescar, 400);
      });
      estado.observer.observe(estado.elegido.doc.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    } catch (e) {
      console.warn("[AJO Preview] No se pudo observar el canvas:", e.message);
    }

    // Chequeo de salud: si el editor reemplaza el iframe entero, el observer
    // queda apuntando a un documento muerto y hay que re-enganchar.
    clearInterval(estado.timerSalud);
    estado.timerSalud = setInterval(() => {
      if (estado.ventana && estado.ventana.closed) return pararSync();
      if (estado.elegido && !estado.elegido.el.isConnected) {
        escanear();
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

  // ── 7. Panel de control en la página del editor ────────────────────────────
  // Va dentro de un shadow root propio: la app de Adobe trae cientos de reglas
  // CSS globales y no queremos que le peguen al panel ni el panel a ellas.
  const CSS_PANEL = `
    :host { all: initial; }
    .caja { position:fixed; right:16px; bottom:16px; z-index:2147483647; width:300px;
            font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
            background:#fff; color:#1e293b; border:1px solid #cbd5e1; border-radius:8px;
            box-shadow:0 6px 24px rgba(15,23,42,.18); overflow:hidden; }
    .cab { display:flex; align-items:center; gap:6px; padding:8px 10px; background:#1e293b; color:#fff; }
    .cab__t { font-weight:600; margin-right:auto; font-size:12px; }
    .cab__x { cursor:pointer; opacity:.7; padding:0 4px; }
    .cab__x:hover { opacity:1; }
    .cuerpo { padding:10px; }
    .est { padding:6px 8px; border-radius:5px; margin-bottom:8px; font-size:11px; }
    .est--ok { background:#ecfdf5; color:#065f46; }
    .est--mal { background:#fef2f2; color:#991b1b; }
    select, button { font:inherit; width:100%; padding:6px 8px; border-radius:5px;
                     border:1px solid #cbd5e1; background:#fff; margin-bottom:6px; }
    button { cursor:pointer; }
    .btn--p { background:#4f46e5; color:#fff; border-color:#4f46e5; font-weight:600; }
    .btn--p:hover { background:#4338ca; }
    .fila { display:flex; gap:6px; }
    .fila button { margin-bottom:6px; }
    label.chk { display:flex; align-items:center; gap:6px; margin:2px 0 8px; cursor:pointer; }
    label.chk input { width:auto; margin:0; }
    .pista { font-size:10px; color:#64748b; line-height:1.4; }
  `;

  function crearPanel() {
    if (estado.hostPanel && estado.hostPanel.isConnected) return;
    const host = document.createElement("div");
    host.id = "ajo-email-preview-host";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS_PANEL}</style>
      <div class="caja">
        <div class="cab"><span class="cab__t">Preview del mailing</span><span class="cab__x" id="cerrar">✕</span></div>
        <div class="cuerpo">
          <div class="est" id="est"></div>
          <select id="sel"></select>
          <button class="btn--p" id="abrir">Abrir preview</button>
          <div class="fila">
            <button id="rescan">Re-escanear</button>
            <button id="diag">Diagnóstico</button>
          </div>
          <label class="chk"><input type="checkbox" id="auto" checked> Sincronizar mientras edito</label>
          <div class="pista" id="pista"></div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    estado.hostPanel = host;

    const $ = (id) => sh.getElementById(id);
    $("cerrar").onclick = () => host.remove();
    $("abrir").onclick = () => abrirPreview();
    $("rescan").onclick = () => { escanear(); pintarPanel(); };
    $("diag").onclick = () => diagnostico();
    $("auto").onchange = (e) => {
      estado.autoSync = e.target.checked;
      if (estado.autoSync) arrancarSync();
      else pararSync();
    };
    $("sel").onchange = (e) => {
      estado.elegido = estado.candidatos[Number(e.target.value)] || null;
      arrancarSync();
      refrescar();
      pintarPanel();
    };
  }

  function pintarPanel(mensajeError) {
    if (!estado.hostPanel || !estado.hostPanel.isConnected) return;
    const sh = estado.hostPanel.shadowRoot;
    const est = sh.getElementById("est");
    const sel = sh.getElementById("sel");
    const pista = sh.getElementById("pista");

    const accesibles = estado.candidatos.filter((c) => c.puntaje > 0);
    const bloqueados = estado.candidatos.filter((c) => !c.accesible);

    if (mensajeError) {
      est.className = "est est--mal";
      est.textContent = mensajeError;
    } else if (estado.elegido) {
      est.className = "est est--ok";
      est.textContent =
        "Canvas detectado · " + estado.elegido.ancho + "×" + estado.elegido.alto +
        " · puntaje " + estado.elegido.puntaje;
    } else {
      est.className = "est est--mal";
      est.textContent = "No se detectó el canvas del mailing.";
    }

    sel.innerHTML = "";
    if (!accesibles.length) {
      const o = document.createElement("option");
      o.textContent = "(sin candidatos legibles)";
      sel.appendChild(o);
    }
    estado.candidatos.forEach((c, i) => {
      if (c.puntaje <= 0) return;
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent =
        "#" + i + " · " + c.ancho + "×" + c.alto + " · " + c.puntaje + " pts" +
        (c.id ? " · #" + c.id : "") + (c.titulo ? " · " + c.titulo : "");
      if (estado.elegido === c) o.selected = true;
      sel.appendChild(o);
    });

    const partes = [];
    partes.push(estado.candidatos.length + " iframes hallados, " + accesibles.length + " legibles.");
    if (bloqueados.length) {
      partes.push(
        bloqueados.length + " son cross-origin y no se pueden leer desde acá. " +
        "Si el mailing está en uno de esos, cambiá el selector de contexto de la consola " +
        "(el desplegable arriba a la izquierda, dice 'top') al frame del editor y volvé a pegar el script."
      );
    }
    pista.textContent = partes.join(" ");
  }

  // ── 8. Diagnóstico (para cuando la autodetección falla) ────────────────────
  // Vuelca todo lo que se vio a la consola y lo deja en window.__ajoEmailPreviewDump
  // para copiarlo con copy(__ajoEmailPreviewDump) y reportarlo.
  function diagnostico() {
    escanear();
    const filas = estado.candidatos.map((c, i) => ({
      "#": i,
      puntaje: c.puntaje,
      accesible: c.accesible,
      tamaño: c.ancho + "×" + c.alto,
      id: c.id,
      clase: String(c.clase).slice(0, 60),
      titulo: c.titulo,
      src: String(c.src).slice(0, 80),
      ruta: c.ruta,
      error: c.error || "",
    }));
    console.groupCollapsed("[AJO Preview] Diagnóstico — " + filas.length + " iframes");
    console.table(filas);
    console.log("URL:", location.href);
    console.log("Elegido:", estado.elegido ? estado.elegido.el : null);
    console.groupEnd();
    window.__ajoEmailPreviewDump = JSON.stringify({ url: location.href, candidatos: filas }, null, 2);
    console.log("Copiá el reporte con:  copy(__ajoEmailPreviewDump)");
    return filas;
  }

  // ── 9. Arranque ────────────────────────────────────────────────────────────
  function destruir() {
    pararSync();
    if (estado.hostPanel) estado.hostPanel.remove();
    if (estado.ventana && !estado.ventana.closed) estado.ventana.close();
    delete window[NS];
    console.log("[AJO Preview] Desmontado.");
  }

  window[NS] = {
    panel: () => { crearPanel(); escanear(); pintarPanel(); },
    escanear: () => { escanear(); pintarPanel(); return estado.candidatos; },
    diagnostico,
    refrescar,
    destruir,
    estado,
  };

  escanear();
  crearPanel();
  pintarPanel();
  console.log(
    "[AJO Preview] Activo. Panel abajo a la derecha.\n" +
    "Si no detecta el canvas, corré __ajoEmailPreview.diagnostico() y pasá el resultado."
  );
})();
