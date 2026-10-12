import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { applyPageAssembly, identityPlan, type PageEntry } from "@/lib/pdf/pageAssembly";
import { organizePdf } from "@/lib/pdf/organize";
import { removePdfPages } from "@/lib/pdf/removePages";
import { mergePdfFiles } from "@/lib/pdf/merge";
import {
  allStreamsText,
  inspectPdf,
  makeRichPdf,
  marker,
} from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Hallazgo del descubrimiento de la Wave 7: `copyPages` a un documento nuevo pierde titulo,
 * autor, AcroForm y marcadores. Estas pruebas FALLAN si el motor en sitio los pierde, y comparan
 * con los motores actuales (`organize`, `merge`) para dejar medido el contraste.
 */

const existing = (sourceIndex: number, rotation = 0, copy = false): PageEntry => ({
  kind: "existing",
  sourceIndex,
  rotation,
  ...(copy ? { copy: true } : {}),
});

const RICH = {
  pages: 6,
  title: "Informe anual",
  author: "Ana Perez",
  subject: "Resultados",
  keywords: ["finanzas", "2026"],
  form: true,
  outline: true,
  links: true,
  pageLabels: true,
} as const;

function toFile(bytes: Uint8Array): File {
  return new File([bytes as unknown as BlobPart], "doc.pdf", { type: "application/pdf" });
}

describe("conservacion en sitio: metadatos", () => {
  it("reordenar conserva titulo, autor, asunto y palabras clave", async () => {
    const bytes = await makeRichPdf(RICH);
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(5), existing(0), existing(3)])).bytes);
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
    expect(out.subject).toBe("Resultados");
    expect(out.keywords).toContain("finanzas");
  });

  it("eliminar paginas conserva los metadatos", async () => {
    const bytes = await makeRichPdf(RICH);
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(1)])).bytes);
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
  });

  it("insertar de otro PDF y en blanco conserva los metadatos del documento actual", async () => {
    const bytes = await makeRichPdf(RICH);
    const other = await makeRichPdf({ pages: 2, title: "Otro", author: "Otra" });
    const plan: PageEntry[] = [
      ...identityPlan(6),
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
      { kind: "blank", width: 100, height: 100, rotation: 0 },
    ];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan, { x: other })).bytes);
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
  });

  it("duplicar y girar conservan los metadatos", async () => {
    const bytes = await makeRichPdf(RICH);
    const out = await inspectPdf(
      (await applyPageAssembly(bytes, [existing(0, 90), existing(0, 0, true), ...identityPlan(6).slice(1)])).bytes,
    );
    expect(out.title).toBe("Informe anual");
  });

  it("CONTRASTE: `organizePdf` (copyPages a un documento nuevo) pierde titulo y autor", async () => {
    const bytes = await makeRichPdf(RICH);
    const blob = await organizePdf(toFile(bytes), [
      { kind: "existing", page: 2, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
    ]);
    const out = await inspectPdf(new Uint8Array(await blob.arrayBuffer()));
    expect(out.title).not.toBe("Informe anual");
    expect(out.author).not.toBe("Ana Perez");
  });
});

