/**
 * Reconocimiento 3 — cuál de los <style> es el del mail
 * -----------------------------------------------------
 * Tercera y última pasada antes de escribir la extracción.
 *
 * De `recon-fragmentos.js` ya sabemos que:
 *   - El contenedor del mail es `div.acr-container`, hijo directo de <body>,
 *     y ocupa el 99,9% del documento (85 191 de 85 304 caracteres).
 *   - El HTML es el del mail de verdad: 305 de 774 elementos traen atributo
 *     `style` inline, y las clases son de email (`mobile-full`, `table-radius`,
 *     `image-global-responsive`), no del editor.
 *
 * Lo que falta: las clases `mobile-*` son de media queries, y sus reglas NO
 * están dentro del contenedor (`styleTags: 0`). Están en alguno de los 20
 * `<style>` sueltos del documento, mezclados con los del editor. Sin ese CSS
 * la preview se ve bien en escritorio pero pierde todo el responsive.
 *
 * Este script clasifica cada `<style>`: cuántas clases realmente usadas por el
 * mail define, cuántos selectores `.acr-`/`.acd-` (del editor) tiene, y cuántas
 * media queries. El del mail va a tener muchas clases del mail y cero acr/acd.
 *
 * Solo lectura. Reporta nombres de selectores y conteos, nunca declaraciones
 * CSS ni contenido del mail.
 *
 * Uso:
 *   1. Consola en el contexto `iframe.html` / `acrites-ui-iframe...`.
 *   2. Pegar → Enter → copy(__recon4)
 */
(() => {
  "use strict";

  const o = { origen: location.pathname };

  const cont = document.querySelector(".acr-container");
  o.contenedorEncontrado = !!cont;

  // Clases que el mail usa de verdad, ignorando las del editor (`acr-*`).
  const usadas = new Set();
  if (cont) {
    for (const el of cont.querySelectorAll("*")) {
      const cn = el.className;
      if (cn && cn.split) {
        for (const k of cn.split(/\s+/)) if (k && !k.startsWith("acr-")) usadas.add(k);
      }
    }
  }
  o.clasesEnMail = usadas.size;

  o.styles = [...document.querySelectorAll("style")].map((s, i) => {
    const t = s.textContent || "";

    // Primer token de cada selector, solo para identificar de qué es la hoja.
    const sels = (t.match(/[^{}]+(?=\{)/g) || [])
      .map((x) => x.trim().split(/[\s,]/)[0])
      .filter(Boolean);

    let clasesDelMail = 0;
    for (const c of usadas) if (t.includes("." + c)) clasesDelMail++;

    return {
      i,
      len: t.length,
      media: (t.match(/@media/g) || []).length,
      acr: (t.match(/\.acr-|\.acd-/g) || []).length,
      clasesDelMail,
      primerosSelectores: sels.slice(0, 6),
    };
  });

  console.table(
    o.styles.map((s) => ({
      i: s.i,
      len: s.len,
      media: s.media,
      "acr/acd": s.acr,
      "clases del mail": s.clasesDelMail,
    }))
  );
  console.log(o);
  window.__recon4 = JSON.stringify(o, null, 1);
  console.log("Copia con:  copy(__recon4)");
  return o;
})();
