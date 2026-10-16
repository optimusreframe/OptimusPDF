import { createHash } from "node:crypto";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it, vi } from "vitest";
import {
  signBatch,
  type SignBatchDocument,
  type SignBatchSigned,
} from "@/lib/pdf/signBatch";

/*
 * Copias en el ZIP de «Firmar PDF» (U1.1): el MISMO PDF firmado N veces con nombres unicos, en orden estable, sin volver
 * a firmar, con el registro contando cada archivo y con los limites comprobados ANTES de firmar nada.
 */

function doc(id: string, name: string, copies?: number): SignBatchDocument {
  return {
    id,
    name,
    file: new File([`contenido ${id}`], name, { type: "application/pdf" }),
    ...(copies === undefined ? {} : { copies }),
  };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

function fakeSign(signers: Record<string, string[]> = {}) {
  return vi.fn(
    async (document: SignBatchDocument): Promise<SignBatchSigned> => ({
      bytes: bytesOf(`firmado:${document.id}`),
      signerNames: signers[document.id] ?? ["Ana", "Luis"],
    }),
  );
}

async function readZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

/** PDF real de N paginas: el registro cuenta paginas con pdf-lib. */
async function realPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([200, 200]);
  return pdf.save();
}

describe("signBatch — copias", () => {
  it("4 documentos x 2 copias = 8 archivos con nombres unicos y orden estable (cada documento, original y luego su copia)", async () => {
    const sign = fakeSign();
    const result = await signBatch({
      documents: [
        doc("a", "Contrato.pdf", 2),
        doc("b", "Anexo.pdf", 2),
        doc("c", "Carta.pdf", 2),
        doc("d", "Autorizacion.pdf", 2),
      ],
      sign,
      lang: "es",
    });

    expect(result.mimeType).toBe("application/zip");
    const expected = [
      "Ana y Luis - Contrato-firmado.pdf",
      "Ana y Luis - Contrato-firmado (copia 2).pdf",
      "Ana y Luis - Anexo-firmado.pdf",
      "Ana y Luis - Anexo-firmado (copia 2).pdf",
      "Ana y Luis - Carta-firmado.pdf",
      "Ana y Luis - Carta-firmado (copia 2).pdf",
      "Ana y Luis - Autorizacion-firmado.pdf",
      "Ana y Luis - Autorizacion-firmado (copia 2).pdf",
    ];
    // Orden del ZIP = orden de los archivos entregados.
    expect(Object.keys((await readZip(result.blob)).files)).toEqual(expected);
    expect(result.files.map((file) => file.filename)).toEqual(expected);
    expect(result.files.map((file) => [file.documentId, file.copy])).toEqual([
      ["a", 1], ["a", 2], ["b", 1], ["b", 2], ["c", 1], ["c", 2], ["d", 1], ["d", 2],
    ]);
    expect(new Set(expected.map((n) => n.toLowerCase())).size).toBe(8);
    // El informe habla de DOCUMENTOS (4) y nombra su archivo original.
    expect(result.report.ok.map((item) => item.filename)).toEqual([
      "Ana y Luis - Contrato-firmado.pdf",
      "Ana y Luis - Anexo-firmado.pdf",
      "Ana y Luis - Carta-firmado.pdf",
      "Ana y Luis - Autorizacion-firmado.pdf",
    ]);
    // El nombre del ZIP cuenta documentos, no archivos.
    expect(result.filename).toBe("Firmados - 4 documentos.zip");
  });

  it("las copias COMPARTEN el PDF firmado: `sign` se llama UNA vez por documento y los bytes son identicos", async () => {
    const sign = fakeSign();
    const result = await signBatch({ documents: [doc("a", "A.pdf", 3), doc("b", "B.pdf")], sign, lang: "es" });
    expect(sign).toHaveBeenCalledTimes(2);
    const zip = await readZip(result.blob);
    const original = await zip.file("Ana y Luis - A-firmado.pdf")!.async("string");
    expect(original).toBe("firmado:a");
    expect(await zip.file("Ana y Luis - A-firmado (copia 2).pdf")!.async("string")).toBe(original);
    expect(await zip.file("Ana y Luis - A-firmado (copia 3).pdf")!.async("string")).toBe(original);
    expect(await zip.file("Ana y Luis - B-firmado.pdf")!.async("string")).toBe("firmado:b");
  });

  it("un solo documento con copias es un ZIP; sin copias sigue siendo el PDF suelto de siempre", async () => {
    const withCopies = await signBatch({ documents: [doc("a", "Solo.pdf", 2)], sign: fakeSign(), lang: "es" });
    expect(withCopies.mimeType).toBe("application/zip");
    expect(withCopies.filename).toBe("Firmados - 1 documento.zip");
    expect(Object.keys((await readZip(withCopies.blob)).files)).toEqual([
      "Ana y Luis - Solo-firmado.pdf",
      "Ana y Luis - Solo-firmado (copia 2).pdf",
    ]);

    for (const copies of [undefined, 1]) {
      const plain = await signBatch({ documents: [doc("a", "Solo.pdf", copies)], sign: fakeSign(), lang: "es" });
      expect(plain.mimeType).toBe("application/pdf");
      expect(plain.filename).toBe("Ana y Luis - Solo-firmado.pdf");
      expect(plain.files).toEqual([{ documentId: "a", filename: "Ana y Luis - Solo-firmado.pdf", copy: 1 }]);
    }
  });

  it("en ingles: «(copy 2)»", async () => {
    const result = await signBatch({ documents: [doc("a", "Deal.pdf", 2)], sign: fakeSign(), lang: "en" });
    expect(Object.keys((await readZip(result.blob)).files)).toEqual([
      "Ana and Luis - Deal-signed.pdf",
      "Ana and Luis - Deal-signed (copy 2).pdf",
    ]);
  });

  it("nombres repetidos entre documentos: las copias no se pisan con ellos y el orden sigue siendo estable", async () => {
    const result = await signBatch({
      documents: [doc("a", "Igual.pdf", 2), doc("b", "Igual.pdf", 2), doc("c", "Igual (copia 2).pdf")],
      sign: fakeSign({ a: ["Ana"], b: ["Ana"], c: ["Ana"] }),
      lang: "es",
    });
    const names = Object.keys((await readZip(result.blob)).files);
    expect(names).toHaveLength(5);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(5);
    expect(names).toEqual(result.files.map((file) => file.filename));
    expect(names.slice(0, 2)).toEqual(["Ana - Igual-firmado.pdf", "Ana - Igual-firmado (copia 2).pdf"]);
  });

  it("un documento que FALLA no entrega sus copias; los demas conservan las suyas", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "b") throw new Error("boom");
      return { bytes: bytesOf(document.id), signerNames: ["Ana"] };
    });
    const result = await signBatch({ documents: [doc("a", "A.pdf", 2), doc("b", "B.pdf", 3), doc("c", "C.pdf", 2)], sign, lang: "es" });
    expect(Object.keys((await readZip(result.blob)).files)).toEqual([
      "Ana - A-firmado.pdf",
      "Ana - A-firmado (copia 2).pdf",
      "Ana - C-firmado.pdf",
      "Ana - C-firmado (copia 2).pdf",
    ]);
    expect(result.report.failed).toEqual([{ id: "b", name: "B.pdf", code: "unknown" }]);
    expect(result.report.ok.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("la barra de progreso no retrocede y llega a 1 con copias", async () => {
    const seen: number[] = [];
    await signBatch({
      documents: [doc("a", "A.pdf", 5), doc("b", "B.pdf", 5)],
      sign: fakeSign(),
      lang: "es",
      onProgress: (value) => seen.push(value),
    });
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1])).toBe(true);
  });
});