describe("conservacion en sitio: formulario (AcroForm)", () => {
  it("reordenar conserva todos los campos y sus valores", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await applyPageAssembly(bytes, [existing(5), existing(4), existing(3), existing(2), existing(1), existing(0)]);
    const out = await inspectPdf(result.bytes);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3", "campo-4", "campo-5", "campo-6"]);
    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getForm().getTextField("campo-3").getText()).toBe("valor-3");
  });

  it("cada widget sigue apuntando (/P) a su pagina tras reordenar", async () => {
    const bytes = await makeRichPdf({ pages: 3, form: true });
    const result = await applyPageAssembly(bytes, [existing(2), existing(0), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const pages = loaded.getPages();
    const form = loaded.getForm();
    const owner = (name: string) => {
      const widget = form.getTextField(name).acroField.getWidgets()[0];
      const pageRef = widget.P();
      return pages.findIndex((page) => page.ref === pageRef);
    };
    expect(owner("campo-3")).toBe(0);
    expect(owner("campo-1")).toBe(1);
    expect(owner("campo-2")).toBe(2);
  });

  it("al eliminar una pagina se va su campo y los demas se quedan", async () => {
    const bytes = await makeRichPdf({ pages: 4, form: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(2), existing(3)]);
    const out = await inspectPdf(result.bytes);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-3", "campo-4"]);
    expect(result.warnings).toContainEqual({ code: "formFieldsRemoved", count: 1 });
  });

  it("duplicar una pagina con campo crea un widget propio que comparte el campo (mismo valor)", async () => {
    const bytes = await makeRichPdf({ pages: 2, form: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(0, 0, true), existing(1)]);
    const loaded = await PDFDocument.load(result.bytes);
    const widgets = loaded.getForm().getTextField("campo-1").acroField.getWidgets();
    expect(widgets.length).toBe(2);
    const pages = loaded.getPages();
    const owners = widgets.map((widget) => pages.findIndex((page) => page.ref === widget.P()));
    expect(owners.sort()).toEqual([0, 1]);
    expect((await inspectPdf(result.bytes)).fieldNames.sort()).toEqual(["campo-1", "campo-2"]);
  });

  it("una pagina de otro PDF con campos que repiten nombre se renombra y queda registrada", async () => {
    const bytes = await makeRichPdf({ pages: 2, form: true });
    const other = await makeRichPdf({ pages: 2, form: true });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
      existing(1),
    ];
    const result = await applyPageAssembly(bytes, plan, { x: other });
    const names = (await inspectPdf(result.bytes)).fieldNames.sort();
    expect(names).toEqual(["campo-1", "campo-1_2", "campo-2"]);
    expect(result.warnings).toContainEqual({ code: "fieldsRenamed", count: 1 });
    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getForm().getTextField("campo-1_2").getText()).toBe("valor-1");
  });

  it("los widgets de la pagina importada apuntan a la pagina importada, no a una copia huerfana", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2, form: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan, { x: other });
    const loaded = await PDFDocument.load(result.bytes);
    const widget = loaded.getForm().getTextField("campo-2").acroField.getWidgets()[0];
    expect(widget.P()).toBe(loaded.getPage(1).ref);
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(2);
  });

  it("de otro PDF solo entra el campo de la pagina elegida (no los de las demas)", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, form: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 2, rotation: 0 }];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan, { x: other })).bytes);
    expect(out.fieldNames).toEqual(["campo-3"]);
  });

  it("un campo de firma no se copia a otro documento y se avisa", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2, form: true, signatureField: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan, { x: other });
    expect((await inspectPdf(result.bytes)).fieldNames).not.toContain("firma");
    expect(result.warnings).toContainEqual({ code: "signatureFieldsRemoved", count: 1 });
  });

  it("un campo de firma no se clona al duplicar la pagina", async () => {
    const bytes = await makeRichPdf({ pages: 2, signatureField: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(0, 0, true)]);
    const loaded = await PDFDocument.load(result.bytes);
    const widgets = loaded.getPages().map((page) => (page.node.Annots()?.size() ?? 0));
    expect(widgets).toEqual([1, 0]);
  });

  it("CONTRASTE: unir con `mergePdfFiles` (copyPages) deja el documento sin AcroForm", async () => {
    const bytes = await makeRichPdf({ pages: 2, form: true });
    const blob = await mergePdfFiles([toFile(bytes), toFile(bytes)]);
    const out = await inspectPdf(new Uint8Array(await blob.arrayBuffer()));
    expect(out.fieldNames).toEqual([]);
  });

  it("un documento sin formulario no gana uno al insertar paginas sin campos", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const other = await makeRichPdf({ pages: 2 });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    const loaded = await PDFDocument.load((await applyPageAssembly(bytes, plan, { x: other })).bytes);
    expect(loaded.catalog.has(loaded.context.obj("AcroForm") as never)).toBe(false);
  });

  it("insertar una pagina con campos en un documento SIN formulario crea el formulario", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 1, form: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan, { x: other })).bytes);
    expect(out.fieldNames).toEqual(["campo-1"]);
  });
});

