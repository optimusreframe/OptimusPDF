import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  CONFIG_VERSION_MULTI,
  configDocumentEntry,
  exportSignConfigSet,
  importSignConfig,
  importSignConfigSet,
  isSignConfigManifestV2,
  sanitizeConfigDocumentName,
  type ExportConfigDocument,
  type SignConfigManifestV2,
} from "@/app/sign-pdf/signConfig";
import { sessionFromConfigSet } from "@/app/sign-pdf/configSession";
import { docIdOf, type SignerBlock } from "@/app/sign-pdf/docSet";
import { MAX_DOCUMENTS, MAX_DOCUMENT_BYTES } from "@/app/sign-pdf/signLimits";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Configuracion v2 (varios documentos): ida y vuelta, v1 frente a v2 y zips
 * manipulados. Cada caso malicioso se construye a mano con JSZip.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#e5484d" };
const MARTA: Signer = { id: "sg-3", name: "Marta", color: "#10b981" };

function pdfBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>`);
}

function pdfFile(name: string, tag = name): File {
  return new File([pdfBytes(tag) as BlobPart], name, { type: "application/pdf" });
}

function slot(id: string, signerId: string, pageIndex = 0): SignatureField {
  return {
    id,
    signerId,
    pageIndex,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
  };
}

function exportDoc(name: string, over: Partial<ExportConfigDocument> = {}): ExportConfigDocument {
  const file = pdfFile(name);
  return {
    id: docIdOf(file),
    file,
    fields: [slot(`fld-${name}`, "sg-1")],
    textFields: [],
    textValues: {},
    ...over,
  };
}

function block(over: Partial<SignerBlock> & Pick<SignerBlock, "id" | "signerId">): SignerBlock {
  return {
    appliesTo: [],
    signature: null,
    initials: null,
    stamps: {},
    auto: true,
    ...over,
  };
}

function asZipFile(blob: Blob, name = "config.zip"): File {
  return new File([blob], name, { type: "application/zip" });
}

/** Un manifiesto v2 valido de dos documentos, para deformarlo en cada caso. */
function validManifest(over: Partial<SignConfigManifestV2> = {}): SignConfigManifestV2 {
  return {
    version: 2,
    mode: "multi",
    signMode: "same",
    signers: [ANA],
    blocks: [{ id: "bk-1", signerId: "sg-1", appliesTo: ["doc-1", "doc-2"], auto: true }],
    documents: [
      {
        id: "doc-1",
        entry: configDocumentEntry(0),
        name: "uno.pdf",
        fields: [slot("f1", "sg-1")],
        textFields: [],
        textValues: {},
      },
      {
        id: "doc-2",
        entry: configDocumentEntry(1),
        name: "dos.pdf",
        fields: [],
        textFields: [],
        textValues: {},
      },
    ],
    ...over,
  };
}

async function buildZip(
  manifest: unknown,
  entries: Record<string, Uint8Array | string> = {
    "documentos/01.pdf": pdfBytes("1"),
    "documentos/02.pdf": pdfBytes("2"),
  },
  options: { createFolders?: boolean } = {},
): Promise<File> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.file(name, data, { createFolders: options.createFolders ?? false });
  }
  zip.file("manifest.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return asZipFile(await zip.generateAsync({ type: "blob" }));
}

describe("exportSignConfigSet", () => {
  it("con UN documento exporta la v1 de siempre (importable con el importador v1)", async () => {
    const doc = exportDoc("solo.pdf");
    const blob = await exportSignConfigSet([doc], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documento.pdf", "manifest.json"]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest.version).toBe(1);
    expect(manifest.documents).toBeUndefined();

    const imported = await importSignConfig(asZipFile(blob));
    expect(imported.manifest.fields).toEqual(doc.fields);
  });

  it("con varios documentos exporta la v2: un PDF por documento en documentos/NN.pdf mas el manifiesto", async () => {
    const blob = await exportSignConfigSet([exportDoc("a.pdf"), exportDoc("b.pdf"), exportDoc("c.pdf")], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([
      "documentos/01.pdf",
      "documentos/02.pdf",
      "documentos/03.pdf",
      "manifest.json",
    ]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest.version).toBe(CONFIG_VERSION_MULTI);
    expect(manifest.documents.map((d: { entry: string }) => d.entry)).toEqual([
      "documentos/01.pdf",
      "documentos/02.pdf",
      "documentos/03.pdf",
    ]);
  });

  it("el zip tiene exactamente N + 1 entradas (sin carpetas aparte)", async () => {
    const blob = await exportSignConfigSet([exportDoc("a.pdf"), exportDoc("b.pdf")], {
      mode: "multi",
      signMode: "same",
      signers: [],
      blocks: [],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files)).toHaveLength(3);
  });

  it("los bloques se exportan SIN trazos ni sellos: solo el alcance", async () => {
    const a = exportDoc("a.pdf");
    const b = exportDoc("b.pdf");
    const blob = await exportSignConfigSet([a, b], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [
        block({
          id: "bk-7",
          signerId: "sg-1",
          appliesTo: [a.id, b.id],
          signature: { dataUrl: "data:image/png;base64,SECRETO", ratio: 0.3 },
          initials: { dataUrl: "data:image/png;base64,SECRETO2", ratio: 0.4 },
          stamps: { [a.id]: "stamp-a", [b.id]: "stamp-b" },
        }),
      ],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const text = await zip.file("manifest.json")!.async("text");
    expect(text).not.toContain("SECRETO");
    expect(text).not.toContain("stamp-a");
    expect(text).not.toContain("dataUrl");
    const manifest = JSON.parse(text);
    expect(manifest.blocks).toEqual([
      { id: "bk-7", signerId: "sg-1", appliesTo: ["doc-1", "doc-2"], auto: true },
    ]);
  });

  it("el alcance de un bloque se traduce a los ids del manifiesto y descarta documentos ajenos", async () => {
    const a = exportDoc("a.pdf");
    const b = exportDoc("b.pdf");
    const blob = await exportSignConfigSet([a, b], {
      mode: "multi",
      signMode: "independent",
      signers: [ANA],
      blocks: [
        block({ id: "bk-1", signerId: "sg-1", appliesTo: [b.id, "doc-ajeno"], auto: false }),
        block({ id: "bk-2", signerId: "sg-1", appliesTo: ["doc-ajeno"] }),
      ],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest.blocks).toEqual([
      { id: "bk-1", signerId: "sg-1", appliesTo: ["doc-2"], auto: false },
    ]);
    expect(manifest.signMode).toBe("independent");
  });

  it("rechaza exportar mas de MAX_DOCUMENTS documentos", async () => {
    const docs = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, index) => exportDoc(`d${index}.pdf`));
    await expect(
      exportSignConfigSet(docs, { mode: "multi", signMode: "same", signers: [], blocks: [] }),
    ).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("rechaza exportar sin documentos", async () => {
    await expect(
      exportSignConfigSet([], { mode: "multi", signMode: "same", signers: [], blocks: [] }),
    ).rejects.toMatchObject({ code: "empty" });
  });
});

describe("importSignConfigSet — ida y vuelta", () => {
  it("v2: conserva documentos, nombres, bytes, huecos, firmantes, bloques y modo", async () => {
    const a = exportDoc("contrato A.pdf", { textValues: { "txt-1": "Ana" } });
    const b = exportDoc("anexo ñ.pdf", { fields: [] });
    const blob = await exportSignConfigSet([a, b], {
      mode: "multi",
      signMode: "independent",
      signers: [ANA, LUIS],
      blocks: [
        block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id], auto: false }),
        block({ id: "bk-2", signerId: "sg-1", appliesTo: [b.id], auto: false }),
      ],
    });
    const set = await importSignConfigSet(asZipFile(blob));
    expect(set.version).toBe(2);
    expect(set.mode).toBe("multi");
    expect(set.signMode).toBe("independent");
    expect(set.signers).toEqual([ANA, LUIS]);
    expect(set.documents.map((d) => d.file.name)).toEqual(["contrato A.pdf", "anexo ñ.pdf"]);
    expect(new Uint8Array(await set.documents[0].file.arrayBuffer())).toEqual(pdfBytes("contrato A.pdf"));
    expect(set.documents[0].fields).toEqual(a.fields);
    expect(set.documents[0].textValues).toEqual({ "txt-1": "Ana" });
    expect(set.blocks.map((blk) => blk.appliesTo)).toEqual([["doc-1"], ["doc-2"]]);
  });

  it("v1 se sigue leyendo con el importador nuevo (un documento, sin bloques)", async () => {
    const doc = exportDoc("viejo.pdf");
    const blob = await exportSignConfigSet([doc], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [],
    });
    const set = await importSignConfigSet(asZipFile(blob));
    expect(set.version).toBe(1);
    expect(set.documents).toHaveLength(1);
    expect(set.documents[0].file.name).toBe("documento.pdf");
    expect(set.blocks).toEqual([]);
    expect(set.signMode).toBe("same");
  });

  it("el importador v1 de siempre sigue rechazando una v2 (no la lee a medias)", async () => {
    const zipFile = await buildZip(validManifest());
    await expect(importSignConfig(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("v2 con UN solo documento tambien se lee", async () => {
    const manifest = validManifest({
      blocks: [],
      documents: [validManifest().documents[0]],
    });
    const zipFile = await buildZip(manifest, { "documentos/01.pdf": pdfBytes("1") });
    const set = await importSignConfigSet(zipFile);
    expect(set.documents).toHaveLength(1);
  });

  it("datos heredados con MAS de 2 firmantes se importan intactos (solo se limita el alta)", async () => {
    const zipFile = await buildZip(validManifest({ signers: [ANA, LUIS, MARTA] }));
    const set = await importSignConfigSet(zipFile);
    expect(set.signers).toEqual([ANA, LUIS, MARTA]);
  });

  it("acepta un zip con una entrada de carpeta 'documentos/' (otro compresor)", async () => {
    const zipFile = await buildZip(
      validManifest(),
      { "documentos/01.pdf": pdfBytes("1"), "documentos/02.pdf": pdfBytes("2") },
      { createFolders: true },
    );
    await expect(importSignConfigSet(zipFile)).resolves.toMatchObject({ version: 2 });
  });

  it("el nombre del archivo viene del manifiesto, sin rutas", async () => {
    const manifest = validManifest();
    manifest.documents[0].name = "../../etc/passwd.pdf";
    manifest.documents[1].name = "C:\\Users\\x\\dos";
    const set = await importSignConfigSet(await buildZip(manifest));
    expect(set.documents[0].file.name).toBe("passwd.pdf");
    expect(set.documents[1].file.name).toBe("dos.pdf");
  });
});

describe("importSignConfigSet — zips maliciosos o rotos", () => {
  it("rechaza una entrada con ruta '..' (path traversal)", async () => {
    const manifest = validManifest();
    manifest.documents[0].entry = "../documentos/01.pdf";
    const zipFile = await buildZip(manifest, {
      "../documentos/01.pdf": pdfBytes("1"),
      "documentos/02.pdf": pdfBytes("2"),
    });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza una ruta absoluta o con barras invertidas en el manifiesto", async () => {
    for (const entry of ["/documentos/01.pdf", "documentos\\01.pdf", "documentos/../01.pdf", "otra/01.pdf"]) {
      const manifest = validManifest();
      manifest.documents[0].entry = entry;
      const zipFile = await buildZip(manifest);
      await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
    }
  });

  it("rechaza entradas EXTRA que el manifiesto no declara", async () => {
    const zipFile = await buildZip(validManifest(), {
      "documentos/01.pdf": pdfBytes("1"),
      "documentos/02.pdf": pdfBytes("2"),
      "documentos/99.pdf": pdfBytes("extra"),
    });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un archivo ajeno bajo otra ruta (script, exe...)", async () => {
    const zipFile = await buildZip(validManifest(), {
      "documentos/01.pdf": pdfBytes("1"),
      "documentos/02.pdf": pdfBytes("2"),
      "pwn.sh": "rm -rf /",
    });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un documento declarado que NO esta en el zip", async () => {
    const zipFile = await buildZip(validManifest(), { "documentos/01.pdf": pdfBytes("1") });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza una version futura", async () => {
    const zipFile = await buildZip({ ...validManifest(), version: 3 });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza demasiados documentos (MAX_DOCUMENTS + 1)", async () => {
    const count = MAX_DOCUMENTS + 1;
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `doc-${index + 1}`,
      entry: configDocumentEntry(index),
      name: `d${index}.pdf`,
      fields: [],
      textFields: [],
      textValues: {},
    }));
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < count; index += 1) entries[configDocumentEntry(index)] = pdfBytes(String(index));
    const zipFile = await buildZip(validManifest({ blocks: [], documents }), entries);
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("acepta exactamente MAX_DOCUMENTS documentos", async () => {
    const documents = Array.from({ length: MAX_DOCUMENTS }, (_, index) => ({
      id: `doc-${index + 1}`,
      entry: configDocumentEntry(index),
      name: `d${index}.pdf`,
      fields: [],
      textFields: [],
      textValues: {},
    }));
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < MAX_DOCUMENTS; index += 1) entries[configDocumentEntry(index)] = pdfBytes(String(index));
    const set = await importSignConfigSet(await buildZip(validManifest({ blocks: [], documents }), entries));
    expect(set.documents).toHaveLength(MAX_DOCUMENTS);
  });

  it("rechaza un PDF sin la cabecera %PDF-", async () => {
    const zipFile = await buildZip(validManifest(), {
      "documentos/01.pdf": pdfBytes("1"),
      "documentos/02.pdf": "esto no es un pdf",
    });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un PDF vacio", async () => {
    const zipFile = await buildZip(validManifest(), {
      "documentos/01.pdf": pdfBytes("1"),
      "documentos/02.pdf": new Uint8Array(),
    });
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un PDF que descomprime a mas del tope por documento", async () => {
    const huge = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    huge.set(new TextEncoder().encode("%PDF-"));
    const zip = new JSZip();
    zip.file("documentos/01.pdf", pdfBytes("1"), { createFolders: false });
    zip.file("documentos/02.pdf", huge, { createFolders: false, compression: "DEFLATE" });
    zip.file("manifest.json", JSON.stringify(validManifest()));
    const zipFile = asZipFile(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  }, 30_000);

  /** Cambia el tamano descomprimido declarado (cabeceras local y central) de TODAS las entradas. */
  function lieAboutSize(zipBytes: Uint8Array, declared: number): Uint8Array {
    const out = new Uint8Array(zipBytes);
    const view = new DataView(out.buffer);
    for (let offset = 0; offset + 46 < out.length; offset += 1) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x04034b50) view.setUint32(offset + 22, declared, true);
      else if (signature === 0x02014b50) view.setUint32(offset + 24, declared, true);
    }
    return out;
  }

  it("una cabecera de tamano MENTIROSA (declara poco, descomprime mucho) se rechaza como invalidConfig, no como error desconocido", async () => {
    const huge = new Uint8Array(MAX_DOCUMENT_BYTES + 8 * 1024 * 1024);
    huge.set(new TextEncoder().encode("%PDF-"));
    const zip = new JSZip();
    zip.file("documentos/01.pdf", pdfBytes("1"), { createFolders: false });
    zip.file("documentos/02.pdf", huge, { createFolders: false, compression: "DEFLATE" });
    zip.file("manifest.json", JSON.stringify(validManifest()));
    const built = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const lying = new File([lieAboutSize(built, 64) as BlobPart], "mentiroso.zip");
    await expect(importSignConfigSet(lying)).rejects.toMatchObject({ code: "invalidConfig" });
  }, 60_000);

  it("un manifiesto con cabecera mentirosa tambien es invalidConfig", async () => {
    const zip = new JSZip();
    zip.file("documentos/01.pdf", pdfBytes("1"), { createFolders: false });
    zip.file("manifest.json", JSON.stringify(validManifest()));
    const built = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const lying = new File([lieAboutSize(built, 3) as BlobPart], "mentiroso.zip");
    await expect(importSignConfigSet(lying)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("datos comprimidos corruptos dan invalidConfig (nunca 'unknown')", async () => {
    const zip = new JSZip();
    zip.file("documentos/01.pdf", new Uint8Array(4000).fill(7), { createFolders: false, compression: "DEFLATE" });
    zip.file("documentos/02.pdf", pdfBytes("2"), { createFolders: false });
    zip.file("manifest.json", JSON.stringify(validManifest()));
    const built = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const broken = new Uint8Array(built);
    // Estropea los bytes comprimidos del primer documento (justo tras su cabecera local).
    for (let index = 50; index < 70; index += 1) broken[index] = 0xff;
    await expect(importSignConfigSet(new File([broken as BlobPart], "roto.zip"))).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza un manifiesto que no es JSON", async () => {
    await expect(importSignConfigSet(await buildZip("{no json"))).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza un zip sin manifiesto", async () => {
    const zip = new JSZip();
    zip.file("documentos/01.pdf", pdfBytes("1"));
    const zipFile = asZipFile(await zip.generateAsync({ type: "blob" }));
    await expect(importSignConfigSet(zipFile)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza algo que no es un zip", async () => {
    await expect(
      importSignConfigSet(new File([new Uint8Array([1, 2, 3])], "config.zip")),
    ).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza ids de documento repetidos", async () => {
    const manifest = validManifest();
    manifest.documents[1].id = "doc-1";
    await expect(importSignConfigSet(await buildZip(manifest))).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza entradas fuera de orden o repetidas (documentos/NN.pdf debe ser el N-esimo)", async () => {
    const manifest = validManifest();
    manifest.documents[1].entry = configDocumentEntry(0);
    await expect(importSignConfigSet(await buildZip(manifest))).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza un bloque que apunta a un documento o a un firmante que no existen", async () => {
    await expect(
      importSignConfigSet(
        await buildZip(
          validManifest({
            blocks: [{ id: "bk-1", signerId: "sg-1", appliesTo: ["doc-9"], auto: true }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalidConfig" });
    await expect(
      importSignConfigSet(
        await buildZip(
          validManifest({
            blocks: [{ id: "bk-1", signerId: "sg-9", appliesTo: ["doc-1"], auto: true }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un rect fuera de rango o un tipo de campo desconocido dentro de un documento", async () => {
    const bad = validManifest();
    bad.documents[0].fields = [{ ...slot("f", "sg-1"), rect: { x: 5, y: 0, width: 0.1, height: 0.1 } }];
    await expect(importSignConfigSet(await buildZip(bad))).rejects.toMatchObject({ code: "invalidConfig" });

    const bad2 = validManifest();
    bad2.documents[0].textFields = [
      { id: "t", pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: "manual", confidence: "high", type: "raro" as never },
    ];
    await expect(importSignConfigSet(await buildZip(bad2))).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("rechaza un zip desproporcionado antes de leerlo", async () => {
    const big = new File([new Uint8Array(1)], "gigante.zip");
    Object.defineProperty(big, "size", { value: 500 * 1024 * 1024 });
    await expect(importSignConfigSet(big)).rejects.toMatchObject({ code: "invalidConfig" });
  });
});

describe("isSignConfigManifestV2", () => {
  it("acepta un manifiesto valido", () => {
    expect(isSignConfigManifestV2(validManifest())).toBe(true);
  });

  it("rechaza signMode o mode desconocidos", () => {
    expect(isSignConfigManifestV2({ ...validManifest(), signMode: "varias" })).toBe(false);
    expect(isSignConfigManifestV2({ ...validManifest(), mode: "otro" })).toBe(false);
  });

  it("rechaza una lista de documentos vacia", () => {
    expect(isSignConfigManifestV2({ ...validManifest(), documents: [], blocks: [] })).toBe(false);
  });

  it("rechaza un nombre de documento absurdamente largo", () => {
    const manifest = validManifest();
    manifest.documents[0].name = "x".repeat(300);
    expect(isSignConfigManifestV2(manifest)).toBe(false);
  });

  it("no acepta v1 ni null", () => {
    expect(isSignConfigManifestV2({ ...validManifest(), version: 1 })).toBe(false);
    expect(isSignConfigManifestV2(null)).toBe(false);
  });
});

describe("sanitizeConfigDocumentName", () => {
  it("deja un nombre normal intacto, con acentos", () => {
    expect(sanitizeConfigDocumentName("Contrato ñandú.pdf", 0)).toBe("Contrato ñandú.pdf");
  });

  it("anade .pdf si falta y no lo duplica", () => {
    expect(sanitizeConfigDocumentName("anexo", 0)).toBe("anexo.pdf");
    expect(sanitizeConfigDocumentName("ANEXO.PDF", 0)).toBe("ANEXO.PDF");
  });

  it("quita rutas, controles y puntos iniciales", () => {
    expect(sanitizeConfigDocumentName("a/b\\c\u0000.pdf", 0)).toBe("c.pdf");
    expect(sanitizeConfigDocumentName("...oculto.pdf", 0)).toBe("oculto.pdf");
  });

  it("un nombre vacio o inservible cae a documento-NN.pdf", () => {
    expect(sanitizeConfigDocumentName("", 0)).toBe("documento-01.pdf");
    expect(sanitizeConfigDocumentName("///", 4)).toBe("documento-05.pdf");
    expect(sanitizeConfigDocumentName("...", 9)).toBe("documento-10.pdf");
  });
});

describe("sessionFromConfigSet", () => {
  it("v2: documentos, bloques sin trazos, modo de firma y activo en el primero", async () => {
    const a = exportDoc("a.pdf");
    const b = exportDoc("b.pdf");
    const blob = await exportSignConfigSet([a, b], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id], signature: { dataUrl: "x", ratio: 1 } })],
    });
    const set = await importSignConfigSet(asZipFile(blob));
    const files = set.documents.map((d) => d.file);
    const patch = sessionFromConfigSet(set, files, ["key-1", "key-2"]);
    const [idA, idB] = files.map(docIdOf);
    expect(patch.docOrder).toEqual([idA, idB]);
    expect(patch.activeDocId).toBe(idA);
    expect(patch.step).toBe("signers");
    expect(patch.mode).toBe("multi");
    expect(patch.blocks).toHaveLength(1);
    expect(patch.blocks![0].signature).toBeNull();
    expect(patch.blocks![0].stamps).toEqual({});
    expect(patch.blocks![0].appliesTo).toEqual([idA, idB]);
    expect(patch.docs![idA].sealedKey).toBe("key-1");
    expect(patch.docs![idA].textFieldsDetectedFor).toBe("key-1");
    expect(patch.docs![idB].fields).toEqual(b.fields);
  });

  it("v1: un documento y los bloques los crea la sesion (uno automatico por firmante)", async () => {
    const doc = exportDoc("viejo.pdf");
    const blob = await exportSignConfigSet([doc], {
      mode: "multi",
      signMode: "same",
      signers: [ANA, LUIS],
      blocks: [],
    });
    const set = await importSignConfigSet(asZipFile(blob));
    const patch = sessionFromConfigSet(set, [set.documents[0].file], ["k"]);
    expect(patch.blocks!.map((blk) => blk.signerId)).toEqual(["sg-1", "sg-2"]);
    expect(patch.blocks!.every((blk) => blk.signature === null)).toBe(true);
  });

  it("los bloques importados reciben ids nuevos (no chocan con los del contador)", async () => {
    const a = exportDoc("a.pdf");
    const b = exportDoc("b.pdf");
    const blob = await exportSignConfigSet([a, b], {
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id] })],
    });
    const set = await importSignConfigSet(asZipFile(blob));
    const files = set.documents.map((d) => d.file);
    const first = sessionFromConfigSet(set, files, [null, null]);
    const second = sessionFromConfigSet(set, files, [null, null]);
    expect(first.blocks![0].id).not.toBe(second.blocks![0].id);
  });

  it("una huella no calculada deja el documento por sellar", async () => {
    const set = await importSignConfigSet(await buildZip(validManifest()));
    const files = set.documents.map((d) => d.file);
    const patch = sessionFromConfigSet(set, files, [null, null]);
    expect(patch.docs![docIdOf(files[0])].sealedKey).toBe("");
    expect(patch.docs![docIdOf(files[0])].textFieldsDetectedFor).toBeNull();
  });
});
