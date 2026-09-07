/**
 * Reconocimiento 2 — el contenedor del mail y de dónde salen los estilos
 * ----------------------------------------------------------------------
 * Segunda pasada, para correr DESPUÉS de `recon.js`, ya sabiendo que el canvas
 * de Campaign Classic es el documento del iframe `acrites-ui-iframe` y que el
 * mail está armado con divs `.acr-fragment.acr-component`.
 *
 * Contesta las dos preguntas que definen si la preview es viable:
 *
 *   1. ¿Cuál es el contenedor que envuelve a TODOS los fragmentos?
 *      Es lo que hay que clonar para la preview — no los fragmentos sueltos.
 *      Se calcula subiendo desde el primer fragmento hasta el primer ancestro
 *      que los contenga a todos.
 *
 *   2. ¿Los estilos son inline o del editor?
 *      Si el mail trae sus estilos en atributos `style` (lo normal en emails),
 *      la preview sale fiel. Si dependen de la hoja CSS del editor, al sacar el
 *      HTML afuera se ve sin estilos y hay que buscar el HTML fuente en otro
 *      lado — por eso también se listan textareas e inputs ocultos grandes,
 *      que es donde las apps suelen guardar el HTML crudo.
 *
 * Solo lectura, igual que `recon.js`, y con el mismo criterio de privacidad:
 * cuenta atributos `style` pero no lee sus valores, de las hojas de estilo
 * reporta largo y URL pero no el CSS, y de los campos de texto solo el largo.
 *
 * Uso:
 *   1. DevTools → Console → desplegable de contexto (dice "top" o
 *      "Main Content") → elegir `iframe.html` / `acrites-ui-iframe...`.
 *   2. Pegar este archivo → Enter.
 *   3. copy(__recon3)
 */
(() => {
  "use strict";

  const o = { origen: location.origin + location.pathname };

  const corto = (v, n) => String(v == null ? "" : v).slice(0, n);

  // ── 1. Los fragmentos y su contenedor común ────────────────────────────────
  const F = [...document.querySelectorAll(".acr-fragment")];
  o.fragmentos = F.length;

  // Sube desde el primer fragmento hasta el primer ancestro que los tenga a todos.
  let c = F[0];
  while (c && !F.every((f) => c.contains(f))) c = c.parentElement;

  const info = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      clase: corto(el.className, 100),
      tam: Math.round(r.width) + "x" + Math.round(r.height),
      htmlLen: el.innerHTML.length,
      tablas: el.querySelectorAll("table").length,
      imgs: el.querySelectorAll("img").length,
      conStyleAttr: el.querySelectorAll("[style]").length, // ← pregunta 2
      styleTags: el.querySelectorAll("style").length,
      total: el.querySelectorAll("*").length,
    };
  };

  o.contenedor = info(c);

  // Cadena de ancestros hasta <body>, para ubicar el contenedor en el árbol.
  o.cadena = [];
  let p = c;
  let n = 0;
  while (p && p !== document.body && n++ < 10) {
    o.cadena.push({ tag: p.tagName.toLowerCase(), id: p.id || "", clase: corto(p.className, 80) });
    p = p.parentElement;
  }

  o.body = {
    clase: corto(document.body.className, 100),
    htmlLen: document.body.innerHTML.length,
    total: document.querySelectorAll("*").length,
  };

  // ── 2. De dónde salen los estilos ──────────────────────────────────────────
  // Largo de cada <style> y URL de cada hoja externa: si el peso está acá y no
  // en atributos inline, el mail depende del CSS del editor.
  o.hojas = {
    styleTags: [...document.querySelectorAll("style")].map((s) => (s.textContent || "").length),
    links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
      String(l.href).split("?")[0]
    ),
  };

  // Clases más usadas dentro de los fragmentos: si son casi todas `acr-*`, el
  // HTML renderizado está lleno de marcas del editor y no es reusable tal cual.
  const cls = {};
  for (const f of F) {
    for (const el of f.querySelectorAll("*")) {
      const cn = el.className;
      if (cn && cn.split) {
        for (const k of cn.split(/\s+/)) if (k) cls[k] = (cls[k] || 0) + 1;
      }
    }
  }
  o.clasesTop = Object.entries(cls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // ── 3. ¿Hay HTML crudo guardado en algún campo? ────────────────────────────
  o.textareas = [...document.querySelectorAll("textarea")].map((t) => ({
    id: t.id || "",
    clase: corto(t.className, 50),
    len: (t.value || "").length,
  }));
  o.ocultosGrandes = [...document.querySelectorAll('input[type="hidden"]')]
    .map((i) => ({ id: i.id || "", len: (i.value || "").length }))
    .filter((x) => x.len > 500);

  // ── Salida ─────────────────────────────────────────────────────────────────
  console.log(o);
  window.__recon3 = JSON.stringify(o, null, 1);
  console.log("Copia con:  copy(__recon3)");
  return o;
})();
