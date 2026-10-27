import { createCanvas } from "@napi-rs/canvas";
import { renderBlankPage, renderBookSpread, renderCeilingStains, renderDamagePhoto, renderFormPage, renderFullBleedPage, renderIdCard, renderRoofTiles, renderTextPage, renderWhiteWithRect, type PageRender } from "../../src/lib/scan/__fixtures__/pages";
import { composeScene, type SceneParams } from "../../src/lib/scan/__fixtures__/scene";
import type { Rgba } from "../../src/lib/scan/pixels";
import type { QuadCorners } from "../../src/lib/scan/perspective";

/**
 * Fotos SINTETICAS (nunca documentos reales) para las pruebas E2E del motor del Escaner: se generan aqui, en Node, con el
 * mismo corpus que Vitest, y viajan a la pagina como JPEG en base64.
 */

export type PhotoFixture = {
  id: string;
  base64: string;
  width: number;
  height: number;
  quad: QuadCorners | null;
  neededRotation: 0 | 90 | 180 | 270;
  title: string | null;
};

function jpegOf(image: Rgba, quality = 92): Buffer {
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  const data = context.createImageData(image.width, image.height);
  data.data.set(image.data);
  context.putImageData(data, 0, 0);
  return canvas.toBuffer("image/jpeg", quality);
}

function make(id: string, page: PageRender, scene: SceneParams, hasQuad = true): PhotoFixture {
  const result = composeScene(page.canvas, scene);
  const jpeg = jpegOf(result.image);
  return { id, base64: jpeg.toString("base64"), width: result.image.width, height: result.image.height, quad: hasQuad ? result.quad : null, neededRotation: result.neededRotation, title: page.title };
}

/** Foto que ES la imagen (sin escritorio): el lienzo tal cual, sin recorte posible. */
function plain(id: string, render: PageRender & { width?: number; height?: number }): PhotoFixture {
  const jpeg = render.canvas.toBuffer("image/jpeg", 92);
  return { id, base64: jpeg.toString("base64"), width: render.canvas.width, height: render.canvas.height, quad: null, neededRotation: 0, title: render.title };
}

/** Foto grande de «dano» (3200 x 2400, con textura): para los presets de calidad y el peso. */
function bigPhoto(): PhotoFixture {
  const base = renderDamagePhoto(9);
  const canvas = createCanvas(3200, 2400);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(base.canvas, 0, 0, 3200, 2400);
  let seed = 12345;
  for (let i = 0; i < 60_000; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const x = seed % 3200;
    seed = (seed * 16807) % 2147483647;
    const y = seed % 2400;
    seed = (seed * 16807) % 2147483647;
    const v = seed % 255;
    ctx.fillStyle = `rgba(${v},${(v * 7) % 255},${(v * 13) % 255},0.3)`;
    ctx.fillRect(x, y, 3, 3);
  }
  // Calidad ~90 (la de una camara de movil): el modelo de recodificado de `prepareForPdf` esta calibrado para ese rango.
  const jpeg = canvas.toBuffer("image/jpeg", 90);
  return { id: "bigphoto", base64: jpeg.toString("base64"), width: 3200, height: 2400, quad: null, neededRotation: 0, title: null };
}

export function buildScanFixtures(): Record<string, PhotoFixture> {
  const text = () => renderTextPage({ seed: 41, title: "Contrato de servicio", letterhead: true, date: "2026-03-12" });
  const fixtures: Record<string, PhotoFixture> = {};
  const add = (fixture: PhotoFixture) => {
    fixtures[fixture.id] = fixture;
  };
  add(make("text0", text(), { seed: 11, desk: "dark", angleDeg: -3, keystone: 0.03, shadow: 0.15, noise: 2.5 }));
  add(make("text90", text(), { seed: 12, desk: "wood", turns: 1, angleDeg: 2, shadow: 0.2 }));
  add(make("text180", text(), { seed: 13, desk: "blue", turns: 2, angleDeg: 1, shadow: 0.1 }));
  add(make("text270", text(), { seed: 14, desk: "dark", turns: 3, angleDeg: -2, shadow: 0.1 }));
  add(make("blur", text(), { seed: 15, desk: "dark", blur: 5, shadow: 0.1 }));
  add(make("glare", text(), { seed: 16, desk: "dark", glare: { x: 0.5, y: 0.45, radius: 0.16, strength: 1.4 } }));
  add(make("blank", renderBlankPage({ seed: 21, stamp: true }), { seed: 17, desk: "wood", shadow: 0.15 }));
  add(make("dupA", renderTextPage({ seed: 61, title: "Informe de siniestro" }), { seed: 18, desk: "dark", angleDeg: -2, keystone: 0.02, scale: 0.74 }));
  add(make("dupB", renderTextPage({ seed: 61, title: "Informe de siniestro" }), { seed: 19, desk: "wood", angleDeg: 3, keystone: -0.03, scale: 0.7, shadow: 0.2 }));
  add(make("other", renderTextPage({ seed: 71, title: "Acta de inspección" }), { seed: 20, desk: "dark" }));
  add(make("formA", renderFormPage({ family: 2, fill: 1 }), { seed: 22, desk: "dark", scale: 0.72 }));
  add(make("formB", renderFormPage({ family: 2, fill: 2 }), { seed: 23, desk: "wood", scale: 0.72, angleDeg: 1 }));
  add(make("id", renderIdCard(5), { seed: 24, desk: "wood", scale: 0.62, width: 900, height: 700, angleDeg: -3 }));
  add(make("book", renderBookSpread(6), { seed: 25, desk: "dark", scale: 0.85, width: 1100, height: 900, angleDeg: 1 }));
  add(make("photo", renderDamagePhoto(7), { seed: 26, width: 800, height: 600 }, false));
  // Foto grande (~7,7 Mpx): decodificacion, procesado a resolucion completa y cancelacion.
  add(make("big", renderTextPage({ seed: 81, title: "Presupuesto de reparación", letterhead: true }), { seed: 27, desk: "dark", width: 2400, height: 3200, angleDeg: -2 }));
  // Sin documento (el recorte NO debe tocarlas) y la pagina blanca a sangre con un rectangulo rojo dentro (480 x 60 sobre 600 x 800).
  for (const fixture of [plain("roof", renderRoofTiles(61)), plain("ceiling", renderCeilingStains(71)), plain("whiteRed", renderWhiteWithRect()), plain("fullBleed", renderFullBleedPage(95)), bigPhoto()]) add(fixture);
  return fixtures;
}
