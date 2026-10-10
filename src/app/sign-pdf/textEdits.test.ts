import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import {
  MAX_SIGN_TEXT_EDITS,
  applyEditsToFile,
  effectiveTextEdits,
  hasTextEdits,
  sanitizeTextEdits,
  stampKeyOf,
  textEditsKey,
} from "@/app/sign-pdf/textEdits";
import {
  captureStamp,
  isSignerComplete,
  pendingSigners,
  validCapture,
} from "@/app/sign-pdf/captures";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Texto original editado dentro de Firmar (W6-A): validacion de borradores, la
 * huella que ata las capturas de firma al contenido editado y la aplicacion de
 * las ediciones al PDF.
 */

const A = makeEdit({ id: "e1", blockId: "p0-b0", text: "Hola" });
const B = makeEdit({ id: "e2", blockId: "p0-b1", text: "Adios", box: { x: 50, y: 600, width: 100, height: 14 } });

async function pdfWith(text: string): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText(text, { x: 50, y: 250, size: 12, font });
  const bytes = await doc.save();
  return new File([bytes as BlobPart], "doc.pdf", { type: "application/pdf", lastModified: 1_700_000_000_000 });
}

async function textOf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
  } finally {
    await task.destroy();
  }
}

describe("sanitizeTextEdits — lo que viene de un borrador", () => {
  it("conserva ediciones validas y descarta lo invalido sin lanzar", () => {
    const out = sanitizeTextEdits([A, { id: 5 }, null, "x", { ...B, box: { x: Number.NaN, y: 1, width: 1, height: 1 } }, B]);
    expect(out.map((edit) => edit.id)).toEqual(["e1", "e2"]);
  });

  it("un valor que no es lista da lista vacia", () => {
    expect(sanitizeTextEdits(undefined)).toEqual([]);
    expect(sanitizeTextEdits({})).toEqual([]);
    expect(sanitizeTextEdits("[]")).toEqual([]);
  });

  it("descarta ids repetidos (un borrador corrupto no duplica una edicion)", () => {
    expect(sanitizeTextEdits([A, { ...A, text: "otra" }])).toHaveLength(1);
  });

  it("respeta el tope por documento", () => {
    const many = Array.from({ length: MAX_SIGN_TEXT_EDITS + 50 }, (_, i) => makeEdit({ id: `x${i}`, blockId: `b${i}` }));
    expect(sanitizeTextEdits(many)).toHaveLength(MAX_SIGN_TEXT_EDITS);
  });
});

describe("effectiveTextEdits / hasTextEdits", () => {
  it("un bloque reemplazado cuenta aunque quede vacio (borra el original); un texto propio vacio no", () => {
    const deleted = makeEdit({ id: "d", blockId: "p0-b3", text: "" });
    const emptyOwn = makeEdit({ id: "o", text: "   " });
    expect(effectiveTextEdits([deleted, emptyOwn, A])).toEqual([deleted, A]);
    expect(hasTextEdits([emptyOwn])).toBe(false);
    expect(hasTextEdits([deleted])).toBe(true);
    expect(hasTextEdits(undefined)).toBe(false);
    expect(hasTextEdits([])).toBe(false);
  });
});

describe("huella de las ediciones (textEditsKey / stampKeyOf)", () => {
  it("sin ediciones la huella de sellado ES la del archivo, tal cual (no toca la carrera de huellas)", () => {
    expect(stampKeyOf("abc123", undefined)).toBe("abc123");
    expect(stampKeyOf("abc123", [])).toBe("abc123");
    expect(stampKeyOf("abc123", [makeEdit({ id: "o", text: " " })])).toBe("abc123");
  });

  it("sin huella de archivo (aun calculandose) se queda como esta: null o vacia", () => {
    expect(stampKeyOf(null, [A])).toBeNull();
    expect(stampKeyOf("", [A])).toBe("");
    expect(stampKeyOf(undefined, [A])).toBeUndefined();
  });

  it("con ediciones suma una huella estable del contenido", () => {
    const key = stampKeyOf("abc123", [A, B]) as string;
    expect(key.startsWith("abc123+t")).toBe(true);
    expect(stampKeyOf("abc123", [A, B])).toBe(key);
  });

  it("cambiar el texto, la posicion o el estilo cambia la huella", () => {
    const base = textEditsKey([A]);
    expect(textEditsKey([{ ...A, text: "Hola!" }])).not.toBe(base);
    expect(textEditsKey([{ ...A, box: { ...A.box, x: A.box.x + 1 } }])).not.toBe(base);
    expect(textEditsKey([{ ...A, bold: true }])).not.toBe(base);
    expect(textEditsKey([A, B])).not.toBe(base);
  });

  it("no depende del orden de las claves del objeto (un borrador restaurado da la misma huella)", () => {
    const shuffled = {
      cover: A.cover,
      rotation: A.rotation,
      italic: A.italic,
      bold: A.bold,
      fontKey: A.fontKey,
      align: A.align,
      color: A.color,
      fontSize: A.fontSize,
      text: A.text,
      box: { height: A.box.height, width: A.box.width, y: A.box.y, x: A.box.x },
      pageIndex: A.pageIndex,
      blockId: A.blockId,
      id: A.id,
    };
    expect(textEditsKey([shuffled as typeof A])).toBe(textEditsKey([A]));
    // Y el JSON de ida y vuelta (borrador en IndexedDB) tampoco la cambia.
    expect(textEditsKey(JSON.parse(JSON.stringify([A])))).toBe(textEditsKey([A]));
  });

  it("el orden de las ediciones SI cuenta (se dibujan en ese orden)", () => {
    expect(textEditsKey([A, B])).not.toBe(textEditsKey([B, A]));
  });
});

