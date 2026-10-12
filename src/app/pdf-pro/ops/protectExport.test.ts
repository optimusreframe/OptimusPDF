import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { buildProtectedExport, protectedFileName } from "@/app/pdf-pro/ops/protectExport";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";
import { ProtectValidationError, type ProtectOptions } from "@/lib/pdf/protect";

/** `buildProtectedExport`: cifrar es una opcion de exportacion pura (bytes → bytes), validada como la herramienta suelta. */

const OPTS = (patch: Partial<ProtectOptions> = {}): ProtectOptions => ({ password: "secreto1", confirm: "secreto1", ...patch });

async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch {
    return true;
  }
}

describe("buildProtectedExport", () => {
  it("devuelve un PDF cifrado que se abre con la contraseña y no sin ella", async () => {
    const input = await makePdfBytes(2);
    const out = await buildProtectedExport(input, OPTS());
    expect(await isEncrypted(out.bytes)).toBe(true);
    const opened = await PDFDocument.load(out.bytes, { password: "secreto1", updateMetadata: false } as never);
    expect(opened.getPageCount()).toBe(2);
  });

  it("NO modifica los bytes de entrada (el documento de trabajo sigue sin cifrar)", async () => {
    const input = await makePdfBytes(2);
    const copy = input.slice();
    await buildProtectedExport(input, OPTS());
    expect(input).toEqual(copy);
    expect(await isEncrypted(input)).toBe(false);
  });

  it("el blob y los bytes son el mismo contenido", async () => {
    const out = await buildProtectedExport(await makePdfBytes(1), OPTS());
    expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(out.bytes);
    expect(out.blob.type).toBe("application/pdf");
  });

  it("informa de la revision de cifrado aplicada", async () => {
    const out = await buildProtectedExport(await makePdfBytes(1), OPTS());
    expect([2, 3, 4, 5]).toContain(out.appliedEncryptionRevision);
    expect(typeof out.legacyRevisionIgnoredRestrictions).toBe("boolean");
  });

  it("valida con las reglas de la herramienta suelta: vacia, corta, distinta", async () => {
    const input = await makePdfBytes(1);
    await expect(buildProtectedExport(input, OPTS({ password: "", confirm: "" }))).rejects.toMatchObject({ reason: "empty" });
    await expect(buildProtectedExport(input, OPTS({ password: "ab", confirm: "ab" }))).rejects.toMatchObject({ reason: "tooShort" });
    await expect(buildProtectedExport(input, OPTS({ confirm: "otra" }))).rejects.toMatchObject({ reason: "mismatch" });
    await expect(buildProtectedExport(input, OPTS({ password: "secreto1", confirm: "secreto1", requirePasswordToOpen: false }))).rejects.toBeInstanceOf(ProtectValidationError);
  });

  it("rechaza contraseñas fuera de Latin-1 ANTES de cifrar (€, emoji, chino)", async () => {
    const input = await makePdfBytes(1);
    for (const password of ["precio€uro", "clave😀x", "密码密码密码"]) {
      await expect(buildProtectedExport(input, OPTS({ password, confirm: password }))).rejects.toMatchObject({ reason: "unsupportedChars" });
    }
  });

  it("admite Latin-1 con acentos y eñes", async () => {
    const out = await buildProtectedExport(await makePdfBytes(1), OPTS({ password: "Año-ñandú", confirm: "Año-ñandú" }));
    expect(await isEncrypted(out.bytes)).toBe(true);
  });

  it("sin contraseña de apertura pero con permisos restringidos cifra igual (se abre sin pedir nada)", async () => {
    const out = await buildProtectedExport(await makePdfBytes(1), OPTS({ requirePasswordToOpen: false, allowCopying: false }));
    // Sin contraseña de usuario el PDF abre con la cadena vacia.
    const opened = await PDFDocument.load(out.bytes, { password: "", updateMetadata: false } as never);
    expect(opened.getPageCount()).toBe(1);
  });

  it("un archivo que no es PDF falla con error tipado (no un cifrado vacio)", async () => {
    await expect(buildProtectedExport(new Uint8Array([1, 2, 3]), OPTS())).rejects.toMatchObject({ name: "PdfError" });
  });

  it("informa del progreso", async () => {
    const seen: number[] = [];
    await buildProtectedExport(await makePdfBytes(1), OPTS(), (value) => seen.push(value));
    expect(seen.at(-1)).toBe(1);
  });
});

describe("protectedFileName", () => {
  it("usa el sufijo de la herramienta suelta en cada idioma", () => {
    expect(protectedFileName("informe.pdf", "es")).toBe("informe-protegido.pdf");
    expect(protectedFileName("informe.pdf", "en")).toBe("informe-protected.pdf");
  });
});
