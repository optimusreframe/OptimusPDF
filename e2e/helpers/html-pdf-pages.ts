import { createCanvas } from "@napi-rs/canvas";

/**
 * Paginas HTML SINTETICAS (las genera la prueba; ningun dato real ni de Internet) para ejercitar el motor «HTML a PDF»:
 * un articulo largo con imagenes y tablas, una pagina con cabecera fija y aviso de cookies, una pagina mas ancha que la hoja,
 * una con `@media print`, una con un hueco enorme en blanco y una con un hero a pantalla completa.
 */

export const RED: [number, number, number] = [192, 57, 43];
export const BLUE: [number, number, number] = [41, 128, 185];
export const GREEN: [number, number, number] = [39, 174, 96];
export const ORANGE: [number, number, number] = [230, 126, 34];

/** PNG de color liso con una franja, como data URI (decodificado por el navegador de verdad). */
export function pngDataUri(width: number, height: number, [r, g, b]: [number, number, number]): string {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = `rgb(${r},${g},${b})`;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255,255,255,0.35)";
  context.fillRect(0, Math.floor(height / 2) - 6, width, 12);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

/** Texto determinista (misma salida siempre). */
function makeText(seed: number, sentences: number): string {
  const words = "casa rio montaña ciudad camino viaje historia puerta ventana libro tiempo mujer hombre mundo trabajo vida noche dia agua fuego tierra cielo luz sombra palabra idea sueño memoria jardin puente calle plaza mercado escuela maestro alumno papel tinta mano pie ojo voz silencio viento lluvia nieve sol luna estrella".split(" ");
  let state = seed * 9301 + 49297;
  const next = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const out: string[] = [];
  for (let sentence = 0; sentence < sentences; sentence += 1) {
    const length = 8 + Math.floor(next() * 12);
    const picked: string[] = [];
    for (let word = 0; word < length; word += 1) picked.push(words[Math.floor(next() * words.length)]);
    const text = picked.join(" ");
    out.push(`${text[0].toUpperCase()}${text.slice(1)}.`);
  }
  return out.join(" ");
}

const ARTICLE_CSS = `
  body{margin:0;font:16px/1.55 Georgia,"Times New Roman",serif;color:#222;background:#fff}
  .wrap{max-width:720px;margin:0 auto;padding:24px}
  h1{font-size:30px;line-height:1.2;margin:0 0 20px}
  h2{font-size:22px;line-height:1.25;margin:28px 0 12px;color:#111}
  p{margin:0 0 16px}
  blockquote{margin:16px 0;padding:8px 16px;border-left:4px solid #bbb;color:#444}
  img{display:block;margin:16px auto}
  table{border-collapse:separate;border-spacing:0 6px;width:100%;margin:16px 0}
  td,th{padding:6px 10px;background:#eef2f7;text-align:left}
  th{background:#d6e0ee}
`;

