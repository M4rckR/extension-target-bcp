/**
 * Adobe Campaign Classic — Preview del mailing
 * --------------------------------------------
 * Muestra la previsualización del mail que se está editando, sincronizada en
 * vivo, en un panel acoplado a la derecha del canvas.
 *
 * POR QUÉ UN PANEL Y NO UNA VENTANA APARTE
 * El iframe del canvas está sandboxeado sin `allow-popups`, así que
 * `window.open` está bloqueado desde adentro — verificado en vivo:
 *   "Blocked opening '' in a new window because the request was made in a
 *    sandboxed frame whose 'allow-popups' permission is not set."
 * No es el bloqueador de popups ni falta de gesto de usuario: es el atributo
 * `sandbox` del iframe, y no hay forma de saltarlo desde el código de la
 * página. La versión en extensión sí va a poder abrir ventana aparte, con
 * `chrome.windows.create` desde el service worker, que no está sujeto al
 * sandbox del frame.
 *
 * DE DÓNDE SALE EL CONTENIDO (los tres recon del repo)
 *   - El canvas es el documento del iframe `acrites-ui-iframe`.
 *   - El mail entero vive en `div.acr-container`, hijo directo de <body>.
 *   - El HTML del DOM es el HTML del mail: ~40% de los elementos traen estilos
 *     inline y las clases son de email (`mobile-full`, `table-radius`).
 *   - El CSS responsive vive en <style> sueltos del documento, mezclado con el
 *     del editor. Ver `clasificarEstilos()`.
 *
 * IMPORTANTE: se pega en la consola con el contexto puesto en
 * `iframe.html` / `acrites-ui-iframe.experience.adobe.net`, no en `top`.
 *
 * API en window.__accPreview:
 *   .abrir()      muestra el panel
 *   .refrescar()  re-renderiza a mano
 *   .html()       devuelve el HTML extraído — `copy(__accPreview.html())`
 *   .estilos()    tabla de qué CSS se llevó, qué descartó y por qué
 *   .destruir()   corta la sincronización y saca el panel
 */
