import { describe, expect, it } from "vitest";
import type { PageEntry } from "@/lib/pdf/pageAssembly";
import { PAGES_STRINGS } from "@/app/pdf-pro/pages/pagesStrings";
import { CURRENT_SOURCE_KEY, buildGridItems, imagePageAspect, visiblePagesBySource } from "@/app/pdf-pro/pages/pagesView";
import type { PagesSource } from "@/app/pdf-pro/pages/pagesStore";

const S = PAGES_STRINGS.es;
const infos = [
  { width: 300, height: 400, rotation: 0 },
  { width: 400, height: 300, rotation: 90 },
  { width: 300, height: 400, rotation: 0 },
];

describe("imagePageAspect", () => {
  const wide = { width: 200, height: 100, rotation: 0 };
  const tall = { width: 100, height: 200, rotation: 0 };

  it("A4 vertical por defecto (imagen vertical)", () => {
    expect(imagePageAspect(undefined, tall)).toBeCloseTo(595.28 / 841.89, 3);
  });

  it("con orientacion automatica una imagen apaisada da una pagina apaisada", () => {
    expect(imagePageAspect({ pageSize: "a4", orientation: "auto" }, wide)).toBeCloseTo(841.89 / 595.28, 3);
  });

  it("`fit` usa la proporcion de la imagen", () => {
    expect(imagePageAspect({ pageSize: "fit" }, wide)).toBe(2);
  });

  it("Carta", () => {
    expect(imagePageAspect({ pageSize: "letter" }, tall)).toBeCloseTo(612 / 792, 3);
  });

  it("orientacion forzada a apaisado", () => {
    expect(imagePageAspect({ pageSize: "a4", orientation: "landscape" }, tall)).toBeGreaterThan(1);
  });

  it("sin medida de la imagen usa A4", () => {
    expect(imagePageAspect({ pageSize: "fit" }, null)).toBeCloseTo(595.28 / 841.89, 3);
  });
});

describe("buildGridItems", () => {
  const plan: PageEntry[] = [
    { kind: "existing", sourceIndex: 0, rotation: 0, id: "a" },
    { kind: "existing", sourceIndex: 2, rotation: 90, id: "b" },
    { kind: "existing", sourceIndex: 0, rotation: 0, copy: true, id: "c" },
    { kind: "blank", width: 200, height: 100, rotation: 0, id: "d" },
    { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 180, id: "e" },
    { kind: "image", sourceId: "i", rotation: 0, id: "f" },
  ];
  const sources: Record<string, PagesSource> = {
    x: { id: "x", kind: "pdf", name: "otro.pdf", size: 1, status: "ready", infos: [infos[0], infos[1]] },
    i: { id: "i", kind: "image", name: "foto.png", size: 1, status: "ready", previewUrl: "blob:foto", infos: [{ width: 100, height: 50, rotation: 0 }] },
  };
  const thumb = (key: string, index: number) => (key === CURRENT_SOURCE_KEY ? `cur-${index}` : `${key}-${index}`);
  const items = buildGridItems({ plan, sources, pageInfos: infos, thumb, strings: S });

  it("un item por entrada, con su id y su numero visible", () => {
    expect(items.map((item) => [item.id, item.number])).toEqual([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6]]);
  });

  it("las paginas del documento llevan su miniatura y su proporcion", () => {
    expect(items[0].thumb).toBe("cur-0");
    expect(items[1].thumb).toBe("cur-2");
    expect(items[0].aspect).toBeCloseTo(0.75);
  });

  it("la segunda linea dice de donde sale cada pagina", () => {
    expect(items[0].detail).toBe("");
    expect(items[1].detail).toBe("original 3");
    expect(items[2].detail).toBe("copia de 1");
    expect(items[3].detail).toBe("en blanco");
    expect(items[4].detail).toBe("otro.pdf, página 2");
    expect(items[5].detail).toBe("imagen foto.png");
  });

  it("la rotacion es la extra (normalizada) y se anuncia en la etiqueta", () => {
    expect(items[1].rotation).toBe(90);
    expect(items[1].ariaLabel).toContain("girada 90°");
    expect(items[4].rotation).toBe(180);
    expect(items[0].ariaLabel).not.toContain("girada");
  });

  it("la etiqueta accesible lleva posicion y total", () => {
    expect(items[0].ariaLabel).toContain("Página 1 de 6");
    expect(items[5].ariaLabel).toContain("Página 6 de 6");
  });

  it("las externas usan la miniatura de su fuente y las imagenes su vista previa", () => {
    expect(items[4].thumb).toBe("x-1");
    expect(items[5].thumb).toBe("blob:foto");
  });

  it("una en blanco usa la proporcion de su tamano", () => {
    expect(items[3].aspect).toBe(2);
  });

  it("sin medidas usa A4 y no rompe", () => {
    const bare = buildGridItems({ plan: [plan[0], plan[4]], sources: {}, pageInfos: null, thumb: () => undefined, strings: S });
    expect(bare[0].aspect).toBeCloseTo(595.28 / 841.89, 3);
    expect(bare[1].detail).toContain("PDF");
  });

  it("en ingles", () => {
    const en = buildGridItems({ plan: [plan[1]], sources, pageInfos: infos, thumb, strings: PAGES_STRINGS.en });
    expect(en[0].ariaLabel).toContain("Page 1 of 1");
    expect(en[0].detail).toBe("original 3");
  });
});

describe("visiblePagesBySource", () => {
  const plan: PageEntry[] = [
    { kind: "existing", sourceIndex: 0, rotation: 0 },
    { kind: "external", sourceId: "x", sourceIndex: 4, rotation: 0 },
    { kind: "blank", width: 1, height: 1, rotation: 0 },
    { kind: "existing", sourceIndex: 7, rotation: 0 },
    { kind: "external", sourceId: "y", sourceIndex: 0, rotation: 0 },
  ];

  it("agrupa por documento las paginas que se ven", () => {
    const out = visiblePagesBySource(plan, 0, 4);
    expect([...out[CURRENT_SOURCE_KEY]]).toEqual([0, 7]);
    expect([...out.x]).toEqual([4]);
    expect([...out.y]).toEqual([0]);
  });

  it("solo cuenta el rango pedido y se acota al plan", () => {
    const out = visiblePagesBySource(plan, 1, 2);
    expect(Object.keys(out)).toEqual(["x"]);
    expect(Object.keys(visiblePagesBySource(plan, -5, 99)).sort()).toEqual([CURRENT_SOURCE_KEY, "x", "y"]);
  });

  it("las blancas y las imagenes no piden miniatura", () => {
    expect(visiblePagesBySource([{ kind: "blank", width: 1, height: 1, rotation: 0 }], 0, 0)).toEqual({});
  });
});
