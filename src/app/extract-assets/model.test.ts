import { describe, expect, it } from "vitest";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import type { AssetFormat, AssetKind, ExtractResult, ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import {
  FILTER_ORDER,
  allVisibleSelected,
  analyzedRange,
  assetLabel,
  assetPages,
  canSaveToVault,
  confidencePercent,
  countByFilter,
  defaultFormat,
  defaultVaultKind,
  errorCodeOf,
  fileExtension,
  fill,
  filterAssets,
  filterOfKind,
  formatName,
  isCancellation,
  isProbable,
  kindName,
  noticesFor,
  offersOriginal,
  pagesText,
  planBaseNames,
  pruneSelection,
  resolveFormat,
  sizeText,
  sortAssets,
  sourceName,
  summaryText,
  toggleAllVisible,
  toggleSelection,
  typeLabel,
  withExtension,
} from "@/app/extract-assets/model";

const x = es.extract;
const xe = en.extract;

function asset(partial: Partial<ExtractedAsset> & { id: string }): ExtractedAsset {
  return {
    kind: "signature",
    confidence: 0.95,
    reasons: [],
    source: "xobject",
    occurrences: [{ pageIndex: 2, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.07 } }],
    pixel: { width: 420, height: 140, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: 1000,
    thumb: null,
    ref: { engine: "image", objectId: partial.id, pageIndex: 2 },
    ...partial,
  };
}

describe("fill", () => {
  it("sustituye las claves y deja intactas las que faltan", () => {
    expect(fill("Página {page} de {total}", { page: 3, total: 8 })).toBe("Página 3 de 8");
    expect(fill("{a} y {b}", { a: "x" })).toBe("x y {b}");
    expect(fill("{n} {n}", { n: 0 })).toBe("0 0");
  });
});

describe("filtros", () => {
  const kinds: AssetKind[] = ["signature", "initials", "image", "logo", "stamp", "watermark", "drawing", "photo"];
  it("cada tipo cae en un filtro: las fotos con las imagenes y los dibujos en «Otros»", () => {
    expect(kinds.map(filterOfKind)).toEqual(["signature", "initials", "image", "logo", "stamp", "watermark", "other", "image"]);
    expect(FILTER_ORDER).toEqual(["all", "signature", "initials", "image", "logo", "stamp", "watermark", "other"]);
  });
  it("cuenta por filtro (y «Todos» es el total) y filtra", () => {
    const assets = kinds.map((kind, index) => asset({ id: `a${index}`, kind }));
    const counts = countByFilter(assets);
    expect(counts).toEqual({ all: 8, signature: 1, initials: 1, image: 2, logo: 1, stamp: 1, watermark: 1, other: 1 });
    expect(filterAssets(assets, "image").map((a) => a.kind)).toEqual(["image", "photo"]);
    expect(filterAssets(assets, "all")).toHaveLength(8);
    expect(filterAssets(assets, "all")).not.toBe(assets);
  });
});

describe("orden", () => {
  it("por pagina, luego de arriba abajo, luego de izquierda a derecha; sin pagina, al final; empate por id", () => {
    const at = (id: string, page: number, x: number, y: number) => asset({ id, occurrences: [{ pageIndex: page, rect: { x, y, width: 0.1, height: 0.1 } }] });
    const sorted = sortAssets([
      asset({ id: "z-sin-pagina", occurrences: [] }),
      at("b", 2, 0.5, 0.1),
      at("a", 2, 0.2, 0.1),
      at("c", 2, 0.2, 0.5),
      at("d", 0, 0.9, 0.9),
      at("e", 0, 0.9, 0.9),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["d", "e", "a", "b", "c", "z-sin-pagina"]);
  });
  it("no muta la entrada", () => {
    const input = [asset({ id: "b" }), asset({ id: "a" })];
    sortAssets(input);
    expect(input.map((a) => a.id)).toEqual(["b", "a"]);
  });
  it("usa la primera aparicion de un elemento repetido", () => {
    const repeated = asset({ id: "r", occurrences: [{ pageIndex: 5, rect: { x: 0, y: 0, width: 1, height: 1 } }, { pageIndex: 1, rect: { x: 0, y: 0.4, width: 1, height: 1 } }] });
    const single = asset({ id: "s", occurrences: [{ pageIndex: 3, rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    expect(sortAssets([single, repeated]).map((a) => a.id)).toEqual(["r", "s"]);
  });
});

describe("«probable» y nombres accesibles", () => {
  it("las imagenes y fotos nunca son «probables»; el resto, si su confianza es menor que 0,9", () => {
    expect(isProbable(asset({ id: "1", kind: "image", confidence: 0.3 }))).toBe(false);
    expect(isProbable(asset({ id: "2", kind: "photo", confidence: 0.3 }))).toBe(false);
    expect(isProbable(asset({ id: "3", kind: "signature", confidence: 0.89 }))).toBe(true);
    expect(isProbable(asset({ id: "4", kind: "signature", confidence: 0.9 }))).toBe(false);
    expect(isProbable(asset({ id: "5", kind: "stamp", confidence: 0.5 }))).toBe(true);
  });
  it("«Firma probable, página 3, 420 × 140 px»", () => {
    expect(assetLabel(x, asset({ id: "1", confidence: 0.6 }))).toBe("Firma probable, página 3, 420 × 140 px");
    expect(assetLabel(x, asset({ id: "2", confidence: 0.95 }))).toBe("Firma, página 3, 420 × 140 px");
    expect(assetLabel(xe, asset({ id: "3", confidence: 0.6 }))).toBe("Probable signature, page 3, 420 × 140 px");
  });
  it("varias paginas: hasta tres se nombran, mas se cuentan", () => {
    const pages = (list: number[]) => asset({ id: "p", occurrences: list.map((pageIndex) => ({ pageIndex, rect: { x: 0, y: 0, width: 1, height: 1 } })) });
    expect(assetPages(pages([4, 1, 1, 7]))).toEqual([2, 5, 8]);
    expect(pagesText(x, [3])).toBe("página 3");
    expect(pagesText(x, [1, 2, 5])).toBe("páginas 1, 2, 5");
    expect(pagesText(x, [1, 2, 3, 4])).toBe("4 páginas");
    expect(pagesText(x, [])).toBe("");
    expect(assetLabel(x, pages([0, 1, 2, 3, 4, 5]))).toBe("Firma, 6 páginas, 420 × 140 px");
  });
  it("sin pixeles: «solo texto» o «vectorial»", () => {
    expect(sizeText(x, asset({ id: "t", pixel: null, source: "text" }))).toBe("solo texto");
    expect(sizeText(x, asset({ id: "v", pixel: null, source: "vector" }))).toBe("vectorial");
    expect(typeLabel(x, asset({ id: "w", kind: "watermark", confidence: 0.7 }))).toBe("Marca de agua probable");
  });
  it("todos los tipos, origenes y formatos tienen texto en los dos idiomas", () => {
    for (const strings of [x, xe]) {
      for (const kind of ["signature", "initials", "image", "logo", "stamp", "watermark", "drawing", "photo"] as const) {
        expect(kindName(strings, kind).length).toBeGreaterThan(0);
        const label = typeLabel(strings, asset({ id: kind, kind, confidence: 0.1 }));
        // Las imagenes y fotos no son «probables» (ver arriba): su chip es el nombre del tipo.
        if (kind === "image" || kind === "photo") expect(label).toBe(kindName(strings, kind));
        else expect(label.length).toBeGreaterThan(kindName(strings, kind).length);
      }
      for (const source of ["xobject", "inline", "mask", "form", "ink-annot", "stamp-annot", "sig-widget", "ocg", "text", "vector", "region"] as const) expect(sourceName(strings, source).length).toBeGreaterThan(0);
      for (const format of ["png", "jpg-original", "jpg", "svg", "txt"] as const) expect(formatName(strings, format).length).toBeGreaterThan(0);
    }
  });
  it("confianza en porcentaje acotado", () => {
    expect(confidencePercent(asset({ id: "a", confidence: 0.934 }))).toBe(93);
    expect(confidencePercent(asset({ id: "b", confidence: 7 }))).toBe(100);
    expect(confidencePercent(asset({ id: "c", confidence: -1 }))).toBe(0);
  });
});

describe("formato de descarga y nombres de archivo", () => {
  const fmt = (...formats: AssetFormat[]) => asset({ id: "f", formats });
  it("«png» pide PNG si lo hay, si no el formato por defecto", () => {
    expect(resolveFormat(fmt("png", "jpg-original"), "png")).toBe("png");
    expect(resolveFormat(fmt("jpg-original", "png"), "png")).toBe("png");
    expect(resolveFormat(fmt("txt", "svg"), "png")).toBe("txt");
    expect(resolveFormat(fmt(), "png")).toBe("png");
  });
  it("«original» prefiere el JPG original, luego el SVG; un texto, su .txt; sin nada, el por defecto", () => {
    expect(resolveFormat(fmt("png", "jpg-original"), "original")).toBe("jpg-original");
    expect(resolveFormat(fmt("png", "svg"), "original")).toBe("svg");
    expect(resolveFormat(fmt("svg", "png"), "original")).toBe("svg");
    expect(resolveFormat(asset({ id: "t", pixel: null, formats: ["txt", "svg"] }), "original")).toBe("txt");
    expect(resolveFormat(fmt("png"), "original")).toBe("png");
    expect(defaultFormat(fmt("svg", "png"))).toBe("svg");
  });
  it("la preferencia «Original» solo se ofrece si algun elemento tiene algo distinto de PNG", () => {
    // (una firma de imagen incrustada tambien la ofrece: su «Original» es la imagen sin limpiar; ver `model.fixes.test.ts`)
    const logo = (id: string) => asset({ id, kind: "logo", formats: ["png"] });
    expect(offersOriginal([logo("a"), logo("b")])).toBe(false);
    expect(offersOriginal([logo("a"), fmt("png", "svg")])).toBe(true);
    expect(offersOriginal([])).toBe(false);
  });
  it("extensiones", () => {
    expect(["png", "jpg-original", "jpg", "svg", "txt"].map((f) => fileExtension(f as AssetFormat))).toEqual(["png", "jpg", "jpg", "svg", "txt"]);
    expect(withExtension("p03-firma-01", "jpg-original")).toBe("p03-firma-01.jpg");
  });
  it("p03-firma-01: pagina de la primera aparicion, tipo y contador por pagina y tipo, estable", () => {
    const at = (id: string, kind: AssetKind, page: number) => asset({ id, kind, occurrences: [{ pageIndex: page, rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    const list = [at("a", "signature", 2), at("b", "signature", 2), at("c", "initials", 2), at("d", "signature", 3), at("e", "watermark", 0)];
    const names = planBaseNames(list, x);
    expect([...names.values()]).toEqual(["p03-firma-01", "p03-firma-02", "p03-iniciales-01", "p04-firma-01", "p01-marca-de-agua-01"]);
    // El mismo elemento conserva su nombre aunque se pida otro subconjunto del mismo orden.
    expect(planBaseNames(list, xe).get("a")).toBe("p03-signature-01");
  });
  it("con mas de 99 paginas el numero lleva 3 cifras; sin pagina, «documento-»", () => {
    const at = (id: string, page: number) => asset({ id, occurrences: [{ pageIndex: page, rect: { x: 0, y: 0, width: 1, height: 1 } }] });
    expect(planBaseNames([at("a", 2), at("b", 149)], x).get("a")).toBe("p003-firma-01");
    expect(planBaseNames([asset({ id: "z", occurrences: [] })], x).get("z")).toBe("documento-firma-01");
  });
});

describe("guardar en Firmas guardadas", () => {
  it("solo lo que tiene pixeles; las iniciales se proponen como iniciales, lo demas como firma", () => {
    expect(canSaveToVault(asset({ id: "a" }))).toBe(true);
    expect(canSaveToVault(asset({ id: "b", pixel: null }))).toBe(false);
    expect(defaultVaultKind(asset({ id: "c", kind: "initials" }))).toBe("initials");
    expect(defaultVaultKind(asset({ id: "d", kind: "logo" }))).toBe("signature");
  });
});

describe("seleccion", () => {
  const list = ["a", "b", "c"].map((id) => asset({ id }));
  it("alterna sin mutar", () => {
    const base = new Set(["a"]);
    const next = toggleSelection(base, "b");
    expect([...next]).toEqual(["a", "b"]);
    expect([...base]).toEqual(["a"]);
    expect([...toggleSelection(next, "a")]).toEqual(["b"]);
  });
  it("«Seleccionar todo» marca los visibles; si ya lo estaban, los desmarca; lo oculto no cambia", () => {
    const visible = list.slice(0, 2);
    const marked = toggleAllVisible(new Set(["c"]), visible);
    expect([...marked].sort()).toEqual(["a", "b", "c"]);
    expect(allVisibleSelected(marked, visible)).toBe(true);
    expect([...toggleAllVisible(marked, visible)]).toEqual(["c"]);
    expect(allVisibleSelected(new Set(["a"]), visible)).toBe(false);
    expect(allVisibleSelected(new Set(["a"]), [])).toBe(false);
    expect([...toggleAllVisible(new Set(), [])]).toEqual([]);
  });
  it("al volver a buscar se descartan los que ya no existen", () => {
    expect([...pruneSelection(new Set(["a", "z"]), list)]).toEqual(["a"]);
  });
});

describe("resumen, avisos y rango", () => {
  const base: ExtractResult = { pageCount: 6, assets: [], scannedPages: [], warnings: [], truncated: false };
  it("resumen del resultado", () => {
    expect(summaryText(x, base, 6)).toBe("No encontramos elementos; prueba a recortar una región.");
    expect(summaryText(x, { ...base, assets: [asset({ id: "1" })] }, 1)).toBe("Encontramos 1 elemento en 1 página.");
    expect(summaryText(x, { ...base, assets: [asset({ id: "1" }), asset({ id: "2" })] }, 6)).toBe("Encontramos 2 elementos en 6 páginas.");
    expect(summaryText(xe, { ...base, assets: [asset({ id: "1" }), asset({ id: "2" })] }, 6)).toBe("We found 2 elements in 6 pages.");
  });
  it("avisos: escaneadas (una linea para todas), rango, topes, firma digital, imagenes y cifrado; sin avisos, nada", () => {
    expect(noticesFor(x, base, { from: 1, to: 6 })).toEqual([]);
    const notices = noticesFor(
      x,
      {
        ...base,
        pageCount: 450,
        scannedPages: [4, 2],
        warnings: [
          { code: "scanned-page", pageIndex: 4 },
          { code: "too-many-pages" },
          { code: "too-many-assets" },
          { code: "digital-signature", pageIndex: 1 },
          { code: "image-too-large", pageIndex: 2 },
          { code: "decode-failed", pageIndex: 3 },
          { code: "decode-failed" },
          { code: "encrypted" },
          { code: "cancelled" },
        ],
      },
      { from: 1, to: 300 },
    );
    const byId = Object.fromEntries(notices.map((notice) => [notice.id, notice]));
    expect(byId.scanned.text).toBe("Las páginas 3, 5 son escaneos: no se separan solas. Recorta la región donde está la firma.");
    expect(byId.scanned.action).toBe("region");
    expect(byId["too-many-pages"].text).toContain("450 páginas");
    expect(byId["too-many-pages"].text).toContain("1–300");
    expect(byId["too-many-pages"].action).toBe("range");
    expect(byId["digital-1"].text).toBe("La página 2 tiene una firma digital. Se muestra su apariencia; no se comprueba su validez.");
    expect(byId["large-2"].text).toContain("página 3");
    expect(byId["decode-3"].text).toContain("página 4");
    expect(byId["decode-x"].text).toBe("No se pudo leer una de las imágenes.");
    expect(byId.encrypted.code).toBe("encrypted");
    expect(byId.cancelled.code).toBe("cancelled");
    expect(notices.filter((n) => n.code === "scanned-page")).toHaveLength(1);
  });
  it("una sola pagina escaneada usa la frase en singular", () => {
    const [notice] = noticesFor(x, { ...base, scannedPages: [4] }, { from: 1, to: 6 });
    expect(notice.text).toBe("La página 5 es un escaneo: recorta la región donde está la firma.");
  });
  it("rango analizado (1-based) segun lo pedido y el tope", () => {
    expect(analyzedRange(450, undefined, 300)).toEqual({ from: 1, to: 300 });
    expect(analyzedRange(450, { from: 300, to: 449 }, 300)).toEqual({ from: 301, to: 450 });
    expect(analyzedRange(450, { from: 0, to: 449 }, 300)).toEqual({ from: 1, to: 300 });
    expect(analyzedRange(6, undefined, 300)).toEqual({ from: 1, to: 6 });
    expect(analyzedRange(6, { from: 40, to: 50 }, 300)).toEqual({ from: 6, to: 6 });
  });
});

describe("errores", () => {
  it("cancelaciones: AbortError, InkError «aborted» y PdfError «cancelled»; nada mas", () => {
    expect(isCancellation(new DOMException("x", "AbortError"))).toBe(true);
    expect(isCancellation(Object.assign(new Error("x"), { code: "aborted" }))).toBe(true);
    expect(isCancellation(Object.assign(new Error("x"), { code: "cancelled" }))).toBe(true);
    expect(isCancellation(new Error("x"))).toBe(false);
    expect(isCancellation("abort")).toBe(false);
    expect(isCancellation(null)).toBe(false);
  });
  it("un PdfError se reconoce por nombre y codigo aunque venga de otro paquete; lo demas va al clasificador", () => {
    const foreign = Object.assign(new Error("x"), { name: "PdfError", code: "encrypted" });
    expect(errorCodeOf(foreign, () => "unknown")).toBe("encrypted");
    expect(errorCodeOf(new Error("x"), () => "corrupt")).toBe("corrupt");
    expect(errorCodeOf(Object.assign(new Error("x"), { name: "PdfError", code: 3 }), () => "unknown")).toBe("unknown");
    expect(errorCodeOf("texto", () => "tooLarge")).toBe("tooLarge");
  });
});
