import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { applyPageAssembly, type PageAssemblyWarning, type PageEntry } from "@/lib/pdf/pageAssembly";
import { extractPages, splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { inspectPdf, makeRichPdf, pageDrawFingerprints } from "@/lib/pdf/testing/pageAssemblyFixtures";
import {
  LEAK_VECTORS,
  PAGE_MARKS,
  annotMark,
  buttonChain,
  buttonTarget,
  countBeads,
  makeLeakPdf,
  scanFile,
  type LeakVector,
} from "@/lib/pdf/testing/pageAssemblyLeakFixtures";

/**
 * D1 (Wave 9 · B7): lo que se QUITA no se queda dentro del archivo. Si una pagina quitada seguia referenciada desde algo
 * que se conserva (un boton con salto, una accion encadenada con `/Next`, un `/AA` de pagina o de catalogo, el `/P` de una
 * anotacion, un articulo, la accion de apertura, el orden de calculo del formulario...), su objeto de pagina, su texto y
 * sus anotaciones seguian en el archivo. Aqui se comprueba POR CADENAS sobre el archivo (flujos descomprimidos incluidos)
 * y contando los objetos `/Type /Page`, por las cuatro vias que quitan paginas y por la que las copia (Unir).
 */

const existing = (sourceIndex: number): PageEntry => ({ kind: "existing", sourceIndex, rotation: 0 });
const external = (sourceIndex: number): PageEntry => ({ kind: "external", sourceId: "x", sourceIndex, rotation: 0 });

/** `linksRemoved` esperado al quitar las paginas 3 y 4 (el plan `[0, 1]`), por vector. */
const LINKS_REMOVED: Record<LeakVector, number> = {
  widgetButton: 1,
  buttonNamedDest: 1,
  nextChain: 1,
  nextChainMiddle: 1,
  nextArray: 1,
  pageAA: 1,
  catalogAA: 1,
  annotAA: 1,
  annotP: 0,
  popup: 0,
  irt: 0,
  openActionGoTo: 1,
  openActionNext: 1,
  openActionDest: 1,
  threads: 2,
  outlineResidual: 1,
  calcOrder: 0,
  namedAndLegacyDests: 1,
  none: 0,
};

/** Lo que cuelga del CATALOGO del documento no viaja a otro documento: copiar paginas no tiene nada que quitar de ahi. */
const CATALOG_ONLY: ReadonlySet<LeakVector> = new Set([
  "catalogAA",
  "openActionGoTo",
  "openActionNext",
  "openActionDest",
  "outlineResidual",
  "namedAndLegacyDests",
  "buttonNamedDest",
  "threads",
]);

/** `linksRemoved` que se espera, como minimo, al COPIAR las dos primeras paginas a otro documento. */
function copiedLinks(vector: LeakVector): number {
  return CATALOG_ONLY.has(vector) ? 0 : LINKS_REMOVED[vector];
}

function count(warnings: readonly PageAssemblyWarning[], code: PageAssemblyWarning["code"]): number {
  return warnings.filter((warning) => warning.code === code).reduce((total, warning) => total + warning.count, 0);
}

/** Lo que el archivo NO debe llevar: paginas 3 y 4, y todo lo que colgaba de ellas. */
async function expectNoLeak(bytes: Uint8Array, vector: LeakVector, keptPages: number): Promise<void> {
  const scan = await scanFile(bytes);
  expect(scan.pageObjects, "objetos /Type /Page").toBe(keptPages);
  expect(scan.text).toContain(PAGE_MARKS[0]);
  expect(scan.text).toContain(PAGE_MARKS[1]);
  expect(scan.text).not.toContain(PAGE_MARKS[2]);
  expect(scan.text).not.toContain(PAGE_MARKS[3]);
  expect(scan.text).not.toContain("LEAKA-");
  // Ninguna marca privada de reapuntado se queda en el archivo.
  expect(scan.text).not.toContain("OptimusLink");
  expect(scan.text, `marca de ${vector}`).not.toContain(annotMark(vector));
}

describe("D1 · quitar paginas: nada que cuelgue de ellas se queda en el archivo", () => {
  for (const vector of LEAK_VECTORS) {
    describe(vector, () => {
      it("Quitar / Organizar (plan en sitio): sin la pagina, su texto ni sus anotaciones; el boton legitimo sigue; el aviso cuenta lo quitado", async () => {
        const source = await makeLeakPdf(vector);
        const before = await pageDrawFingerprints(source);
        const result = await applyPageAssembly(source, [existing(0), existing(1)]);
        await expectNoLeak(result.bytes, vector, 2);
        expect(count(result.warnings, "linksRemoved")).toBe(LINKS_REMOVED[vector]);
        // Las paginas que se quedan se dibujan igual (mismos flujos, mismas cajas).
        expect(await pageDrawFingerprints(result.bytes)).toEqual(before.slice(0, 2));
        // Referencia legitima: el boton de la pagina 1 sigue llevando a la 2, con su accion encadenada.
        expect(await buttonTarget(result.bytes, 0, "legit")).toBe(1);
        expect(await buttonChain(result.bytes, 0, "legit")).toEqual(["GoTo", "URI"]);
      });

      it("Extraer: igual", async () => {
        const source = await makeLeakPdf(vector);
        const result = await extractPages(source, [0, 1]);
        await expectNoLeak(result.bytes, vector, 2);
        expect(count(result.warnings, "linksRemoved")).toBe(LINKS_REMOVED[vector]);
        expect(await buttonTarget(result.bytes, 0, "legit")).toBe(1);
      });

      it("Dividir en una parte con las dos primeras paginas: sin las demas (el copiador no las arrastra)", async () => {
        const source = await makeLeakPdf(vector);
        const outcome = await splitDocument(source, [[0, 1]], "doc");
        expect(outcome.kind).toBe("pdf");
        await expectNoLeak(outcome.bytes, vector, 2);
        expect(count(outcome.warnings, "linksRemoved")).toBeGreaterThanOrEqual(copiedLinks(vector));
        expect(await buttonTarget(outcome.bytes, 0, "legit")).toBe(1);
      });

      it("Unir (paginas de otro PDF): copiar las dos primeras no arrastra las demas", async () => {
        const source = await makeLeakPdf(vector);
        const base = await PDFDocument.create({ updateMetadata: false });
        const font = await base.embedFont(StandardFonts.Helvetica);
        base.addPage([300, 400]).drawText("BASE-PAGE", { x: 24, y: 300, size: 22, font });
        const baseBytes = new Uint8Array(await base.save());
        const result = await applyPageAssembly(baseBytes, [existing(0), external(0), external(1)], { x: source });
        await expectNoLeak(result.bytes, vector, 3);
        expect(count(result.warnings, "linksRemoved")).toBeGreaterThanOrEqual(copiedLinks(vector));
        expect(await buttonTarget(result.bytes, 1, "legit")).toBe(2);
      });
    });
  }

  it("TODOS los vectores a la vez en un mismo documento: ni Quitar, ni Extraer, ni Dividir, ni Unir dejan nada de las paginas 3 y 4", async () => {
    const source = await makeLeakPdf(LEAK_VECTORS);
    const quitar = await applyPageAssembly(source, [existing(0), existing(1)]);
    await expectNoLeak(quitar.bytes, "widgetButton", 2);
    await expectNoLeak((await extractPages(source, [0, 1])).bytes, "widgetButton", 2);
    await expectNoLeak((await splitDocument(source, [[0, 1]], "doc")).bytes, "widgetButton", 2);
    const base = await makeRichPdf({ pages: 1 });
    const united = await applyPageAssembly(base, [existing(0), external(0), external(1)], { x: source });
    await expectNoLeak(united.bytes, "widgetButton", 3);
    expect(await buttonTarget(quitar.bytes, 0, "legit")).toBe(1);
    expect(count(quitar.warnings, "linksRemoved")).toBeGreaterThan(0);
  });

  it("quitar solo la pagina 3 de 4 (queda la 4): la 4 conserva sus propias anotaciones y lo demas no queda", async () => {
    const source = await makeLeakPdf("widgetButton");
    const result = await applyPageAssembly(source, [existing(0), existing(1), existing(3)]);
    const scan = await scanFile(result.bytes);
    expect(scan.pageObjects).toBe(3);
    expect(scan.text).toContain(PAGE_MARKS[3]);
    expect(scan.text).not.toContain(PAGE_MARKS[2]);
    // El boton hacia la pagina quitada se fue; el de la pagina 2 sigue.
    expect(await buttonTarget(result.bytes, 0, "toDead")).toBeUndefined();
    expect(await buttonTarget(result.bytes, 0, "legit")).toBe(1);
  });

  it("el boton cuya accion llevaba a una pagina quitada se queda (sin la accion); el que lleva a una que se queda, con la suya", async () => {
    const source = await makeLeakPdf("widgetButton");
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const annots = loaded.getPage(0).node.Annots()!;
    const actions: Record<string, boolean> = {};
    for (let index = 0; index < annots.size(); index += 1) {
      const dict = loaded.context.lookup(annots.get(index));
      if (dict instanceof PDFDict && dict.get(PDFName.of("T")) instanceof PDFString) {
        actions[(dict.get(PDFName.of("T")) as PDFString).decodeText()] = dict.has(PDFName.of("A"));
      }
    }
    expect(actions).toEqual({ legit: true, toDead: false });
  });

  it("nextChainMiddle: el salto muerto sale de la cadena y la accion siguiente (URI) pasa a ser la accion del boton", async () => {
    const source = await makeLeakPdf("nextChainMiddle");
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    expect(await buttonChain(result.bytes, 0, "middle")).toEqual(["URI"]);
  });

  it("nextArray: se van los saltos muertos y se quedan el URI y el salto a una pagina viva", async () => {
    const source = await makeLeakPdf("nextArray");
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    expect(await buttonChain(result.bytes, 0, "array")).toEqual(["URI", "URI", "GoTo"]);
  });

  it("pageAA: se va la accion de salto y se queda la otra del mismo /AA", async () => {
    const source = await makeLeakPdf("pageAA");
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const aa = loaded.getPage(0).node.get(PDFName.of("AA")) as PDFDict;
    const keys = aa.keys().map((key) => key.decodeText());
    expect(keys).toEqual(["C"]);
  });

  it("threads: el articulo conserva las cuentas de las paginas que quedan, enlazadas en un anillo", async () => {
    const source = await makeLeakPdf("threads");
    expect(await countBeads(source)).toBe(4);
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    expect(await countBeads(result.bytes)).toBe(2);
    const loaded = await PDFDocument.load(result.bytes);
    const beadOf = (page: number) => {
      const b = loaded.getPage(page).node.get(PDFName.of("B")) as PDFArray;
      return loaded.context.lookup(b.get(0)) as PDFDict;
    };
    const first = beadOf(0);
    const second = beadOf(1);
    // Anillo de dos: cada cuenta apunta a la otra, hacia delante y hacia atras, y su /P es su pagina.
    expect(loaded.context.lookup(first.get(PDFName.of("N")))).toBe(second);
    expect(loaded.context.lookup(first.get(PDFName.of("V")))).toBe(second);
    expect(loaded.context.lookup(second.get(PDFName.of("N")))).toBe(first);
    expect(first.get(PDFName.of("P"))).toBe(loaded.getPage(0).ref);
    expect(second.get(PDFName.of("P"))).toBe(loaded.getPage(1).ref);
    const threads = loaded.catalog.get(PDFName.of("Threads")) as PDFArray;
    expect(threads.size()).toBe(1);
  });

  it("threads: si la primera cuenta (/F) es de una pagina quitada, el articulo empieza por la primera que queda y el anillo se cierra", async () => {
    const source = await makeLeakPdf("threads");
    const result = await applyPageAssembly(source, [existing(1), existing(3)]);
    const loaded = await PDFDocument.load(result.bytes);
    const threads = loaded.catalog.get(PDFName.of("Threads")) as PDFArray;
    const thread = loaded.context.lookup(threads.get(0)) as PDFDict;
    const first = loaded.context.lookup(thread.get(PDFName.of("F"))) as PDFDict;
    expect(first.get(PDFName.of("P"))).toBe(loaded.getPage(0).ref);
    const second = loaded.context.lookup(first.get(PDFName.of("N"))) as PDFDict;
    expect(second.get(PDFName.of("P"))).toBe(loaded.getPage(1).ref);
    expect(loaded.context.lookup(second.get(PDFName.of("N")))).toBe(first);
    expect(loaded.context.lookup(first.get(PDFName.of("V")))).toBe(second);
    expect(count(result.warnings, "linksRemoved")).toBe(2);
    expect((await scanFile(result.bytes)).pageObjects).toBe(2);
  });

  it("threads: si no queda ninguna cuenta del articulo, el articulo se va", async () => {
    const source = await makeLeakPdf("threads");
    const result = await applyPageAssembly(source, [existing(0)]);
    const keep = await applyPageAssembly(source, [existing(2)]);
    const loaded = await PDFDocument.load(result.bytes);
    expect((loaded.catalog.get(PDFName.of("Threads")) as PDFArray).size()).toBe(1);
    // Solo la pagina 3: tambien queda una cuenta (anillo de uno).
    expect(await countBeads(keep.bytes)).toBe(1);
    const only = await applyPageAssembly(await makeLeakPdf("none"), [existing(1)]);
    expect(only.pageCount).toBe(1);
  });

  it("calcOrder: el campo de una pagina quitada sale tambien del orden de calculo (/CO)", async () => {
    const source = await makeLeakPdf("calcOrder");
    const result = await applyPageAssembly(source, [existing(0), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const form = loaded.catalog.get(PDFName.of("AcroForm"));
    const dict = form instanceof PDFRef ? loaded.context.lookup(form) : form;
    const co = (dict as PDFDict).get(PDFName.of("CO"));
    expect(co === undefined || (co instanceof PDFArray && co.size() === 0)).toBe(true);
    expect(count(result.warnings, "formFieldsRemoved")).toBe(1);
  });

  it("sin paginas quitadas ni copiadas no se toca nada (identidad: mismos bytes de contenido y el boton intacto)", async () => {
    const source = await makeLeakPdf("widgetButton");
    const result = await applyPageAssembly(source, [0, 1, 2, 3].map(existing));
    expect(result.warnings).toEqual([]);
    expect(await buttonTarget(result.bytes, 0, "toDead")).toBe(2);
  });
});

describe("D1 · reapuntar y no romper lo legitimo", () => {
  it("Unir: el boton que lleva a otra pagina del MISMO archivo sigue llevando a ella, en el orden nuevo", async () => {
    const source = await makeLeakPdf("none");
    const base = await makeRichPdf({ pages: 1 });
    // El archivo entra con sus paginas invertidas: [1, 0] -> el boton (de la pagina 0 del origen) lleva a la pagina 1 del origen.
    const plan: PageEntry[] = [existing(0), external(1), external(0)];
    const result = await applyPageAssembly(base, plan, { x: source });
    expect(await buttonTarget(result.bytes, 2, "legit")).toBe(1);
    expect(await buttonChain(result.bytes, 2, "legit")).toEqual(["GoTo", "URI"]);
    expect(count(result.warnings, "linksRemoved")).toBe(0);
  });

  it("Unir: si la pagina de destino del boton no viene, la accion se quita y se cuenta (la cadena que sigue se conserva)", async () => {
    const source = await makeLeakPdf("none");
    const base = await makeRichPdf({ pages: 1 });
    const result = await applyPageAssembly(base, [existing(0), external(0)], { x: source });
    expect(await buttonChain(result.bytes, 1, "legit")).toEqual(["URI"]);
    expect(count(result.warnings, "linksRemoved")).toBe(1);
    const scan = await scanFile(result.bytes);
    expect(scan.pageObjects).toBe(2);
    expect(scan.text).not.toContain(PAGE_MARKS[1]);
  });

  it("Dividir en dos partes: el boton que lleva a la OTRA parte pierde la accion (y no arrastra la otra pagina); el de la misma parte se queda", async () => {
    const source = await makeLeakPdf("none");
    const apart = await splitDocument(source, [[0], [1]], "doc");
    expect(count(apart.warnings, "linksRemoved")).toBe(1);
    const zip = await JSZip.loadAsync(apart.bytes);
    const first = await scanFile(await zip.file("doc-1.pdf")!.async("uint8array"));
    expect(first.pageObjects).toBe(1);
    expect(first.text).toContain(PAGE_MARKS[0]);
    expect(first.text).not.toContain(PAGE_MARKS[1]);
    const together = await splitDocument(source, [[0, 1]], "doc");
    expect(count(together.warnings, "linksRemoved")).toBe(0);
    expect(await buttonTarget(together.bytes, 0, "legit")).toBe(1);
  });

  it("las paginas plantilla con nombre (fuera del arbol, en /Names /Pages) no son paginas quitadas: se quedan enteras", async () => {
    const source = await makeLeakPdf("none");
    const document = await PDFDocument.load(source);
    const context = document.context;
    const N = PDFName.of;
    const contents = context.register(context.stream("BT /F1 12 Tf (PLANTILLA-MARCA) Tj ET"));
    const template = context.register(
      context.obj({ Type: N("Page"), MediaBox: [0, 0, 100, 100], Contents: contents, Resources: {} } as never),
    );
    document.catalog.set(
      N("Names"),
      context.obj({ Pages: context.obj({ Names: [PDFString.of("plantilla"), template] }) } as never),
    );
    const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
    const result = await applyPageAssembly(bytes, [existing(0), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const names = loaded.catalog.get(N("Names")) as PDFDict;
    const pages = loaded.context.lookup(names.get(N("Pages"))) as PDFDict;
    const array = loaded.context.lookup(pages.get(N("Names"))) as PDFArray;
    expect(array.size()).toBe(2);
    expect((await scanFile(result.bytes)).text).toContain("PLANTILLA-MARCA");
  });

  it("un PDF etiquetado conserva su estructura al quitar paginas aunque una pagina que se queda las nombre", async () => {
    const tagged = await makeRichPdf({ pages: 4, taggedContent: true });
    const document = await PDFDocument.load(tagged);
    const context = document.context;
    const N = PDFName.of;
    const annot = context.register(
      context.obj({
        Type: N("Annot"),
        Subtype: N("Widget"),
        FT: N("Btn"),
        Ff: 65536,
        T: PDFString.of("salto"),
        Rect: [10, 10, 60, 40],
        A: context.obj({ S: N("GoTo"), D: context.obj([document.getPage(3).ref, N("Fit")]) }),
      } as never),
    );
    document.getPage(0).node.set(N("Annots"), context.obj([annot]));
    const bytes = new Uint8Array(await document.save());
    const result = await applyPageAssembly(bytes, [existing(0), existing(1)]);
    const report = await inspectPdf(result.bytes);
    expect(report.pageObjects).toBe(2);
    expect(report.hasStructTree).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "structureRemoved")).toBe(false);
    expect(count(result.warnings, "linksRemoved")).toBe(1);
    expect((await scanFile(result.bytes)).text).not.toContain("MARCA-PAGINA-0004");
  });
});

/* ------------------------------------------------------------------ *
 * Referencias plantadas en sitios cualquiera
 * ------------------------------------------------------------------ */

/** Generador pseudoaleatorio determinista (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("D1 · referencias a paginas quitadas plantadas en sitios cualesquiera", () => {
  const N = PDFName.of;

  async function planted(seed: number): Promise<Uint8Array> {
    const next = random(seed);
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const ctx = pdf.context;
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = [0, 1, 2, 3].map((index) => {
      const page = pdf.addPage([300, 400]);
      page.drawText(PAGE_MARKS[index], { x: 24, y: 300, size: 22, font });
      return page;
    });
    const dead = pages[2].ref;
    const deadDest = () => ctx.obj([dead, N("XYZ"), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]);
    const annot = ctx.register(ctx.obj({ Type: N("Annot"), Subtype: N("Text"), Rect: [0, 0, 10, 10], Contents: PDFString.of("viva") } as never));
    pages[0].node.set(N("Annots"), ctx.obj([annot]));
    const xobject = ctx.register(ctx.stream("q Q", { Type: N("XObject"), Subtype: N("Form"), BBox: [0, 0, 10, 10] }));
    (ctx.lookup(xobject) as unknown as { dict: PDFDict }).dict.set(N("XDead"), dead);
    pages[0].node.set(N("XForm"), xobject);
    const shared = ctx.register(ctx.obj({ Ref: dead, Arr: [1, dead, PDFString.of("s")] } as never));
    const holders: PDFDict[] = [
      pages[0].node,
      pages[1].node,
      ctx.lookup(annot) as PDFDict,
      pdf.catalog,
      ctx.lookup(shared) as PDFDict,
    ];
    const plants = [
      (holder: PDFDict, key: string) => holder.set(N(key), dead),
      (holder: PDFDict, key: string) => holder.set(N(key), deadDest()),
      (holder: PDFDict, key: string) => holder.set(N(key), ctx.obj({ Inner: [dead], Deeper: { Again: deadDest() } } as never)),
      (holder: PDFDict, key: string) => holder.set(N(key), ctx.obj([1, dead, PDFString.of("s"), deadDest()] as never)),
      (holder: PDFDict, key: string) => holder.set(N(key), ctx.register(ctx.obj([deadDest(), dead] as never))),
      (holder: PDFDict, key: string) => holder.set(N(key), shared),
    ];
    const count = 3 + Math.floor(next() * 5);
    for (let index = 0; index < count; index += 1) {
      const holder = holders[Math.floor(next() * holders.length)];
      plants[Math.floor(next() * plants.length)](holder, `XPlant${index}`);
    }
    return new Uint8Array(await pdf.save({ useObjectStreams: false }));
  }

  for (let seed = 1; seed <= 24; seed += 1) {
    it(`semilla ${seed}: ninguna referencia a la pagina quitada sobrevive y la pagina 3 no queda en el archivo`, async () => {
      const source = await planted(seed);
      const result = await applyPageAssembly(source, [existing(0), existing(1), existing(3)]);
      const scan = await scanFile(result.bytes);
      expect(scan.pageObjects).toBe(3);
      expect(scan.text).not.toContain(PAGE_MARKS[2]);
      for (const mark of [PAGE_MARKS[0], PAGE_MARKS[1], PAGE_MARKS[3]]) expect(scan.text).toContain(mark);
      const extracted = await extractPages(source, [0, 1, 3]);
      expect((await scanFile(extracted.bytes)).text).not.toContain(PAGE_MARKS[2]);
      const split = await splitDocument(source, [[0, 1], [3]], "doc");
      expect(split.parts).toBe(2);
      const zip = await JSZip.loadAsync(split.bytes);
      for (const name of Object.keys(zip.files)) {
        const part = await scanFile(await zip.file(name)!.async("uint8array"));
        expect(part.text, name).not.toContain(PAGE_MARKS[2]);
        expect(part.pageObjects, name).toBe(name === "doc-4.pdf" ? 1 : 2);
      }
    });
  }
});