describe("signBatch — limites de copias", () => {
  it("mas de 5 copias: error ANTES de firmar nada (tooLarge)", async () => {
    const sign = fakeSign();
    const run = signBatch({ documents: [doc("a", "A.pdf"), doc("b", "B.pdf", 6)], sign, lang: "es" });
    await expect(run).rejects.toMatchObject({ name: "PdfError", code: "tooLarge" });
    await expect(run).rejects.toThrow(/sign:invalidCopies 6/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("0, negativas, decimales y NaN: error (unknown) antes de firmar", async () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const sign = fakeSign();
      const run = signBatch({ documents: [doc("a", "A.pdf", bad)], sign, lang: "es" });
      await expect(run).rejects.toMatchObject({ name: "PdfError", code: "unknown" });
      expect(sign).not.toHaveBeenCalled();
    }
  });

  it("exactamente 5 copias si cabe", async () => {
    const result = await signBatch({ documents: [doc("a", "A.pdf", 5)], sign: fakeSign(), lang: "es" });
    expect(result.files).toHaveLength(5);
  });

  it("maximo de archivos de la ronda (`limits.maxFiles`): 50 caben, 51 no, y el error llega antes de firmar", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => doc(`d${i}`, `Doc ${i}.pdf`, 5));
    const ok = await signBatch({ documents: ten, sign: fakeSign(), lang: "es", limits: { maxFiles: 50 } });
    expect(ok.files).toHaveLength(50);
    expect(Object.keys((await readZip(ok.blob)).files)).toHaveLength(50);

    const sign = fakeSign();
    const over = [...ten, doc("x", "X.pdf", 1)];
    const run = signBatch({ documents: over, sign, lang: "es", limits: { maxFiles: 50 } });
    await expect(run).rejects.toMatchObject({ code: "tooLarge" });
    await expect(run).rejects.toThrow(/sign:tooManyFiles 51 > 50/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("sin `maxFiles` el tope es el de siempre del ZIP (100 archivos)", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => doc(`d${i}`, `Doc ${i}.pdf`, 5));
    await expect(signBatch({ documents: twenty, sign: fakeSign(), lang: "es" })).resolves.toBeTruthy();
    const twentyOne = [...twenty, doc("z", "Z.pdf", 1)];
    await expect(signBatch({ documents: twentyOne, sign: fakeSign(), lang: "es" })).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("el tope de documentos sigue contando documentos, no archivos", async () => {
    const run = signBatch({
      documents: [doc("a", "A.pdf", 5), doc("b", "B.pdf", 5), doc("c", "C.pdf")],
      sign: fakeSign(),
      lang: "es",
      limits: { maxDocuments: 2, maxFiles: 50 },
    });
    await expect(run).rejects.toMatchObject({ code: "tooLarge" });
  });
});

describe("signBatch — registro (.json) con copias", () => {
  it("cada archivo del ZIP tiene su fila con el MISMO hash, y las copias dicen de cual lo son", async () => {
    const pdf = await realPdf(2);
    const result = await signBatch({
      documents: [doc("a", "Contrato.pdf", 3), doc("b", "Anexo.pdf")],
      sign: async (document) => ({ bytes: document.id === "a" ? pdf : await realPdf(1), signerNames: ["Ana"] }),
      lang: "es",
      record: { noSignerName: "Sin nombre" },
    });
    const zip = await readZip(result.blob);
    const record = JSON.parse((await zip.file("registro-firmas.json")!.async("string")) as string);
    expect(record.documents.map((row: { file: string }) => row.file)).toEqual([
      "Ana - Contrato-firmado.pdf",
      "Ana - Contrato-firmado (copia 2).pdf",
      "Ana - Contrato-firmado (copia 3).pdf",
      "Ana - Anexo-firmado.pdf",
    ]);
    const hash = createHash("sha256").update(pdf).digest("hex");
    for (const row of record.documents.slice(0, 3)) {
      expect(row.sha256).toBe(hash);
      expect(row.pages).toBe(2);
      // La fila se puede volver a calcular desde el archivo real del ZIP.
      expect(createHash("sha256").update(await zip.file(row.file)!.async("uint8array")).digest("hex")).toBe(row.sha256);
    }
    expect(record.documents.map((row: { copyOf?: string }) => row.copyOf)).toEqual([
      undefined,
      "Ana - Contrato-firmado.pdf",
      "Ana - Contrato-firmado.pdf",
      undefined,
    ]);
    // El registro del resultado es el mismo que el del ZIP.
    expect(result.record?.documents).toHaveLength(4);
  });

  it("sin copias el registro no cambia: ninguna fila lleva `copyOf`", async () => {
    const result = await signBatch({
      documents: [doc("a", "A.pdf"), doc("b", "B.pdf")],
      sign: fakeSign({ a: ["Ana"], b: ["Ana"] }),
      lang: "es",
      record: { noSignerName: "Sin nombre" },
    });
    for (const row of result.record!.documents) expect("copyOf" in row).toBe(false);
  });

  it("un solo documento con copias y registro: el registro va DENTRO del ZIP (hay varios archivos)", async () => {
    const result = await signBatch({
      documents: [doc("a", "Solo.pdf", 2)],
      sign: fakeSign({ a: ["Ana"] }),
      lang: "es",
      record: { noSignerName: "Sin nombre" },
    });
    const names = Object.keys((await readZip(result.blob)).files);
    expect(names).toContain("registro-firmas.json");
    expect(result.record?.documents.map((row) => row.file)).toEqual(["Ana - Solo-firmado.pdf", "Ana - Solo-firmado (copia 2).pdf"]);
  });
});
