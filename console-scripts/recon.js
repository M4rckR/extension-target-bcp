/**
 * Reconocimiento del DOM — Adobe Email Designer
 * ---------------------------------------------
 * Script de solo lectura para mapear la estructura de la página antes de
 * escribir la detección del canvas. NO modifica nada, no hace pedidos de red,
 * no abre ventanas.
 *
 * Reporta ESTRUCTURA, no contenido: el esqueleto que genera borra todos los
 * nodos de texto y todos los atributos salvo class/id, así que no salen ni el
 * texto del mailing, ni URLs de imágenes, ni alt, ni datos de clientes.
 *
 * Uso:
 *   1. Abrir el mailing en el Email Designer.
 *   2. DevTools → Console → pegar este archivo → Enter.
 *      (Chrome pide escribir "allow pasting" la primera vez.)
 *   3. copy(__recon)   → deja el reporte JSON en el portapapeles.
 */
(() => {
  "use strict";

  const out = {
    origen: location.origin + location.pathname,
    // el hash de las apps de Adobe lleva tenant y sandbox — se recorta
    hash: location.hash.slice(0, 120),
    frames: [],
    editables: [],
    customEls: [],
  };

  // ── Recorrido: document + todos los shadow roots ───────────────────────────
  function raices(raiz, prof = 0, acc = []) {
    if (prof > 10 || acc.indexOf(raiz) !== -1) return acc;
    acc.push(raiz);
    let els;
    try {
      els = raiz.querySelectorAll("*");
    } catch (e) {
      return acc;
    }
    for (const el of els) if (el.shadowRoot) raices(el.shadowRoot, prof + 1, acc);
    return acc;
  }

  // ── Esqueleto anonimizado: solo tags + class/id, sin texto ─────────────────
  function esqueleto(el, limite = 400) {
    try {
      const c = el.cloneNode(true);
      const limpiar = (n) => {
        for (const hijo of [...n.childNodes]) {
          if (hijo.nodeType === 3 || hijo.nodeType === 8) hijo.remove();
          else if (hijo.nodeType === 1) {
            for (const attr of [...hijo.attributes]) {
              if (attr.name !== "class" && attr.name !== "id") hijo.removeAttribute(attr.name);
            }
            limpiar(hijo);
          }
        }
      };
      limpiar(c);
      for (const attr of [...c.attributes]) {
        if (attr.name !== "class" && attr.name !== "id") c.removeAttribute(attr.name);
      }
      return c.outerHTML.replace(/\s+/g, " ").slice(0, limite);
    } catch (e) {
      return "(no se pudo)";
    }
  }

  const corto = (v, n) => String(v == null ? "" : v).slice(0, n);

  // ── Inventario de iframes (incluye anidados y los de dentro de shadow DOM) ─
  function escanear(doc, ruta, prof) {
    if (prof > 4) return;
    for (const r of raices(doc)) {
      let marcos;
      try {
        marcos = r.querySelectorAll("iframe, frame");
      } catch (e) {
        continue;
      }
      for (const f of marcos) {
        let d = null;
        let err = null;
        try {
          d = f.contentDocument;
          if (!d) err = "contentDocument nulo";
        } catch (e) {
          err = "cross-origin";
        }

        const rc = f.getBoundingClientRect();
        const e = {
          ruta,
          id: f.id || "",
          clase: corto(f.className, 80),
          titulo: corto(f.getAttribute("title"), 60),
          // solo el origen+path del src, sin query string (puede llevar tokens)
          src: corto((f.getAttribute("src") || "").split("?")[0], 100),
          tam: Math.round(rc.width) + "x" + Math.round(rc.height),
          accesible: !!d,
          err,
        };

        if (d) {
          e.htmlLen = ((d.documentElement && d.documentElement.outerHTML) || "").length;
          e.tablas = d.querySelectorAll("table").length;
          e.tds = d.querySelectorAll("td").length;
          e.imgs = d.querySelectorAll("img").length;
          e.editables = d.querySelectorAll("[contenteditable]").length;
          e.esqueleto = d.body ? esqueleto(d.body) : "";
        }

        out.frames.push(e);
        if (d) escanear(d, ruta + " > iframe" + (f.id ? "#" + f.id : ""), prof + 1);
      }
    }
  }

  escanear(document, "top", 0);

  // ── Custom elements presentes (para saber con qué está hecha la UI) ────────
  const tags = new Set();
  for (const r of raices(document)) {
    try {
      for (const el of r.querySelectorAll("*")) {
        if (el.tagName.indexOf("-") !== -1) tags.add(el.tagName.toLowerCase());
      }
    } catch (e) {}
  }
  out.customEls = [...tags].sort().slice(0, 60);

  // ── contenteditable sueltos: por si el canvas NO es un iframe ──────────────
  for (const r of raices(document)) {
    try {
      for (const el of r.querySelectorAll('[contenteditable="true"], [contenteditable=""]')) {
        const rc = el.getBoundingClientRect();
        out.editables.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          clase: corto(el.className, 60),
          tam: Math.round(rc.width) + "x" + Math.round(rc.height),
          htmlLen: el.innerHTML.length,
          tablas: el.querySelectorAll("table").length,
        });
      }
    } catch (e) {}
  }
  out.editables = out.editables.slice(0, 25);

  // ── Salida ─────────────────────────────────────────────────────────────────
  console.groupCollapsed("[Recon] " + out.frames.length + " iframes · " + out.editables.length + " editables");
  console.table(
    out.frames.map((f) => ({
      id: f.id,
      clase: f.clase,
      titulo: f.titulo,
      tam: f.tam,
      acc: f.accesible,
      htmlLen: f.htmlLen,
      tablas: f.tablas,
      imgs: f.imgs,
      err: f.err || "",
    }))
  );
  if (out.editables.length) console.table(out.editables);
  console.groupEnd();

  window.__recon = JSON.stringify(out, null, 1);
  console.log(
    "Frames: " + out.frames.length +
    " | Legibles: " + out.frames.filter((f) => f.accesible).length +
    " | Editables: " + out.editables.length +
    " | Custom elements: " + out.customEls.length
  );
  console.log("Copiá el reporte con:  copy(__recon)");
  return out;
})();
