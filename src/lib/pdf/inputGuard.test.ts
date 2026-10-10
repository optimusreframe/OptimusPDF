import { describe, expect, it } from "vitest";
import { loadPdf, toPdfError, PdfError } from "@/lib/pdf/core";
import {
  createInputGuard,
  decryptInputCopy,
  isDecryptedCopy,
  markDecryptedCopy,
} from "@/lib/pdf/inputGuard";
import {
  BAD_FILE_KINDS,
  EXPECTED_CODE,
  buildBadFile,
  buildEncryptedPdf,
  buildGoodPdf,
  fileWithSize,
  pdfFile,
} from "@/lib/pdf/testing/inputFixtures";

/**
 * `inputGuard` (Wave 6 · U1/U3) con ARCHIVOS REALES: PDF danados de verdad,
 * cifrado de verdad. El "abrir el documento" del navegador (pdf.js) se sustituye
 * por el cargador de pdf-lib, que en Node rechaza exactamente los mismos archivos
 * rotos; la inspeccion de cifrado es la real del motor de Desbloquear.
 */

/** Abre como lo hacen los motores: cargar Y leer las paginas (basura con cabecera carga pero no tiene paginas). */
async function strictOpen(file: File): Promise<void> {
  (await loadPdf(file)).getPageCount();
}

const guard = createInputGuard({ open: strictOpen });

describe("inputGuard — los 7 archivos malos", () => {
  for (const kind of BAD_FILE_KINDS) {
    it(`${kind}: se reconoce al subirlo`, async () => {
      const result = await guard(await buildBadFile(kind));
      const expected = EXPECTED_CODE[kind];
      if (expected === "encrypted") {
        expect(result).toEqual({ status: "encrypted", needsPassword: true });
      } else {
        expect(result).toEqual({ status: "problem", code: expected });
      }
    });
  }

  it("un PDF bueno pasa", async () => {
    expect(await guard(pdfFile(await buildGoodPdf(), "bueno.pdf"))).toEqual({ status: "ok" });
  });

  it("un archivo que no es PDF (imagen) en una herramienta de imagen solo se mira por vacio y peso", async () => {
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], "foto.jpg", { type: "image/jpeg" });
    expect(await guard(photo)).toEqual({ status: "ok" });
    const empty = new File([], "foto.jpg", { type: "image/jpeg" });
    expect(await guard(empty)).toEqual({ status: "problem", code: "emptyFile" });
  });

  it("un .docx de mas de 100 MB avisa de peso, sin pretender que sea un PDF", async () => {
    const huge = fileWithSize(101 * 1024 * 1024, "informe.docx", "PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await guard(huge)).toEqual({ status: "problem", code: "tooLarge" });
  });

  it("la cabecera %PDF- puede ir tras algo de basura en el primer kilobyte", async () => {
    const good = await buildGoodPdf(1);
    const prefixed = new Uint8Array([...new TextEncoder().encode("basura previa\n"), ...good]);
    expect(await createInputGuard({ open: async () => {} })(pdfFile(prefixed))).toEqual({ status: "ok" });
  });

  it("sin %PDF- en el primer kilobyte NO es un PDF aunque lo diga mas adelante", async () => {
    const late = new Uint8Array(2000).fill(0x20);
    late.set(new TextEncoder().encode("%PDF-1.4"), 1500);
    expect(await guard(pdfFile(late))).toEqual({ status: "problem", code: "notPdf" });
  });

  it("una extension .PDF en mayusculas y un tipo vacio se tratan como PDF", async () => {
    const file = new File(["texto"], "ARCHIVO.PDF");
    expect(await guard(file)).toEqual({ status: "problem", code: "notPdf" });
  });

  it("si abrir el documento falla con un error raro, es danado (nunca 'desconocido')", async () => {
    const weird = createInputGuard({
      open: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'Pages')");
      },
    });
    expect(await weird(pdfFile(await buildGoodPdf()))).toEqual({ status: "problem", code: "corrupt" });
  });

  it("por encima del limite de apertura profunda no se abre el documento (solo cabecera y cola)", async () => {
    let opened = false;
    const lazy = createInputGuard({
      open: async () => {
        opened = true;
      },
    });
    const big = fileWithSize(60 * 1024 * 1024, "grande.pdf", "%PDF-1.4\n");
    expect(await lazy(big)).toEqual({ status: "ok" });
    expect(opened).toBe(false);
  });
});

describe("inputGuard — cifrado", () => {
  it("con contrasena de apertura: pide contrasena", async () => {
    const file = pdfFile(await buildEncryptedPdf("secreta"), "protegido.pdf");
    expect(await guard(file)).toEqual({ status: "encrypted", needsPassword: true });
  });

  it("solo restringe permisos (contrasena de apertura vacia): se abre sin pedir nada", async () => {
    const file = pdfFile(await buildEncryptedPdf(""), "permisos.pdf");
    // pdf.js (y este cargador) lo abren con la contrasena vacia: no es un fallo de apertura.
    const lenient = createInputGuard({ open: async () => {} });
    expect(await lenient(file)).toEqual({ status: "encrypted", needsPassword: false });
  });

  it("el texto «/Encrypt» dentro del contenido de un PDF sin cifrar no lo marca como cifrado", async () => {
    const good = await buildGoodPdf(1);
    const noisy = new Uint8Array([...good, ...new TextEncoder().encode("\n% /Encrypt (no es un cifrado)\n")]);
    const lenient = createInputGuard({ open: async () => {} });
    expect(await lenient(pdfFile(noisy))).toEqual({ status: "ok" });
  });
});

