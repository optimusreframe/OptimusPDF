import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  MAX_SPLIT_PARTS,
  bookmarkGroups,
  describeGroup,
  extractPages,
  extractionPlan,
  parseRangeParts,
  planSplit,
  readBookmarkStarts,
  splitDocument,
} from "@/lib/pdf/pageAssemblyExport";
import { allStreamsText, inspectPdf, makeRichPdf, marker } from "@/lib/pdf/testing/pageAssemblyFixtures";

const RICH = { pages: 8, title: "Libro", author: "Autor", form: true, outline: true, links: true } as const;

async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, Uint8Array> = {};
  for (const name of Object.keys(zip.files)) out[name] = await zip.files[name].async("uint8array");
  return out;
}

describe("extractPages", () => {
  it("devuelve un PDF nuevo con solo las paginas pedidas, en orden", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await extractPages(bytes, [5, 1, 3]);
    const out = await inspectPdf(result.bytes);
    expect(out.markers).toEqual([marker(1), marker(3), marker(5)]);
  });

  it("no modifica el documento de entrada", async () => {
    const bytes = await makeRichPdf(RICH);
    const copy = bytes.slice();
    await extractPages(bytes, [0, 1]);
    expect(bytes).toEqual(copy);
  });

  it("conserva titulo, autor, formulario y marcadores de las paginas extraidas", async () => {
    const bytes = await makeRichPdf(RICH);
    const out = await inspectPdf((await extractPages(bytes, [2, 3])).bytes);
    expect(out.title).toBe("Libro");
    expect(out.author).toBe("Autor");
    expect(out.fieldNames.sort()).toEqual(["campo-3", "campo-4"]);
    expect(out.outlineTitles).toEqual(["Capitulo 3", "Capitulo 4"]);
    expect(out.outlineTargets).toEqual([0, 1]);
  });

  it("no arrastra el contenido de las paginas que no se extraen", async () => {
    const bytes = await makeRichPdf(RICH);
    const text = await allStreamsText((await extractPages(bytes, [0])).bytes);
    expect(text).toContain(marker(0));
    for (let i = 1; i < 8; i += 1) expect(text).not.toContain(marker(i));
  });

  it("ignora duplicados, negativos y no enteros; sin paginas lanza `nothingSelected`; fuera de rango es `invalidConfig`", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    expect((await extractPages(bytes, [1, 1, -2, 1.5])).pageCount).toBe(1);
    await expect(extractPages(bytes, [])).rejects.toMatchObject({ code: "nothingSelected" });
    await expect(extractPages(bytes, [99])).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("`extractionPlan` ordena y deduplica", () => {
    expect(extractionPlan([4, 1, 4, 2]).map((entry) => (entry.kind === "existing" ? entry.sourceIndex : -1))).toEqual([1, 2, 4]);
  });

  it("extraer todas las paginas da un documento equivalente", async () => {
    const bytes = await makeRichPdf({ pages: 4, title: "Todo" });
    const out = await inspectPdf((await extractPages(bytes, [0, 1, 2, 3])).bytes);
    expect(out.pageCount).toBe(4);
    expect(out.title).toBe("Todo");
  });
});

describe("parseRangeParts", () => {
  it("cada elemento es una parte", () => {
    expect(parseRangeParts("1-3, 5, 7-9", 10)).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 7, to: 9 },
    ]);
  });

  it("acepta guiones largos y espacios alrededor", () => {
    expect(parseRangeParts("2 – 4;6", 10)).toEqual([
      { from: 2, to: 4 },
      { from: 6, to: 6 },
    ]);
  });

  it("devuelve null con tramos invalidos", () => {
    expect(parseRangeParts("3-1", 10)).toBeNull();
    expect(parseRangeParts("0", 10)).toBeNull();
    expect(parseRangeParts("11", 10)).toBeNull();
    expect(parseRangeParts("a", 10)).toBeNull();
    expect(parseRangeParts("1-2-3", 10)).toBeNull();
  });

  it("una cadena vacia es una lista vacia", () => {
    expect(parseRangeParts("   ", 10)).toEqual([]);
  });
});

