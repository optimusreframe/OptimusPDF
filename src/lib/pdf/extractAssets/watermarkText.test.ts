import { describe, expect, it } from "vitest";
import {
  BIG_TEXT_PT,
  MAX_WATERMARK_ALPHA,
  aggregateTextWatermarks,
  buildTextWatermarkAsset,
  buildTextWatermarkSvg,
  hasWatermarkKeyword,
  isDiagonal,
  isWatermarkLikeRun,
  renderTextWatermarkPreview,
  type TextPageFindings,
} from "./watermarkText";
import type { TextRun } from "./watermarkOps";
import { decodePng, isPng, napiSurfaceFactory } from "./__fixtures__/annots/nodeEnv";
import { renderAnnotationAsset } from "./annotationsRender";
import { pngBlob } from "./annotationsRaster";

const run = (over: Partial<TextRun> = {}): TextRun => ({
  text: "CONFIDENCIAL",
  alpha: 0.2,
  angleDeg: 40,
  fontSizePt: 60,
  bbox: { x: 100, y: 200, width: 300, height: 250 },
  ocIds: [],
  count: 1,
  ...over,
});

const pageWith = (pageIndex: number, runs: TextRun[]): TextPageFindings => ({ pageIndex, viewWidth: 612, viewHeight: 792, runs });
const pages = (indices: number[], make: () => TextRun = () => run()) => indices.map((i) => pageWith(i, [make()]));

describe("isDiagonal", () => {
  it("lo que esta cerca de un multiplo de 90 grados no es diagonal; el resto, si (en ambos sentidos)", () => {
    for (const angle of [0, 5, 11.9, 90, 85, 180, -90, -180, 270]) expect(isDiagonal(angle), `${angle}`).toBe(false);
    for (const angle of [12, 30, 45, 60, 78, -30, -45, 135, 200]) expect(isDiagonal(angle), `${angle}`).toBe(true);
  });
});

describe("isWatermarkLikeRun", () => {
  it("translucido y (diagonal o grande)", () => {
    expect(isWatermarkLikeRun(run())).toBe(true);
    expect(isWatermarkLikeRun(run({ angleDeg: 0, fontSizePt: BIG_TEXT_PT }))).toBe(true);
  });

  it("opaco, horizontal pequeno, de una letra o solo simbolos no lo es", () => {
    expect(isWatermarkLikeRun(run({ alpha: 1 }))).toBe(false);
    expect(isWatermarkLikeRun(run({ alpha: MAX_WATERMARK_ALPHA }))).toBe(false);
    expect(isWatermarkLikeRun(run({ angleDeg: 0, fontSizePt: BIG_TEXT_PT - 1 }))).toBe(false);
    expect(isWatermarkLikeRun(run({ text: "A" }))).toBe(false);
    expect(isWatermarkLikeRun(run({ text: "— —" }))).toBe(false);
  });
});

describe("hasWatermarkKeyword", () => {
  it("reconoce palabras de marca de agua con o sin acentos y mayusculas", () => {
    for (const text of ["BORRADOR", "Confidencial", "NO VÁLIDO", "Draft", "CONFIDENTIAL", "Muestra", "marca de agua", "Do Not Copy"]) expect(hasWatermarkKeyword(text), text).toBe(true);
    for (const text of ["Nota interna", "Contrato 2026", "Firma"]) expect(hasWatermarkKeyword(text), text).toBe(false);
  });
});

