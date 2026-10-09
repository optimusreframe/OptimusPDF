import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { PdfError } from "@/lib/pdf/core";
import {
  signBatch,
  type SignBatchContext,
  type SignBatchDocument,
  type SignBatchSigned,
} from "@/lib/pdf/signBatch";

/**
 * `signBatch` solo orquesta: la firma real se inyecta (`sign`), asi que aqui
 * se sustituye por un doble. jszip y Blob/File funcionan igual en Node, por
 * lo que el ZIP se genera y se vuelve a leer de verdad.
 */

function doc(id: string, name = `${id}.pdf`, content = `contenido ${id}`): SignBatchDocument {
  return {
    id,
    name,
    file: new File([content], name, { type: "application/pdf" }),
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `sign` que devuelve `firmado:<id>` con los firmantes indicados por documento. */
function fakeSign(signers: Record<string, string[]> = {}) {
  return vi.fn(
    async (document: SignBatchDocument): Promise<SignBatchSigned> => ({
      bytes: bytesOf(`firmado:${document.id}`),
      signerNames: signers[document.id] ?? ["Ana"],
    }),
  );
}

async function readZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

describe("signBatch — src/lib/pdf/signBatch.ts", () => {
  it("3 documentos: ZIP con un PDF por documento, nombres «<firmantes> - <doc>-firmado.pdf» y contenido intacto", async () => {
    const sign = fakeSign({ a: ["Ana"], b: ["Ana", "Luis"], c: ["Luis"] });
    const result = await signBatch({
      documents: [doc("a", "Contrato A.pdf"), doc("b", "Contrato B.pdf"), doc("c", "Anexo.pdf")],
      sign,
      lang: "es",
    });

    expect(result.mimeType).toBe("application/zip");
    expect(result.filename).toBe("Firmados - 3 documentos.zip");
    expect(sign).toHaveBeenCalledTimes(3);

    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      "Ana - Contrato A-firmado.pdf",
      "Ana y Luis - Contrato B-firmado.pdf",
      "Luis - Anexo-firmado.pdf",
    ]);
    expect(await zip.file("Ana - Contrato A-firmado.pdf")?.async("string")).toBe("firmado:a");
    expect(await zip.file("Ana y Luis - Contrato B-firmado.pdf")?.async("string")).toBe("firmado:b");
    expect(await zip.file("Luis - Anexo-firmado.pdf")?.async("string")).toBe("firmado:c");

    expect(result.report.failed).toEqual([]);
    expect(result.report.ok).toEqual([
      { id: "a", name: "Contrato A.pdf", filename: "Ana - Contrato A-firmado.pdf" },
      { id: "b", name: "Contrato B.pdf", filename: "Ana y Luis - Contrato B-firmado.pdf" },
      { id: "c", name: "Anexo.pdf", filename: "Luis - Anexo-firmado.pdf" },
    ]);
  });

  it("en ingles: sufijo «-signed», «and» y nombre del ZIP en ingles", async () => {
    const result = await signBatch({
      documents: [doc("a", "Deal.pdf"), doc("b", "Annex.pdf")],
      sign: fakeSign({ a: ["Ana", "Luis"], b: ["Ana"] }),
      lang: "en",
    });
    expect(result.filename).toBe("Signed - 2 documents.zip");
    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      "Ana - Annex-signed.pdf",
      "Ana and Luis - Deal-signed.pdf",
    ]);
  });

  it("conserva acentos, mayusculas, CJK y emoji en los nombres de las entradas del ZIP", async () => {
    const result = await signBatch({
      documents: [doc("a", "Informe ÑOÑO.pdf"), doc("b", "合同🙂.pdf")],
      sign: fakeSign({ a: ["Ángela Núñez"], b: ["王小明"] }),
      lang: "es",
    });
    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual(
      ["Ángela Núñez - Informe ÑOÑO-firmado.pdf", "王小明 - 合同🙂-firmado.pdf"].sort(),
    );
    expect(await zip.file("王小明 - 合同🙂-firmado.pdf")?.async("string")).toBe("firmado:b");
  });

  it("fallo de UN documento: los demas se entregan en el ZIP y el informe lo recoge", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "b") throw new PdfError("corrupt");
      return { bytes: bytesOf(`firmado:${document.id}`), signerNames: ["Ana"] };
    });
    const result = await signBatch({
      documents: [doc("a", "A.pdf"), doc("b", "B.pdf"), doc("c", "C.pdf")],
      sign,
      lang: "es",
    });

    expect(sign).toHaveBeenCalledTimes(3);
    expect(result.filename).toBe("Firmados - 2 documentos.zip");
    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual(["Ana - A-firmado.pdf", "Ana - C-firmado.pdf"]);
    expect(result.report.ok.map((item) => item.id)).toEqual(["a", "c"]);
    expect(result.report.failed).toEqual([{ id: "b", name: "B.pdf", code: "corrupt" }]);
  });

  it("un error que no es PdfError se traduce a un codigo (unknown) y no aborta el lote", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "a") throw new Error("boom");
      return { bytes: bytesOf("x"), signerNames: [] };
    });
    const result = await signBatch({
      documents: [doc("a"), doc("b")],
      sign,
      lang: "es",
    });
    expect(result.report.failed).toEqual([{ id: "a", name: "a.pdf", code: "unknown" }]);
    expect(result.report.ok).toHaveLength(1);
  });

  it("una firma que devuelve 0 bytes cuenta como fallo, no como documento vacio en el ZIP", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => ({
      bytes: document.id === "a" ? new Uint8Array() : bytesOf("ok"),
      signerNames: [],
    }));
    const result = await signBatch({ documents: [doc("a"), doc("b")], sign, lang: "es" });
    expect(result.report.failed).toEqual([{ id: "a", name: "a.pdf", code: "unknown" }]);
    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files)).toEqual(["b-firmado.pdf"]);
  });

  it("fallan TODOS: lanza el error del primero (PdfError) y no genera nada", async () => {
    const codes: Record<string, "corrupt" | "encrypted"> = { a: "corrupt", b: "encrypted" };
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      throw new PdfError(codes[document.id]);
    });
    const promise = signBatch({ documents: [doc("a"), doc("b")], sign, lang: "es" });
    await expect(promise).rejects.toBeInstanceOf(PdfError);
    await expect(promise).rejects.toMatchObject({ code: "corrupt" });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("cancelacion a mitad: aborta, no firma los siguientes ni genera ZIP", async () => {
    const controller = new AbortController();
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "b") controller.abort();
      return { bytes: bytesOf(document.id), signerNames: ["Ana"] };
    });
    const generate = vi.spyOn(JSZip.prototype, "generateAsync");

    await expect(
      signBatch({
        documents: [doc("a"), doc("b"), doc("c")],
        sign,
        lang: "es",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "PdfError", code: "cancelled" });

    // "c" nunca se firma y el ZIP no llega a generarse.
    expect(sign.mock.calls.map(([document]) => document.id)).toEqual(["a", "b"]);
    expect(generate).not.toHaveBeenCalled();
    generate.mockRestore();
  });

  it("cancelacion: si `sign` lanza «cancelled» el lote se cancela, no cuenta como fallo parcial", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "b") throw new PdfError("cancelled");
      return { bytes: bytesOf(document.id), signerNames: [] };
    });
    await expect(
      signBatch({ documents: [doc("a"), doc("b"), doc("c")], sign, lang: "es" }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("senal ya abortada: cancela antes de firmar nada", async () => {
    const controller = new AbortController();
    controller.abort();
    const sign = fakeSign();
    await expect(
      signBatch({ documents: [doc("a"), doc("b")], sign, lang: "es", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("progreso: monotono, empieza en 0, termina en 1 y reparte el tramo de cada documento", async () => {
    const values: number[] = [];
    const sign = vi.fn(
      async (document: SignBatchDocument, context: SignBatchContext): Promise<SignBatchSigned> => {
        context.onProgress(0.5);
        // Valor desordenado a proposito: el motor no debe retroceder.
        context.onProgress(0.2);
        context.onProgress(1);
        return { bytes: bytesOf(document.id), signerNames: ["Ana"] };
      },
    );
    await signBatch({
      documents: [doc("a"), doc("b"), doc("c"), doc("d")],
      sign,
      lang: "es",
      onProgress: (value) => values.push(value),
    });

    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    // Todos dentro de [0, 1].
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    // Al terminar los 4 documentos (95 %) aun queda el empaquetado.
    expect(values.some((value) => Math.abs(value - 0.95) < 1e-9)).toBe(true);
    // Mitad del primer documento: 0.5 * (0.95 / 4).
    expect(values.some((value) => Math.abs(value - 0.5 * (0.95 / 4)) < 1e-9)).toBe(true);
  });

  it("progreso tambien es monotono si un documento falla en medio", async () => {
    const values: number[] = [];
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id === "b") throw new PdfError("corrupt");
      return { bytes: bytesOf(document.id), signerNames: [] };
    });
    await signBatch({
      documents: [doc("a"), doc("b"), doc("c")],
      sign,
      lang: "es",
      onProgress: (value) => values.push(value),
    });
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    expect(values[values.length - 1]).toBe(1);
  });

  it("mismo documento y mismos firmantes: nombres unicos «(2)», «(3)» y no se pierde ninguno", async () => {
    const result = await signBatch({
      documents: [
        doc("a", "Contrato.pdf"),
        doc("b", "Contrato.pdf"),
        doc("c", "CONTRATO.pdf"),
      ],
      sign: fakeSign({ a: ["Ana"], b: ["Ana"], c: ["ANA"] }),
      lang: "es",
    });
    const zip = await readZip(result.blob);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      "ANA - CONTRATO-firmado (3).pdf",
      "Ana - Contrato-firmado (2).pdf",
      "Ana - Contrato-firmado.pdf",
    ]);
    expect(await zip.file("Ana - Contrato-firmado.pdf")?.async("string")).toBe("firmado:a");
    expect(await zip.file("Ana - Contrato-firmado (2).pdf")?.async("string")).toBe("firmado:b");
    expect(await zip.file("ANA - CONTRATO-firmado (3).pdf")?.async("string")).toBe("firmado:c");
    // El informe lleva el nombre FINAL de cada entrada.
    expect(result.report.ok.map((item) => item.filename)).toEqual([
      "Ana - Contrato-firmado.pdf",
      "Ana - Contrato-firmado (2).pdf",
      "ANA - CONTRATO-firmado (3).pdf",
    ]);
  });

  it("un documento sin firmantes se llama «<doc>-firmado.pdf»", async () => {
    const result = await signBatch({
      documents: [doc("a", "Sin firmantes.pdf"), doc("b", "Con firmante.pdf")],
      sign: fakeSign({ a: [], b: ["Luis"] }),
      lang: "es",
    });
    const zip = await readZip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      "Luis - Con firmante-firmado.pdf",
      "Sin firmantes-firmado.pdf",
    ]);
  });

  it("un solo documento: devuelve el PDF firmado (sin ZIP) con su nombre", async () => {
    const result = await signBatch({
      documents: [doc("a", "Contrato.pdf")],
      sign: fakeSign({ a: ["Ana", "Luis"] }),
      lang: "es",
    });
    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("Ana y Luis - Contrato-firmado.pdf");
    expect(result.blob.type).toBe("application/pdf");
    expect(new TextDecoder().decode(await result.blob.arrayBuffer())).toBe("firmado:a");
    expect(result.report).toEqual({
      ok: [{ id: "a", name: "Contrato.pdf", filename: "Ana y Luis - Contrato-firmado.pdf" }],
      failed: [],
    });
  });

  it("un solo documento que falla: lanza su error (nada que entregar)", async () => {
    const sign = vi.fn(async (): Promise<SignBatchSigned> => {
      throw new PdfError("encrypted");
    });
    await expect(
      signBatch({ documents: [doc("a")], sign, lang: "es" }),
    ).rejects.toMatchObject({ code: "encrypted" });
  });

  it("tres documentos donde solo uno se firma: ZIP de un documento (singular) con el informe", async () => {
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      if (document.id !== "b") throw new PdfError("corrupt");
      return { bytes: bytesOf("ok"), signerNames: ["Ana"] };
    });
    const result = await signBatch({
      documents: [doc("a"), doc("b"), doc("c")],
      sign,
      lang: "es",
    });
    expect(result.mimeType).toBe("application/zip");
    expect(result.filename).toBe("Firmados - 1 documento.zip");
    expect(result.report.failed.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("pasa a `sign` el documento completo (campos extra incluidos) y la senal", async () => {
    type Rich = SignBatchDocument & { placements: number[] };
    const controller = new AbortController();
    const seen: Rich[] = [];
    let seenSignal: AbortSignal | undefined;
    await signBatch<Rich>({
      documents: [{ ...doc("a"), placements: [1, 2] }],
      sign: async (document, context) => {
        seen.push(document);
        seenSignal = context.signal;
        return { bytes: bytesOf("ok"), signerNames: [] };
      },
      lang: "es",
      signal: controller.signal,
    });
    expect(seen[0].placements).toEqual([1, 2]);
    expect(seenSignal).toBe(controller.signal);
  });

  it("sin documentos: PdfError «empty»", async () => {
    await expect(signBatch({ documents: [], sign: fakeSign(), lang: "es" })).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("limites: mas documentos que `maxDocuments` o mas bytes que `maxTotalBytes` -> «tooLarge» sin firmar", async () => {
    const sign = fakeSign();
    await expect(
      signBatch({
        documents: [doc("a"), doc("b"), doc("c")],
        sign,
        lang: "es",
        limits: { maxDocuments: 2 },
      }),
    ).rejects.toMatchObject({ code: "tooLarge" });
    await expect(
      signBatch({
        documents: [doc("a", "a.pdf", "x".repeat(60)), doc("b", "b.pdf", "x".repeat(60))],
        sign,
        lang: "es",
        limits: { maxTotalBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: "tooLarge" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("por defecto el tope de documentos es el del modulo ZIP (100)", async () => {
    const documents = Array.from({ length: 101 }, (_, i) => doc(`d${i}`));
    await expect(
      signBatch({ documents, sign: fakeSign(), lang: "es" }),
    ).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("firma secuencial: nunca hay dos `sign` a la vez", async () => {
    let running = 0;
    let maxRunning = 0;
    const sign = vi.fn(async (document: SignBatchDocument): Promise<SignBatchSigned> => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return { bytes: bytesOf(document.id), signerNames: [] };
    });
    await signBatch({ documents: [doc("a"), doc("b"), doc("c")], sign, lang: "es" });
    expect(maxRunning).toBe(1);
  });
});
