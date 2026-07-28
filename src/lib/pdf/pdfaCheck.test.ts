import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFRef,
} from "@cantoo/pdf-lib";
import {
  checkPdfaCompliance,
  formatClaim,
  parsePdfaClaim,
  readPdfVersion,
  summarize,
  type PdfaCheck,
  type PdfaCheckId,
  type PdfaReport,
} from "@/lib/pdf/pdfaCheck";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` dentro del propio
 * test (misma convencion que `unlock.test.ts` y `protect.test.ts`: sin
 * archivos externos). Cada `it` arma su documento, porque los objetos de
 * pdf-lib son mutables y varias pruebas los mutan a proposito.
 *
 * Todo lo que se comprueba aqui es ESTRUCTURA: fuentes con o sin
 * programa incrustado, OutputIntent con o sin perfil, XMP con o sin
 * `pdfaid`, cifrado, JavaScript y adjuntos. Ningun test afirma
 * conformidad PDF/A real: el motor tampoco lo hace.
 */

const NAMES_KEY = PDFName.of("Names");
const JAVASCRIPT_KEY = PDFName.of("JavaScript");
const EMBEDDED_FILES_KEY = PDFName.of("EmbeddedFiles");
const METADATA_KEY = PDFName.of("Metadata");
const OUTPUT_INTENTS_KEY = PDFName.of("OutputIntents");

async function createDocument(): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  return document;
}

async function toFile(document: PDFDocument, name = "muestra.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/pdf",
  });
}

async function report(document: PDFDocument, name?: string): Promise<PdfaReport> {
  return checkPdfaCompliance(await toFile(document, name));
}

function checkFor(result: PdfaReport, id: PdfaCheckId): PdfaCheck {
  const check = result.checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`El informe no trae la casilla "${id}"`);
  return check;
}

/** Texto con una de las 14 fuentes estandar: NUNCA va incrustada. */
async function drawWithStandardFont(document: PDFDocument): Promise<void> {
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.getPage(0).drawText("Hola", { font, size: 12, x: 10, y: 10 });
}

/**
 * Fuente TrueType con `/FontDescriptor` y `/FontFile2`. El contenido del
 * programa no importa para una comprobacion estructural: lo que se
 * verifica es que la entrada existe y resuelve a un flujo.
 */
function addEmbeddedFont(document: PDFDocument, name = "ABCDEF+Prueba"): void {
  const context = document.context;
  const program = context.register(
    context.flateStream(new Uint8Array([0, 1, 0, 0]), { Length1: 4 }),
  );
  const descriptor = context.register(
    context.obj({
      Type: "FontDescriptor",
      FontName: name,
      Flags: 4,
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
      FontBBox: [0, -200, 1000, 800],
      FontFile2: program,
    }),
  );
  const font = context.register(
    context.obj({
      Type: "Font",
      Subtype: "TrueType",
      BaseFont: name,
      FirstChar: 32,
      LastChar: 32,
      Widths: [500],
      FontDescriptor: descriptor,
    }),
  );
  document.getPage(0).node.setFontDictionary(PDFName.of("F9"), font);
}

/** Fuente sin `/FontDescriptor`: el lector la tomaria de su sistema. */
function addNonEmbeddedFont(document: PDFDocument, name = "Arial"): void {
  const context = document.context;
  const font = context.register(
    context.obj({
      Type: "Font",
      Subtype: "TrueType",
      BaseFont: name,
      FirstChar: 32,
      LastChar: 32,
      Widths: [500],
    }),
  );
  document.getPage(0).node.setFontDictionary(PDFName.of("F8"), font);
}

function addOutputIntent(
  document: PDFDocument,
  options: { withProfile?: boolean; subtype?: string } = {},
): void {
  const context = document.context;
  const { withProfile = true, subtype = "GTS_PDFA1" } = options;
  const entry: Record<string, unknown> = {
    Type: "OutputIntent",
    S: subtype,
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
  };
  if (withProfile) {
    entry.DestOutputProfile = context.register(
      context.flateStream(new Uint8Array(128), { N: 3 }),
    );
  }
  const intents = PDFArray.withContext(context);
  intents.push(context.register(context.obj(entry as never)));
  document.catalog.set(OUTPUT_INTENTS_KEY, context.register(intents));
}

function xmpFor(part: string, conformance: string | null): string {
  const conformanceLine = conformance
    ? `\n        <pdfaid:conformance>${conformance}</pdfaid:conformance>`
    : "";
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
        <pdfaid:part>${part}</pdfaid:part>${conformanceLine}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function addMetadata(document: PDFDocument, xmp: string): void {
  const context = document.context;
  const stream = context.register(
    context.stream(xmp, { Type: "Metadata", Subtype: "XML" }),
  );
  document.catalog.set(METADATA_KEY, stream);
}

/** Crea (o reutiliza) el `/Names` del catalogo. */
function ensureNames(document: PDFDocument): PDFDict {
  const existing = document.catalog.lookupMaybe(NAMES_KEY, PDFDict);
  if (existing) return existing;
  const names = PDFDict.withContext(document.context);
  document.catalog.set(NAMES_KEY, document.context.register(names));
  return names;
}

/** Arbol de nombres de una sola hoja: `/Names [ (clave) valor ]`. */
function addNameTreeEntry(
  document: PDFDocument,
  branch: PDFName,
  key: string,
  value: PDFRef,
): void {
  const context = document.context;
  const entries = PDFArray.withContext(context);
  entries.push(PDFString.of(key));
  entries.push(value);
  const tree = PDFDict.withContext(context);
  tree.set(NAMES_KEY, entries);
  ensureNames(document).set(branch, context.register(tree));
}

function addJavaScript(document: PDFDocument): void {
  const context = document.context;
  const action = context.register(
    context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert(1);") }),
  );
  addNameTreeEntry(document, JAVASCRIPT_KEY, "Aviso", action);
}

function addEmbeddedFile(document: PDFDocument): void {
  const context = document.context;
  const data = context.register(
    context.flateStream(new Uint8Array([1, 2, 3]), { Type: "EmbeddedFile" }),
  );
  const spec = context.register(
    context.obj({
      Type: "Filespec",
      F: PDFString.of("datos.txt"),
      UF: PDFString.of("datos.txt"),
      EF: { F: data },
    }),
  );
  addNameTreeEntry(document, EMBEDDED_FILES_KEY, "datos.txt", spec);
}

/** Documento que supera todas las casillas de este motor. */
async function createLikelyCompliant(): Promise<PDFDocument> {
  const document = await createDocument();
  addEmbeddedFont(document);
  addOutputIntent(document);
  addMetadata(document, xmpFor("1", "B"));
  return document;
}

/* ------------------------------------------------------------------ *
 * parsePdfaClaim (puro)
 * ------------------------------------------------------------------ */

describe("parsePdfaClaim — src/lib/pdf/pdfaCheck.ts", () => {
  it("lee part y conformance en forma de ELEMENTO", () => {
    expect(parsePdfaClaim(xmpFor("1", "B"))).toEqual({
      part: "1",
      conformance: "B",
      revision: null,
    });
  });

  it("lee part y conformance en forma de ATRIBUTO", () => {
    const xmp = `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="U"/>`;
    expect(parsePdfaClaim(xmp)).toEqual({
      part: "2",
      conformance: "U",
      revision: null,
    });
  });

  it("no da por hecho el prefijo 'pdfaid': lo resuelve por el namespace", () => {
    const xmp = `<rdf:Description xmlns:pa="http://www.aiim.org/pdfa/ns/id/"><pa:part>3</pa:part><pa:conformance>A</pa:conformance></rdf:Description>`;
    expect(parsePdfaClaim(xmp)).toMatchObject({ part: "3", conformance: "A" });
  });

  it("PDF/A-4 declara 'rev' y no tiene conformance", () => {
    const xmp = `<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="4" pdfaid:rev="2020"/>`;
    expect(parsePdfaClaim(xmp)).toEqual({
      part: "4",
      conformance: null,
      revision: "2020",
    });
  });

  it("XMP sin identificacion PDF/A -> null (no se inventa una declaracion)", () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description dc:title="Informe"/></rdf:RDF></x:xmpmeta>`;
    expect(parsePdfaClaim(xmp)).toBeNull();
  });

  it("formatClaim compone la etiqueta legible", () => {
    expect(formatClaim({ part: "1", conformance: "B", revision: null })).toBe("PDF/A-1b");
    expect(formatClaim({ part: "4", conformance: null, revision: "2020" })).toBe("PDF/A-4");
  });
});

