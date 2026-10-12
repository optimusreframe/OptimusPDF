import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { getPdfjsLegacy, STANDARD_FONTS_DIR } from "@/lib/pdf/editRenderTestUtils";
import {
  SIGNATURE_MAX_OPS,
  SignatureMemo,
  digestOperatorList,
  normalizeObjectName,
  pageSignature,
  snapshotScopedSignature,
} from "@/app/pdf-pro/viewer/pageSignature";

type Sig = Parameters<typeof pageSignature>[0];

async function pdfWith(
  pages: { text: string; rotate?: number; crop?: boolean; rect?: boolean }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([300, 400]);
    page.drawText(spec.text, { x: 30, y: 300, size: 24, font });
    if (spec.rect) page.drawRectangle({ x: 20, y: 20, width: 100, height: 50, color: rgb(1, 0, 0) });
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.crop) page.setCropBox(10, 10, 200, 300);
  }
  return doc.save();
}

async function signaturesOf(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await getPdfjsLegacy();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_DIR, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      out.push(await pageSignature(page as unknown as Sig, `fallback:${i}`));
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

describe("normalizeObjectName", () => {
  it("quita el contador de documentos y el orden de carga de las fuentes", () => {
    expect(normalizeObjectName("g_d0_f1")).toBe("f");
    expect(normalizeObjectName("g_d7_f12")).toBe("f");
    expect(normalizeObjectName("g_d3_img_p0_1")).toBe("img_p0_1");
  });

  it("deja igual lo que no es un objeto comun", () => {
    expect(normalizeObjectName("#000000")).toBe("#000000");
    expect(normalizeObjectName("f1")).toBe("f1");
    expect(normalizeObjectName("g_other")).toBe("g_other");
  });
});

describe("digestOperatorList", () => {
  const list = (fns: number[], args: unknown[] = fns.map(() => null)) => ({ fnArray: fns, argsArray: args });

  it("es determinista", () => {
    const a = digestOperatorList(list([1, 2, 3], [[1, 2], "x", null]));
    const b = digestOperatorList(list([1, 2, 3], [[1, 2], "x", null]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("cambia si cambia una operacion, un argumento numerico o un texto", () => {
    const base = digestOperatorList(list([1, 2, 3], [[1, 2], "x", null]));
    expect(digestOperatorList(list([1, 2, 4], [[1, 2], "x", null]))).not.toBe(base);
    expect(digestOperatorList(list([1, 2, 3], [[1, 3], "x", null]))).not.toBe(base);
    expect(digestOperatorList(list([1, 2, 3], [[1, 2], "y", null]))).not.toBe(base);
  });

  it("distingue glifos de texto distintos (lo que cambia al editar un texto)", () => {
    const glyphs = (chars: string) => [{ unicode: chars, fontChar: chars, width: 10 }];
    expect(digestOperatorList(list([44], [glyphs("a")]))).not.toBe(digestOperatorList(list([44], [glyphs("b")])));
  });

  it("distingue arreglos tipados por contenido", () => {
    const a = digestOperatorList(list([5], [new Float32Array([1, 2, 3, 4])]));
    const b = digestOperatorList(list([5], [new Float32Array([1, 2, 3, 5])]));
    expect(a).not.toBe(b);
  });

  it("una lista demasiado grande no se resume (la huella pasa a ser del snapshot)", () => {
    const fns = new Array(SIGNATURE_MAX_OPS + 1).fill(1);
    expect(digestOperatorList(list(fns))).toBeNull();
  });

  it("si tarda mas que el plazo, se rinde", () => {
    let t = 0;
    const clock = () => (t += 5);
    const fns = new Array(5_000).fill(1);
    expect(digestOperatorList(list(fns), clock, 20)).toBeNull();
  });

  it("una lista vacia tiene huella", () => {
    expect(digestOperatorList(list([]))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("pageSignature (con pdf.js real)", () => {
  it("la misma pagina da la misma huella en dos aperturas", async () => {
    const bytes = await pdfWith([{ text: "Hola" }]);
    expect(await signaturesOf(bytes)).toEqual(await signaturesOf(bytes));
  });

  it("otro texto da otra huella", async () => {
    const [a] = await signaturesOf(await pdfWith([{ text: "Hola" }]));
    const [b] = await signaturesOf(await pdfWith([{ text: "Adios" }]));
    expect(a).not.toBe(b);
  });

  it("girar la pagina cambia la huella", async () => {
    const [a] = await signaturesOf(await pdfWith([{ text: "Hola" }]));
    const [b] = await signaturesOf(await pdfWith([{ text: "Hola", rotate: 90 }]));
    expect(a).not.toBe(b);
  });

  it("recortar con CropBox cambia la huella", async () => {
    const [a] = await signaturesOf(await pdfWith([{ text: "Hola" }]));
    const [b] = await signaturesOf(await pdfWith([{ text: "Hola", crop: true }]));
    expect(a).not.toBe(b);
  });

  it("anadir un grafico cambia la huella", async () => {
    const [a] = await signaturesOf(await pdfWith([{ text: "Hola" }]));
    const [b] = await signaturesOf(await pdfWith([{ text: "Hola", rect: true }]));
    expect(a).not.toBe(b);
  });

  it("paginas distintas del mismo documento tienen huellas distintas", async () => {
    const sigs = await signaturesOf(await pdfWith([{ text: "Uno" }, { text: "Dos" }, { text: "Tres" }]));
    expect(new Set(sigs).size).toBe(3);
  });

  it("borrar una pagina no cambia la huella de las demas (se reutiliza su render)", async () => {
    const original = await pdfWith([{ text: "Uno" }, { text: "Dos" }, { text: "Tres" }]);
    const before = await signaturesOf(original);
    const edited = await PDFDocument.load(original);
    edited.removePage(0);
    const after = await signaturesOf(await edited.save());
    expect(after).toEqual([before[1], before[2]]);
  });

  it("girar una sola pagina deja igual la huella de las otras", async () => {
    const original = await pdfWith([{ text: "Uno" }, { text: "Dos" }, { text: "Tres" }]);
    const before = await signaturesOf(original);
    const edited = await PDFDocument.load(original);
    edited.getPage(1).setRotation(degrees(90));
    const after = await signaturesOf(await edited.save());
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("reordenar paginas (mover la ultima al principio) conserva la huella de cada una", async () => {
    const original = await pdfWith([{ text: "Uno" }, { text: "Dos" }, { text: "Tres" }]);
    const before = await signaturesOf(original);
    const edited = await PDFDocument.load(original);
    // Se mueve la referencia dentro de /Kids: los objetos de pagina (y su `ref`) no cambian, como al reordenar en sitio.
    const kids = edited.catalog.Pages().Kids();
    const lastRef = kids.get(2);
    kids.remove(2);
    kids.insert(0, lastRef);
    const after = await signaturesOf(await edited.save());
    expect(after).toEqual([before[2], before[0], before[1]]);
  });

  it("el orden en que se cargan las paginas no cambia su huella (los nombres de fuente de pdf.js dependen de el)", async () => {
    const bytes = await pdfWith([{ text: "Uno" }, { text: "Dos" }]);
    const pdfjs = await getPdfjsLegacy();
    const open = async () =>
      pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_DIR, verbosity: 0 }).promise;
    const forward = await open();
    const a = [await pageSignature((await forward.getPage(1)) as unknown as Sig, "x"), await pageSignature((await forward.getPage(2)) as unknown as Sig, "x")];
    const backward = await open();
    const b2 = await pageSignature((await backward.getPage(2)) as unknown as Sig, "x");
    const b1 = await pageSignature((await backward.getPage(1)) as unknown as Sig, "x");
    expect([b1, b2]).toEqual(a);
    await forward.loadingTask.destroy();
    await backward.loadingTask.destroy();
  });
});

describe("pageSignature: reserva", () => {
  it("sin getOperatorList usa la huella de reserva", async () => {
    expect(await pageSignature({} as Sig, "fb")).toBe("fb");
  });

  it("si getOperatorList falla usa la huella de reserva y no lanza", async () => {
    const page = { getOperatorList: async () => Promise.reject(new Error("x")) } as unknown as Sig;
    expect(await pageSignature(page, "fb")).toBe("fb");
  });

  it("una pagina enorme (demasiadas operaciones) usa la reserva", async () => {
    const fns = new Array(100).fill(1);
    const page = { getOperatorList: async () => ({ fnArray: fns, argsArray: fns }) } as unknown as Sig;
    expect(await pageSignature(page, "fb", { maxOps: 10 })).toBe("fb");
  });

  it("incluye ref, giro y caja visible en la huella", async () => {
    const make = (rotate: number, view: number[]) =>
      ({
        ref: { num: 7, gen: 0 },
        rotate,
        view,
        getOperatorList: async () => ({ fnArray: [1], argsArray: [null] }),
      }) as unknown as Sig;
    const a = await pageSignature(make(0, [0, 0, 100, 100]), "fb");
    expect(a.startsWith("p7.0:0:0,0,100,100:")).toBe(true);
    expect(await pageSignature(make(90, [0, 0, 100, 100]), "fb")).not.toBe(a);
    expect(await pageSignature(make(0, [0, 0, 100, 101]), "fb")).not.toBe(a);
  });

  it("la huella de reserva depende del snapshot y de la pagina", () => {
    expect(snapshotScopedSignature("s1", 0)).not.toBe(snapshotScopedSignature("s2", 0));
    expect(snapshotScopedSignature("s1", 0)).not.toBe(snapshotScopedSignature("s1", 1));
  });
});

describe("SignatureMemo", () => {
  it("recuerda la huella de cada pagina por snapshot", () => {
    const memo = new SignatureMemo();
    memo.set("s1", 0, "a");
    memo.set("s2", 0, "b");
    expect(memo.get("s1", 0)).toBe("a");
    expect(memo.get("s2", 0)).toBe("b");
    expect(memo.get("s1", 1)).toBeUndefined();
  });

  it("conserva como mucho N snapshots (el mas antiguo sale)", () => {
    const memo = new SignatureMemo(2);
    memo.set("s1", 0, "a");
    memo.set("s2", 0, "b");
    memo.set("s3", 0, "c");
    expect(memo.get("s1", 0)).toBeUndefined();
    expect(memo.get("s2", 0)).toBe("b");
    expect(memo.get("s3", 0)).toBe("c");
  });

  it("escribir en un snapshot lo marca como el mas reciente", () => {
    const memo = new SignatureMemo(2);
    memo.set("s1", 0, "a");
    memo.set("s2", 0, "b");
    memo.set("s1", 1, "a2");
    memo.set("s3", 0, "c");
    expect(memo.get("s1", 0)).toBe("a");
    expect(memo.get("s2", 0)).toBeUndefined();
  });

  it("clear lo olvida todo", () => {
    const memo = new SignatureMemo();
    memo.set("s1", 0, "a");
    memo.clear();
    expect(memo.get("s1", 0)).toBeUndefined();
  });
});