describe("conservacion en sitio: marcadores", () => {
  it("reordenar conserva todos los marcadores y apuntan a la pagina correcta", async () => {
    const bytes = await makeRichPdf(RICH);
    const plan = [existing(5), existing(4), existing(3), existing(2), existing(1), existing(0)];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 3", "Capitulo 4", "Capitulo 5", "Capitulo 6"]);
    expect(out.outlineTargets).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("rotar y duplicar no tocan los marcadores", async () => {
    const bytes = await makeRichPdf(RICH);
    const plan = [existing(0, 90), existing(0, 0, true), ...identityPlan(6).slice(1)];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(out.outlineTitles.length).toBe(6);
    expect(out.outlineTargets[0]).toBe(0);
  });

  it("al eliminar una pagina se va su marcador (con aviso) y los demas siguen apuntando bien", async () => {
    const bytes = await makeRichPdf(RICH);
    const plan = [existing(0), existing(1), existing(3), existing(4), existing(5)];
    const result = await applyPageAssembly(bytes, plan);
    const out = await inspectPdf(result.bytes);
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 4", "Capitulo 5", "Capitulo 6"]);
    expect(out.outlineTargets).toEqual([0, 1, 2, 3, 4]);
    expect(result.warnings).toContainEqual({ code: "outlinesRemoved", count: 1 });
  });

  it("ningun marcador queda apuntando a una pagina que no existe", async () => {
    const bytes = await makeRichPdf(RICH);
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(2), existing(4)])).bytes);
    expect(out.outlineTargets.every((target) => target >= 0)).toBe(true);
    expect(out.outlineTitles).toEqual(["Capitulo 3", "Capitulo 5"]);
  });

  it("si se quitan todas las paginas con marcador, desaparece el arbol de marcadores", async () => {
    const bytes = await makeRichPdf(RICH);
    const plan: PageEntry[] = [{ kind: "blank", width: 100, height: 100, rotation: 0 }];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(out.outlineTitles).toEqual([]);
  });

  it("marcadores anidados: quitar un hijo conserva padre y hermanos", async () => {
    const bytes = await makeRichPdf({ pages: 5, nestedOutline: true });
    const plan = [existing(0), existing(1), existing(3), existing(4)];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 4", "Capitulo 5"]);
    expect(out.outlineTargets).toEqual([0, 1, 2, 3]);
  });

  it("marcadores anidados: quitar el padre sube a los hijos", async () => {
    const bytes = await makeRichPdf({ pages: 4, nestedOutline: true });
    const result = await applyPageAssembly(bytes, [existing(1), existing(2), existing(3)]);
    const out = await inspectPdf(result.bytes);
    expect(out.outlineTitles).toEqual(["Capitulo 2", "Capitulo 3", "Capitulo 4"]);
    expect(out.outlineTargets).toEqual([0, 1, 2]);
    expect(result.warnings).toContainEqual({ code: "outlinesRemoved", count: 1 });
  });

  it("el /Count del arbol de marcadores queda coherente tras podar", async () => {
    const bytes = await makeRichPdf(RICH);
    const result = await applyPageAssembly(bytes, [existing(0), existing(5)]);
    const loaded = await PDFDocument.load(result.bytes);
    const outlines = loaded.catalog.lookup(loaded.context.obj("Outlines") as never);
    expect(outlines).toBeDefined();
    const out = await inspectPdf(result.bytes);
    expect(out.outlineTitles.length).toBe(2);
  });

  it("CONTRASTE: `organizePdf` (copyPages) pierde todos los marcadores", async () => {
    const bytes = await makeRichPdf(RICH);
    const blob = await organizePdf(toFile(bytes), [
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "existing", page: 2, rotation: 0 },
    ]);
    const out = await inspectPdf(new Uint8Array(await blob.arrayBuffer()));
    expect(out.outlineTitles).toEqual([]);
  });

  it("CONTRASTE: `removePdfPages` (en sitio) conserva titulo y formulario; el motor nuevo ademas adelgaza el archivo", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 12 });
    const legacyBlob = await removePdfPages(toFile(bytes), { remove: [2, 3, 4, 5, 6, 7, 8, 9] });
    const legacy = new Uint8Array(await legacyBlob.arrayBuffer());
    expect((await inspectPdf(legacy)).title).toBe("Informe anual");
    const mine = (await applyPageAssembly(bytes, [existing(0), existing(1), existing(10), existing(11)])).bytes;
    expect(mine.length).toBeLessThan(legacy.length);
  });
});

