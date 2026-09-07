/**
 * Reconocimiento 4 — contenido condicional / dinámico
 * ---------------------------------------------------
 * El mail tiene bloques que se muestran o no según variables (header, footer,
 * etc.). El objetivo es poder alternar entre las ramas desde la preview.
 *
 * LA PREGUNTA QUE DECIDE SI SE PUEDE
 * ¿Están las dos ramas en el DOM, una de ellas oculta, o el editor renderiza
 * únicamente la activa?
 *
 *   - Las dos en el DOM  → se puede alternar del lado del cliente.
 *   - Solo la activa     → el HTML de la otra rama no existe donde podemos
 *                          leerlo, y hay que buscarlo en otro lado.
 *
 * Pista que ya teníamos: entre las hojas del editor está
 * `acd-plugin-dynamic-content-acc-iframe.css`, así que hay un plugin de
 * contenido dinámico. Falta ver con qué marca el DOM.
 *
 * QUÉ MIRA
 *   1. Todos los nombres de atributo usados dentro del mail — ahí van a
 *      aparecer los `data-*` con los que el plugin marca los bloques.
 *   2. Elementos ocultos (display:none, [hidden], visibility:hidden): si una
 *      rama está en el DOM pero no se ve, va a estar acá.
 *   3. Nodos comentario: ACC usa sintaxis `<%...%>` para personalización, y el
 *      editor podría guardarla como comentario.
 *   4. Rastros de `<%` / `%>` en el HTML.
 *   5. Clases `acr-*` / `acd-*` dentro del mail.
 *
 * PRIVACIDAD — LEER ANTES DE COMPARTIR
 * A diferencia de los recon anteriores, este SÍ muestra algunos valores: los de
 * los atributos que parecen del plugin dinámico, recortados a 120 caracteres.
 * Es necesario para entender cómo se expresa la condición, pero esos valores
 * pueden nombrar campos del perfil (por ejemplo `recipient.segmento`). No trae
 * datos de clientes, pero **revisá la salida antes de pegarla en ningún lado**,
 * y más siendo un repo público.
 *
 * Uso:
 *   1. Consola en el contexto `iframe.html` / `acrites-ui-iframe...`.
 *   2. Abrir un mail que TENGA un bloque condicional.
 *   3. Pegar → Enter → copy(__recon5)
 */
(() => {
  "use strict";

  const cont = document.querySelector(".acr-container");
  if (!cont) {
    console.warn(
      "[Recon condicionales] No se encontró .acr-container.\n" +
      "¿Está la consola en el contexto `iframe.html` / `acrites-ui-iframe...`?"
    );
    return;
  }

  const o = { origen: location.pathname };
  const corto = (v, n) => String(v == null ? "" : v).slice(0, n);
  const todos = [...cont.querySelectorAll("*")];
  o.elementos = todos.length;

  // ── 1. Nombres de atributo usados dentro del mail ──────────────────────────
  // Solo nombres y conteos. Acá deberían asomar los marcadores del plugin.
  const attrs = {};
  for (const el of todos) {
    for (const a of el.attributes) attrs[a.name] = (attrs[a.name] || 0) + 1;
  }
  o.atributos = Object.entries(attrs).sort((a, b) => b[1] - a[1]);

  // ── 2. Atributos que parecen del plugin dinámico, CON valor ────────────────
  // Es lo único que muestra valores. Sin esto no se puede saber cómo se
  // expresa la condición ni cómo se relacionan las ramas entre sí.
  const RE_INTERESANTE = /acd|acr|dynamic|condition|conditional|variant|block|perso|target|rule/i;
  o.marcadores = [];
  for (const el of todos) {
    for (const a of el.attributes) {
      if (a.name === "class" || a.name === "style" || a.name === "id") continue;
      if (!RE_INTERESANTE.test(a.name)) continue;
      o.marcadores.push({
        tag: el.tagName.toLowerCase(),
        attr: a.name,
        valor: corto(a.value, 120),
        oculto: !el.offsetParent && getComputedStyle(el).display === "none",
      });
    }
  }
  o.marcadores = o.marcadores.slice(0, 60);

  // ── 3. Elementos ocultos ───────────────────────────────────────────────────
  // Si la rama inactiva está en el DOM pero no se ve, aparece acá.
  o.ocultos = [];
  for (const el of todos) {
    const cs = getComputedStyle(el);
    const oculto = cs.display === "none" || cs.visibility === "hidden" || el.hasAttribute("hidden");
    if (!oculto) continue;
    o.ocultos.push({
      tag: el.tagName.toLowerCase(),
      clase: corto(el.className, 60),
      id: el.id || "",
      motivo: el.hasAttribute("hidden") ? "[hidden]" : cs.display === "none" ? "display:none" : "visibility",
      htmlLen: el.innerHTML.length,
      tablas: el.querySelectorAll("table").length,
    });
  }
  o.ocultosTotal = o.ocultos.length;
  o.ocultos = o.ocultos.slice(0, 40);

  // ── 4. Nodos comentario ────────────────────────────────────────────────────
  // ACC usa <% ... %> para personalización; el editor podría dejarlo como
  // comentario en el DOM. Se recortan a 150 caracteres.
  o.comentarios = [];
  const tw = document.createTreeWalker(cont, NodeFilter.SHOW_COMMENT);
  let n;
  while ((n = tw.nextNode())) o.comentarios.push(corto(n.nodeValue, 150));
  o.comentariosTotal = o.comentarios.length;
  o.comentarios = o.comentarios.slice(0, 30);

  // ── 5. Rastros de sintaxis de personalización ──────────────────────────────
  const html = cont.innerHTML;
  o.sintaxis = {
    aperturas: (html.match(/<%/g) || []).length,
    cierres: (html.match(/%>/g) || []).length,
    llaves: (html.match(/\{\{/g) || []).length,
  };

  // ── 6. Clases del editor dentro del mail ───────────────────────────────────
  const clases = {};
  for (const el of todos) {
    const cn = el.className;
    if (cn && cn.split) {
      for (const k of cn.split(/\s+/)) {
        if (k && /^(acr|acd)-/.test(k)) clases[k] = (clases[k] || 0) + 1;
      }
    }
  }
  o.clasesEditor = Object.entries(clases).sort((a, b) => b[1] - a[1]);

  // ── Salida ─────────────────────────────────────────────────────────────────
  console.groupCollapsed("[Recon condicionales]");
  console.log("Atributos usados:");
  console.table(o.atributos.map(([nombre, veces]) => ({ nombre, veces })));
  if (o.marcadores.length) {
    console.log("Marcadores del plugin dinámico:");
    console.table(o.marcadores);
  }
  if (o.ocultos.length) {
    console.log("Elementos ocultos (¿ramas inactivas?):");
    console.table(o.ocultos);
  }
  console.log("Clases del editor:", o.clasesEditor);
  console.log("Comentarios:", o.comentariosTotal, "| Sintaxis <% %>:", o.sintaxis);
  console.groupEnd();

  window.__recon5 = JSON.stringify(o, null, 1);
  console.log("Copia con:  copy(__recon5)   — revisá la salida antes de compartirla");
  return o;
})();
