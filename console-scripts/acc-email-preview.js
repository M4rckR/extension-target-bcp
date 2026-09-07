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
 *   .variantes()  tabla de bloques condicionales y cuál queda elegido
 *   .destruir()   corta la sincronización y saca el panel
 *
 * CONTENIDO CONDICIONAL
 * El mail tiene bloques que cambian según variables del perfil (header y footer
 * distintos por segmento). El editor deja TODAS las ramas en el DOM, así que si
 * no se podan se ven apiladas. El panel trae dos niveles de control:
 *
 *   - Escenario: un control por variable de condición. Elegir
 *     CODSUBSEGMENTO = M1N resuelve de una vez el header, el footer y todo lo
 *     que dependa de ella.
 *   - Bloques: un control por grupo, para forzar una rama a mano cuando la
 *     condición no se pudo parsear o se quiere ver una puntual.
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
    escenario: {},            // variable de condicion -> valor elegido
    manual: {},               // grupo -> id de variante forzada, o '__todas__'
    mostrarTodas: false,      // true = no podar nada, se ven todas las ramas
    verVariantes: true,       // mostrar el selector de variantes en el panel
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

  // ── 1 bis. Contenido dinámico: las variantes condicionales ─────────────────
  // El editor deja TODAS las ramas en el DOM, marcadas con atributos propios:
  //
  //   <div class="acr-dc-variant"
  //        acr-dc-variant-group="1778750287213"   ← agrupa las ramas del mismo condicional
  //        acr-dc-variant-index="1"               ← orden dentro del grupo
  //        acr-dc-variant-label="Header - Consumo"
  //        acr-dc-cond="targetData.CODSUBSEGMENTO == 'M1N'">
  //
  // Como están todas, la preview puede quedarse con una y descartar el resto,
  // que es lo que haría el mail real. Sin esto se ven todas apiladas.
  const SEL_VARIANTE = ".acr-dc-variant";

  /** Todas las variantes del mail, con sus atributos ya leídos. */
  function variantes() {
    const cont = contenedor();
    if (!cont) return [];
    return [...cont.querySelectorAll(SEL_VARIANTE)].map((el) => ({
      el,
      id: el.getAttribute("acr-dc-variant-id") || "",
      grupo: el.getAttribute("acr-dc-variant-group") || "",
      indice: Number(el.getAttribute("acr-dc-variant-index") || 0),
      etiqueta: el.getAttribute("acr-dc-variant-label") || "(sin nombre)",
      cond: el.getAttribute("acr-dc-cond") || "",
    }));
  }

  /** Map grupo → variantes ordenadas por índice. */
  function grupos() {
    const g = new Map();
    for (const v of variantes()) {
      if (!g.has(v.grupo)) g.set(v.grupo, []);
      g.get(v.grupo).push(v);
    }
    for (const arr of g.values()) arr.sort((a, b) => a.indice - b.indice);
    return g;
  }

  // Se parsean solo comparaciones simples `algo == 'valor'`. Alcanza para el
  // caso real (targetData.CODSUBSEGMENTO == 'M1N') y permite ofrecer un
  // selector por variable en vez de uno por bloque: elegir un valor resuelve
  // de una vez el header, el footer y todo lo que dependa de esa variable.
  // Las condiciones que no matchean quedan como "no evaluable" y se resuelven
  // a mano con el selector del grupo.
  const RE_COMPARACION = /([A-Za-z_$][\w.$]*)\s*(===?|!==?)\s*['"]([^'"]*)['"]/g;

  function parsearCond(cond) {
    const partes = [];
    RE_COMPARACION.lastIndex = 0;
    let m;
    while ((m = RE_COMPARACION.exec(cond))) {
      partes.push({ variable: m[1], negado: m[2][0] === "!", valor: m[3] });
    }
    // Si quedó texto con operadores lógicos que no entendemos, se avisa.
    const evaluable = partes.length > 0 && !/\|\||&&|\bor\b|\band\b/i.test(cond);
    return { partes, evaluable };
  }

  /** Variables detectadas en las condiciones, con sus valores posibles. */
  function variablesDetectadas() {
    const vars = new Map();
    for (const v of variantes()) {
      for (const p of parsearCond(v.cond).partes) {
        if (!vars.has(p.variable)) vars.set(p.variable, new Set());
        vars.get(p.variable).add(p.valor);
      }
    }
    return vars;
  }

  /**
   * Nombre legible de un valor de condición, deducido de las etiquetas.
   * El editor las escribe como "Header - Consumo" / "Header - Bex", así que el
   * tramo posterior al guion nombra el escenario: la variante con condición
   * `== 'M1N'` se llama "Consumo" y la de `== 'X1N'`, "Bex". Se deduce del mail
   * en vez de hardcodearlo, así sigue andando en otros mails y otras variables.
   * Devuelve "" si no se puede deducir, y ahí se muestra el valor crudo.
   */
  function nombreDeValor(variable, valor) {
    const nombres = new Set();
    for (const v of variantes()) {
      const coincide = parsearCond(v.cond).partes.some(
        (p) => p.variable === variable && !p.negado && p.valor === valor
      );
      if (!coincide) continue;
      const partes = v.etiqueta.split(" - ");
      if (partes.length > 1) nombres.add(partes.slice(1).join(" - ").trim());
    }
    return nombres.size === 1 ? " · " + [...nombres][0] : "";
  }

  /** ¿Esta variante aplica con el escenario elegido? */
  function aplica(v) {
    const { partes, evaluable } = parsearCond(v.cond);
    if (!evaluable) return false;
    return partes.every((p) => {
      const actual = estado.escenario[p.variable];
      if (actual === undefined) return false;
      return p.negado ? actual !== p.valor : actual === p.valor;
    });
  }

  /**
   * Qué variante se muestra de cada grupo. Prioridad:
   *   1. Elección manual del usuario para ese grupo.
   *   2. La primera cuya condición se cumple con el escenario.
   *   3. La que no tiene condición (rama por defecto / "si no").
   *   4. Ninguna — el grupo entero se oculta, que es lo que haría el mail real.
   */
  function elegidas() {
    const sel = new Map();
    for (const [grupo, arr] of grupos()) {
      const manual = estado.manual[grupo];
      if (manual === "__todas__") {
        sel.set(grupo, "__todas__");
      } else if (manual) {
        sel.set(grupo, manual);
      } else {
        const match = arr.find(aplica) || arr.find((v) => !v.cond.trim());
        sel.set(grupo, match ? match.id : null);
      }
    }
    return sel;
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

    // Dejar una sola variante por grupo, como haría el mail real. Si no se
    // podan, se ven todas las ramas apiladas (dos headers, dos footers…).
    if (!estado.mostrarTodas) {
      const sel = elegidas();
      for (const el of copia.querySelectorAll(SEL_VARIANTE)) {
        const grupo = el.getAttribute("acr-dc-variant-group") || "";
        const elegida = sel.get(grupo);
        if (elegida === "__todas__") continue;
        if (el.getAttribute("acr-dc-variant-id") !== elegida) el.remove();
      }
    }

    const base = String(document.baseURI || location.href).replace(/"/g, "&quot;");
    const css = clasificarEstilos()
      .filter((e) => e.llevar)
      .map((e) => e.css)
      .join("\n\n");

    return (
      '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
      // Sin referrer: si el servidor de las imágenes tiene protección
      // anti-hotlinking, un Referer del host del editor se las rechaza y salen
      // rotas. Bajado a disco no se manda referrer y ahí cargan bien — esto
      // reproduce ese comportamiento dentro de la preview.
      '<meta name="referrer" content="no-referrer">\n' +
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
    .vars { flex:none; max-height:32%; overflow:auto; background:#eef2ff;
            border-bottom:1px solid #c7d2fe; padding:7px 9px; }
    .vars__t { font-size:10px; font-weight:600; color:#4338ca; text-transform:uppercase;
               letter-spacing:.04em; margin-bottom:5px; }
    .vars__f { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
    .vars__f label { flex:1; font-size:11px; color:#1e293b; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap; }
    .vars__f select { flex:1; min-width:0; font:inherit; font-size:11px; padding:3px 4px;
                      border:1px solid #c7d2fe; border-radius:4px; background:#fff; }
    .vars__sep { border-top:1px dashed #c7d2fe; margin:6px 0 5px; }
    .vars__vacio { font-size:11px; color:#64748b; }
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
          <button id="verVars" data-activo="si">Variantes</button>
          <button id="refrescar">↻</button>
          <button id="copiar">Copiar</button>
          <button class="barra__x" id="cerrar">✕</button>
        </div>
        <div class="estado" id="estado"></div>
        <div class="vars" id="vars"></div>
        <div class="lienzo"><div class="escala" id="escala"><iframe id="vista" referrerpolicy="no-referrer"></iframe></div></div>
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
    $("verVars").onclick = () => {
      estado.verVariantes = !estado.verVariantes;
      $("verVars").dataset.activo = estado.verVariantes ? "si" : "no";
      pintarVariantes();
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

  /**
   * Dibuja el selector de variantes: arriba un control por variable de
   * condición (elegir un valor resuelve de una vez todos los bloques que
   * dependen de ella), abajo uno por grupo para forzar a mano cuando la
   * condición no se pudo parsear o se quiere ver una rama puntual.
   */
  function pintarVariantes() {
    if (!estado.host || !estado.host.isConnected) return;
    const sh = estado.host.shadowRoot;
    const caja = sh.getElementById("vars");
    if (!caja) return;

    if (!estado.verVariantes) {
      caja.style.display = "none";
      return;
    }
    caja.style.display = "";
    caja.textContent = "";

    const gs = grupos();
    if (!gs.size) {
      caja.innerHTML = '<div class="vars__vacio">Este mail no tiene bloques condicionales.</div>';
      return;
    }

    const vars = variablesDetectadas();
    const sel = elegidas();

    const titulo = (txt) => {
      const d = document.createElement("div");
      d.className = "vars__t";
      d.textContent = txt;
      caja.appendChild(d);
    };
    const fila = (etiqueta, tip) => {
      const f = document.createElement("div");
      f.className = "vars__f";
      const l = document.createElement("label");
      l.textContent = etiqueta;
      if (tip) l.title = tip;
      const s = document.createElement("select");
      f.appendChild(l);
      f.appendChild(s);
      caja.appendChild(f);
      return s;
    };

    // ── Escenario: un control por variable ──────────────────────────────────
    if (vars.size) {
      titulo("Escenario");
      for (const [variable, valores] of vars) {
        // Se muestra solo el último tramo (CODSUBSEGMENTO en vez de
        // targetData.CODSUBSEGMENTO); el nombre completo va en el tooltip.
        const corto = variable.split(".").pop();
        const s = fila(corto, variable);
        const opciones = [["", "(sin definir)"]].concat(
          [...valores].sort().map((v) => [v, v + nombreDeValor(variable, v)])
        );
        for (const [valor, texto] of opciones) {
          const o = document.createElement("option");
          o.value = valor;
          o.textContent = texto;
          if ((estado.escenario[variable] || "") === valor) o.selected = true;
          s.appendChild(o);
        }
        s.onchange = (e) => {
          const v = e.target.value;
          if (v) estado.escenario[variable] = v;
          else delete estado.escenario[variable];
          // Elegir un escenario invalida las elecciones manuales previas:
          // si no, el manual ganaría y parecería que el escenario no hace nada.
          estado.manual = {};
          refrescar();
        };
      }
    }

    // ── Bloques: un control por grupo, para forzar a mano ───────────────────
    const sep = document.createElement("div");
    sep.className = "vars__sep";
    caja.appendChild(sep);
    titulo("Bloques (" + gs.size + ")");

    for (const [grupo, arr] of gs) {
      const activa = sel.get(grupo);
      const nombre = (arr[0].etiqueta || "").split(" - ")[0] || "Bloque";
      const s = fila(nombre, arr.map((v) => v.etiqueta + (v.cond ? " · " + v.cond : "")).join("\n"));

      const opciones = [["", "auto"]]
        .concat(arr.map((v) => [v.id, v.etiqueta]))
        .concat([["__todas__", "todas"], ["__ninguna__", "ocultar"]]);

      for (const [valor, texto] of opciones) {
        const o = document.createElement("option");
        o.value = valor;
        // En "auto" se aclara qué quedó elegido, para no tener que adivinar.
        if (!valor) {
          const elegida = arr.find((v) => v.id === activa);
          o.textContent = "auto → " + (elegida ? elegida.etiqueta : "ninguna");
        } else {
          o.textContent = texto;
        }
        if ((estado.manual[grupo] || "") === valor) o.selected = true;
        s.appendChild(o);
      }

      s.onchange = (e) => {
        const v = e.target.value;
        if (!v) delete estado.manual[grupo];
        else estado.manual[grupo] = v;
        refrescar();
      };
    }
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
    pintarVariantes();
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

  /** Diagnóstico: qué variantes hay, su condición y cuál queda elegida. */
  function infoVariantes() {
    const sel = elegidas();
    const filas = [];
    for (const [grupo, arr] of grupos()) {
      for (const v of arr) {
        const { evaluable } = parsearCond(v.cond);
        filas.push({
          grupo,
          indice: v.indice,
          etiqueta: v.etiqueta,
          cond: v.cond,
          evaluable,
          elegida: sel.get(grupo) === v.id || sel.get(grupo) === "__todas__",
        });
      }
    }
    console.table(filas);
    console.log("Escenario:", estado.escenario, "| Manual:", estado.manual);
    return filas;
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

  window[NS] = { abrir, refrescar, html: extraer, estilos, variantes: infoVariantes, destruir, estado };

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