describe("conservacion en sitio: enlaces y destinos", () => {
  it("los enlaces internos de una pagina movida siguen llevando a la misma pagina", async () => {
    const bytes = await makeRichPdf({ pages: 5, links: true });
    const plan = [existing(4), existing(3), existing(2), existing(1), existing(0)];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    // La pagina 1 original (ahora la ultima) enlazaba a la ultima (ahora la primera) y por nombre a la 3.ª.
    expect(out.links[4]).toEqual(["page:0", "uri", "page:2"]);
  });

  it("un enlace a una pagina eliminada se quita; el enlace web y los demas se quedan", async () => {
    const bytes = await makeRichPdf({ pages: 5, links: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(1), existing(2)]);
    const out = await inspectPdf(result.bytes);
    expect(out.links[0]).toEqual(["uri", "page:2"]);
    expect(result.warnings).toContainEqual({ code: "linksRemoved", count: 1 });
  });

  it("un enlace por nombre cuyo destino se elimino se quita", async () => {
    const bytes = await makeRichPdf({ pages: 5, links: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(1), existing(4)]);
    const out = await inspectPdf(result.bytes);
    // «destino-tres» (pagina 3) ya no existe; el enlace a la ultima pagina se conserva.
    expect(out.links[0]).toEqual(["page:2", "uri"]);
    expect(result.warnings.find((w) => w.code === "namedDestinationsRemoved")?.count).toBeGreaterThanOrEqual(1);
  });

  it("ningun enlace queda roto (`broken`) tras eliminar paginas", async () => {
    const bytes = await makeRichPdf({ pages: 6, links: true });
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(0), existing(1)])).bytes);
    expect(out.links.flat().includes("broken")).toBe(false);
  });

  it("las paginas copiadas de otro PDF no traen sus enlaces internos (llevarian a paginas que no vienen)", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan, { x: other });
    const out = await inspectPdf(result.bytes);
    // Se conserva el enlace web; los dos internos se quitan.
    expect(out.links[1]).toEqual(["uri"]);
    expect(result.warnings).toContainEqual({ code: "linksRemoved", count: 2 });
    expect(out.pageObjects).toBe(2);
  });

  it("copiar una pagina con enlaces no arrastra el resto del documento externo", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 8, links: true, form: true, outline: true });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan, { x: other });
    const text = await allStreamsText(result.bytes);
    expect(text).toContain(marker(0));
    for (let i = 1; i < 8; i += 1) expect(text).not.toContain(marker(i));
    expect(result.bytes.length).toBeLessThan(other.length);
  });

  it("la accion de apertura que llevaba a una pagina eliminada se quita", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const document = await PDFDocument.load(bytes);
    const target = document.getPage(2).ref;
    document.catalog.set(document.context.obj("OpenAction") as never, document.context.obj([target, "Fit"]));
    const withOpen = await document.save();
    const out = await applyPageAssembly(withOpen, [existing(0), existing(1)]);
    const loaded = await PDFDocument.load(out.bytes);
    const keys = loaded.catalog.keys().map((key) => key.decodeText());
    expect(keys).not.toContain("OpenAction");
  });
});