describe("aggregateTextWatermarks", () => {
  it("en >= 50 % de las paginas (y 2 o mas) es marca de agua; en menos, no", () => {
    expect(aggregateTextWatermarks(pages([0, 1, 2]), 6)).toHaveLength(1); // justo 50 %
    expect(aggregateTextWatermarks(pages([0, 1]), 6)).toHaveLength(0); // 33 %
    expect(aggregateTextWatermarks(pages([0, 1, 2, 3, 4, 5]), 6)).toHaveLength(1);
  });

  it("una sola pagina no cuenta, tampoco en un documento de 2 paginas donde aparece solo en una", () => {
    expect(aggregateTextWatermarks(pages([3], () => run({ text: "Nota interna de revision" })), 6)).toEqual([]);
    expect(aggregateTextWatermarks(pages([0], () => run({ text: "Nota interna" })), 2)).toEqual([]);
    expect(aggregateTextWatermarks(pages([0]), 2)).toEqual([]);
  });

  it("un documento de UNA pagina solo acepta textos con palabra tipica de marca de agua, con menos confianza", () => {
    expect(aggregateTextWatermarks(pages([0], () => run({ text: "Nota interna" })), 1)).toEqual([]);
    const single = aggregateTextWatermarks(pages([0], () => run({ text: "BORRADOR" })), 1);
    expect(single).toHaveLength(1);
    expect(single[0].reasons.join(" ")).toContain("única página");
    const repeated = aggregateTextWatermarks(pages([0, 1, 2], () => run({ text: "BORRADOR" })), 3);
    expect(single[0].confidence).toBeLessThan(repeated[0].confidence);
  });

  it("agrupa por texto sin acentos ni mayusculas ni espacios de mas, y guarda una ocurrencia por pagina", () => {
    const found = aggregateTextWatermarks(
      [pageWith(0, [run({ text: "Confidencial" })]), pageWith(1, [run({ text: "CONFIDENCIAL " })]), pageWith(2, [run({ text: "confidencial" }), run({ text: "CONFIDENCIAL", bbox: { x: 0, y: 0, width: 10, height: 10 } })])],
      3,
    );
    expect(found).toHaveLength(1);
    expect(found[0].pages).toEqual([0, 1, 2]);
    expect(found[0].occurrences).toHaveLength(3);
    expect(found[0].occurrences[2].rect.x).toBeCloseTo(100 / 612, 2);
  });

  it("los textos distintos son marcas distintas, cada una con su umbral", () => {
    const mix = [
      pageWith(0, [run({ text: "UNO" }), run({ text: "DOS" })]),
      pageWith(1, [run({ text: "UNO" })]),
      pageWith(2, [run({ text: "UNO" }), run({ text: "DOS" })]),
      pageWith(3, [run()]),
    ];
    const found = aggregateTextWatermarks(mix, 4);
    expect(found.map((f) => f.text).sort()).toEqual(["DOS", "UNO"]);
  });

  it("los textos dentro de una capa que ya entrega la deteccion (a) no se repiten", () => {
    const inLayer = () => run({ ocIds: ["7R"] });
    expect(aggregateTextWatermarks(pages([0, 1, 2], inLayer), 3, new Set(["7R"]))).toEqual([]);
    expect(aggregateTextWatermarks(pages([0, 1, 2], inLayer), 3, new Set(["8R"]))).toHaveLength(1);
  });

  it("explica el motivo (opacidad, giro, repeticion) y sube la confianza con la repeticion y las palabras clave", () => {
    const strong = aggregateTextWatermarks(pages([0, 1, 2, 3]), 4)[0];
    expect(strong.reasons).toEqual(expect.arrayContaining(["texto translúcido (opacidad 20 %)", "girado 40°", "repetido en 4 de 4 páginas", "palabra típica de marca de agua"]));
    expect(strong.confidence).toBeLessThanOrEqual(0.95);
    const weak = aggregateTextWatermarks(pages([0, 1], () => run({ text: "Zeta Tau", angleDeg: 0, fontSizePt: 50, alpha: 0.6 })), 4)[0];
    expect(weak.confidence).toBeLessThan(strong.confidence);
    expect(weak.reasons.join(" ")).not.toContain("girado");
  });

  it("ordena por confianza y es determinista", () => {
    const a = aggregateTextWatermarks([...pages([0, 1, 2], () => run({ text: "ZZ INTERNO" })), ...pages([3], () => run({ text: "BORRADOR" }))], 4);
    const b = aggregateTextWatermarks([...pages([0, 1, 2], () => run({ text: "ZZ INTERNO" })), ...pages([3], () => run({ text: "BORRADOR" }))], 4);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i += 1) expect(a[i - 1].confidence).toBeGreaterThanOrEqual(a[i].confidence);
  });
});

describe("vista previa y elemento", () => {
  const ref = { engine: "text" as const, text: "A & B <C>", angleDeg: 30, fontSizePt: 40, opacity: 0.3 };

  it("el SVG escapa el texto, gira en sentido contrario al angulo y lleva la opacidad", () => {
    const svg = buildTextWatermarkSvg(ref);
    expect(svg).toContain("A &amp; B &lt;C&gt;");
    expect(svg).toContain("rotate(-30 ");
    expect(svg).toContain('fill-opacity="0.3"');
    expect(svg).toContain('font-size="40"');
    expect(svg).not.toContain("<C>");
    expect(buildTextWatermarkSvg({ engine: "text", text: "x" })).toContain("rotate(0 ");
  });

  it("el PNG de la vista previa es valido y la superficie se libera", () => {
    let released = 0;
    const factory = (w: number, h: number) => ({ ...napiSurfaceFactory(w, h), release: () => (released += 1) });
    const image = renderTextWatermarkPreview(ref, factory, 1);
    expect(image.width).toBeGreaterThan(8);
    expect(image.data.length).toBe(image.width * image.height * 4);
    expect(released).toBe(1);
  });

  it("buildTextWatermarkAsset da un elemento del contrato con TXT, PNG y SVG y miniatura <= 256 px", async () => {
    const [candidate] = aggregateTextWatermarks(pages([0, 1, 2, 3]), 4);
    const asset = await buildTextWatermarkAsset(candidate, napiSurfaceFactory);
    expect(asset).toMatchObject({ kind: "watermark", source: "text", formats: ["txt", "png", "svg"], ref: { engine: "text", text: "CONFIDENCIAL" } });
    expect(asset.occurrences.map((o) => o.pageIndex)).toEqual([0, 1, 2, 3]);
    expect(asset.id).toMatch(/^wm-text-[0-9a-f]{8}$/);
    expect(asset.bytesEstimate).toBe(12);
    expect(asset.thumb).not.toBeNull();
    const thumb = await decodePng(asset.thumb as Blob);
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(256);
  });

  it("renderAnnotationAsset entrega el TXT exacto, un SVG y un PNG sin abrir el documento", async () => {
    const [candidate] = aggregateTextWatermarks(pages([0, 1, 2, 3]), 4);
    const asset = await buildTextWatermarkAsset(candidate, napiSurfaceFactory);
    const never = {} as never; // el documento no se toca para los elementos de texto
    expect(await (await renderAnnotationAsset(never, asset, "txt")).text()).toBe("CONFIDENCIAL\n");
    expect(await (await renderAnnotationAsset(never, asset)).text()).toBe("CONFIDENCIAL\n"); // por defecto: el primero de `formats`
    const svg = await (await renderAnnotationAsset(never, asset, "svg")).text();
    expect(svg).toContain("<text");
    const png = await renderAnnotationAsset(never, asset, "png", { createSurface: napiSurfaceFactory });
    expect(await isPng(png)).toBe(true);
    await expect(renderAnnotationAsset(never, asset, "jpg")).rejects.toMatchObject({ code: "unsupported-format" });
    expect(await isPng(await pngBlob({ width: 1, height: 1, data: new Uint8ClampedArray(4) }))).toBe(true);
  });
});