describe("decryptInputCopy — copia sin contrasena", () => {
  it("contrasena mala: wrongPassword y no se crea ninguna copia", async () => {
    const file = pdfFile(await buildEncryptedPdf("secreta"));
    expect(await decryptInputCopy(file, "otra")).toEqual({ status: "wrongPassword" });
  });

  it("contrasena buena: copia legible SIN contrasena, marcada como descifrada, original intacto", async () => {
    const original = await buildEncryptedPdf("secreta");
    const file = pdfFile(original, "protegido.pdf");
    const attempt = await decryptInputCopy(file, "secreta");
    expect(attempt.status).toBe("ok");
    if (attempt.status !== "ok") return;
    expect(attempt.file).not.toBe(file);
    expect(attempt.file.name).toBe("protegido.pdf");
    expect(isDecryptedCopy(attempt.file)).toBe(true);
    expect(isDecryptedCopy(file)).toBe(false);
    // Se abre sin contrasena...
    const reopened = await loadPdf(attempt.file);
    expect(reopened.getPageCount()).toBe(1);
    // ...y el original sigue cifrado.
    await expect(loadPdf(file)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("contrasena vacia sobre un PDF de solo permisos: copia sin restricciones", async () => {
    const file = pdfFile(await buildEncryptedPdf(""));
    const attempt = await decryptInputCopy(file, "");
    expect(attempt.status).toBe("ok");
  });

  it("una copia de un PDF que no estaba cifrado se devuelve tal cual", async () => {
    const file = pdfFile(await buildGoodPdf(2));
    const attempt = await decryptInputCopy(file, "");
    expect(attempt.status).toBe("ok");
    if (attempt.status !== "ok") return;
    expect((await loadPdf(attempt.file)).getPageCount()).toBe(2);
  });

  it("un archivo que no es PDF falla con un codigo de archivo (no 'wrongPassword')", async () => {
    const attempt = await decryptInputCopy(pdfFile("hola", "texto.pdf"), "x");
    expect(attempt.status).toBe("failed");
  });

  it("marcar y consultar copias descifradas funciona por identidad de File", () => {
    const a = pdfFile("a");
    const b = pdfFile("a");
    markDecryptedCopy(a);
    expect(isDecryptedCopy(a)).toBe(true);
    expect(isDecryptedCopy(b)).toBe(false);
  });
});

describe("toPdfError — los errores reales de las librerias", () => {
  async function loadError(kind: (typeof BAD_FILE_KINDS)[number]): Promise<unknown> {
    try {
      await strictOpen(await buildBadFile(kind));
    } catch (error) {
      return toPdfError(error);
    }
    throw new Error("se esperaba un error");
  }

  it("basura tras una cabecera valida (TypeError de pdf-lib) es 'corrupt', no 'unknown'", async () => {
    const error = await loadError("garbage");
    expect(error).toBeInstanceOf(PdfError);
    expect((error as PdfError).code).toBe("corrupt");
  });

  it("un PDF truncado es 'corrupt'", async () => {
    expect(((await loadError("truncated")) as PdfError).code).toBe("corrupt");
  });

  it("un archivo vacio es 'corrupt' en el motor (el shell lo afina a 'emptyFile' mirando el archivo)", async () => {
    expect(((await loadError("empty")) as PdfError).code).toBe("corrupt");
  });

  it("texto y PNG renombrados son 'corrupt' en el motor", async () => {
    expect(((await loadError("notPdf")) as PdfError).code).toBe("corrupt");
    expect(((await loadError("renamedPng")) as PdfError).code).toBe("corrupt");
  });

  it("un PDF cifrado es 'encrypted'", async () => {
    expect(((await loadError("encrypted")) as PdfError).code).toBe("encrypted");
  });

  it.each([
    ["PDFInvalidObjectParsingError", "Failed to parse invalid PDF object"],
    ["Error", "Invalid object ref: 12 0 R"],
    ["UnexpectedObjectError", "Expected instance of PDFDict, but got instance of undefined"],
    ["InvalidPDFException", "Invalid PDF structure."],
    ["FormatError", "Bad xref entry"],
    ["MissingPDFHeaderError", "No PDF header found"],
  ])("%s: «%s» es 'corrupt'", (name, message) => {
    const error = new Error(message);
    error.name = name;
    expect(toPdfError(error).code).toBe("corrupt");
  });

  it.each([
    "Array buffer allocation failed",
    "Invalid array length",
    "out of memory",
  ])("un fallo de memoria («%s») es 'tooLarge'", (message) => {
    expect(toPdfError(new RangeError(message)).code).toBe("tooLarge");
  });

  it("un error cualquiera sigue siendo 'unknown' como ultimo recurso", () => {
    expect(toPdfError(new Error("algo inesperado")).code).toBe("unknown");
  });

  it("PasswordException de pdf.js es 'encrypted'", () => {
    const error = new Error("No password given");
    error.name = "PasswordException";
    expect(toPdfError(error).code).toBe("encrypted");
  });
});