(() => {
  "use strict";

  const NS = "__accPreview";

  // ── 0. Reemplazo de la instancia previa ────────────────────────────────────
  // Si ya hay una corriendo, se desmonta y este pegado la reemplaza. Antes el
  // guard reusaba la instancia vieja llamando a su abrir(), lo cual hacía que
  // pegar una versión corregida del script no tuviera ningún efecto: seguía
  // ejecutándose el código anterior. Desmontar y arrancar de cero también evita
  // duplicar el MutationObserver y el panel.
  if (window[NS]) {
    try {
      window[NS].destruir();
    } catch (e) {
      // instancia vieja rota o de una versión sin destruir() — se descarta igual
      delete window[NS];
    }
    console.log("[ACC Preview] Se desmontó la instancia anterior.");
  }

  const SEL_CONTENEDOR = ".acr-container";
  const ANCHOS = { escritorio: 700, movil: 375 };

  const estado = {
    host: null,
    observer: null,
    timerSync: null,
    timerSalud: null,
    autoSync: true,
    ancho: ANCHOS.escritorio, // ancho simulado del mail
    panel: 0,                 // ancho del panel en pantalla; se calcula al abrir
    ajustar: true,            // escalar el mail para que entre en el panel
  };

  const contenedor = () => document.querySelector(SEL_CONTENEDOR);

  // ── 1. Qué <style> son del mail y cuáles del editor ────────────────────────
  // El documento del canvas mezcla los dos. Los del editor se delatan por dos
  // rasgos, cualquiera alcanza para descartarlos:
  //   a) Selectores .acr-* / .acd-*  → canvas, grid, dark mode, plugins.
  //   b) Nombres de CSS Modules con hash (colorPicker__wrapper___3urhm) → los
  //      paneles de la UI del editor.
  // De lo que queda se conserva lo que defina al menos dos clases que el mail
  // usa de verdad, o lo que traiga media queries — por esta segunda vía entra
  // el responsive por id (#acr-t94e), que no define clases pero sí afecta al
  // mail. Se deduplica por contenido exacto: el editor emite el bloque
  // responsive dos veces, idéntico byte a byte.
  const RE_EDITOR = /\.acr-|\.acd-/;
  const RE_MODULO_CSS = /___[A-Za-z0-9_-]{4,}/;

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

  function clasificarEstilos() {
    const usadas = clasesDelMail();
    const vistos = new Set();

    return [...document.querySelectorAll("style")].map((s, i) => {
      const t = s.textContent || "";
      let hits = 0;
      for (const c of usadas) if (t.includes("." + c)) hits++;
      const media = /@media/.test(t);

      let motivo = null;
      if (!t) motivo = "vacío";
      else if (RE_EDITOR.test(t)) motivo = "editor (.acr-/.acd-)";
      else if (RE_MODULO_CSS.test(t)) motivo = "editor (CSS module)";
      else if (hits < 2 && !media) motivo = "no aporta al mail";
      else if (vistos.has(t)) motivo = "duplicado exacto";

      if (!motivo) vistos.add(t);

      return { i, len: t.length, clasesDelMail: hits, media, llevar: !motivo, motivo, css: t };
    });
  }

  // ── 2. Extracción del HTML ─────────────────────────────────────────────────
  // Limpieza deliberadamente mínima: se sacan las marcas de edición
  // (contenteditable, spellcheck) y los <script>, nada más. NO se tocan clases
  // ni ids: el CSS que sí nos llevamos los referencia — el bloque de media
  // queries por id (#acr-t94e…) dejaría de aplicar si los borráramos. Las
  // clases acr-* que quedan son inocuas, porque la hoja que las estilaba es
  // justamente una de las descartadas.
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

    const base = String(document.baseURI || location.href).replace(/"/g, "&quot;");
    const css = clasificarEstilos()
      .filter((e) => e.llevar)
      .map((e) => e.css)
      .join("\n\n");

    return (
      '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
      '<base href="' + base + '">\n' +
      "<style>\n" + css + "\n</style>\n" +
      '</head>\n<body style="margin:0">\n' + copia.innerHTML + "\n</body>\n</html>"
    );
  }

  // ── 3. El panel ────────────────────────────────────────────────────────────
  // Va en un shadow root propio: el documento del canvas trae 20 hojas de
  // estilo del editor y no queremos que le peguen al panel ni el panel a ellas.
  // Se cuelga de <body>, fuera de .acr-container, así el MutationObserver que
  // vigila el mail no se dispara por nuestros propios nodos.
  const CSS_PANEL = `
    :host { all: initial; }
    .panel { position:fixed; top:0; right:0; bottom:0; z-index:2147483647;
             display:flex; flex-direction:column; background:#f1f5f9;
             border-left:1px solid #cbd5e1; box-shadow:-4px 0 16px rgba(15,23,42,.14);
             font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
             color:#1e293b; }
    .agarre { position:absolute; left:-3px; top:0; bottom:0; width:7px;
              cursor:ew-resize; background:transparent; }
    .agarre:hover { background:#4f46e5; opacity:.35; }
    .barra { display:flex; flex-wrap:wrap; align-items:center; gap:5px; padding:7px 9px;
             background:#1e293b; color:#fff; flex:none; }
    .barra__t { font-weight:600; font-size:11px; margin-right:auto; }
    .barra button { font:inherit; font-size:11px; padding:4px 8px; border:0; border-radius:4px;
                    background:#475569; color:#fff; cursor:pointer; }
    .barra button:hover { background:#64748b; }
    .barra button[data-activo="si"] { background:#4f46e5; }
    .barra label { font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer; }
    .barra__x { background:transparent!important; font-size:14px!important; padding:0 5px!important; }
    .estado { padding:4px 9px; background:#e2e8f0; color:#475569; font-size:10px; flex:none; }
    .lienzo { flex:1; overflow:auto; padding:10px; }
    .escala { transform-origin: top left; }
    iframe { border:1px solid #cbd5e1; background:#fff; display:block; }
  `;

  /**
   * Ancho inicial del panel, relativo al frame. El canvas puede ser angosto
   * (se midió en 678 px), así que un ancho fijo se comería casi todo el editor:
   * se toma el 45% y se acota entre 300 y 560.
   */
  function anchoInicial() {
    return Math.max(300, Math.min(560, Math.round(window.innerWidth * 0.45)));
  }

  function crearPanel() {
    if (estado.host && estado.host.isConnected) return estado.host.shadowRoot;
    if (!estado.panel) estado.panel = anchoInicial();

    const host = document.createElement("div");
    host.id = "acc-preview-host";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `<style>${CSS_PANEL}</style>
      <div class="panel" id="panel">
        <div class="agarre" id="agarre"></div>
        <div class="barra">
          <span class="barra__t">Preview</span>
          <label><input type="checkbox" id="auto" checked> En vivo</label>
          <button id="escritorio" data-activo="si">700</button>
          <button id="movil">375</button>
          <button id="ajustar" data-activo="si">Ajustar</button>
          <button id="refrescar">↻</button>
          <button id="copiar">Copiar</button>
          <button class="barra__x" id="cerrar">✕</button>
        </div>
        <div class="estado" id="estado"></div>
        <div class="lienzo"><div class="escala" id="escala"><iframe id="vista"></iframe></div></div>
      </div>`;

    (document.body || document.documentElement).appendChild(host);
    estado.host = host;

    const $ = (id) => sh.getElementById(id);
    $("cerrar").onclick = () => destruir();
    $("refrescar").onclick = () => refrescar();
    $("escritorio").onclick = () => fijarAncho(ANCHOS.escritorio);
    $("movil").onclick = () => fijarAncho(ANCHOS.movil);
    $("ajustar").onclick = () => {
      estado.ajustar = !estado.ajustar;
      $("ajustar").dataset.activo = estado.ajustar ? "si" : "no";
      aplicarMedidas();
    };
    $("auto").onchange = (e) => {
      estado.autoSync = e.target.checked;
      if (estado.autoSync) arrancarSync();
      else pararSync();
    };
    $("copiar").onclick = () => copiar();

    // Arrastrar el borde izquierdo para ensanchar/angostar el panel.
    const agarre = $("agarre");
    agarre.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const mover = (e) => {
        const ancho = window.innerWidth - e.clientX;
        estado.panel = Math.max(300, Math.min(ancho, window.innerWidth - 80));
        aplicarMedidas();
      };
      const soltar = () => {
        document.removeEventListener("mousemove", mover);
        document.removeEventListener("mouseup", soltar);
      };
      document.addEventListener("mousemove", mover);
      document.addEventListener("mouseup", soltar);
    });

    aplicarMedidas();
    return sh;
  }

  /** Ancho del panel, ancho simulado del mail y escala para que entre. */
  function aplicarMedidas() {
    if (!estado.host || !estado.host.isConnected) return;
    const sh = estado.host.shadowRoot;
    sh.getElementById("panel").style.width = estado.panel + "px";

    const vista = sh.getElementById("vista");
    vista.width = estado.ancho;
    vista.style.height = Math.max(window.innerHeight - 120, 400) + "px";

    // El mail se maqueta a 700px; si el panel es más angosto se escala en vez
    // de mostrar scroll horizontal, que es incómodo para revisar un mail.
    const disponible = estado.panel - 32;
    const factor = estado.ajustar ? Math.min(1, disponible / estado.ancho) : 1;
    const escala = sh.getElementById("escala");
    escala.style.transform = "scale(" + factor + ")";
    escala.style.width = estado.ancho + "px";
    escala.style.height = factor < 1 ? Number(vista.style.height.replace("px", "")) * factor + "px" : "auto";
  }

  function fijarAncho(px) {
    estado.ancho = px;
    if (!estado.host) return;
    const sh = estado.host.shadowRoot;
    sh.getElementById("escritorio").dataset.activo = px === ANCHOS.escritorio ? "si" : "no";
    sh.getElementById("movil").dataset.activo = px === ANCHOS.movil ? "si" : "no";
    aplicarMedidas();
  }

  function refrescar() {
    if (!estado.host || !estado.host.isConnected) return;
    const sh = estado.host.shadowRoot;
    const est = sh.getElementById("estado");

    const html = extraer();
    if (!html) {
      est.textContent = "No se encontró " + SEL_CONTENEDOR;
      return;
    }

    sh.getElementById("vista").srcdoc = html;
    aplicarMedidas();
    est.textContent =
      new Date().toLocaleTimeString("es-PE") + " · " + Math.round(html.length / 1024) + " KB";
  }

  /**
   * Copiar al portapapeles. En un frame sandboxeado la Clipboard API puede
   * estar bloqueada, así que hay fallback a textarea + execCommand, y si eso
   * también falla queda `copy(__accPreview.html())` desde la consola.
   */
  function copiar() {
    const html = extraer();
    if (!html) return;
    const sh = estado.host.shadowRoot;
    const est = sh.getElementById("estado");
    const ok = () => (est.textContent = "HTML copiado (" + Math.round(html.length / 1024) + " KB)");
    const falla = () => {
      est.textContent = "Bloqueado — usá copy(__accPreview.html()) en la consola";
      console.warn("[ACC Preview] Portapapeles bloqueado. Usá:  copy(__accPreview.html())");
    };

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(html).then(ok, () => legacy(html) ? ok() : falla());
      } else if (legacy(html)) ok();
      else falla();
    } catch (e) {
      falla();
    }
  }

  function legacy(texto) {
    try {
      const ta = document.createElement("textarea");
      ta.value = texto;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ── 4. Sincronización en vivo ──────────────────────────────────────────────
  // Se observa SOLO el contenedor del mail, no el body: así los nodos que el
  // editor (y este panel) meten fuera de él no disparan re-render.
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
      const actual = contenedor();
      if (actual && !actual.isConnected) {
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
  function abrir() {
    crearPanel();
    refrescar();
    arrancarSync();
  }

  function destruir() {
    pararSync();
    if (estado.host) estado.host.remove();
    estado.host = null;
    delete window[NS];
    console.log("[ACC Preview] Desmontado.");
  }

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

  window[NS] = { abrir, refrescar, html: extraer, estilos, destruir, estado };

  window.addEventListener("resize", () => aplicarMedidas());

  if (!contenedor()) {
    console.warn(
      "[ACC Preview] No se encontró " + SEL_CONTENEDOR + " en este documento.\n" +
      "¿Está la consola en el contexto `iframe.html` / `acrites-ui-iframe...`? " +
      "Si dice `top` o `Main Content`, cambialo y volvé a pegar el script."
    );
  } else {
    abrir();
    console.log(
      "[ACC Preview] Panel abierto a la derecha.\n" +
      "__accPreview.estilos() muestra qué CSS se llevó. " +
      "copy(__accPreview.html()) copia el HTML del mail."
    );
  }
})();