describe("conservacion en sitio: etiquetas de pagina y PDF etiquetado", () => {
  it("anadir paginas al final conserva las etiquetas de pagina", async () => {
    const bytes = await makeRichPdf({ pages: 4, pageLabels: true });
    const plan: PageEntry[] = [...identityPlan(4), { kind: "blank", width: 100, height: 100, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan);
    expect((await inspectPdf(result.bytes)).hasPageLabels).toBe(true);
    expect(result.warnings.some((w) => w.code === "pageLabelsRemoved")).toBe(false);
  });

  it("rotar sin mover paginas conserva las etiquetas", async () => {
    const bytes = await makeRichPdf({ pages: 4, pageLabels: true });
    const plan = identityPlan(4).map((entry) => ({ ...entry, rotation: 90 }));
    expect((await inspectPdf((await applyPageAssembly(bytes, plan)).bytes)).hasPageLabels).toBe(true);
  });

  it("reordenar quita las etiquetas de pagina (ya no coincidirian) y avisa", async () => {
    const bytes = await makeRichPdf({ pages: 4, pageLabels: true });
    const result = await applyPageAssembly(bytes, [existing(1), existing(0), existing(2), existing(3)]);
    expect((await inspectPdf(result.bytes)).hasPageLabels).toBe(false);
    expect(result.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 1 });
  });

  it("insertar en medio quita las etiquetas y avisa", async () => {
    const bytes = await makeRichPdf({ pages: 3, pageLabels: true });
    const plan: PageEntry[] = [existing(0), { kind: "blank", width: 10, height: 10, rotation: 0 }, existing(1), existing(2)];
    expect((await applyPageAssembly(bytes, plan)).warnings.map((w) => w.code)).toContain("pageLabelsRemoved");
  });

  it("un documento sin etiquetas no avisa de que las quita", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const result = await applyPageAssembly(bytes, [existing(2), existing(0)]);
    expect(result.warnings.map((w) => w.code)).not.toContain("pageLabelsRemoved");
  });

  it("un PDF etiquetado que solo se reordena conserva su estructura", async () => {
    const bytes = await makeRichPdf({ pages: 3, tagged: true });
    const result = await applyPageAssembly(bytes, [existing(2), existing(1), existing(0)]);
    expect((await inspectPdf(result.bytes)).hasStructTree).toBe(true);
  });

  it("un PDF etiquetado al que se eliminan paginas pierde la estructura (y avisa), para no arrastrar las paginas quitadas", async () => {
    const bytes = await makeRichPdf({ pages: 4, tagged: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(1)]);
    const out = await inspectPdf(result.bytes);
    expect(out.hasStructTree).toBe(false);
    expect(out.pageObjects).toBe(2);
    expect(result.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
  });
});

describe("lo eliminado ya no esta dentro del archivo", () => {
  it("el texto de una pagina eliminada no aparece en ningun flujo del resultado", async () => {
    const bytes = await makeRichPdf({ pages: 5, form: true, outline: true, links: true });
    const before = await allStreamsText(bytes);
    expect(before).toContain(marker(3));
    const out = await applyPageAssembly(bytes, [existing(0), existing(4)]);
    const text = await allStreamsText(out.bytes);
    expect(text).toContain(marker(0));
    expect(text).toContain(marker(4));
    for (const index of [1, 2, 3]) expect(text).not.toContain(marker(index));
  });

  it("eliminar paginas reduce el tamano del archivo", async () => {
    const bytes = await makeRichPdf({ pages: 40, form: true, outline: true });
    const out = await applyPageAssembly(bytes, [existing(0), existing(1)]);
    expect(out.bytes.length).toBeLessThan(bytes.length / 4);
  });

  it("no quedan paginas huerfanas: solo hay tantos objetos /Page como paginas", async () => {
    const bytes = await makeRichPdf({ pages: 8, form: true, outline: true, links: true, tagged: true });
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(6), existing(2), existing(2, 0, true)])).bytes);
    expect(out.pageObjects).toBe(3);
  });

  it("insertar paginas externas no deja paginas huerfanas del otro documento", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const other = await makeRichPdf({ pages: 6, form: true, links: true, outline: true });
    const plan: PageEntry[] = [...identityPlan(2), { kind: "external", sourceId: "x", sourceIndex: 3, rotation: 0 }];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan, { x: other })).bytes);
    expect(out.pageObjects).toBe(3);
  });

  it("CONTRASTE: `removePdfPages` deja el contenido de las paginas eliminadas dentro del archivo", async () => {
    const bytes = await makeRichPdf({ pages: 6 });
    const blob = await removePdfPages(toFile(bytes), { remove: [2, 3, 4, 5] });
    const legacy = new Uint8Array(await blob.arrayBuffer());
    const text = await allStreamsText(legacy);
    // El motor actual no suelta los objetos sin referencia: el texto sigue en el archivo.
    expect(text).toContain(marker(3));
  });
});