/* ------------------------------------------------------------------ *
 * Fuentes
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: fuentes incrustadas", () => {
  it("fuente estandar (sin FontDescriptor) -> fail y la nombra", async () => {
    const document = await createDocument();
    await drawWithStandardFont(document);

    const result = await report(document);
    const fonts = checkFor(result, "fonts");

    expect(fonts.status).toBe("fail");
    expect(fonts.code).toBe("fontsMissing");
    expect(fonts.names).toContain("Helvetica");
  });

  it("fuente con FontDescriptor + FontFile2 -> pass", async () => {
    const document = await createDocument();
    addEmbeddedFont(document);

    const fonts = checkFor(await report(document), "fonts");

    expect(fonts.status).toBe("pass");
    expect(fonts.code).toBe("fontsAllEmbedded");
    expect(fonts.count).toBe(1);
  });

  it("mezcla de incrustada y no incrustada -> fail, y solo lista la que falta", async () => {
    const document = await createDocument();
    addEmbeddedFont(document);
    addNonEmbeddedFont(document, "Times-Roman");

    const fonts = checkFor(await report(document), "fonts");

    expect(fonts.status).toBe("fail");
    expect(fonts.names).toEqual(["Times-Roman"]);
    expect(fonts.count).toBe(1);
  });

  it("documento sin ninguna fuente -> pass ('nada que incrustar'), no fail", async () => {
    const fonts = checkFor(await report(await createDocument()), "fonts");

    expect(fonts.status).toBe("pass");
    expect(fonts.code).toBe("fontsNone");
  });

  it("fuente Type0 con descendiente incrustado -> pass; sin descriptor -> fail", async () => {
    const embedded = await createDocument();
    const context = embedded.context;
    const program = context.register(
      context.flateStream(new Uint8Array([0, 1]), { Subtype: "CIDFontType0C" }),
    );
    const descriptor = context.register(
      context.obj({ Type: "FontDescriptor", FontName: "XYZ+CID", FontFile3: program }),
    );
    const descendant = context.register(
      context.obj({
        Type: "Font",
        Subtype: "CIDFontType0",
        BaseFont: "XYZ+CID",
        FontDescriptor: descriptor,
      }),
    );
    const composite = context.register(
      context.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: "XYZ+CID",
        Encoding: "Identity-H",
        DescendantFonts: [descendant],
      }),
    );
    embedded.getPage(0).node.setFontDictionary(PDFName.of("C0"), composite);

    expect(checkFor(await report(embedded), "fonts").status).toBe("pass");

    const bare = await createDocument();
    const bareContext = bare.context;
    const bareDescendant = bareContext.register(
      bareContext.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        BaseFont: "SinIncrustar",
      }),
    );
    const bareComposite = bareContext.register(
      bareContext.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: "SinIncrustar",
        Encoding: "Identity-H",
        DescendantFonts: [bareDescendant],
      }),
    );
    bare.getPage(0).node.setFontDictionary(PDFName.of("C1"), bareComposite);

    const bareFonts = checkFor(await report(bare), "fonts");
    expect(bareFonts.status).toBe("fail");
    expect(bareFonts.names).toContain("SinIncrustar");
  });

  it("tambien mira dentro de un XObject de formulario, no solo la pagina", async () => {
    const document = await createDocument();
    const context = document.context;
    const font = context.register(
      context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" }),
    );
    const form = context.register(
      context.flateStream(new Uint8Array([32]), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 10, 10],
        Resources: { Font: { F1: font } },
      }),
    );
    document.getPage(0).node.setXObject(PDFName.of("X1"), form);

    const fonts = checkFor(await report(document), "fonts");
    expect(fonts.status).toBe("fail");
    expect(fonts.names).toContain("Courier");
  });
});

/* ------------------------------------------------------------------ *
 * OutputIntent
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: OutputIntent", () => {
  it("OutputIntent PDF/A con DestOutputProfile -> pass", async () => {
    const document = await createDocument();
    addOutputIntent(document);

    const intent = checkFor(await report(document), "outputIntent");
    expect(intent.status).toBe("pass");
    expect(intent.code).toBe("outputIntentValid");
    expect(intent.text).toBe("sRGB IEC61966-2.1");
  });

  it("OutputIntent PDF/A SIN DestOutputProfile -> fail", async () => {
    const document = await createDocument();
    addOutputIntent(document, { withProfile: false });

    const intent = checkFor(await report(document), "outputIntent");
    expect(intent.status).toBe("fail");
    expect(intent.code).toBe("outputIntentNoProfile");
  });

  it("sin OutputIntent y sin declaracion PDF/A -> warn (es condicional, no un incumplimiento probado)", async () => {
    const intent = checkFor(await report(await createDocument()), "outputIntent");
    expect(intent.status).toBe("warn");
    expect(intent.code).toBe("outputIntentNone");
  });

  it("sin OutputIntent pero el XMP dice ser PDF/A -> fail (se contradice a si mismo)", async () => {
    const document = await createDocument();
    addMetadata(document, xmpFor("1", "B"));

    const intent = checkFor(await report(document), "outputIntent");
    expect(intent.status).toBe("fail");
    expect(intent.code).toBe("outputIntentNone");
  });

  it("OutputIntent de otro estandar (GTS_PDFX) -> no cuenta como PDF/A", async () => {
    const document = await createDocument();
    addOutputIntent(document, { subtype: "GTS_PDFX" });

    const intent = checkFor(await report(document), "outputIntent");
    expect(intent.code).toBe("outputIntentForeign");
    expect(intent.count).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Identificacion XMP
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: identificacion PDF/A en el XMP", () => {
  it("sin flujo /Metadata -> fail", async () => {
    const result = await report(await createDocument());
    const identification = checkFor(result, "identification");

    expect(identification.status).toBe("fail");
    expect(identification.code).toBe("identificationNoStream");
    expect(result.claim).toBeNull();
  });

  it("con /Metadata pero sin pdfaid -> fail (existe XMP, no identificacion)", async () => {
    const document = await createDocument();
    addMetadata(
      document,
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description dc:title="Informe"/></rdf:RDF></x:xmpmeta>`,
    );

    const identification = checkFor(await report(document), "identification");
    expect(identification.status).toBe("fail");
    expect(identification.code).toBe("identificationNoClaim");
  });

  it("con pdfaid:part/conformance -> pass y el informe expone la declaracion", async () => {
    const document = await createDocument();
    addMetadata(document, xmpFor("2", "B"));

    const result = await report(document);
    const identification = checkFor(result, "identification");

    expect(identification.status).toBe("pass");
    expect(identification.text).toBe("PDF/A-2b");
    expect(result.claim).toEqual({ part: "2", conformance: "B", revision: null });
  });
});

/* ------------------------------------------------------------------ *
 * Cifrado
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: cifrado", () => {
  it("PDF cifrado con contrasena -> la casilla de cifrado falla", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "claveSegura1", ownerPassword: "claveSegura1" });

    const result = await report(document, "cifrado.pdf");
    const encryption = checkFor(result, "encryption");

    expect(encryption.status).toBe("fail");
    expect(encryption.code).toBe("encryptionStandard");
    expect(result.verdict).toBe("notCompliant");
  });

  it("PDF cifrado: el XMP no se puede leer, y se dice 'unknown' en vez de 'no declara'", async () => {
    const document = await createDocument();
    addMetadata(document, xmpFor("1", "B"));
    document.encrypt({ userPassword: "claveSegura1", ownerPassword: "claveSegura1" });

    const identification = checkFor(await report(document, "cifrado.pdf"), "identification");
    expect(identification.status).toBe("unknown");
    expect(identification.code).toBe("identificationUnreadable");
  });

  it("PDF sin cifrar -> la casilla de cifrado pasa", async () => {
    const encryption = checkFor(await report(await createDocument()), "encryption");
    expect(encryption.status).toBe("pass");
    expect(encryption.code).toBe("encryptionNone");
  });
});

/* ------------------------------------------------------------------ *
 * JavaScript y adjuntos
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: JavaScript y archivos incrustados", () => {
  it("accion JavaScript en el arbol de nombres -> fail", async () => {
    const document = await createDocument();
    addJavaScript(document);

    const result = await report(document);
    const javascript = checkFor(result, "javascript");

    expect(javascript.status).toBe("fail");
    expect(javascript.code).toBe("javascriptFound");
    expect(javascript.count).toBe(1);
    expect(result.verdict).toBe("notCompliant");
  });

  it("JavaScript en /OpenAction del catalogo -> tambien se detecta", async () => {
    const document = await createDocument();
    const context = document.context;
    document.catalog.set(
      PDFName.of("OpenAction"),
      context.register(context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(2);") })),
    );

    expect(checkFor(await report(document), "javascript").status).toBe("fail");
  });

  it("sin JavaScript -> pass", async () => {
    expect(checkFor(await report(await createDocument()), "javascript").status).toBe("pass");
  });

  it("adjunto sin declaracion PDF/A -> warn (PDF/A-3 si los admite)", async () => {
    const document = await createDocument();
    addEmbeddedFile(document);

    const attachments = checkFor(await report(document), "embeddedFiles");
    expect(attachments.status).toBe("warn");
    expect(attachments.count).toBe(1);
  });

  it("adjunto en un documento que dice ser PDF/A-1b -> fail", async () => {
    const document = await createDocument();
    addMetadata(document, xmpFor("1", "B"));
    addEmbeddedFile(document);

    expect(checkFor(await report(document), "embeddedFiles").status).toBe("fail");
  });

  it("adjunto en un documento que dice ser PDF/A-3b -> no es incumplimiento", async () => {
    const document = await createDocument();
    addMetadata(document, xmpFor("3", "B"));
    addEmbeddedFile(document);

    expect(checkFor(await report(document), "embeddedFiles").status).not.toBe("fail");
  });
});

/* ------------------------------------------------------------------ *
 * Informe completo
 * ------------------------------------------------------------------ */

