import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { runOperation } from "@/app/pdf-pro/proAdapter";
import { rotateAllOperation } from "@/app/pdf-pro/proOperations";
import {
  DEFAULT_PRO_CROP_OPTIONS,
  DEFAULT_PRO_ROTATE_OPTIONS,
  compressOperation,
  cropOperation,
  headerFooterOperation,
  metadataOperation,
  pageNumbersOperation,
  repairOperation,
  rotateOperation,
  unlockOperation,
  watermarkOperation,
} from "@/app/pdf-pro/ops/docOperations";
import { EMPTY_METADATA_FORM } from "@/app/pdf-pro/ops/metadataForm";
import { buildProtectedExport } from "@/app/pdf-pro/ops/protectExport";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";
import { DEFAULT_HEADER_FOOTER_OPTIONS, addHeaderFooter, addHeaderFooterToBytes } from "@/lib/pdf/headerFooter";
import { DEFAULT_PAGE_NUMBERS_OPTIONS, addPageNumbers, addPageNumbersToBytes } from "@/lib/pdf/pageNumbers";
import { DEFAULT_WATERMARK_OPTIONS, addWatermark, addWatermarkToBytes } from "@/lib/pdf/watermark";
import { cropPdf, cropPdfToBytes } from "@/lib/pdf/crop";
import { rotatePdf, rotatePdfToBytes } from "@/lib/pdf/rotate";
import { protectPdf, protectPdfToBytes, DEFAULT_PROTECT_OPTIONS } from "@/lib/pdf/protect";
import { compressPdf, compressPdfToBytes } from "@/lib/pdf/compress";
import { repairPdf, repairPdfToBytes } from "@/lib/pdf/repair";
import { removeProtection, removeProtectionToBytes } from "@/lib/pdf/unlock";
import { pdfBytesToBlob, savePdfToBlob, savePdfToBytes } from "@/lib/pdf/core";
import { asPdfFile } from "@/app/pdf-pro/ops/opUtils";

/**
 * Wave 10 · C-B4 · PDF Pro trabaja con BYTES de punta a punta: los motores entregan el `Uint8Array` de `PDFDocument.save()`
 * y la operacion lo confirma como snapshot, sin ir a `Blob` y volver a leerlo (`blob.arrayBuffer()`): con un PDF de 100 MB
 * eran dos copias enteras (~200 MB de pico y ~50 ms por operacion). La API de `Blob` de las herramientas sueltas sigue
 * ahi y da EXACTAMENTE los mismos bytes.
 */

/** Cuenta los `Blob` que se construyen con los bytes de un PDF por los caminos compartidos de `core` (guardar y envolver). */
const blobCalls = vi.hoisted(() => ({ savePdfToBlob: 0, pdfBytesToBlob: 0 }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    savePdfToBlob: (...args: Parameters<typeof actual.savePdfToBlob>) => {
      blobCalls.savePdfToBlob += 1;
      return actual.savePdfToBlob(...args);
    },
    pdfBytesToBlob: (...args: Parameters<typeof actual.pdfBytesToBlob>) => {
      blobCalls.pdfBytesToBlob += 1;
      return actual.pdfBytesToBlob(...args);
    },
  };
});

beforeEach(() => {
  blobCalls.savePdfToBlob = 0;
  blobCalls.pdfBytesToBlob = 0;
});

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

