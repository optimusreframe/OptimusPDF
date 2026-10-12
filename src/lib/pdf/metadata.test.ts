import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFStream } from "@cantoo/pdf-lib";
import {
  EMPTY_PDF_METADATA,
  hasAnyMetadata,
  readMetadata,
  stripMetadata,
  writeMetadata,
} from "@/lib/pdf/metadata";

/**
 * Motor de metadatos: ida y vuelta con pdf-lib y con pdf.js (`getMetadata`, build «legacy» como en
 * `detectScale.test.ts`: el build normal no corre en Node).
 */

async function makePdf(pages = 2, init?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = document.addPage([300, 400]);
    page.drawText(`Pagina ${i + 1}`, { x: 40, y: 340, size: 18 });
  }
  init?.(document);
  return document.save({ useObjectStreams: true });
}

async function pdfjsMetadata(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const meta = await doc.getMetadata();
    return { info: meta.info as Record<string, unknown>, xmp: meta.metadata };
  } finally {
    await task.destroy();
  }
}

const XMP_PACKET = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Titulo viejo en XMP</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

function attachXmp(document: PDFDocument): void {
  const stream = document.context.stream(XMP_PACKET, { Type: "Metadata", Subtype: "XML" });
  document.catalog.set(PDFName.of("Metadata"), document.context.register(stream));
}

function xmpStreams(document: PDFDocument): number {
  let count = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/XML") count += 1;
  }
  return count;
}

describe("readMetadata", () => {
  it("un PDF sin metadatos devuelve cadenas vacias y fechas nulas", async () => {
    const bytes = await makePdf(1, (doc) => {
      // `PDFDocument.create` pone productor y fechas: se quitan para probar el vacio.
      doc.context.trailerInfo.Info = undefined;
    });
    const info = await readMetadata(bytes);
    expect(info).toMatchObject({ ...EMPTY_PDF_METADATA, hasXmp: false, customKeys: [] });
  });

  it("lee todos los campos escritos con pdf-lib", async () => {
    const created = new Date("2024-03-05T10:20:30Z");
    const modified = new Date("2025-01-02T03:04:05Z");
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle("Informe anual");
      doc.setAuthor("Ana Pérez");
      doc.setSubject("Resultados");
      doc.setKeywords(["a, b, c"]);
      doc.setCreator("Hoja de calculo");
      doc.setProducer("Motor X");
      doc.setCreationDate(created);
      doc.setModificationDate(modified);
    });
    const info = await readMetadata(bytes);
    expect(info.title).toBe("Informe anual");
    expect(info.author).toBe("Ana Pérez");
    expect(info.subject).toBe("Resultados");
    expect(info.keywords).toBe("a, b, c");
    expect(info.creator).toBe("Hoja de calculo");
    expect(info.producer).toBe("Motor X");
    expect(info.creationDate?.toISOString()).toBe(created.toISOString());
    expect(info.modificationDate?.toISOString()).toBe(modified.toISOString());
  });

  it("detecta el XMP y las claves personalizadas", async () => {
    const bytes = await makePdf(1, (doc) => {
      attachXmp(doc);
      const info = doc.context.lookup(doc.context.trailerInfo.Info!) as unknown as { set: (k: PDFName, v: unknown) => void };
      info.set(PDFName.of("Proyecto"), doc.context.obj("Alfa"));
    });
    const info = await readMetadata(bytes);
    expect(info.hasXmp).toBe(true);
    expect(info.customKeys).toEqual(["Proyecto"]);
  });

  it("acepta un Blob y rechaza bytes que no son un PDF con un error tipado", async () => {
    const bytes = await makePdf(1);
    expect((await readMetadata(new Blob([bytes as unknown as BlobPart]))).hasXmp).toBe(false);
    await expect(readMetadata(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ name: "PdfError" });
  });
});

