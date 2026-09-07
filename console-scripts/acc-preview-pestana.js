/**
 * Adobe Campaign Classic — Preview del mailing en una pestaña aparte
 * -------------------------------------------------------------------
 * Alternativa a `acc-email-preview.js` (que muestra la preview en un panel
 * acoplado dentro del canvas). Esta versión la saca a una pestaña del navegador.
 *
 * POR QUÉ HACEN FALTA DOS PEGADOS
 * El iframe del canvas está sandboxeado sin `allow-popups`, así que desde
 * adentro no se puede abrir ni ventana ni pestaña — para el navegador son lo
 * mismo. Pero el sandbox NO bloquea `postMessage`, y el frame `top`
 * (experience.adobe.com) no está sandboxeado. Entonces:
 *
 *   canvas (sandboxeado)            top (sin sandbox)
 *     extrae el HTML  ──postMessage──►  lo escribe en la pestaña que abrió
 *     en cada edición
 *
 * ES UN SOLO ARCHIVO, SE PEGA DOS VECES
 * Detecta solo en qué contexto está y toma el rol que corresponde, así no hay
 * que acordarse de qué script va en qué lado:
 *
 *   1. Contexto `top` → rol RECEPTOR. Abre la pestaña (el pegado en consola
 *      cuenta como gesto de usuario, así que el bloqueador de popups no la
 *      corta) y se queda escuchando.
 *   2. Contexto `iframe.html` → rol EMISOR. Extrae el mail y lo manda arriba
 *      en cada edición.
 *
 * El orden importa: primero el receptor, después el emisor. Si se hace al
 * revés, el receptor pide los datos al arrancar y el emisor responde, así que
 * igual se recupera.
 *
 * SEGURIDAD
 * El emisor manda el HTML dirigido exclusivamente a `experience.adobe.com`
 * (nunca con `'*'`), y el receptor descarta cualquier mensaje que no venga del
 * origen del canvas. Los dos orígenes están fijos, tomados de los recon.
 *
 * API:
 *   window.__accTab.abrir()     receptor: reabre la pestaña
 *   window.__accTab.enviar()    emisor: manda el HTML ahora
 *   window.__accTab.html()      emisor: devuelve el HTML — copy(__accTab.html())
 *   window.__accTab.destruir()  desmonta el rol de este contexto
 */
