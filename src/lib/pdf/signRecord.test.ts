import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  SIGNING_RECORD_TYPE,
  SIGNING_RECORD_VERSION,
  buildSigningRecord,
  buildSigningRecordEntry,
  serializeSigningRecord,
  signingRecordBlob,
  signingRecordFilename,
} from "@/lib/pdf/signRecord";

/**
 * Registro de firmas APARTE (`registro-firmas.json`): hash SHA-256 verificable recalculandolo, fecha, firmantes y
 * paginas del PDF entregado. Nunca dentro del PDF.
 */

async function pdfBytes(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) doc.addPage([200, 200]);
  return doc.save({ useObjectStreams: true });
}

const NOW = new Date("2026-10-14T12:00:00.000Z");

describe("signRecord — src/lib/pdf/signRecord.ts", () => {
  it("el nombre del archivo es registro-firmas.json en espanol y signing-record.json en ingles", () => {
    expect(signingRecordFilename("es")).toBe("registro-firmas.json");
    expect(signingRecordFilename("en")).toBe("signing-record.json");
  });

  it("la fila lleva el SHA-256 REAL de los bytes (recalculable con cualquier herramienta), las paginas, la fecha y los firmantes", async () => {
    const bytes = await pdfBytes(3);
    const entry = await buildSigningRecordEntry({
      file: "Ana - Contrato-firmado.pdf",
      bytes,
      signerNames: ["Ana Perez", "Luis"],
      noSignerName: "Sin nombre",
      now: NOW,
    });
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.pages).toBe(3);
    expect(entry.signedAt).toBe("2026-10-14T12:00:00.000Z");
    expect(entry.signers).toEqual(["Ana Perez", "Luis"]);
    expect(entry.file).toBe("Ana - Contrato-firmado.pdf");
  });

  it("un firmante sin nombre se escribe con el texto de respaldo; «Solo yo» (sin firmantes) deja la lista vacia", async () => {
    const bytes = await pdfBytes(1);
    const blank = await buildSigningRecordEntry({ file: "a.pdf", bytes, signerNames: ["  ", "Luis"], noSignerName: "Sin nombre" });
    expect(blank.signers).toEqual(["Sin nombre", "Luis"]);
    const solo = await buildSigningRecordEntry({ file: "a.pdf", bytes, signerNames: [], noSignerName: "Sin nombre" });
    expect(solo.signers).toEqual([]);
  });

  it("si los bytes no son un PDF legible, las paginas son null (no se tumba un documento bien firmado) pero el hash se calcula", async () => {
    const bytes = new TextEncoder().encode("esto no es un pdf");
    const entry = await buildSigningRecordEntry({ file: "x.pdf", bytes, signerNames: [], noSignerName: "-" });
    expect(entry.pages).toBeNull();
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("el registro completo es JSON valido con tipo, version, algoritmo, nota en el idioma activo y los documentos", async () => {
    const bytes = await pdfBytes(2);
    const entry = await buildSigningRecordEntry({ file: "a.pdf", bytes, signerNames: ["Ana"], noSignerName: "-", now: NOW });
    const es = buildSigningRecord([entry], "es", NOW);
    expect(es).toMatchObject({
      type: SIGNING_RECORD_TYPE,
      version: SIGNING_RECORD_VERSION,
      generatedAt: "2026-10-14T12:00:00.000Z",
      hashAlgorithm: "SHA-256",
    });
    expect(es.note).toContain("No es una firma certificada");
    expect(buildSigningRecord([entry], "en", NOW).note).toContain("not a certified signature");

    const parsed = JSON.parse(serializeSigningRecord(es));
    expect(parsed.documents).toEqual([entry]);
    expect(Object.keys(parsed.documents[0]).sort()).toEqual(["file", "pages", "sha256", "signedAt", "signers"]);
  });

  it("el Blob descargable es application/json con exactamente el JSON serializado", async () => {
    const record = buildSigningRecord([], "es", NOW);
    const blob = signingRecordBlob(record);
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe(serializeSigningRecord(record));
  });
});