/** Tres PDF distintos: texto simple, con imagenes/streams grandes y rotado/de varios tamaños. */
async function corpus(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const plain = await makePdfBytes(3);
  const heavy = await PDFDocument.create();
  for (let i = 0; i < 4; i += 1) {
    const page = heavy.addPage([420, 595]);
    page.drawText(`Pesado ${i + 1}`, { x: 30, y: 540, size: 20 });
    const noise = new Uint8Array(40_000);
    for (let j = 0; j < noise.length; j += 1) noise[j] = (j * 31 + i * 17) & 255;
    const stream = heavy.context.stream(noise, { Type: "XObject", Subtype: "Image", Width: 200, Height: 200, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    const ref = heavy.context.register(stream);
    page.node.Resources()!.set(heavy.context.obj("XObject"), heavy.context.obj({ Im0: ref }));
  }
  const mixed = await PDFDocument.create();
  mixed.addPage([200, 300]).drawText("A", { x: 20, y: 250, size: 18 });
  mixed.addPage([612, 792]).drawText("B", { x: 20, y: 700, size: 18 });
  mixed.getPage(0).setRotation({ type: "degrees" as never, angle: 90 } as never);
  return [
    { name: "texto", bytes: plain },
    { name: "streams", bytes: new Uint8Array(await heavy.save()) },
    { name: "mixto", bytes: new Uint8Array(await mixed.save()) },
  ];
}

describe("core · savePdfToBytes / pdfBytesToBlob", () => {
  it("savePdfToBytes da EXACTAMENTE los bytes de savePdfToBlob (misma llamada a save)", async () => {
    const bytes = await makePdfBytes(3);
    const first = await PDFDocument.load(bytes);
    const second = await PDFDocument.load(bytes);
    const viaBytes = await savePdfToBytes(first);
    const viaBlob = await bytesOf(await savePdfToBlob(second));
    expect(viaBytes).toBeInstanceOf(Uint8Array);
    expect(same(viaBytes, viaBlob)).toBe(true);
  });

  it("pdfBytesToBlob envuelve los mismos bytes en un Blob application/pdf", async () => {
    const bytes = await makePdfBytes(1);
    const blob = pdfBytesToBlob(bytes);
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBe(bytes.byteLength);
    expect(same(await bytesOf(blob), bytes)).toBe(true);
  });
});

describe("cada motor: la variante de bytes y la de Blob dan los MISMOS bytes (3 PDF)", () => {
  it("girar, recortar, marca de agua, numerar, encabezado y pie", async () => {
    for (const { name, bytes } of await corpus()) {
      const file = () => asPdfFile(bytes);
      const checks: [string, Uint8Array, Blob][] = [
        ["rotar", await rotatePdfToBytes(file(), { base: 90 }), await rotatePdf(file(), { base: 90 })],
        [
          "recortar",
          await cropPdfToBytes(file(), { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, scope: "all", pageIndex: 0, fromPage: 1, toPage: 0 }),
          await cropPdf(file(), { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, scope: "all", pageIndex: 0, fromPage: 1, toPage: 0 }),
        ],
        [
          "marca de agua",
          await addWatermarkToBytes(file(), { ...DEFAULT_WATERMARK_OPTIONS, text: "BORRADOR" }),
          await addWatermark(file(), { ...DEFAULT_WATERMARK_OPTIONS, text: "BORRADOR" }),
        ],
        ["numerar", await addPageNumbersToBytes(file(), DEFAULT_PAGE_NUMBERS_OPTIONS), await addPageNumbers(file(), DEFAULT_PAGE_NUMBERS_OPTIONS)],
        [
          "encabezado y pie",
          await addHeaderFooterToBytes(file(), { ...DEFAULT_HEADER_FOOTER_OPTIONS, header: { left: "H", center: "", right: "" } }),
          await addHeaderFooter(file(), { ...DEFAULT_HEADER_FOOTER_OPTIONS, header: { left: "H", center: "", right: "" } }),
        ],
      ];
      for (const [label, viaBytes, viaBlob] of checks) {
        expect(viaBytes, `${name}/${label}`).toBeInstanceOf(Uint8Array);
        expect(same(viaBytes, await bytesOf(viaBlob)), `${name}/${label}: mismos bytes`).toBe(true);
      }
    }
  });

  it("proteger: mismo PDF cifrado (peso, paginas al abrirlo con la contraseña) y los mismos avisos", async () => {
    for (const { name, bytes } of await corpus()) {
      const options = { ...DEFAULT_PROTECT_OPTIONS, password: "secreto", confirm: "secreto", allowFillingForms: false };
      const viaBytes = await protectPdfToBytes(asPdfFile(bytes), options);
      const viaBlob = await protectPdf(asPdfFile(bytes), options);
      // El cifrado lleva azar (identificador del archivo y sales): dos cifrados del mismo PDF no son identicos byte a byte,
      // pero si de la misma longitud y se abren con la contraseña al mismo documento.
      const viaBlobBytes = await bytesOf(viaBlob);
      expect(viaBytes.bytes.byteLength, name).toBe(viaBlobBytes.byteLength);
      expect(viaBytes.appliedEncryptionRevision, name).toBe(viaBlob.appliedEncryptionRevision);
      expect(viaBytes.legacyRevisionIgnoredRestrictions, name).toBe(viaBlob.legacyRevisionIgnoredRestrictions);
      const original = await PDFDocument.load(bytes);
      for (const encrypted of [viaBytes.bytes, viaBlobBytes]) {
        await expect(PDFDocument.load(encrypted)).rejects.toThrow();
        const opened = await PDFDocument.load(encrypted, { password: "secreto" } as never);
        expect(opened.getPageCount(), name).toBe(original.getPageCount());
      }
    }
  });

  it("comprimir: los mismos bytes, o `null` (ya optimizado) donde la herramienta suelta devuelve el archivo de entrada", async () => {
    for (const { name, bytes } of await corpus()) {
      const input = asPdfFile(bytes);
      const viaBytes = await compressPdfToBytes(input, { level: "recommended", mode: "recompress" });
      const viaBlob = await compressPdf(input, { level: "recommended", mode: "recompress" });
      expect(viaBytes.alreadyOptimized, name).toBe(viaBlob.alreadyOptimized);
      expect(viaBytes.originalSize, name).toBe(viaBlob.originalSize);
      expect(viaBytes.compressedSize, name).toBe(viaBlob.compressedSize);
      expect(viaBytes.pages, name).toBe(viaBlob.pages);
      if (viaBytes.alreadyOptimized) {
        expect(viaBytes.bytes, name).toBeNull();
        expect(viaBlob.blob, name).toBe(input);
      } else {
        expect(same(viaBytes.bytes!, await bytesOf(viaBlob.blob)), name).toBe(true);
      }
    }
  });

  it("reparar: los mismos bytes y el mismo informe (incluido el peso de salida)", async () => {
    const damaged = (await makePdfBytes(2)).slice();
    // Un PDF sano (sin daños: se devuelve tal cual) y uno sin cola (daño real: se reconstruye).
    const truncated = damaged.subarray(0, damaged.byteLength - 40).slice();
    for (const [name, input] of [["sano", damaged], ["truncado", truncated]] as const) {
      const viaBytes = await repairPdfToBytes(asPdfFile(input));
      const viaBlob = await repairPdf(asPdfFile(input));
      expect(same(viaBytes.bytes, await bytesOf(viaBlob.blob)), name).toBe(true);
      expect(viaBytes.report, name).toEqual(viaBlob.report);
      expect(viaBytes.report.outputBytes, name).toBe(viaBytes.bytes.byteLength);
    }
  });

  it("desbloquear: los mismos bytes y la misma accion, con y sin cifrado", async () => {
    const plain = await makePdfBytes(2);
    const encrypted = await protectPdfToBytes(asPdfFile(plain), { ...DEFAULT_PROTECT_OPTIONS, password: "clave", confirm: "clave", requirePasswordToOpen: false, allowPrinting: false });
    for (const [name, input] of [["cifrado", encrypted.bytes], ["sin cifrado", plain]] as const) {
      const options = { password: "clave", acknowledgeSignatureInvalidation: true };
      const viaBytes = await removeProtectionToBytes(asPdfFile(input), options).catch((error: unknown) => error);
      const viaBlob = await removeProtection(asPdfFile(input), options).catch((error: unknown) => error);
      if (viaBytes instanceof Error || viaBlob instanceof Error) {
        // Sin cifrado ni restricciones no hay nada que quitar: los dos caminos fallan con el MISMO error tipado.
        expect(viaBytes instanceof Error, name).toBe(true);
        expect(viaBlob instanceof Error, name).toBe(true);
        expect((viaBytes as Error).message, name).toBe((viaBlob as Error).message);
        continue;
      }
      const a = viaBytes as { bytes: Uint8Array; action: string };
      const b = viaBlob as { blob: Blob; action: string };
      expect(a.action, name).toBe(b.action);
      expect(same(a.bytes, await bytesOf(b.blob)), name).toBe(true);
      // Y es el PDF GUARDADO sin cifrado (no la entrada devuelta tal cual): se abre sin contraseña y no es el archivo de entrada.
      expect(same(a.bytes, input), `${name}: no es la entrada`).toBe(false);
      await expect(PDFDocument.load(a.bytes), `${name}: se abre sin contraseña`).resolves.toBeDefined();
    }
  });
});

describe("las operaciones de PDF Pro no construyen ningun Blob de PDF (ni leen uno de vuelta)", () => {
  async function runAndCount<T>(operation: Parameters<typeof runOperation<T>>[0], bytes: Uint8Array, options: T) {
    const outcome = await runOperation(operation, bytes, options);
    expect(outcome.ok, operation.id).toBe(true);
    return outcome;
  }

  it("girar todo, girar, recortar, marca de agua, numerar, encabezado y pie, metadatos y reparar", async () => {
    const input = await makePdfBytes(3);
    const runs: [string, () => Promise<unknown>][] = [
      ["rotate-all", () => runAndCount(rotateAllOperation, input, undefined)],
      ["rotate", () => runAndCount(rotateOperation, input, { ...DEFAULT_PRO_ROTATE_OPTIONS, angle: 180 })],
      ["crop", () => runAndCount(cropOperation, input, DEFAULT_PRO_CROP_OPTIONS)],
      ["watermark", () => runAndCount(watermarkOperation, input, { ...DEFAULT_WATERMARK_OPTIONS, text: "X" })],
      ["page-numbers", () => runAndCount(pageNumbersOperation, input, DEFAULT_PAGE_NUMBERS_OPTIONS)],
      ["header-footer", () => runAndCount(headerFooterOperation, input, { ...DEFAULT_HEADER_FOOTER_OPTIONS, header: { left: "H", center: "", right: "" } })],
      [
        "metadata",
        () => runAndCount(metadataOperation, input, { mode: "set", form: { ...EMPTY_METADATA_FORM, title: "Titulo nuevo" }, original: null, keepXmp: false }),
      ],
      ["repair", () => runAndCount(repairOperation, input, undefined)],
    ];
    for (const [id, run] of runs) {
      blobCalls.savePdfToBlob = 0;
      blobCalls.pdfBytesToBlob = 0;
      await run();
      expect(blobCalls, `${id}: sin Blob`).toEqual({ savePdfToBlob: 0, pdfBytesToBlob: 0 });
    }
  });

  it("comprimir y quitar restricciones tampoco (aunque no cambien nada)", async () => {
    const input = await makePdfBytes(2);
    await runOperation(compressOperation, input, undefined);
    expect(blobCalls).toEqual({ savePdfToBlob: 0, pdfBytesToBlob: 0 });
    await runOperation(unlockOperation, input, { password: "", acknowledgeSignatureInvalidation: true, inspected: "restricted" });
    expect(blobCalls).toEqual({ savePdfToBlob: 0, pdfBytesToBlob: 0 });
  });

  it("«Guardar con contraseña» crea el Blob de la descarga UNA vez y los bytes salen del mismo resultado", async () => {
    const input = await makePdfBytes(2);
    const result = await buildProtectedExport(input, { ...DEFAULT_PROTECT_OPTIONS, password: "clave", confirm: "clave" });
    expect(blobCalls).toEqual({ savePdfToBlob: 0, pdfBytesToBlob: 1 });
    expect(same(result.bytes, await bytesOf(result.blob))).toBe(true);
  });

  it("ninguna operacion toca los bytes del snapshot de entrada (ni los modifica ni los deja transferidos), tampoco con el File sin copia", async () => {
    const plain = await makePdfBytes(3);
    const protectedPdf = (
      await protectPdfToBytes(asPdfFile(plain), { ...DEFAULT_PROTECT_OPTIONS, password: "clave", confirm: "clave", requirePasswordToOpen: false, allowPrinting: false })
    ).bytes;
    const truncated = plain.subarray(0, plain.byteLength - 40).slice();
    const cases: [string, Uint8Array, () => Promise<unknown>][] = [
      ["compress", plain, () => runOperation(compressOperation, plain, undefined)],
      ["repair sano", plain, () => runOperation(repairOperation, plain, undefined)],
      ["repair truncado", truncated, () => runOperation(repairOperation, truncated, undefined)],
      ["unlock cifrado", protectedPdf, () => runOperation(unlockOperation, protectedPdf, { password: "", acknowledgeSignatureInvalidation: true, inspected: "restricted" })],
      ["rotate-all", plain, () => runOperation(rotateAllOperation, plain, undefined)],
    ];
    for (const [name, input, run] of cases) {
      const before = input.slice();
      const length = input.byteLength;
      await run();
      expect(input.byteLength, `${name}: no se transfirio`).toBe(length);
      expect(same(input, before), `${name}: no se modifico`).toBe(true);
    }
  });

  it("la salida de la operacion es la misma que la de la herramienta suelta (mismos bytes de punta a punta)", async () => {
    const input = await makePdfBytes(3);
    const outcome = await runOperation(rotateAllOperation, input, undefined);
    if (!outcome.ok) throw new Error("fallo");
    const loose = await bytesOf(await rotatePdf(asPdfFile(input), { base: 90 }));
    expect(same(outcome.bytes, loose)).toBe(true);
  });
});
