import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFNumber } from "@cantoo/pdf-lib";
import {
  MIN_PASSWORD_LENGTH,
  ProtectValidationError,
  protectPdf,
  unsupportedPasswordChars,
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
      [{ password: "clave€7", confirm: "clave€7" }, "unsupportedChars"],
    ];

    for (const [options, reason] of cases) {
      await expect(protectPdf(file, options)).rejects.toBeInstanceOf(ProtectValidationError);
      await expect(protectPdf(file, options)).rejects.toMatchObject({ reason });
    }
  });

  // Regresion (W6-D): con «€», chino o emoji `document.encrypt` lanzaba «Password contains one or more
  // invalid characters» y la interfaz lo mostraba como «El PDF esta protegido con contrasena».
  it("una contrasena con caracteres fuera de Latin-1 se rechaza ANTES de cifrar y senala los caracteres", async () => {
    expect(unsupportedPasswordChars("clave€7")).toEqual(["€"]);
    expect(unsupportedPasswordChars("密码1234😀😀")).toEqual(["密", "码", "😀"]);
    expect(unsupportedPasswordChars("contraseña-ñandú-ÿ")).toEqual([]);
    expect(validateProtectOptions({ password: "clave€7", confirm: "otra" })).toBe("unsupportedChars");

    const file = await toFile(await createDocument());
    const attempt = protectPdf(file, { password: "clave€7", confirm: "clave€7" });
    await expect(attempt).rejects.toBeInstanceOf(ProtectValidationError);
    await expect(attempt).rejects.toMatchObject({ reason: "unsupportedChars" });
  });

  it("las contrasenas Latin-1 con acentos si se cifran", async () => {
    const file = await toFile(await createDocument());
    const blob = await protectPdf(file, { password: "contraseña-ñandú", confirm: "contraseña-ñandú" });
    expect(blob.size).toBeGreaterThan(0);
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

/**
 * Crea un PDF cuya cabecera declara la version 1.3 en vez de la 1.7 por
 * defecto de `@cantoo/pdf-lib` (`PDFContext` la fija en el constructor,
 * ver `node_modules/@cantoo/pdf-lib/src/core/PDFContext.ts` linea 87).
 * "%PDF-1.7" y "%PDF-1.3" tienen la misma longitud (un solo digito de
 * major y minor), asi que basta con parchear esos bytes en el resultado
 * ya serializado: `PDFParser.parseHeader` lee el numero con
 * `parseRawInt`, sin exigir una longitud fija, asi que el resto del
 * archivo se sigue interpretando igual.
 */
async function toOldVersionFile(document: PDFDocument, name = "viejo.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  const patched = bytes.slice();
  const oldHeader = "%PDF-1.3";
  for (let index = 0; index < oldHeader.length; index += 1) {
    patched[index] = oldHeader.charCodeAt(index);
  }
  return new File([patched as unknown as BlobPart], name, { type: "application/pdf" });
}

/** Lee el `/R` (revision de cifrado) del `/Encrypt` de un PDF ya protegido, sin descifrar. */
async function readEncryptionRevision(blob: Blob): Promise<number | undefined> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const encryptRef = probe.context.trailerInfo.Encrypt;
  const encryptDict = probe.context.lookup(encryptRef, PDFDict);
  return encryptDict.lookupMaybe(PDFName.of("R"), PDFNumber)?.asNumber();
}

describe("protectPdf — permisos extendidos (imprimir/copiar/modificar/anotar/rellenar/ensamblar, contrasena opcional)", () => {
  it("sin tocar los campos nuevos, el /P sigue siendo exactamente el mismo que el comportamiento original", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const blob = await protectPdf(file, { password: "unaClaveSegura1", confirm: "unaClaveSegura1" });
    const bits = await readPermissionBits(blob);

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

    expect(bits).toBe(referenceBits);
    // Y el PDF (version 1.7 por defecto) aplica una revision moderna: no
    // hay categorias ignoradas.
    expect(blob.appliedEncryptionRevision).toBeGreaterThanOrEqual(3);
    expect(blob.legacyRevisionIgnoredRestrictions).toBe(false);
  });

  it("allowPrinting: false -> el /P resultante ya no trae el bit de impresion de alta resolucion", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const fullBlob = await protectPdf(file, {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
    });
    const restrictedBlob = await protectPdf(file, {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
      allowPrinting: false,
    });

    const fullBits = await readPermissionBits(fullBlob);
    const restrictedBits = await readPermissionBits(restrictedBlob);

    // Bit 3 (impresion, valor 0b100) presente en el permiso completo...
    expect((fullBits as number) & 0b100).not.toBe(0);
    // ...y ausente cuando se pide restringir impresion.
    expect((restrictedBits as number) & 0b100).toBe(0);
    expect(fullBits).not.toBe(restrictedBits);
  });

  it("requirePasswordToOpen: false + un permiso restringido -> el PDF abre SIN contrasena y el permiso restringido no esta en /P", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const blob = await protectPdf(file, {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
      requirePasswordToOpen: false,
      allowPrinting: false,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Abre sin pedir una contrasena de verdad: la cadena vacia basta
    // (mismo criterio que documenta `unlock.ts` para "no exige nada al
    // abrir"). Omitir `password` del todo, en cambio, lanza
    // `EncryptedPDFError` en pdf-lib sin importar que el userPassword
    // interno sea vacio -- por eso se pasa explicitamente `""`.
    const reopened = await PDFDocument.load(bytes, { password: "", updateMetadata: false });
    expect(reopened.getPageCount()).toBe(1);

    const bits = await readPermissionBits(blob);
    expect((bits as number) & 0b100).toBe(0);
  });

  it("requirePasswordToOpen: false + todos los permisos concedidos -> ProtectValidationError('nothingToDo'), no cifra nada", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const options: ProtectOptions = {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
      requirePasswordToOpen: false,
    };

    expect(validateProtectOptions(options)).toBe("nothingToDo");
    await expect(protectPdf(file, options)).rejects.toBeInstanceOf(ProtectValidationError);
    await expect(protectPdf(file, options)).rejects.toMatchObject({ reason: "nothingToDo" });
  });

  it("PDF con cabecera 1.3 + fillingForms/documentAssembly restringidos -> revision R=2 detectada y la restriccion no tiene efecto real", async () => {
    const document = await createDocument();

    const oldFileGranted = await toOldVersionFile(document, "viejo-concedido.pdf");
    const oldFileRestricted = await toOldVersionFile(document, "viejo-restringido.pdf");

    const grantedBlob = await protectPdf(oldFileGranted, {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
      allowFillingForms: true,
      allowDocumentAssembly: true,
    });
    const restrictedBlob = await protectPdf(oldFileRestricted, {
      password: "unaClaveSegura1",
      confirm: "unaClaveSegura1",
      allowFillingForms: false,
      allowDocumentAssembly: false,
    });

    // La revision aplicada depende de la version de ENTRADA (1.3), no de
    // lo que pida el usuario: en ambos casos cae a R=2.
    expect(await readEncryptionRevision(grantedBlob)).toBe(2);
    expect(await readEncryptionRevision(restrictedBlob)).toBe(2);
    expect(grantedBlob.appliedEncryptionRevision).toBe(2);
    expect(restrictedBlob.appliedEncryptionRevision).toBe(2);

    // El motor lo comunica honestamente...
    expect(grantedBlob.legacyRevisionIgnoredRestrictions).toBe(false);
    expect(restrictedBlob.legacyRevisionIgnoredRestrictions).toBe(true);

    // ...y el /P resultante lo confirma: en R=2 los bits de fillingForms y
    // documentAssembly no existen en absoluto, asi que restringirlos no
    // cambia nada del /P frente a concederlos.
    const grantedBits = await readPermissionBits(grantedBlob);
    const restrictedBits = await readPermissionBits(restrictedBlob);
    expect(grantedBits).toBe(restrictedBits);
  });
});
