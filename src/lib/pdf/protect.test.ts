import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFNumber } from "@cantoo/pdf-lib";
import {
  MIN_PASSWORD_LENGTH,
  ProtectValidationError,
  protectPdf,
  validateProtectOptions,
  type ProtectOptions,
} from "@/lib/pdf/protect";

/**
 * Fixtures reales, construidas en el propio test con `@cantoo/pdf-lib`
 * (misma convencion que `unlock.test.ts`: sin archivos externos, cada
 * `it` arma su propio documento).
 */
async function createDocument(): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  return document;
}

async function toFile(document: PDFDocument, name = "plain.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/** Lee el `/P` (bits de permisos) del `/Encrypt` de un PDF ya protegido, sin descifrar. */
async function readPermissionBits(blob: Blob): Promise<number | undefined> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const encryptRef = probe.context.trailerInfo.Encrypt;
  const encryptDict = probe.context.lookup(encryptRef, PDFDict);
  return encryptDict.lookupMaybe(PDFName.of("P"), PDFNumber)?.asNumber();
}

describe("protectPdf / validateProtectOptions — src/lib/pdf/protect.ts", () => {
  it("proteger con contrasena valida produce un PDF que NO abre sin contrasena", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const blob = await protectPdf(file, { password: "unaClaveSegura1", confirm: "unaClaveSegura1" });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    await expect(PDFDocument.load(bytes, { updateMetadata: false })).rejects.toThrow();
  });

  it("proteger con contrasena valida produce un PDF que SI abre con la contrasena correcta", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const blob = await protectPdf(file, { password: "unaClaveSegura1", confirm: "unaClaveSegura1" });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const reopened = await PDFDocument.load(bytes, {
      password: "unaClaveSegura1",
      updateMetadata: false,
    });
    expect(reopened.getPageCount()).toBe(1);
  });

  it("validateProtectOptions: contrasena vacia -> 'empty'", () => {
    expect(validateProtectOptions({ password: "", confirm: "" })).toBe("empty");
  });

  it("validateProtectOptions: contrasena mas corta que MIN_PASSWORD_LENGTH -> 'tooShort'", () => {
    const short = "a".repeat(Math.max(0, MIN_PASSWORD_LENGTH - 1));
    expect(validateProtectOptions({ password: short, confirm: short })).toBe("tooShort");
  });

  it("validateProtectOptions: contrasena y confirmacion no coinciden -> 'mismatch'", () => {
    expect(
      validateProtectOptions({ password: "unaClaveSegura1", confirm: "otraClaveDistinta" }),
    ).toBe("mismatch");
  });

  it("validateProtectOptions: contrasena valida y confirmada -> null (sin fallo)", () => {
    expect(
      validateProtectOptions({ password: "unaClaveSegura1", confirm: "unaClaveSegura1" }),
    ).toBeNull();
  });

  it("protectPdf lanza ProtectValidationError con el motivo exacto para cada formulario invalido", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const cases: Array<[ProtectOptions, string]> = [
      [{ password: "", confirm: "" }, "empty"],
      [{ password: "ab", confirm: "ab" }, "tooShort"],
      [{ password: "unaClaveSegura1", confirm: "otra" }, "mismatch"],
    ];

    for (const [options, reason] of cases) {
      await expect(protectPdf(file, options)).rejects.toBeInstanceOf(ProtectValidationError);
      await expect(protectPdf(file, options)).rejects.toMatchObject({ reason });
    }
  });

  it("intentar proteger un PDF ya cifrado da un error apropiado (no lo protege dos veces en silencio)", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "yaProtegido1", ownerPassword: "yaProtegido1" });
    const alreadyProtected = await toFile(document, "ya-protegido.pdf");

    await expect(
      protectPdf(alreadyProtected, { password: "otraClaveNueva1", confirm: "otraClaveNueva1" }),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("concede permisos completos (equivalentes a FULL_PERMISSIONS): /P coincide con un cifrado sin restricciones", async () => {
    const document = await createDocument();
    const file = await toFile(document);
    const blob = await protectPdf(file, { password: "unaClaveSegura1", confirm: "unaClaveSegura1" });
    const protectedBits = await readPermissionBits(blob);

    // Documento de referencia cifrado a mano con el mismo conjunto de
    // permisos "todo concedido" que documenta el comentario de
    // `FULL_PERMISSIONS` en protect.ts. El valor de /P es una funcion pura
    // del objeto de permisos (no de la contrasena ni del contenido), asi
    // que coincidir aqui confirma por comportamiento -sin importar
    // `FULL_PERMISSIONS`, que no se exporta- que protectPdf no restringe
    // nada.
    const reference = await createDocument();
    reference.encrypt({
      userPassword: "cualquier-cosa1",
      ownerPassword: "cualquier-cosa1",
      permissions: {
        printing: "highResolution",
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      },
    });
    const referenceBlob = await toFile(reference);
    const referenceBits = await readPermissionBits(referenceBlob);

    expect(protectedBits).toBe(referenceBits);

    // Y se distingue de verdad de un cifrado que SI restringe (el que
    // resulta de no pasar `permissions`, que la libreria pone a cero segun
    // el propio comentario del motor).
    const restricted = await createDocument();
    restricted.encrypt({ userPassword: "cualquier-cosa1", ownerPassword: "cualquier-cosa1" });
    const restrictedBlob = await toFile(restricted);
    const restrictedBits = await readPermissionBits(restrictedBlob);

    expect(protectedBits).not.toBe(restrictedBits);
  });
});