describe("las capturas de firma se invalidan si cambia el texto editado", () => {
  const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
  const FIELD: SignatureField = {
    id: "f1",
    signerId: "sg-1",
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.08 },
  };
  const draft = { dataUrl: "data:image/png;base64,AA==", ratio: 0.3 };

  function capturedWith(edits: Parameters<typeof stampKeyOf>[1]) {
    const key = stampKeyOf("filehash", edits) as string;
    return {
      [ANA.id]: { signature: draft, initials: null, stamp: captureStamp(key, [FIELD], ANA.id) },
    };
  }

  it("una firma hecha sobre el documento SIN editar sigue valiendo mientras no se edite", () => {
    const captures = capturedWith(undefined);
    expect(isSignerComplete([FIELD], captures, ANA.id, stampKeyOf("filehash", []) as string)).toBe(true);
  });

  it("editar un texto DESPUES de firmar invalida la captura: el firmante tiene que volver a firmar", () => {
    const captures = capturedWith(undefined);
    const afterEdit = stampKeyOf("filehash", [A]) as string;
    expect(validCapture(captures, [FIELD], ANA.id, afterEdit).signature).toBeNull();
    expect(pendingSigners([ANA], [FIELD], captures, afterEdit)).toHaveLength(1);
  });

  it("una firma hecha sobre el documento ya editado vale con esas ediciones y deja de valer si cambian", () => {
    const captures = capturedWith([A]);
    expect(validCapture(captures, [FIELD], ANA.id, stampKeyOf("filehash", [A]) as string).signature).toEqual(draft);
    expect(validCapture(captures, [FIELD], ANA.id, stampKeyOf("filehash", [{ ...A, text: "Otro" }]) as string).signature).toBeNull();
    // Deshacer la edicion tambien cambia lo que firmo el firmante.
    expect(validCapture(captures, [FIELD], ANA.id, stampKeyOf("filehash", []) as string).signature).toBeNull();
  });
});

describe("applyEditsToFile — se aplican ANTES de estampar firmas", () => {
  it("sin ediciones devuelve el MISMO archivo, sin leerlo ni reescribirlo", async () => {
    const file = await pdfWith("Original");
    const result = await applyEditsToFile(file, undefined);
    expect(result.file).toBe(file);
    expect((await applyEditsToFile(file, [])).file).toBe(file);
  });

  it("con ediciones devuelve un PDF nuevo con el texto editado (mismo nombre y fecha)", async () => {
    const file = await pdfWith("Original");
    const edit = makeEdit({
      id: "e1",
      text: "Reemplazo",
      box: { x: 50, y: 245, width: 200, height: 16 },
      cover: { color: "#ffffff", padding: 1 },
    });
    const { file: edited, warnings } = await applyEditsToFile(file, [edit]);
    expect(edited).not.toBe(file);
    expect(edited.name).toBe("doc.pdf");
    expect(edited.lastModified).toBe(file.lastModified);
    expect(await textOf(edited)).toContain("Reemplazo");
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("el original no se muta: el archivo de partida sigue siendo el de partida", async () => {
    const file = await pdfWith("Original");
    const before = new Uint8Array(await file.arrayBuffer());
    await applyEditsToFile(file, [makeEdit({ id: "e1", text: "Nuevo", box: { x: 50, y: 245, width: 200, height: 16 } })]);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(before);
  });

  it("informa del progreso", async () => {
    const file = await pdfWith("Original");
    const steps: number[] = [];
    await applyEditsToFile(file, [makeEdit({ id: "e1", text: "Nuevo", box: { x: 50, y: 245, width: 200, height: 16 } })], {
      onProgress: (value) => steps.push(value),
    });
    expect(steps[steps.length - 1]).toBe(1);
  });
});