describe("la copia nunca se queda con la hoja original", () => {
  it("con la copia ANTES que la pagina original, los marcadores y enlaces siguen apuntando a la original", async () => {
    const bytes = await makeRichPdf({ pages: 3, outline: true, links: true });
    const plan = [existing(0, 0, true), existing(0), existing(1), existing(2)];
    const out = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    // «Capitulo 1» apunta a la entrada que NO es copia (la 2.ª), no a la copia que va delante.
    expect(out.outlineTargets[0]).toBe(1);
    // Los enlaces de la pagina 1 viven en la original; la copia lleva los suyos propios.
    expect(out.links[1]).toEqual(out.links[0]);
  });

  it("si la original se quita y queda solo la copia, la copia es la que recibe los marcadores", async () => {
    const bytes = await makeRichPdf({ pages: 3, outline: true });
    const out = await inspectPdf((await applyPageAssembly(bytes, [existing(0, 0, true), existing(2)])).bytes);
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 3"]);
    expect(out.outlineTargets).toEqual([0, 1]);
  });
});

describe("verificacion de lo guardado", () => {
  it("si el archivo guardado no tiene las paginas del plan, falla en vez de entregarlo (nunca pierde paginas en silencio)", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const real = PDFDocument.load.bind(PDFDocument);
    let calls = 0;
    const spy = vi.spyOn(PDFDocument, "load").mockImplementation(async (...args: Parameters<typeof PDFDocument.load>) => {
      calls += 1;
      // La 1.ª lectura es la del documento actual; la 2.ª es la comprobacion del resultado.
      if (calls === 2) return { getPageCount: () => 99 } as unknown as PDFDocument;
      return real(...args);
    });
    await expect(applyPageAssembly(bytes, [existing(0), existing(1)])).rejects.toMatchObject({ code: "unknown" });
    spy.mockRestore();
  });

  it("con `verify: false` no hay segunda lectura", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const real = PDFDocument.load.bind(PDFDocument);
    let calls = 0;
    const spy = vi.spyOn(PDFDocument, "load").mockImplementation(async (...args: Parameters<typeof PDFDocument.load>) => {
      calls += 1;
      return real(...args);
    });
    await applyPageAssembly(bytes, [existing(0)], {}, { verify: false });
    expect(calls).toBe(1);
    calls = 0;
    await applyPageAssembly(bytes, [existing(0)]);
    expect(calls).toBe(2);
    spy.mockRestore();
  });
});

describe("el resultado se puede encadenar (varias operaciones seguidas)", () => {
  it("aplicar dos veces sigue conservando metadatos, formulario y marcadores", async () => {
    const bytes = await makeRichPdf(RICH);
    const first = await applyPageAssembly(bytes, [existing(5), existing(4), existing(3), existing(2), existing(1), existing(0)]);
    const second = await applyPageAssembly(first.bytes, [existing(0), existing(1, 90), existing(5)]);
    const out = await inspectPdf(second.bytes);
    expect(out.title).toBe("Informe anual");
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-5", "campo-6"]);
    expect(out.outlineTitles.length).toBe(3);
    expect(out.rotations).toEqual([0, 90, 0]);
    expect(out.markers).toEqual([marker(5), marker(4), marker(0)]);
  });

  it("deshacer encadenado: aplicar el plan inverso devuelve el orden original", async () => {
    const bytes = await makeRichPdf({ pages: 6 });
    const order = [3, 5, 1, 0, 4, 2];
    const forward = await applyPageAssembly(bytes, order.map((i) => existing(i)));
    const inverse = order.map((_, position) => existing(order.indexOf(position)));
    const back = await inspectPdf((await applyPageAssembly(forward.bytes, inverse)).bytes);
    expect(back.markers).toEqual([0, 1, 2, 3, 4, 5].map(marker));
  });

  it("duplicar y luego eliminar la original deja una pagina valida con campos", async () => {
    const bytes = await makeRichPdf({ pages: 2, form: true });
    const first = await applyPageAssembly(bytes, [existing(0), existing(0, 0, true), existing(1)]);
    const second = await applyPageAssembly(first.bytes, [existing(1), existing(2)]);
    const out = await inspectPdf(second.bytes);
    expect(out.markers).toEqual([marker(0), marker(1)]);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-2"]);
  });

  it("insertar de otro PDF y luego reordenar mantiene los campos importados", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2, form: true });
    const first = await applyPageAssembly(bytes, [
      existing(0),
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
      { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 0 },
    ], { x: other });
    const second = await applyPageAssembly(first.bytes, [existing(2), existing(1), existing(0)]);
    const out = await inspectPdf(second.bytes);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-2"]);
    expect(out.pageObjects).toBe(3);
  });
});