describe("checkPdfaCompliance: informe y veredicto", () => {
  it("PDF cotidiano (fuente estandar, sin XMP, sin OutputIntent) -> notCompliant con varias casillas rojas", async () => {
    const document = await createDocument();
    await drawWithStandardFont(document);

    const result = await report(document, "cotidiano.pdf");

    expect(result.verdict).toBe("notCompliant");
    expect(result.failed).toBeGreaterThanOrEqual(2);
    expect(checkFor(result, "identification").status).toBe("fail");
    expect(checkFor(result, "fonts").status).toBe("fail");
  });

  it("documento con los seis marcadores en orden -> noIssuesFound (que NO es 'certificado')", async () => {
    const result = await report(await createLikelyCompliant(), "parece-pdfa.pdf");

    expect(result.failed).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.unknowns).toBe(0);
    expect(result.verdict).toBe("noIssuesFound");
    expect(result.claim).toEqual({ part: "1", conformance: "B", revision: null });
  });

  it("el informe trae siempre las seis casillas, en orden fijo", async () => {
    const result = await report(await createDocument());

    expect(result.checks.map((check) => check.id)).toEqual([
      "identification",
      "fonts",
      "outputIntent",
      "encryption",
      "javascript",
      "embeddedFiles",
    ]);
  });

  it("el informe describe el archivo: nombre, tamano, paginas y version", async () => {
    const document = await createDocument();
    document.addPage([200, 200]);

    const result = await report(document, "tres-datos.pdf");

    expect(result.fileName).toBe("tres-datos.pdf");
    expect(result.fileSize).toBeGreaterThan(0);
    expect(result.pageCount).toBe(2);
    expect(result.pdfVersion).toMatch(/^\d+\.\d+$/);
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  it("un archivo vacio no se inspecciona: lanza PdfError('corrupt')", async () => {
    const empty = new File([], "vacio.pdf", { type: "application/pdf" });
    await expect(checkPdfaCompliance(empty)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("respeta la cancelacion via AbortSignal", async () => {
    const file = await toFile(await createDocument());
    const controller = new AbortController();
    controller.abort();

    await expect(
      checkPdfaCompliance(file, undefined, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("informa progreso monotono hasta 1", async () => {
    const file = await toFile(await createLikelyCompliant());
    const values: number[] = [];

    await checkPdfaCompliance(file, (value) => values.push(value));

    expect(values.length).toBeGreaterThan(1);
    expect(values[values.length - 1]).toBe(1);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Utilidades puras
 * ------------------------------------------------------------------ */

describe("summarize / readPdfVersion", () => {
  it("un solo fail manda sobre cualquier aviso: notCompliant", () => {
    const totals = summarize([
      { id: "fonts", status: "fail", code: "fontsMissing" },
      { id: "javascript", status: "pass", code: "javascriptNone" },
      { id: "outputIntent", status: "warn", code: "outputIntentNone" },
    ]);
    expect(totals.verdict).toBe("notCompliant");
    expect(totals.failed).toBe(1);
  });

  it("sin fails pero con algo sin comprobar -> inconclusive, nunca 'sin incidencias'", () => {
    expect(
      summarize([
        { id: "fonts", status: "pass", code: "fontsAllEmbedded" },
        { id: "encryption", status: "unknown", code: "encryptionUnknown" },
      ]).verdict,
    ).toBe("inconclusive");
  });

  it("todo en verde -> noIssuesFound", () => {
    expect(
      summarize([
        { id: "fonts", status: "pass", code: "fontsAllEmbedded" },
        { id: "javascript", status: "pass", code: "javascriptNone" },
      ]).verdict,
    ).toBe("noIssuesFound");
  });

  it("readPdfVersion lee la cabecera y devuelve null si no la hay", () => {
    expect(readPdfVersion(new TextEncoder().encode("%PDF-1.7\n%\xE2\xE3"))).toBe("1.7");
    expect(readPdfVersion(new TextEncoder().encode("no soy un pdf"))).toBeNull();
  });
});
