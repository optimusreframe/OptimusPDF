import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

/**
 * Los 7 archivos malos de la Wave 6 (U1) mas el PDF bueno y el cifrado, como
 * `File` reales para las pruebas de entrada de cualquier herramienta. Se
 * construyen con pdf-lib (nada de bytes de mentira donde importa): el truncado
 * es un PDF valido cortado por la mitad, el cifrado se cifra de verdad.
 */

export const PDF_HEADER = "%PDF-1.7\n";

export async function buildGoodPdf(pages = 3): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([300, 400]);
    page.drawText(`Pagina ${index + 1}`, { x: 20, y: 200, size: 14, font });
  }
  return document.save();
}

export async function buildEncryptedPdf(
  userPassword: string,
  ownerPassword = "owner-secret",
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  document.encrypt({ userPassword, ownerPassword, permissions: {} });
  return document.save();
}

/** Bytes de relleno deterministas (no aleatorios: las pruebas no deben depender del azar). */
function filler(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131 + 17) & 0xff;
  return bytes;
}

const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

export function pdfFile(bytes: Uint8Array | string, name = "documento.pdf"): File {
  const part = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  return new File([part as BlobPart], name, { type: "application/pdf" });
}

/** Un `File` que declara `size` bytes sin reservarlos (la comprobacion de peso no lee el contenido). */
export function fileWithSize(
  size: number,
  name: string,
  head: string,
  type = "application/pdf",
): File {
  const file = new File([head], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

export type BadFileKind =
  | "garbage"
  | "truncated"
  | "empty"
  | "notPdf"
  | "encrypted"
  | "renamedPng"
  | "tooLarge";

/** El codigo que la interfaz tiene que mostrar para cada uno. */
export const EXPECTED_CODE: Record<BadFileKind, "corrupt" | "emptyFile" | "notPdf" | "encrypted" | "tooLarge"> = {
  garbage: "corrupt",
  truncated: "corrupt",
  empty: "emptyFile",
  notPdf: "notPdf",
  encrypted: "encrypted",
  renamedPng: "notPdf",
  tooLarge: "tooLarge",
};

export async function buildBadFile(kind: BadFileKind): Promise<File> {
  switch (kind) {
    case "garbage":
      return pdfFile(Uint8Array.from([...new TextEncoder().encode(PDF_HEADER), ...filler(4000)]), "basura.pdf");
    case "truncated": {
      const good = await buildGoodPdf(4);
      return pdfFile(good.subarray(0, Math.floor(good.length / 2)), "truncado.pdf");
    }
    case "empty":
      return pdfFile(new Uint8Array(0), "vacio.pdf");
    case "notPdf":
      return pdfFile("Esto es un texto plano con extension pdf.\n".repeat(20), "texto.pdf");
    case "encrypted":
      return pdfFile(await buildEncryptedPdf("abc"), "cifrado.pdf");
    case "renamedPng":
      return pdfFile(PNG_1X1, "imagen.pdf");
    case "tooLarge":
      return fileWithSize(101 * 1024 * 1024, "enorme.pdf", PDF_HEADER);
  }
}

export const BAD_FILE_KINDS: BadFileKind[] = [
  "garbage",
  "truncated",
  "empty",
  "notPdf",
  "encrypted",
  "renamedPng",
  "tooLarge",
];