describe("writeMetadata", () => {
  it("ida y vuelta: pdf-lib lee lo escrito y pdf.js `getMetadata` tambien", async () => {
    const bytes = await makePdf(2);
    const created = new Date("2023-07-01T08:00:00Z");
    const { bytes: out } = await writeMetadata(bytes, {
      title: "Contrato de servicio",
      author: "Luis Gómez",
      subject: "Acuerdo",
      keywords: "contrato, 2026, cliente",
      creator: "OptimusPDF",
      producer: "OptimusPDF Pro",
      creationDate: created,
    });
    const back = await readMetadata(out);
    expect(back).toMatchObject({
      title: "Contrato de servicio",
      author: "Luis Gómez",
      subject: "Acuerdo",
      keywords: "contrato, 2026, cliente",
      creator: "OptimusPDF",
      producer: "OptimusPDF Pro",
    });
    expect(back.creationDate?.toISOString()).toBe(created.toISOString());

    const viaPdfjs = await pdfjsMetadata(out);
    expect(viaPdfjs.info.Title).toBe("Contrato de servicio");
    expect(viaPdfjs.info.Author).toBe("Luis Gómez");
    expect(viaPdfjs.info.Subject).toBe("Acuerdo");
    expect(viaPdfjs.info.Keywords).toBe("contrato, 2026, cliente");
    expect(viaPdfjs.info.Creator).toBe("OptimusPDF");
    expect(viaPdfjs.info.Producer).toBe("OptimusPDF Pro");
    expect(String(viaPdfjs.info.CreationDate)).toContain("D:20230701");
  });

  it("conserva texto Unicode (UTF-16) y emoji", async () => {
    const bytes = await makePdf(1);
    const { bytes: out } = await writeMetadata(bytes, { title: "Reunión ñandú — 日本語 🚀" });
    expect((await readMetadata(out)).title).toBe("Reunión ñandú — 日本語 🚀");
    expect((await pdfjsMetadata(out)).info.Title).toBe("Reunión ñandú — 日本語 🚀");
  });

  it("los campos no mencionados se conservan y no cambian las paginas", async () => {
    const bytes = await makePdf(3, (doc) => {
      doc.setAuthor("Autor previo");
      doc.setSubject("Asunto previo");
    });
    const { bytes: out, changed } = await writeMetadata(bytes, { title: "Nuevo" });
    const back = await readMetadata(out);
    expect(back.author).toBe("Autor previo");
    expect(back.subject).toBe("Asunto previo");
    expect(back.title).toBe("Nuevo");
    expect(changed).toEqual(["title"]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(3);
  });

  it("una cadena vacia o null QUITA el campo", async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle("Algo");
      doc.setAuthor("Alguien");
      doc.setCreationDate(new Date("2020-01-01T00:00:00Z"));
    });
    const { bytes: out } = await writeMetadata(bytes, { title: "", author: null, creationDate: null });
    const back = await readMetadata(out);
    expect(back.title).toBe("");
    expect(back.author).toBe("");
    expect(back.creationDate).toBeNull();
    const info = (await pdfjsMetadata(out)).info;
    expect("Title" in info).toBe(false);
    expect("Author" in info).toBe(false);
    expect("CreationDate" in info).toBe(false);
  });

  it("actualiza la fecha de modificacion con el reloj dado, salvo que se fije o se desactive", async () => {
    const bytes = await makePdf(1);
    const now = new Date("2026-10-12T12:00:00Z");
    const a = await writeMetadata(bytes, { title: "A" }, { now: () => now });
    expect((await readMetadata(a.bytes)).modificationDate?.toISOString()).toBe(now.toISOString());

    const fixed = new Date("2019-05-05T05:05:05Z");
    const b = await writeMetadata(bytes, { title: "B", modificationDate: fixed }, { now: () => now });
    expect((await readMetadata(b.bytes)).modificationDate?.toISOString()).toBe(fixed.toISOString());

    const original = await readMetadata(bytes);
    const c = await writeMetadata(bytes, { title: "C" }, { touchModificationDate: false, now: () => now });
    expect((await readMetadata(c.bytes)).modificationDate?.toISOString()).toBe(
      original.modificationDate?.toISOString(),
    );
  });

  it("sin cambios reales no toca la fecha ni el XMP", async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle("Igual");
      attachXmp(doc);
    });
    const before = await readMetadata(bytes);
    const result = await writeMetadata(bytes, { title: "Igual" });
    expect(result.changed).toEqual([]);
    expect(result.xmpRemoved).toBe(false);
    const after = await readMetadata(result.bytes);
    expect(after.hasXmp).toBe(true);
    expect(after.modificationDate?.toISOString()).toBe(before.modificationDate?.toISOString());
  });

  it("al cambiar un dato con XMP, lo elimina (y lo informa) para que no contradiga", async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle("Viejo");
      attachXmp(doc);
    });
    const result = await writeMetadata(bytes, { title: "Nuevo" });
    expect(result.xmpRemoved).toBe(true);
    const viaPdfjs = await pdfjsMetadata(result.bytes);
    expect(viaPdfjs.xmp).toBeNull();
    expect(viaPdfjs.info.Title).toBe("Nuevo");
  });

  it("`xmp: keep` conserva el paquete aunque cambie el titulo", async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle("Viejo");
      attachXmp(doc);
    });
    const result = await writeMetadata(bytes, { title: "Nuevo" }, { xmp: "keep" });
    expect(result.xmpRemoved).toBe(false);
    expect((await readMetadata(result.bytes)).hasXmp).toBe(true);
  });

  it("no hay rastro del XMP viejo dentro del archivo tras quitarlo", async () => {
    const bytes = await makePdf(1, (doc) => attachXmp(doc));
    const { bytes: out } = await writeMetadata(bytes, { title: "T" });
    const reloaded = await PDFDocument.load(out);
    expect(xmpStreams(reloaded)).toBe(0);
    expect(Buffer.from(out).includes(Buffer.from("Titulo viejo en XMP"))).toBe(false);
  });

  it("un PDF sin Info acepta metadatos nuevos", async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.context.trailerInfo.Info = undefined;
    });
    const { bytes: out } = await writeMetadata(bytes, { author: "Nadie" });
    expect((await readMetadata(out)).author).toBe("Nadie");
  });
});

