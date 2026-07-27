import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
} from "@cantoo/pdf-lib";
import type { PDFContext } from "@cantoo/pdf-lib";
import {
  DEFAULT_UNLOCK_OPTIONS,
  UnlockError,
  inspectProtection,
  removeProtection,
  type UnlockOptions,
} from "@/lib/pdf/unlock";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` directamente en el
 * test, sin archivos externos. Cada `it` arma su propio documento en vez
 * de compartir uno via `beforeAll`: los objetos de pdf-lib son mutables, y
 * varias de estas pruebas mutan el documento a proposito (cifrado, borrado
 * de campos), asi que compartir instancias entre tests arriesgaria que un
 * test contaminara al siguiente.
 *
 * Se seleccionaron los ~17 casos de mayor valor de regresion de las 8
 * rondas de fix/revision documentadas en la cabecera de `unlock.ts`, uno
 * por cada rama de decision real del motor, priorizando calidad sobre
 * repetir los 40+ casos exactos usados durante la depuracion.
 */

const PERMS_KEY = PDFName.of("Perms");
const DOC_MDP_KEY = PDFName.of("DocMDP");
const ACRO_FORM_KEY = PDFName.of("AcroForm");
const SIG_FLAGS_KEY = PDFName.of("SigFlags");
const FIELDS_KEY = PDFName.of("Fields");
const KIDS_KEY = PDFName.of("Kids");
const FT_KEY = PDFName.of("FT");
const V_KEY = PDFName.of("V");
const PARENT_KEY = PDFName.of("Parent");
const LOCK_KEY = PDFName.of("Lock");
const ACTION_KEY = PDFName.of("Action");
const REFERENCE_KEY = PDFName.of("Reference");
const TRANSFORM_METHOD_KEY = PDFName.of("TransformMethod");
const FILTER_KEY = PDFName.of("Filter");
const TYPE_KEY = PDFName.of("Type");

/** Documento en blanco de una pagina, listo para que cada test lo mute a su gusto. */
async function createDocument(): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  return document;
}

/** Serializa el documento y lo envuelve como `File`, la entrada real de la API publica. */
async function toFile(document: PDFDocument, name = "test.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/** Relectura ESTRICTA (sin `ignoreEncryption`) de los bytes reales de salida, para postcondiciones. */
async function reloadStrict(blob: Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/**
 * Crea `/AcroForm` con un `/Fields` mutable y lo cuelga del catalogo.
 * Devuelve el propio array (objeto en memoria, no una copia) para que las
 * llamadas siguientes puedan seguir empujando campos dentro de el.
 */
function ensureAcroForm(document: PDFDocument): { acroForm: PDFDict; fields: PDFArray } {
  const context = document.context;
  const fields = PDFArray.withContext(context);
  const acroForm = PDFDict.withContext(context);
  acroForm.set(FIELDS_KEY, fields);
  document.catalog.set(ACRO_FORM_KEY, context.register(acroForm));
  return { acroForm, fields };
}

/** Diccionario de firma minimo; con `fieldMDP: true` añade una restriccion `/Reference` real. */
function makeSignatureDict(context: PDFContext, opts: { fieldMDP?: boolean } = {}): PDFRef {
  const sig = PDFDict.withContext(context);
  sig.set(TYPE_KEY, PDFName.of("Sig"));
  if (opts.fieldMDP) {
    const referenceDict = PDFDict.withContext(context);
    referenceDict.set(TRANSFORM_METHOD_KEY, PDFName.of("FieldMDP"));
    const references = PDFArray.withContext(context);
    references.push(context.register(referenceDict));
    sig.set(REFERENCE_KEY, references);
  }
  return context.register(sig);
}

describe("inspectProtection / removeProtection — src/lib/pdf/unlock.ts", () => {
  it("PDF sin proteccion alguna -> notProtected al intentar quitarla", async () => {
    const document = await createDocument();
    const file = await toFile(document);

    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("ready");
    if (inspection.kind === "ready") {
      expect(inspection.profile.encrypted).toBe(false);
      expect(inspection.profile.hasSignatureRestrictions).toBe(false);
    }

    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "notProtected",
    });
  });

  it("cifrado estandar con usuario vacio + propietario real + permisos restringidos -> passwordRemoved sin pedir nada", async () => {
    const document = await createDocument();
    document.encrypt({
      userPassword: "",
      ownerPassword: "owner-secret",
      permissions: {
        printing: false,
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: false,
        documentAssembly: false,
      },
    });
    const file = await toFile(document);

    const result = await removeProtection(file, DEFAULT_UNLOCK_OPTIONS);
    expect(result.action).toBe("passwordRemoved");

    const reloaded = await reloadStrict(result.blob);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("cifrado con contrasena de usuario real: password incorrecta -> wrongPassword", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "correcthorse", ownerPassword: "correcthorse" });
    const file = await toFile(document);

    await expect(
      inspectProtection(file, { password: "not-the-password" }),
    ).rejects.toMatchObject({ reason: "wrongPassword" });

    await expect(
      removeProtection(file, { password: "not-the-password" }),
    ).rejects.toMatchObject({ reason: "wrongPassword" });
  });

  it("cifrado con contrasena de usuario real: password correcta -> passwordRemoved", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "correcthorse", ownerPassword: "correcthorse" });
    const file = await toFile(document);

    // Sin password explicita, el intento automatico con "" falla: estado
    // normal "hace falta contrasena", no un error.
    const withoutPassword = await inspectProtection(file);
    expect(withoutPassword.kind).toBe("passwordRequired");

    const result = await removeProtection(file, { password: "correcthorse" });
    expect(result.action).toBe("passwordRemoved");
  });

  it("/Perms/DocMDP real sin cifrar, sin ack -> consentRequired", async () => {
    const document = await createDocument();
    const context = document.context;
    const perms = PDFDict.withContext(context);
    perms.set(DOC_MDP_KEY, context.register(PDFDict.withContext(context)));
    document.catalog.set(PERMS_KEY, context.register(perms));
    const file = await toFile(document);

    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("ready");
    if (inspection.kind === "ready") {
      expect(inspection.profile.hasDocMDPRestriction).toBe(true);
      expect(inspection.profile.hasSignatureRestrictions).toBe(true);
    }

    await expect(
      removeProtection(file, { password: "", acknowledgeSignatureInvalidation: false }),
    ).rejects.toMatchObject({ reason: "consentRequired" });
  });

  it("/Perms/DocMDP real sin cifrar, con ack -> signaturesInvalidated, y /Perms/DocMDP + SigFlags quedan limpios", async () => {
    const document = await createDocument();
    const context = document.context;
    const perms = PDFDict.withContext(context);
    perms.set(DOC_MDP_KEY, context.register(PDFDict.withContext(context)));
    document.catalog.set(PERMS_KEY, context.register(perms));
    const file = await toFile(document);

    const result = await removeProtection(file, {
      password: "",
      acknowledgeSignatureInvalidation: true,
    });
    expect(result.action).toBe("signaturesInvalidated");

    // Postcondicion sobre los bytes reales, releidos con carga estricta.
    const reloaded = await reloadStrict(result.blob);
    const reloadedPerms = reloaded.catalog.lookupMaybe(PERMS_KEY, PDFDict);
    expect(reloadedPerms).toBeUndefined();
    const reloadedAcroForm = reloaded.catalog.lookupMaybe(ACRO_FORM_KEY, PDFDict);
    if (reloadedAcroForm) {
      const sigFlags = reloadedAcroForm.lookupMaybe(SIG_FLAGS_KEY, PDFNumber);
      expect(sigFlags === undefined || sigFlags.asNumber() === 0).toBe(true);
    }
  });

  it("/Perms/DocMDP con valor null -> notProtected (no falso positivo)", async () => {
    const document = await createDocument();
    const context = document.context;
    const perms = PDFDict.withContext(context);
    perms.set(DOC_MDP_KEY, PDFNull);
    document.catalog.set(PERMS_KEY, context.register(perms));
    const file = await toFile(document);

    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("ready");
    if (inspection.kind === "ready") {
      expect(inspection.profile.hasDocMDPRestriction).toBe(false);
    }
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "notProtected",
    });
  });

  it("/Perms/DocMDP con referencia rota -> inspectionIncomplete (fallar cerrado, no falso negativo)", async () => {
    const document = await createDocument();
    const context = document.context;
    const perms = PDFDict.withContext(context);
    // Referencia a un objeto que nunca se registra: dangling ref.
    perms.set(DOC_MDP_KEY, PDFRef.of(99999, 0));
    document.catalog.set(PERMS_KEY, context.register(perms));
    const file = await toFile(document);

    await expect(inspectProtection(file)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
  });

  it("/Encrypt con filtro /Adobe.PubSec -> certificateEncryption", async () => {
    const document = await createDocument();
    const context = document.context;
    const encryptDict = PDFDict.withContext(context);
    encryptDict.set(FILTER_KEY, PDFName.of("Adobe.PubSec"));
    context.trailerInfo.Encrypt = context.register(encryptDict);
    const file = await toFile(document);

    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("unsupported");
    if (inspection.kind === "unsupported") {
      expect(inspection.encryption.securityHandler).toBe("/Adobe.PubSec");
    }
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "certificateEncryption",
    });
  });

  it("/Encrypt con filtro desconocido -> unsupportedSecurityHandler (no se inventa que es un certificado)", async () => {
    const document = await createDocument();
    const context = document.context;
    const encryptDict = PDFDict.withContext(context);
    encryptDict.set(FILTER_KEY, PDFName.of("Acme.WeirdSecurity"));
    context.trailerInfo.Encrypt = context.register(encryptDict);
    const file = await toFile(document);

    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("unsupported");
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "unsupportedSecurityHandler",
    });
  });

  it("campo /FT /Sig con /V activo pero SIN restriccion, sin cifrar -> sigue siendo notProtected (decision de producto)", async () => {
    const document = await createDocument();
    const context = document.context;
    const { fields } = ensureAcroForm(document);

    const field = PDFDict.withContext(context);
    field.set(FT_KEY, PDFName.of("Sig"));
    field.set(V_KEY, makeSignatureDict(context));
    fields.push(context.register(field));

    const file = await toFile(document);
    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("ready");
    if (inspection.kind === "ready") {
      expect(inspection.profile.hasActiveSignatures).toBe(true);
      expect(inspection.profile.hasSignatureRestrictions).toBe(false);
    }

    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "notProtected",
    });
  });

  it("el mismo campo firmado sin restriccion pero CIFRADO -> exige consentimiento por hasActiveSignatures", async () => {
    const document = await createDocument();
    const context = document.context;
    const { fields } = ensureAcroForm(document);

    const field = PDFDict.withContext(context);
    field.set(FT_KEY, PDFName.of("Sig"));
    field.set(V_KEY, makeSignatureDict(context));
    fields.push(context.register(field));

    document.encrypt({ userPassword: "", ownerPassword: "owner-secret" });
    const file = await toFile(document);

    // Identidad de consentimiento: sin el flag se lanza consentRequired...
    await expect(
      removeProtection(file, { password: "", acknowledgeSignatureInvalidation: false }),
    ).rejects.toMatchObject({ reason: "consentRequired" });

    // ...y con el flag explicito se completa.
    const result = await removeProtection(file, {
      password: "",
      acknowledgeSignatureInvalidation: true,
    });
    expect(result.action).toBe("passwordAndSignaturesInvalidated");
  });

  it("herencia de /FT y /V por /Parent: padre /FT /Sig no terminal, hijo real con /V + restriccion FieldMDP", async () => {
    const document = await createDocument();
    const context = document.context;
    const { fields } = ensureAcroForm(document);

    const parent = PDFDict.withContext(context);
    parent.set(FT_KEY, PDFName.of("Sig")); // padre tipado, no terminal
    const parentRef = context.register(parent);

    const kids = PDFArray.withContext(context);
    const child = PDFDict.withContext(context);
    // El hijo NO declara /FT propio: debe heredarlo ascendiendo por /Parent.
    child.set(PARENT_KEY, parentRef);
    child.set(V_KEY, makeSignatureDict(context, { fieldMDP: true }));
    const childRef = context.register(child);
    kids.push(childRef);
    parent.set(KIDS_KEY, kids);

    fields.push(parentRef);

    const file = await toFile(document);
    const inspection = await inspectProtection(file);
    expect(inspection.kind).toBe("ready");
    if (inspection.kind === "ready") {
      expect(inspection.profile.hasFieldMDPRestriction).toBe(true);
      expect(inspection.profile.hasSignatureRestrictions).toBe(true);
    }

    const result = await removeProtection(file, {
      password: "",
      acknowledgeSignatureInvalidation: true,
    });
    expect(result.action).toBe("signaturesInvalidated");

    const reloaded = await reloadStrict(result.blob);
    const reloadedAcroForm = reloaded.catalog.lookupMaybe(ACRO_FORM_KEY, PDFDict);
    const reloadedFields = reloadedAcroForm?.lookupMaybe(FIELDS_KEY, PDFArray);
    expect(reloadedFields === undefined || reloadedFields.size() === 0).toBe(true);
  });

  it("/Lock /Include con /Fields COMPLETAMENTE AUSENTE -> inspectionIncomplete", async () => {
    const document = await createDocument();
    const context = document.context;
    const { fields } = ensureAcroForm(document);

    const lock = PDFDict.withContext(context);
    lock.set(ACTION_KEY, PDFName.of("Include"));
    // /Fields deliberadamente ausente: obligatoria en el estandar para /Include.

    const field = PDFDict.withContext(context);
    field.set(FT_KEY, PDFName.of("Sig"));
    field.set(V_KEY, makeSignatureDict(context));
    field.set(LOCK_KEY, context.register(lock));
    fields.push(context.register(field));

    const file = await toFile(document);
    await expect(inspectProtection(file)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
  });

  it("/Lock /Exclude con /Fields roto (referencia colgante) -> inspectionIncomplete", async () => {
    const document = await createDocument();
    const context = document.context;
    const { fields } = ensureAcroForm(document);

    const lock = PDFDict.withContext(context);
    lock.set(ACTION_KEY, PDFName.of("Exclude"));
    lock.set(FIELDS_KEY, PDFRef.of(77777, 0)); // dangling ref, nunca registrada

    const field = PDFDict.withContext(context);
    field.set(FT_KEY, PDFName.of("Sig"));
    field.set(V_KEY, makeSignatureDict(context));
    field.set(LOCK_KEY, context.register(lock));
    fields.push(context.register(field));

    const file = await toFile(document);
    await expect(inspectProtection(file)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
    await expect(removeProtection(file, DEFAULT_UNLOCK_OPTIONS)).rejects.toMatchObject({
      reason: "inspectionIncomplete",
    });
  });

  it("identidad de consentimiento a nivel de removeProtection: sin acknowledgeSignatureInvalidation lanza, con el flag completa", async () => {
    const document = await createDocument();
    const context = document.context;
    const perms = PDFDict.withContext(context);
    perms.set(DOC_MDP_KEY, context.register(PDFDict.withContext(context)));
    document.catalog.set(PERMS_KEY, context.register(perms));
    const file = await toFile(document);

    const withoutAck: UnlockOptions = { password: "", acknowledgeSignatureInvalidation: false };
    await expect(removeProtection(file, withoutAck)).rejects.toBeInstanceOf(UnlockError);
    await expect(removeProtection(file, withoutAck)).rejects.toMatchObject({
      reason: "consentRequired",
    });

    const withAck: UnlockOptions = { password: "", acknowledgeSignatureInvalidation: true };
    await expect(removeProtection(file, withAck)).resolves.toMatchObject({
      action: "signaturesInvalidated",
    });
  });
});
