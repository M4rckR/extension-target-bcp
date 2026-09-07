/**
 * Adobe Campaign Classic — Preview del mailing en una pestaña aparte
 * -------------------------------------------------------------------
 * Alternativa a `acc-email-preview.js` (que muestra la preview en un panel
 * acoplado dentro del canvas). Esta versión la saca a una pestaña del navegador.
 *
 * POR QUÉ HACEN FALTA DOS PEGADOS
 * El iframe del canvas está sandboxeado sin `allow-popups`, así que desde
 * adentro no se puede abrir ni ventana ni pestaña — para el navegador son lo
 * mismo. Pero el sandbox NO bloquea `postMessage`, y los frames de arriba no
 * están sandboxeados. Entonces:
 *
 *   canvas (sandboxeado)          frame de arriba (sin sandbox)
 *     extrae el HTML  ──postMessage──►  lo escribe en la pestaña que abrió
 *     en cada edición
 *
 * ES UN SOLO ARCHIVO, SE PEGA DOS VECES
 * Detecta solo en qué contexto está y toma el rol que corresponde, así no hay
 * que acordarse de qué script va en qué lado:
 *
 *   1. Un frame que NO sea el canvas → rol RECEPTOR. Abre la pestaña (el pegado
 *      en consola cuenta como gesto de usuario) y se queda escuchando.
 *   2. Contexto `iframe.html` → rol EMISOR. Extrae el mail y lo manda al
 *      receptor en cada edición.
 *
 * QUÉ FRAME ELEGIR PARA EL RECEPTOR — Y POR QUÉ IMPORTA
 * La pestaña hereda la CSP del frame que la abrió. Con `top`
 * (experience.adobe.com) el mail se ve pero **las imágenes salen rotas**: su
 * política restringe `img-src`. Verificado en vivo.
 *
 * Por eso el receptor funciona desde cualquier frame, para poder recorrer la
 * cadena hasta dar con uno cuya política deje cargar las imágenes:
 *
 *   top                                      experience.adobe.com  <- imagenes rotas
 *   +- Main Content (pixel-acrites-ui)       experience.adobe.com
 *      +- Main Content (campaign-acc-web-ui) cdn.experience.adobe.net  <- otro origen
 *         +- iframe.html                     acrites-ui-iframe...   <- el canvas
 *
 * Cuando llega el mail, la pestaña informa cuántas imágenes cargaron. Si no
 * cargan todas, ese frame no sirve: probar el receptor en otro.
 *
 * SEGURIDAD
 * El emisor responde únicamente a quien le pidió, dirigido a su origen exacto y
 * nunca con `'*'`, y solo si ese origen es un dominio de Adobe. El receptor
 * descarta cualquier mensaje que no venga del origen del canvas.
 *
 * CONTENIDO CONDICIONAL
 * El mail tiene bloques que cambian según variables del perfil. El emisor manda
 * el mail ENTERO, con todas las ramas, y el filtrado se hace del lado de la
 * pestaña, que es donde está la interfaz: así no hace falta un canal de vuelta
 * para avisarle al canvas qué escenario se eligió. En la barra de la pestaña
 * aparece un control por variable de condición (elegir CODSUBSEGMENTO = M1N
 * resuelve header, footer y todo lo que dependa de ella) y uno por bloque para
 * forzar una rama a mano.
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
  const ORIGEN_CANVAS = "https://acrites-ui-iframe.experience.adobe.net";
  const SEL_CONTENEDOR = ".acr-container";

  // El HTML del mail solo se manda a frames de Adobe. El receptor puede vivir
  // en cualquiera de los tres frames de la cadena, así que no se puede fijar un
  // origen único: se valida el dominio.
  const ORIGEN_VALIDO = /^https:\/\/[a-z0-9.-]+\.adobe\.(com|net)$/;

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

    // Destinos = los frames que pidieron el mail. No se fija uno de antemano
    // porque el receptor puede estar en cualquier frame de la cadena: la CSP
    // de la pestaña la define quien la abre, así que hay que poder probar en
    // varios hasta dar con uno cuya política deje cargar las imágenes.
    const estado = { observer: null, timer: null, enviados: 0, destinos: [] };

    function enviar() {
      const html = extraer();
      if (!html || !estado.destinos.length) return false;
      for (const d of estado.destinos) {
        try {
          // Siempre dirigido al origen exacto del que pidió, nunca '*': el HTML
          // del mail no debe quedar legible para cualquier otro frame.
          d.win.postMessage({ source: CANAL, tipo: "html", html }, d.origen);
          estado.enviados++;
        } catch (e) {
          // frame cerrado o inaccesible — se ignora, el receptor reintenta
        }
      }
      return true;
    }

    // El receptor pide los datos al arrancar. El pedido no lleva contenido, así
    // que aceptarlo no filtra nada; lo que sí importa es a quién le respondemos.
    const onPedido = (ev) => {
      const d = ev.data;
      if (!d || d.source !== CANAL || d.tipo !== "pedido") return;
      if (!ORIGEN_VALIDO.test(ev.origin)) {
        console.warn("[ACC Tab] Pedido descartado, origen no reconocido:", ev.origin);
        return;
      }
      if (!estado.destinos.some((x) => x.win === ev.source)) {
        estado.destinos.push({ win: ev.source, origen: ev.origin });
        console.log("[ACC Tab] Nuevo destino registrado:", ev.origin);
      }
      enviar();
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

    console.log(
      "[ACC Tab] EMISOR activo en el canvas. Esperando que un receptor pida el mail.\n" +
      "Si la pestaña no muestra nada, pegá este mismo archivo en el contexto del frame " +
      "que abrió la pestaña."
    );
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROL RECEPTOR — corre en el frame top
  // ══════════════════════════════════════════════════════════════════════════
  // Corre en cualquier frame que no sea el canvas. NO se exige que sea `top`:
  // la pestaña hereda la CSP del frame que la abre, y la de experience.adobe.com
  // bloquea las imágenes del mail. Probando desde el frame intermedio
  // (cdn.experience.adobe.net) la política puede ser otra.
  {
    const estado = {
      pestana: null,
      ancho: 700,
      recibidos: 0,
      ultimoHtml: null,
      timerPedido: null,
      origen: location.origin,
      escenario: {},   // variable de condición -> valor elegido
      manual: {},      // grupo -> id de variante forzada, o '__todas__'
    };

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
  .vars { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:7px 12px;
          background:#eef2ff; border-bottom:1px solid #c7d2fe; flex:none; }
  .vars:empty { display:none; }
  .vars__g { display:flex; align-items:center; gap:5px; }
  .vars__g label { font-size:11px; color:#4338ca; font-weight:600; }
  .vars__g select { font:inherit; font-size:11px; padding:3px 5px; border:1px solid #c7d2fe;
                    border-radius:4px; background:#fff; color:#1e293b; }
  .lienzo { flex:1; overflow:auto; display:flex; justify-content:center; padding:16px; }
  iframe { background:#fff; border:1px solid #cbd5e1; border-radius:4px; height:100%; }
  .espera { margin:auto; color:#64748b; font-size:13px; text-align:center; }
</style>
</head>
<body>
  <div class="barra">
    <span class="barra__t">Preview del mailing</span>
    <span class="barra__e" id="estado">esperando el mail…</span>
    <span class="barra__e" id="imgs"></span>
    <button id="escritorio" data-activo="si">Escritorio</button>
    <button id="movil">Móvil</button>
    <button id="descargar">Descargar .html</button>
  </div>
  <div class="vars" id="vars"></div>
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
        const r = htmlPodado();
        if (!r) return;
        const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
        const a = t.document.createElement("a");
        a.href = url;
        a.download = "mailing-preview.html";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };

      if (estado.ultimoHtml) render();
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

    // ── Contenido condicional ───────────────────────────────────────────────
    // El emisor manda el mail ENTERO, con todas las ramas: el filtrado se hace
    // acá, del lado de la pestaña, que es donde está la interfaz. Así no hace
    // falta un canal de vuelta para avisarle al canvas qué escenario se eligió.
    // La lógica es la misma que la de acc-email-preview.js, pero aplicada sobre
    // un documento parseado en vez de sobre el DOM vivo.
    const RE_COMPARACION = /([A-Za-z_$][\w.$]*)\s*(===?|!==?)\s*['"]([^'"]*)['"]/g;

    const parsearCond = (cond) => {
      const partes = [];
      RE_COMPARACION.lastIndex = 0;
      let m;
      while ((m = RE_COMPARACION.exec(cond))) {
        partes.push({ variable: m[1], negado: m[2][0] === "!", valor: m[3] });
      }
      return { partes, evaluable: partes.length > 0 && !/\|\||&&|\bor\b|\band\b/i.test(cond) };
    };

    const leerVariantes = (doc) =>
      [...doc.querySelectorAll(".acr-dc-variant")].map((el) => ({
        id: el.getAttribute("acr-dc-variant-id") || "",
        grupo: el.getAttribute("acr-dc-variant-group") || "",
        indice: Number(el.getAttribute("acr-dc-variant-index") || 0),
        etiqueta: el.getAttribute("acr-dc-variant-label") || "(sin nombre)",
        cond: el.getAttribute("acr-dc-cond") || "",
      }));

    function agrupar(vs) {
      const g = new Map();
      for (const v of vs) {
        if (!g.has(v.grupo)) g.set(v.grupo, []);
        g.get(v.grupo).push(v);
      }
      for (const arr of g.values()) arr.sort((a, b) => a.indice - b.indice);
      return g;
    }

    const aplica = (v) => {
      const { partes, evaluable } = parsearCond(v.cond);
      if (!evaluable) return false;
      return partes.every((p) => {
        const actual = estado.escenario[p.variable];
        if (actual === undefined) return false;
        return p.negado ? actual !== p.valor : actual === p.valor;
      });
    };

    /** Qué variante queda de cada grupo: manual > condición > sin condición > ninguna. */
    function elegidas(vs) {
      const sel = new Map();
      for (const [grupo, arr] of agrupar(vs)) {
        const manual = estado.manual[grupo];
        if (manual) sel.set(grupo, manual);
        else {
          const match = arr.find(aplica) || arr.find((v) => !v.cond.trim());
          sel.set(grupo, match ? match.id : null);
        }
      }
      return sel;
    }

    /**
     * Nombre legible de un valor, deducido de las etiquetas: el editor las
     * escribe como "Header - Consumo", así que el tramo tras el guion nombra el
     * escenario. Se deduce del mail en vez de hardcodearlo.
     */
    function nombreDeValor(vs, variable, valor) {
      const nombres = new Set();
      for (const v of vs) {
        const coincide = parsearCond(v.cond).partes.some(
          (p) => p.variable === variable && !p.negado && p.valor === valor
        );
        if (!coincide) continue;
        const partes = v.etiqueta.split(" - ");
        if (partes.length > 1) nombres.add(partes.slice(1).join(" - ").trim());
      }
      return nombres.size === 1 ? " · " + [...nombres][0] : "";
    }

    /** Dibuja los selectores en la barra de la pestaña. */
    function pintarVars(vs) {
      const t = estado.pestana;
      if (!t || t.closed) return;
      const caja = t.document.getElementById("vars");
      if (!caja) return;
      caja.textContent = "";
      if (!vs.length) return;

      const gs = agrupar(vs);
      const sel = elegidas(vs);

      const control = (etiqueta, tip) => {
        const d = t.document.createElement("div");
        d.className = "vars__g";
        const l = t.document.createElement("label");
        l.textContent = etiqueta;
        if (tip) l.title = tip;
        const s = t.document.createElement("select");
        d.appendChild(l);
        d.appendChild(s);
        caja.appendChild(d);
        return s;
      };
      const opcion = (s, valor, texto, elegido) => {
        const o = t.document.createElement("option");
        o.value = valor;
        o.textContent = texto;
        if (elegido) o.selected = true;
        s.appendChild(o);
      };

      // Escenario: un control por variable de condición.
      const vars = new Map();
      for (const v of vs) {
        for (const p of parsearCond(v.cond).partes) {
          if (!vars.has(p.variable)) vars.set(p.variable, new Set());
          vars.get(p.variable).add(p.valor);
        }
      }
      for (const [variable, valores] of vars) {
        const s = control(variable.split(".").pop(), variable);
        opcion(s, "", "(sin definir)", !estado.escenario[variable]);
        for (const val of [...valores].sort()) {
          opcion(s, val, val + nombreDeValor(vs, variable, val), estado.escenario[variable] === val);
        }
        s.onchange = (e) => {
          if (e.target.value) estado.escenario[variable] = e.target.value;
          else delete estado.escenario[variable];
          estado.manual = {}; // el escenario manda: si no, lo manual lo taparía
          render();
        };
      }

      // Bloques: forzar una rama a mano.
      for (const [grupo, arr] of gs) {
        const activa = sel.get(grupo);
        const s = control(
          (arr[0].etiqueta || "Bloque").split(" - ")[0],
          arr.map((v) => v.etiqueta + (v.cond ? " · " + v.cond : "")).join("\n")
        );
        const elegida = arr.find((v) => v.id === activa);
        opcion(s, "", "auto → " + (elegida ? elegida.etiqueta : "ninguna"), !estado.manual[grupo]);
        for (const v of arr) opcion(s, v.id, v.etiqueta, estado.manual[grupo] === v.id);
        opcion(s, "__todas__", "todas", estado.manual[grupo] === "__todas__");
        opcion(s, "__ninguna__", "ocultar", estado.manual[grupo] === "__ninguna__");
        s.onchange = (e) => {
          if (!e.target.value) delete estado.manual[grupo];
          else estado.manual[grupo] = e.target.value;
          render();
        };
      }
    }

    /**
     * El HTML tal como quedaría en el mail real: una sola rama por grupo.
     * Lo usa tanto el render como el botón de descargar, para que el archivo
     * bajado sea el escenario que se está viendo y no el mail con todo apilado.
     */
    function htmlPodado() {
      if (!estado.ultimoHtml) return null;
      const doc = new DOMParser().parseFromString(estado.ultimoHtml, "text/html");
      const vs = leerVariantes(doc);

      if (vs.length) {
        const sel = elegidas(vs);
        for (const el of doc.querySelectorAll(".acr-dc-variant")) {
          const grupo = el.getAttribute("acr-dc-variant-group") || "";
          const elegida = sel.get(grupo);
          if (elegida === "__todas__") continue;
          if (el.getAttribute("acr-dc-variant-id") !== elegida) el.remove();
        }
      }
      return { html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML, variantes: vs };
    }

    function render() {
      const r = htmlPodado();
      if (!r) return;
      pintarVars(r.variantes);
      pintar(r.html);
    }

    function pintar(html) {
      const t = estado.pestana;
      if (!t || t.closed) return;
      const vista = t.document.getElementById("vista");
      if (!vista) return;

      // Contar imágenes cargadas es el dato que decide si este frame sirve:
      // si la CSP heredada bloquea img-src, el mail se ve pero salen todas
      // rotas. El srcdoc hereda el origen del padre, así que se puede inspeccionar.
      vista.onload = () => {
        setTimeout(() => {
          let ok = 0;
          let total = 0;
          try {
            const imgs = vista.contentDocument.images;
            total = imgs.length;
            for (const im of imgs) if (im.complete && im.naturalWidth > 0) ok++;
          } catch (e) {
            // no se pudo inspeccionar — se deja el conteo en 0
          }
          const veredicto = total === 0 ? "sin imágenes" : ok + "/" + total + " imágenes";
          const e = t.document.getElementById("imgs");
          if (e) {
            e.textContent = veredicto;
            e.style.color = total && ok === total ? "#4ade80" : "#fca5a5";
          }
          console.log(
            "[ACC Tab] Abierta desde " + estado.origen + " → " + veredicto +
            (total && ok < total
              ? "\n  La CSP de este frame bloquea las imágenes. Probá pegar el receptor en otro frame."
              : "")
          );
        }, 1500); // margen para que terminen de pedirse
      };

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
      render();
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
      "[ACC Tab] RECEPTOR activo en " + estado.origen + ". Pestaña abierta.\n" +
      "Ahora cambiá el contexto de la consola a `iframe.html` y pegá este MISMO archivo.\n" +
      "Cuando llegue el mail se informa cuántas imágenes cargaron: si no cargan todas, " +
      "la CSP de este frame las bloquea y hay que probar el receptor en otro frame."
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