/** Articulo largo: titulo, secciones con encabezado, parrafos de longitud variada, citas, imagenes y una tabla de 40 filas. */
export function articlePage(options: { sections?: number } = {}): string {
  const sections = options.sections ?? 10;
  const parts: string[] = [`<h1>Un articulo largo de prueba para el PDF</h1>`];
  for (let section = 0; section < sections; section += 1) {
    parts.push(`<h2>Seccion ${section + 1}: ${makeText(section + 100, 1).slice(0, 48)}</h2>`);
    for (let paragraph = 0; paragraph < 4; paragraph += 1) {
      parts.push(`<p>${makeText(section * 10 + paragraph, 2 + ((section + paragraph) % 6))}</p>`);
    }
    if (section % 3 === 1) parts.push(`<blockquote>${makeText(section + 500, 3)}</blockquote>`);
    if (section % 3 === 2) {
      parts.push(`<img alt="" src="${pngDataUri(600, 280, ORANGE)}" width="600" height="280">`);
    }
  }
  const rows = Array.from({ length: 40 }, (_, row) => `<tr><td>Fila ${row + 1}</td><td>${makeText(row + 900, 1)}</td><td>${(row * 37) % 1000}</td></tr>`).join("");
  parts.push(`<table><thead><tr><th>Num</th><th>Detalle</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`);
  parts.push(`<p>${makeText(777, 4)}</p>`);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Articulo</title><style>${ARTICLE_CSS}</style></head><body><div class="wrap">${parts.join("\n")}</div></body></html>`;
}

/** Cabecera `position:fixed` roja, aviso de cookies fijo azul, boton de chat y un `min-height:100vh`. */
export function fixedHeaderPage(): string {
  const paragraphs = Array.from({ length: 44 }, (_, index) => `<p>${makeText(index + 40, 3)}</p>`).join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    body{margin:0;font:16px/1.55 Arial,Helvetica,sans-serif;color:#222;min-height:100vh}
    #top{position:fixed;top:0;left:0;right:0;height:56px;background:rgb(192,57,43);color:#fff;line-height:56px;padding:0 24px;z-index:10}
    .wrap{max-width:700px;margin:0 auto;padding:72px 24px 24px}
    #cookie-banner{position:fixed;left:0;right:0;bottom:0;height:80px;background:rgb(41,128,185);color:#fff;padding:16px;z-index:20}
    .chat{position:fixed;right:16px;bottom:100px;width:56px;height:56px;border-radius:28px;background:rgb(39,174,96);z-index:30}
    p{margin:0 0 16px}
  </style></head><body>
    <div id="top">Cabecera fija del sitio</div>
    <div class="wrap"><h1>Pagina con elementos fijos</h1>${paragraphs}</div>
    <div id="cookie-banner" class="cookie-consent">Usamos cookies. Aceptar.</div>
    <div class="chat" id="chat-widget"></div>
  </body></html>`;
}

/** Contenido de 1400 px de ancho con una marca roja en su borde derecho (si se recorta, la marca no sale). */
export function widePage(): string {
  const rows = Array.from({ length: 18 }, (_, row) => `<tr><td>Fila ${row + 1}</td><td>${makeText(row + 300, 2)}</td><td class="r">${row}</td></tr>`).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    body{margin:0;font:16px/1.5 Arial,sans-serif;color:#222}
    .wide{width:1400px;padding:16px;box-sizing:border-box}
    table{border-collapse:separate;border-spacing:0 6px;width:100%}
    td{padding:6px 10px;background:#eef2f7}
    td.r{width:60px;background:rgb(192,57,43);color:#fff}
  </style></head><body><div class="wide"><h1>Pagina mas ancha que la hoja</h1><table>${rows}</table></div></body></html>`;
}

/** Un bloque verde que la propia pagina oculta al imprimir y otro azul que solo aparece al imprimir. */
export function printPage(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    body{margin:0;font:16px/1.5 Arial,sans-serif;padding:24px}
    .noprint{height:120px;background:rgb(39,174,96)}
    .onlyprint{display:none;height:120px;background:rgb(41,128,185)}
    @media print{.noprint{display:none}.onlyprint{display:block}}
  </style></head><body><p>Contenido normal de la pagina de prueba.</p><div class="noprint"></div><div class="onlyprint"></div><p>Fin.</p></body></html>`;
}

/** Texto, un hueco vacio de 4000 px, texto: ninguna pagina del PDF puede quedar en blanco. */
export function spacerPage(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.5 Arial,sans-serif;padding:24px}.gap{height:4000px}</style></head>
    <body><p>${makeText(1, 3)}</p><div class="gap"></div><p>${makeText(2, 3)}</p></body></html>`;
}

/** Hero de `height:100vh` + `min-height:100vh` en el cuerpo: no debe estirarse hasta el alto de todo el documento. */
export function heroPage(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    body{margin:0;font:16px/1.5 Arial,sans-serif;min-height:100vh}
    .hero{height:100vh;background:rgb(230,126,34);color:#fff;padding:24px;box-sizing:border-box}
    section{padding:24px}
  </style></head><body><div class="hero"><h1>Hero a pantalla completa</h1></div><section><p>${makeText(5, 3)}</p></section></body></html>`;
}