describe("bookmarkGroups", () => {
  const starts = [
    { title: "B", pageIndex: 3, level: 1 },
    { title: "A", pageIndex: 0, level: 1 },
    { title: "C", pageIndex: 6, level: 1 },
  ];

  it("una parte por marcador, ordenadas por pagina", () => {
    const { groups, titles } = bookmarkGroups(starts, 9);
    expect(groups).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
    expect(titles).toEqual(["A", "B", "C"]);
  });

  it("si el primer marcador no esta en la pagina 1, las primeras paginas forman la parte inicial", () => {
    const { groups, titles } = bookmarkGroups([{ title: "X", pageIndex: 2, level: 1 }], 5, "Portada");
    expect(groups).toEqual([[0, 1], [2, 3, 4]]);
    expect(titles).toEqual(["Portada", "X"]);
  });

  it("dos marcadores en la misma pagina dan una sola parte", () => {
    const { groups } = bookmarkGroups(
      [
        { title: "A", pageIndex: 1, level: 1 },
        { title: "B", pageIndex: 1, level: 2 },
      ],
      3,
    );
    expect(groups).toEqual([[0], [1, 2]]);
  });

  it("sin marcadores todo el documento es una parte (no se pierde ninguna pagina)", () => {
    const { groups } = bookmarkGroups([], 4);
    expect(groups).toEqual([[0, 1, 2, 3]]);
  });

  it("la union de las partes cubre todas las paginas exactamente una vez", () => {
    const { groups } = bookmarkGroups(starts, 12);
    expect(groups.flat()).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
});

describe("readBookmarkStarts / planSplit", () => {
  it("lee los marcadores de primer nivel con su pagina", async () => {
    const bytes = await makeRichPdf({ pages: 4, outline: true });
    const starts = await readBookmarkStarts(bytes);
    expect(starts.map((s) => [s.title, s.pageIndex])).toEqual([
      ["Capitulo 1", 0],
      ["Capitulo 2", 1],
      ["Capitulo 3", 2],
      ["Capitulo 4", 3],
    ]);
  });

  it("solo el primer nivel por defecto, y los hijos con `maxLevel` 2", async () => {
    const bytes = await makeRichPdf({ pages: 4, nestedOutline: true });
    expect((await readBookmarkStarts(bytes, 1)).length).toBe(1);
    expect((await readBookmarkStarts(bytes, 2)).length).toBe(4);
  });

  it("un documento sin marcadores no tiene puntos de corte", async () => {
    expect(await readBookmarkStarts(await makeRichPdf({ pages: 3 }))).toEqual([]);
  });

  it("planSplit por marcadores, cada N y rangos", async () => {
    const bytes = await makeRichPdf({ pages: 6, outline: true });
    expect((await planSplit(bytes, { mode: "bookmarks" }, 6)).groups.length).toBe(6);
    expect((await planSplit(bytes, { mode: "every", size: 4 }, 6)).groups).toEqual([[0, 1, 2, 3], [4, 5]]);
    expect(
      (await planSplit(bytes, { mode: "ranges", ranges: [{ from: 1, to: 2 }, { from: 6, to: 6 }] }, 6)).groups,
    ).toEqual([[0, 1], [5]]);
  });

  it("planSplit con un valor invalido no lanza: sin grupos", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    expect((await planSplit(bytes, { mode: "every", size: 0 }, 3)).groups).toEqual([]);
    expect((await planSplit(bytes, { mode: "ranges", ranges: [{ from: 5, to: 9 }] }, 3)).groups).toEqual([]);
  });
});

describe("splitDocument", () => {
  it("una sola parte devuelve un PDF", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await splitDocument(bytes, [[1, 2]], "Libro");
    expect(result.kind).toBe("pdf");
    expect(result.names).toEqual(["Libro-2-3.pdf"]);
    expect((await inspectPdf(result.bytes)).markers).toEqual([marker(1), marker(2)]);
  });

  it("varias partes devuelven un ZIP con un PDF por parte", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await splitDocument(bytes, [[0, 1, 2], [3, 4], [5, 6, 7]], "Libro");
    expect(result.kind).toBe("zip");
    expect(result.parts).toBe(3);
    const files = await unzip(result.bytes);
    expect(Object.keys(files).sort()).toEqual(["Libro-1-3.pdf", "Libro-4-5.pdf", "Libro-6-8.pdf"]);
    expect((await inspectPdf(files["Libro-4-5.pdf"])).markers).toEqual([marker(3), marker(4)]);
  });

  it("la union de las partes contiene cada pagina exactamente una vez", async () => {
    const bytes = await makeRichPdf({ pages: 10 });
    const { groups } = await planSplit(bytes, { mode: "every", size: 3 }, 10);
    const result = await splitDocument(bytes, groups, "Doc");
    const files = await unzip(result.bytes);
    const markers: string[] = [];
    for (const name of Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      markers.push(...((await inspectPdf(files[name])).markers as string[]));
    }
    expect(markers).toEqual(Array.from({ length: 10 }, (_, i) => marker(i)));
  });

  it("cada parte conserva titulo y autor del original", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await splitDocument(bytes, [[0], [1]], "Libro");
    const files = await unzip(result.bytes);
    for (const file of Object.values(files)) {
      const out = await inspectPdf(file);
      expect(out.title).toBe("Libro");
      expect(out.author).toBe("Autor");
    }
  });

  it("cada parte lleva solo su campo de formulario y no el contenido de las demas", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await splitDocument(bytes, [[0, 1], [2, 3]], "Libro");
    const files = await unzip(result.bytes);
    const second = files["Libro-3-4.pdf"];
    expect((await inspectPdf(second)).fieldNames.sort()).toEqual(["campo-3", "campo-4"]);
    const text = await allStreamsText(second);
    expect(text).not.toContain(marker(0));
    expect(text).not.toContain(marker(7));
  });

  it("los enlaces internos no arrastran el documento entero a la parte", async () => {
    const bytes = await makeRichPdf({ pages: 8, links: true });
    const result = await splitDocument(bytes, [[0], [1]], "Doc");
    const files = await unzip(result.bytes);
    const first = await inspectPdf(files["Doc-1.pdf"]);
    expect(first.pageObjects).toBe(1);
    expect(first.links[0]).toEqual(["uri"]);
  });

  it("nombres unicos aunque dos partes pidan el mismo rango", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const result = await splitDocument(bytes, [[0, 1], [0, 1], [0, 1]], "Doc");
    expect(new Set(result.names).size).toBe(3);
    expect(result.names).toEqual(["Doc-1-2.pdf", "Doc-1-2 (2).pdf", "Doc-1-2 (3).pdf"]);
    expect(Object.keys(await unzip(result.bytes)).length).toBe(3);
  });

  it("nombres unicos sin distinguir mayusculas (Windows/macOS)", async () => {
    const bytes = await makeRichPdf({ pages: 3, outline: true });
    const result = await splitDocument(bytes, [[0], [1]], "Doc", { titles: ["Intro", "INTRO"] });
    expect(result.names).toEqual(["Doc - Intro.pdf", "Doc - INTRO (2).pdf"]);
  });

  it("usa el titulo del marcador como nombre y lo limpia de caracteres no validos", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const result = await splitDocument(bytes, [[0], [1]], "Doc", { titles: ["Cap/1: *Inicio*?", ""] });
    expect(result.names).toEqual(["Doc - Cap 1 Inicio.pdf", "Doc-2.pdf"]);
  });

  it("ignora indices fuera de rango; si no queda ninguna parte, `nothingSelected`", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    await expect(splitDocument(bytes, [[9]], "Doc")).rejects.toMatchObject({ code: "nothingSelected" });
    await expect(splitDocument(bytes, [], "Doc")).rejects.toMatchObject({ code: "nothingSelected" });
    const ok = await splitDocument(bytes, [[0, 9]], "Doc");
    expect(ok.kind).toBe("pdf");
  });

  it(`mas de ${MAX_SPLIT_PARTS} partes es \`tooLarge\``, async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const groups = Array.from({ length: MAX_SPLIT_PARTS + 1 }, () => [0]);
    await expect(splitDocument(bytes, groups, "Doc")).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("cancelar con una senal abortada lanza `cancelled`", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const controller = new AbortController();
    controller.abort();
    await expect(splitDocument(bytes, [[0], [1]], "Doc", { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("cancelar a mitad corta la division", async () => {
    const bytes = await makeRichPdf({ pages: 30 });
    const controller = new AbortController();
    const groups = Array.from({ length: 30 }, (_, i) => [i]);
    await expect(
      splitDocument(bytes, groups, "Doc", {
        signal: controller.signal,
        onProgress: (value) => {
          if (value > 0.3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("el progreso es monotono y acaba en 1", async () => {
    const bytes = await makeRichPdf({ pages: 6 });
    const values: number[] = [];
    await splitDocument(bytes, [[0, 1], [2, 3], [4, 5]], "Doc", { onProgress: (v) => values.push(v) });
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    expect(values[values.length - 1]).toBe(1);
  });

  it("500 paginas una a una: 500 archivos en el ZIP sin perder ninguna", async () => {
    const bytes = await makeRichPdf({ pages: 500 });
    const groups = Array.from({ length: 500 }, (_, i) => [i]);
    const started = performance.now();
    const result = await splitDocument(bytes, groups, "Doc");
    const elapsed = performance.now() - started;
    expect(result.parts).toBe(500);
    expect(new Set(result.names).size).toBe(500);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(Object.keys(zip.files).length).toBe(500);
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  it("el documento de entrada no cambia", async () => {
    const bytes = await makeRichPdf(RICH);
    const copy = bytes.slice();
    await splitDocument(bytes, [[0], [1]], "Libro");
    expect(bytes).toEqual(copy);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(8);
  });

  it("`describeGroup` muestra rangos 1-based", () => {
    expect(describeGroup([0, 1, 2, 5])).toBe("1-3, 6");
  });
});