describe("stripMetadata", () => {
  async function loaded(): Promise<Uint8Array> {
    return makePdf(2, (doc) => {
      doc.setTitle("Secreto");
      doc.setAuthor("Persona");
      doc.setSubject("Asunto");
      doc.setKeywords(["k1, k2"]);
      doc.setCreator("Creador");
      doc.setProducer("Productor");
      attachXmp(doc);
      const info = doc.context.lookup(doc.context.trailerInfo.Info!) as unknown as { set: (k: PDFName, v: unknown) => void };
      info.set(PDFName.of("Proyecto"), doc.context.obj("Alfa"));
    });
  }

  it("deja todos los campos vacios segun pdf-lib y pdf.js", async () => {
    const { bytes, removedInfoKeys, xmpRemoved } = await stripMetadata(await loaded());
    expect(removedInfoKeys).toBeGreaterThanOrEqual(7);
    expect(xmpRemoved).toBe(true);
    const back = await readMetadata(bytes);
    expect(hasAnyMetadata(back)).toBe(false);
    const viaPdfjs = await pdfjsMetadata(bytes);
    for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Proyecto"]) {
      expect(key in viaPdfjs.info, key).toBe(false);
    }
    expect(viaPdfjs.xmp).toBeNull();
  });

  it("elimina el XMP tambien del archivo (los bytes ya no lo contienen)", async () => {
    const { bytes } = await stripMetadata(await loaded());
    expect(xmpStreams(await PDFDocument.load(bytes))).toBe(0);
    for (const secret of ["Secreto", "Persona", "Titulo viejo en XMP", "Alfa"]) {
      expect(Buffer.from(bytes).includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("el contenido y el numero de paginas no cambian", async () => {
    const { bytes } = await stripMetadata(await loaded());
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(2);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join("");
      expect(text).toContain("Pagina 1");
    } finally {
      await task.destroy();
    }
  });

  it("es idempotente y no falla en un PDF sin metadatos", async () => {
    const once = await stripMetadata(await loaded());
    const twice = await stripMetadata(once.bytes);
    expect(twice.removedInfoKeys).toBe(0);
    expect(twice.xmpRemoved).toBe(false);
  });

  it("quita el XMP de las paginas", async () => {
    const bytes = await makePdf(2, (doc) => {
      const stream = doc.context.stream(XMP_PACKET, { Type: "Metadata", Subtype: "XML" });
      doc.getPage(0).node.set(PDFName.of("Metadata"), doc.context.register(stream));
    });
    expect((await readMetadata(bytes)).hasXmp).toBe(true);
    const { bytes: out, xmpRemoved } = await stripMetadata(bytes);
    expect(xmpRemoved).toBe(true);
    expect((await readMetadata(out)).hasXmp).toBe(false);
  });
});

describe("hasAnyMetadata", () => {
  it("falso para el vacio y verdadero con cualquier dato", () => {
    const empty = { ...EMPTY_PDF_METADATA, hasXmp: false, customKeys: [] };
    expect(hasAnyMetadata(empty)).toBe(false);
    expect(hasAnyMetadata({ ...empty, title: "x" })).toBe(true);
    expect(hasAnyMetadata({ ...empty, hasXmp: true })).toBe(true);
    expect(hasAnyMetadata({ ...empty, customKeys: ["A"] })).toBe(true);
    expect(hasAnyMetadata({ ...empty, creationDate: new Date() })).toBe(true);
  });
});