(() => {
  "use strict";

  const NS = "__accTab";
  const CANAL = "acc-preview";
  const ORIGEN_TOP = "https://experience.adobe.com";
  const ORIGEN_CANVAS = "https://acrites-ui-iframe.experience.adobe.net";
  const SEL_CONTENEDOR = ".acr-container";

  // Volver a pegar reemplaza la instancia previa en vez de reusarla: si no,
  // pegar una versión corregida no tendría ningún efecto.
  if (window[NS]) {
    try {
      window[NS].destruir();
    } catch (e) {
      delete window[NS];
    }
  }

  const esCanvas = !!document.querySelector(SEL_CONTENEDOR);
  const esTop = window.top === window;

  // ══════════════════════════════════════════════════════════════════════════
  // ROL EMISOR — corre dentro del canvas
  // ══════════════════════════════════════════════════════════════════════════
  if (esCanvas) {
    // ── Clasificación de <style>: cuáles son del mail y cuáles del editor ────
    // Misma lógica que acc-email-preview.js. Está duplicada a propósito: cada
    // archivo de esta carpeta tiene que poder pegarse solo en una consola.
    const RE_EDITOR = /\.acr-|\.acd-/;
    const RE_MODULO_CSS = /___[A-Za-z0-9_-]{4,}/;

    const clasesDelMail = () => {
      const cont = document.querySelector(SEL_CONTENEDOR);
      const usadas = new Set();
      if (!cont) return usadas;
      for (const el of cont.querySelectorAll("*")) {
        const cn = el.className;
        if (cn && cn.split) {
          for (const k of cn.split(/\s+/)) if (k && !k.startsWith("acr-")) usadas.add(k);
        }
      }
      return usadas;
    };

    const cssDelMail = () => {
      const usadas = clasesDelMail();
      const vistos = new Set();
      const out = [];
      for (const s of document.querySelectorAll("style")) {
        const t = s.textContent || "";
        if (!t) continue;
        if (RE_EDITOR.test(t)) continue;       // canvas, grid, dark mode, plugins
        if (RE_MODULO_CSS.test(t)) continue;   // CSS Modules de los paneles
        let hits = 0;
        for (const c of usadas) if (t.includes("." + c)) hits++;
        if (hits < 2 && !/@media/.test(t)) continue;
        if (vistos.has(t)) continue;           // el editor lo emite dos veces
        vistos.add(t);
        out.push(t);
      }
      return out.join("\n\n");
    };

    // ── Extracción ──────────────────────────────────────────────────────────
    // Limpieza mínima: NO se tocan clases ni ids, porque el CSS que sí nos
    // llevamos los referencia (hay un bloque de media queries por id).
    function extraer() {
      const cont = document.querySelector(SEL_CONTENEDOR);
      if (!cont) return null;
      const copia = cont.cloneNode(true);
      for (const el of copia.querySelectorAll("[contenteditable]")) el.removeAttribute("contenteditable");
      for (const el of copia.querySelectorAll("[spellcheck]")) el.removeAttribute("spellcheck");
      for (const el of copia.querySelectorAll("script")) el.remove();

      const base = String(document.baseURI || location.href).replace(/"/g, "&quot;");
      return (
        '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
        // Sin referrer: si el servidor de las imágenes tiene protección
        // anti-hotlinking, un Referer de experience.adobe.com se las rechaza y
        // salen rotas. Bajado a disco no se manda referrer y por eso ahí sí
        // cargan — esto reproduce ese comportamiento dentro de la preview.
        '<meta name="referrer" content="no-referrer">\n' +
        '<base href="' + base + '">\n<style>\n' + cssDelMail() + "\n</style>\n" +
        '</head>\n<body style="margin:0">\n' + copia.innerHTML + "\n</body>\n</html>"
      );
    }

    const estado = { observer: null, timer: null, enviados: 0 };

    function enviar() {
      const html = extraer();
      if (!html) return false;
      try {
        // Dirigido solo a experience.adobe.com, nunca '*': el HTML del mail no
        // debe quedar legible para cualquier otro frame de la página.
        window.top.postMessage({ source: CANAL, tipo: "html", html }, ORIGEN_TOP);
        estado.enviados++;
        return true;
      } catch (e) {
        console.warn("[ACC Tab] No se pudo enviar al frame top:", e.message);
        return false;
      }
    }

    // El receptor pide los datos al arrancar, por si el emisor ya estaba
    // corriendo. El pedido no lleva contenido, así que aceptarlo no filtra nada.
    const onPedido = (ev) => {
      const d = ev.data;
      if (d && d.source === CANAL && d.tipo === "pedido") enviar();
    };
    window.addEventListener("message", onPedido);

    const observer = new MutationObserver(() => {
      clearTimeout(estado.timer);
      estado.timer = setTimeout(enviar, 400);
    });
    observer.observe(document.querySelector(SEL_CONTENEDOR), {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    estado.observer = observer;

    window[NS] = {
      rol: "emisor",
      enviar,
      html: extraer,
      estado,
      destruir() {
        if (estado.observer) estado.observer.disconnect();
        clearTimeout(estado.timer);
        window.removeEventListener("message", onPedido);
        delete window[NS];
        console.log("[ACC Tab] Emisor desmontado.");
      },
    };

    enviar();
    console.log(
      "[ACC Tab] EMISOR activo en el canvas. Mandando el mail al frame top en cada edición.\n" +
      "Si la pestaña no muestra nada, ¿pegaste primero el script en el contexto `top`?"
    );
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROL RECEPTOR — corre en el frame top
  // ══════════════════════════════════════════════════════════════════════════
  if (esTop) {
    const estado = { pestana: null, ancho: 700, recibidos: 0, ultimoHtml: null, timerPedido: null };

    const SHELL = `<head>
<meta charset="utf-8">
<title>Preview del mailing</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f1f5f9; color:#1e293b; display:flex; flex-direction:column; height:100vh; }
  .barra { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1e293b; color:#fff; flex:none; }
  .barra__t { font-weight:600; margin-right:auto; font-size:12px; }
  .barra button { font:inherit; font-size:12px; padding:5px 10px; border:0; border-radius:5px;
                  background:#475569; color:#fff; cursor:pointer; }
  .barra button:hover { background:#64748b; }
  .barra button[data-activo="si"] { background:#4f46e5; }
  .barra__e { font-size:11px; opacity:.75; }
  .lienzo { flex:1; overflow:auto; display:flex; justify-content:center; padding:16px; }
  iframe { background:#fff; border:1px solid #cbd5e1; border-radius:4px; height:100%; }
  .espera { margin:auto; color:#64748b; font-size:13px; text-align:center; }
</style>
</head>
<body>
  <div class="barra">
    <span class="barra__t">Preview del mailing</span>
    <span class="barra__e" id="estado">esperando el mail…</span>
    <button id="escritorio" data-activo="si">Escritorio</button>
    <button id="movil">Móvil</button>
    <button id="descargar">Descargar .html</button>
  </div>
  <div class="lienzo"><iframe id="vista" width="700" referrerpolicy="no-referrer"></iframe></div>
</body>`;

    function abrir() {
      if (estado.pestana && !estado.pestana.closed) {
        estado.pestana.focus();
        return true;
      }
      // Sin string de features, Chrome abre una PESTAÑA (con features abriría
      // una ventana). El pegado en consola cuenta como gesto de usuario.
      const t = window.open("", "acc-preview-tab");
      if (!t) {
        console.warn("[ACC Tab] El navegador bloqueó la pestaña. Permití popups y llamá a __accTab.abrir().");
        return false;
      }
      estado.pestana = t;
      t.document.documentElement.innerHTML = SHELL;

      const $ = (id) => t.document.getElementById(id);
      $("escritorio").onclick = () => fijarAncho(700);
      $("movil").onclick = () => fijarAncho(375);
      $("descargar").onclick = () => {
        if (!estado.ultimoHtml) return;
        const url = URL.createObjectURL(new Blob([estado.ultimoHtml], { type: "text/html" }));
        const a = t.document.createElement("a");
        a.href = url;
        a.download = "mailing-preview.html";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };

      if (estado.ultimoHtml) pintar(estado.ultimoHtml);
      return true;
    }

    function fijarAncho(px) {
      estado.ancho = px;
      const t = estado.pestana;
      if (!t || t.closed) return;
      t.document.getElementById("vista").width = px;
      t.document.getElementById("escritorio").dataset.activo = px === 700 ? "si" : "no";
      t.document.getElementById("movil").dataset.activo = px === 375 ? "si" : "no";
    }

    function pintar(html) {
      const t = estado.pestana;
      if (!t || t.closed) return;
      const vista = t.document.getElementById("vista");
      if (!vista) return;
      vista.srcdoc = html;
      vista.width = estado.ancho;
      t.document.getElementById("estado").textContent =
        new Date().toLocaleTimeString("es-PE") + " · " + Math.round(html.length / 1024) + " KB";
    }

    const onMensaje = (ev) => {
      // Solo se acepta el mail si viene del origen del canvas. Cualquier otro
      // frame de la página podría postear; sin este chequeo le creeríamos.
      if (ev.origin !== ORIGEN_CANVAS) return;
      const d = ev.data;
      if (!d || d.source !== CANAL || d.tipo !== "html" || typeof d.html !== "string") return;
      estado.recibidos++;
      estado.ultimoHtml = d.html;
      clearInterval(estado.timerPedido);
      pintar(d.html);
    };
    window.addEventListener("message", onMensaje);

    /** Pide el mail a todos los frames descendientes, por si el emisor ya corría. */
    function pedir(win = window, prof = 0) {
      if (prof > 5) return;
      for (let i = 0; i < win.frames.length; i++) {
        try {
          // El pedido no lleva datos, por eso '*' acá es inofensivo: no
          // sabemos de antemano en qué frame está el canvas.
          win.frames[i].postMessage({ source: CANAL, tipo: "pedido" }, "*");
          pedir(win.frames[i], prof + 1);
        } catch (e) {
          // frame cross-origin al que no podemos recorrer más adentro
        }
      }
    }

    window[NS] = {
      rol: "receptor",
      abrir,
      pedir,
      estado,
      destruir() {
        window.removeEventListener("message", onMensaje);
        clearInterval(estado.timerPedido);
        if (estado.pestana && !estado.pestana.closed) estado.pestana.close();
        delete window[NS];
        console.log("[ACC Tab] Receptor desmontado.");
      },
    };

    abrir();
    pedir();
    // Reintenta hasta que llegue el primer mail: cubre el caso de pegar el
    // emisor después, o de que el canvas todavía no hubiera cargado.
    estado.timerPedido = setInterval(pedir, 3000);

    console.log(
      "[ACC Tab] RECEPTOR activo en el frame top. Pestaña abierta.\n" +
      "Ahora cambiá el contexto de la consola a `iframe.html` y pegá este MISMO archivo."
    );
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Contexto equivocado
  // ══════════════════════════════════════════════════════════════════════════
  console.warn(
    "[ACC Tab] Este contexto no sirve: no es el frame `top` ni el canvas.\n" +
    "Usá el desplegable de contexto de la Console (segunda fila, a la izquierda del " +
    "buscador Filter) y elegí:\n" +
    "  1º `top`         → abre la pestaña\n" +
    "  2º `iframe.html` → manda el mail\n" +
    "Pegá este mismo archivo en los dos."
  );
})();
