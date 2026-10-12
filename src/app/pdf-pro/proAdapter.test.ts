import { describe, expect, it, vi } from "vitest";
import {
  checkProInput,
  createProRunner,
  decryptProFile,
  exportWarnings,
  runOperation,
} from "@/app/pdf-pro/proAdapter";
import { compressOperation, rotateAllOperation, getProOperation, PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { fakeBytes, fakeDoc, fakeFile, makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { EMPTY_PRO_STATE } from "@/app/pdf-pro/proWorkingDoc";
import { PdfError } from "@/lib/pdf/core";
import { protectPdf } from "@/lib/pdf/protect";
import { createInputGuard, isDecryptedCopy, type InputGuard } from "@/lib/pdf/inputGuard";
import { getPageCount } from "../../../e2e/helpers/pdf-inspection";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { ProOperation, ProWorkingState } from "@/app/pdf-pro/proTypes";

/** Adaptador: progreso, cancelacion, errores tipados, entrada cifrada y avisos. */

const bytes = fakeBytes(32);
const op = (run: ProOperation<void>["run"], extra: Partial<ProOperation<void>> = {}): ProOperation<void> => ({
  id: "t",
  labelKey: "rotateAll90",
  kind: "document",
  run,
  ...extra,
});

describe("runOperation — camino feliz", () => {
  it("devuelve los bytes de la operacion y sus avisos", async () => {
    const out = fakeBytes(40, 2);
    const result = await runOperation(
      op(async () => ({ bytes: out, warnings: [{ code: "unchanged" }], pageCount: 4, report: { n: 1 } })),
      bytes,
      undefined,
    );
    expect(result).toEqual({ ok: true, bytes: out, pageCount: 4, warnings: [{ code: "unchanged" }], report: { n: 1 } });
  });

  it("sin avisos devuelve una lista vacia, no undefined", async () => {
    const result = await runOperation(op(async () => ({ bytes: fakeBytes(10) })), bytes, undefined);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it("pasa a la operacion los bytes, las opciones y el contexto", async () => {
    const run = vi.fn(async () => ({ bytes: fakeBytes(10) }));
    await runOperation({ id: "x", labelKey: "k", kind: "pages", run } as ProOperation<{ a: number }>, bytes, { a: 1 }, { lang: "en" });
    const [inBytes, inOptions, ctx] = run.mock.calls[0] as unknown as [Uint8Array, unknown, { lang: string; signal: AbortSignal; onProgress: unknown }];
    expect(inBytes).toBe(bytes);
    expect(inOptions).toEqual({ a: 1 });
    expect(ctx.lang).toBe("en");
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(typeof ctx.onProgress).toBe("function");
  });

  it("el idioma por defecto del contexto es es", async () => {
    let seen = "";
    await runOperation(op(async (_b, _o, ctx) => ((seen = ctx.lang), { bytes: fakeBytes(10) })), bytes, undefined);
    expect(seen).toBe("es");
  });
});

describe("runOperation — progreso 0..1", () => {
  it("reenvia el progreso acotado a 0..1 y termina en 1", async () => {
    const seen: number[] = [];
    await runOperation(
      op(async (_b, _o, ctx) => {
        ctx.onProgress(-3);
        ctx.onProgress(0.4);
        ctx.onProgress(7);
        ctx.onProgress(Number.NaN);
        return { bytes: fakeBytes(10) };
      }),
      bytes,
      undefined,
      { onProgress: (p) => seen.push(p) },
    );
    expect(seen).toEqual([0, 0.4, 1, 0, 1]);
  });

  it("un progreso tardio despues de cancelar no se reenvia", async () => {
    const seen: number[] = [];
    const controller = new AbortController();
    let late: (value: number) => void = () => {};
    const result = runOperation(
      op(async (_b, _o, ctx) => {
        late = ctx.onProgress;
        return new Promise(() => {});
      }),
      bytes,
      undefined,
      { signal: controller.signal, onProgress: (p) => seen.push(p) },
    );
    await Promise.resolve();
    controller.abort();
    await result;
    late(0.9);
    expect(seen).toEqual([]);
  });
});

describe("runOperation — cancelacion", () => {
  it("abortar corta una operacion que NO escucha la senal y su resultado tardio se ignora", async () => {
    const controller = new AbortController();
    let finish: (v: { bytes: Uint8Array }) => void = () => {};
    const slow = op(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = runOperation(slow, bytes, undefined, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, cancelled: true, code: "cancelled" });
    finish({ bytes: fakeBytes(10) }); // resultado tardio: nada que hacer ni error sin manejar
  });

  it("una senal ya abortada ni siquiera arranca la operacion", async () => {
    const run = vi.fn(async () => ({ bytes: fakeBytes(10) }));
    const controller = new AbortController();
    controller.abort();
    const result = await runOperation(op(run), bytes, undefined, { signal: controller.signal });
    expect(result).toEqual({ ok: false, cancelled: true, code: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("la operacion recibe una senal que se aborta con la externa", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null = null;
    const pending = runOperation(
      op(async (_b, _o, ctx) => {
        received = ctx.signal;
        return new Promise(() => {});
      }),
      bytes,
      undefined,
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(received!.aborted).toBe(false);
    controller.abort();
    await pending;
    expect(received!.aborted).toBe(true);
  });

  it("un motor que lanza cancelled (PdfError) es una cancelacion, no un error", async () => {
    const result = await runOperation(
      op(async () => {
        throw new PdfError("cancelled");
      }),
      bytes,
      undefined,
    );
    expect(result).toEqual({ ok: false, cancelled: true, code: "cancelled" });
  });

  it("un error tardio tras cancelar no se convierte en rechazo sin manejar", async () => {
    const controller = new AbortController();
    let fail: (e: Error) => void = () => {};
    const pending = runOperation(
      op(() => new Promise((_resolve, reject) => (fail = reject))),
      bytes,
      undefined,
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    expect((await pending).ok).toBe(false);
    fail(new Error("tarde"));
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("runOperation — errores tipados (los mensajes claros de W6)", () => {
  it("un PdfError conserva su codigo", async () => {
    const result = await runOperation(
      op(async () => {
        throw new PdfError("tooLarge");
      }),
      bytes,
      undefined,
    );
    expect(result).toEqual({ ok: false, cancelled: false, code: "tooLarge" });
  });

  it.each([
    ["Failed to parse PDF", "corrupt"],
    ["Invalid typed array length: 4294967296", "tooLarge"],
    ["No password given", "encrypted"],
    ["algo raro", "unknown"],
  ])("un Error de libreria «%s» se traduce a %s", async (message, code) => {
    const result = await runOperation(
      op(async () => {
        throw new Error(message);
      }),
      bytes,
      undefined,
    );
    expect(result).toEqual({ ok: false, cancelled: false, code });
  });

  it("un valor lanzado que no es Error es unknown", async () => {
    const result = await runOperation(
      op(async () => {
        throw "texto";
      }),
      bytes,
      undefined,
    );
    expect(result).toMatchObject({ ok: false, code: "unknown" });
  });

  it("una operacion que devuelve 0 bytes es un documento danado, no un exito", async () => {
    const result = await runOperation(op(async () => ({ bytes: new Uint8Array(0) })), bytes, undefined);
    expect(result).toEqual({ ok: false, cancelled: false, code: "corrupt" });
  });
});

describe("createProRunner — runId", () => {
  it("lanzar otra operacion descarta el resultado tardio de la anterior (stale)", async () => {
    const runner = createProRunner();
    let release: (v: { bytes: Uint8Array }) => void = () => {};
    const slow = op(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = runner.run(slow, bytes, undefined);
    await Promise.resolve();
    const second = await runner.run(op(async () => ({ bytes: fakeBytes(12) })), bytes, undefined);
    expect(second).toMatchObject({ ok: true, stale: false });
    release({ bytes: fakeBytes(99) });
    const stale = await first;
    expect(stale).toMatchObject({ ok: false, cancelled: true, stale: true });
    expect(stale.runId).toBeLessThan(second.runId);
  });

  it("cancel() aborta la ejecucion en curso y la marca stale", async () => {
    const runner = createProRunner();
    const pending = runner.run(op(() => new Promise(() => {})), bytes, undefined);
    await Promise.resolve();
    expect(runner.running).toBe(true);
    runner.cancel();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, cancelled: true, stale: true });
    expect(runner.running).toBe(false);
  });

  it("el progreso de una ejecucion superada no llega a la interfaz", async () => {
    const runner = createProRunner();
    const seen: number[] = [];
    let notify: (v: number) => void = () => {};
    const first = runner.run(
      op((_b, _o, ctx) => {
        notify = ctx.onProgress;
        return new Promise(() => {});
      }),
      bytes,
      undefined,
      { onProgress: (p) => seen.push(p) },
    );
    await Promise.resolve();
    await runner.run(op(async () => ({ bytes: fakeBytes(12) })), bytes, undefined);
    notify(0.5);
    await first;
    expect(seen).toEqual([]);
  });

  it("el runId crece con cada ejecucion y running vuelve a false al terminar", async () => {
    const runner = createProRunner();
    const a = await runner.run(op(async () => ({ bytes: fakeBytes(12) })), bytes, undefined);
    const b = await runner.run(op(async () => ({ bytes: fakeBytes(12) })), bytes, undefined);
    expect(b.runId).toBe(a.runId + 1);
    expect(runner.running).toBe(false);
    expect(runner.currentRunId).toBe(b.runId);
  });

  it("un error de la ejecucion vigente se devuelve tipado y no stale", async () => {
    const runner = createProRunner();
    const result = await runner.run(
      op(async () => {
        throw new PdfError("corrupt");
      }),
      bytes,
      undefined,
    );
    expect(result).toMatchObject({ ok: false, cancelled: false, code: "corrupt", stale: false });
  });
});

describe("operaciones de ejemplo (motores reales)", () => {
  it("el registro tiene rotar y comprimir, con etiqueta en es y en", async () => {
    // Las dos primeras son las de ejemplo de la fase A; despues van, en este orden, las de documento de la U5
    // (otras unidades pueden intercalar las suyas: aqui solo se exige que las de la U5 esten y sigan su orden).
    const ids = PRO_OPERATIONS.map((o) => o.id);
    expect(ids.slice(0, 2)).toEqual(["rotate-all", "compress"]);
    expect(ids.filter((id) => ["watermark", "page-numbers", "header-footer", "crop", "rotate", "metadata", "repair", "ocr", "unlock"].includes(id))).toEqual([
      "watermark",
      "page-numbers",
      "header-footer",
      "crop",
      "rotate",
      "metadata",
      "repair",
      "ocr",
      "unlock",
    ]);
    expect(getProOperation("rotate-all")).toBe(PRO_OPERATIONS[0]);
    expect(getProOperation("nada")).toBeUndefined();
    const { PRO_STRINGS } = await import("@/app/pdf-pro/proStrings");
    for (const operation of PRO_OPERATIONS) {
      expect(PRO_STRINGS.es.operations[operation.labelKey]).toBeTruthy();
      expect(PRO_STRINGS.en.operations[operation.labelKey]).toBeTruthy();
      // «Aplicar» del organizador (U4) es la unica operacion de tipo `pages`; el resto son de documento.
      expect(operation.kind).toBe(operation.id === "pages-apply" ? "pages" : "document");
    }
  });

  it("rotar todas las paginas 90 grados con rotate.ts", async () => {
    const input = await makePdfBytes(3);
    const progress: number[] = [];
    const result = await runOperation(rotateAllOperation, input, undefined, { onProgress: (p) => progress.push(p) });
    if (!result.ok) throw new Error("fallo");
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90]);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("rotar suma sobre lo que ya habia (dos veces = 180)", async () => {
    const first = await runOperation(rotateAllOperation, await makePdfBytes(2), undefined);
    if (!first.ok) throw new Error("fallo");
    const second = await runOperation(rotateAllOperation, first.bytes, { degrees: 90 });
    if (!second.ok) throw new Error("fallo");
    const doc = await PDFDocument.load(second.bytes);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([180, 180]);
  });

  it("rotar 270 con la opcion degrees", async () => {
    const result = await runOperation(rotateAllOperation, await makePdfBytes(1), { degrees: 270 });
    if (!result.ok) throw new Error("fallo");
    expect((await PDFDocument.load(result.bytes)).getPage(0).getRotation().angle).toBe(270);
  });

  it("rotar un archivo que no es PDF devuelve un error tipado (no lanza)", async () => {
    const result = await runOperation(rotateAllOperation, fakeBytes(40), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cancelled).toBe(false);
  });

  it("comprimir un PDF pequeno avisa «unchanged» y devuelve los mismos bytes", async () => {
    const input = await makePdfBytes(1);
    const result = await runOperation(compressOperation, input, undefined);
    if (!result.ok) throw new Error("fallo");
    expect(result.warnings).toEqual([{ code: "unchanged" }]);
    expect(result.bytes).toBe(input);
    expect(result.pageCount).toBe(1);
  });

  it("la rotacion conserva el numero de paginas (preservesPageCount)", () => {
    expect(rotateAllOperation.preservesPageCount).toBe(true);
    expect(compressOperation.preservesPageCount).toBe(true);
  });
});

describe("checkProInput — entrada y cifrados", () => {
  const guardReturning = (check: Awaited<ReturnType<InputGuard>>): InputGuard => async () => check;

  it("un PDF correcto esta listo", async () => {
    const file = fakeFile();
    expect(await checkProInput(file, guardReturning({ status: "ok" }))).toEqual({
      status: "ready",
      file,
      wasEncrypted: false,
      restrictionsOnly: false,
    });
  });

  it("un archivo que no es PDF se rechaza como notPdf antes de preguntar al guardian", async () => {
    const guard = vi.fn(async () => ({ status: "ok" as const }));
    const result = await checkProInput(new File(["hola"], "nota.txt", { type: "text/plain" }), guard);
    expect(result).toMatchObject({ status: "problem", code: "notPdf" });
    expect(guard).not.toHaveBeenCalled();
  });

  it.each(["emptyFile", "notPdf", "corrupt"] as const)("problema bloqueante %s", async (code) => {
    const result = await checkProInput(fakeFile(), guardReturning({ status: "problem", code }));
    expect(result).toMatchObject({ status: "problem", code });
  });

  it("tooLarge avisa pero NO bloquea: el archivo se abre", async () => {
    const result = await checkProInput(fakeFile(), guardReturning({ status: "problem", code: "tooLarge" }));
    expect(result.status).toBe("ready");
  });

  it("cifrado con contrasena de apertura pide la contrasena", async () => {
    const file = fakeFile();
    expect(await checkProInput(file, guardReturning({ status: "encrypted", needsPassword: true }))).toEqual({
      status: "password",
      file,
    });
  });

  it("cifrado no soportado (certificado) se informa con su codigo", async () => {
    const result = await checkProInput(
      fakeFile(),
      guardReturning({ status: "unsupported", code: "certificateEncryption" }),
    );
    expect(result).toMatchObject({ status: "unsupported", code: "certificateEncryption" });
  });

  it("si el guardian falla, se intenta abrir igualmente (el motor dira si no sirve)", async () => {
    const result = await checkProInput(fakeFile(), async () => {
      throw new Error("pdf.js no pudo");
    });
    expect(result.status).toBe("ready");
  });

  it("un PDF cifrado SOLO con restricciones se abre solo, con una copia descifrada marcada", async () => {
    const original = await makePdfBytes(2);
    const protectedBlob = await protectPdf(pdfFile(original, "prot.pdf"), {
      password: "clave123",
      confirm: "clave123",
      requirePasswordToOpen: false,
      allowCopying: false,
    });
    const file = pdfFile(new Uint8Array(await protectedBlob.arrayBuffer()), "prot.pdf");
    const guard = createInputGuard({
      open: async () => {},
    });
    const result = await checkProInput(file, guard);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.wasEncrypted).toBe(true);
      expect(result.restrictionsOnly).toBe(true);
      expect(isDecryptedCopy(result.file)).toBe(true);
      expect(await getPageCount(Buffer.from(await result.file.arrayBuffer()))).toBe(2);
    }
  });
});

describe("decryptProFile — copia descifrada en memoria", () => {
  async function protectedFile(password = "clave123") {
    const blob = await protectPdf(pdfFile(await makePdfBytes(2), "secreto.pdf"), { password, confirm: password });
    return pdfFile(new Uint8Array(await blob.arrayBuffer()), "secreto.pdf");
  }

  it("con la contrasena correcta devuelve una copia descifrada y marcada, con el mismo nombre", async () => {
    const result = await decryptProFile(await protectedFile(), "clave123");
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.file.name).toBe("secreto.pdf");
      expect(isDecryptedCopy(result.file)).toBe(true);
      expect(await getPageCount(Buffer.from(await result.file.arrayBuffer()))).toBe(2);
    }
  });

  it("con una contrasena mala dice wrongPassword y no devuelve nada", async () => {
    expect(await decryptProFile(await protectedFile(), "otra")).toEqual({ status: "wrongPassword" });
  });

  it("la copia abierta con contrasena viene marcada y exportWarnings avisa de que no se guarda la contrasena", async () => {
    const result = await decryptProFile(await protectedFile(), "clave123");
    if (result.status !== "ready") throw new Error("no descifro");
    const doc = fakeDoc();
    await doc.open(result.file);
    expect(exportWarnings(doc.getState())).toContainEqual({ code: "decryptedCopy" });
  });
});

describe("exportWarnings — antes de guardar o exportar", () => {
  const stateWith = (patch: Partial<NonNullable<ProWorkingState["document"]>>, dirty: boolean): ProWorkingState => {
    const doc = fakeDoc();
    void doc;
    return {
      ...EMPTY_PRO_STATE,
      dirty,
      document: {
        id: "d",
        name: "x.pdf",
        snapshots: [],
        cursor: 0,
        savedSnapshotId: null,
        fingerprint: null,
        wasEncrypted: false,
        signatures: "none",
        trimmedCount: 0,
        openedAt: 0,
        ...patch,
      },
    };
  };

  it("sin documento no hay avisos", () => {
    expect(exportWarnings(EMPTY_PRO_STATE)).toEqual([]);
  });

  it("firmas digitales activas + cambios sin guardar: aviso de que se invalidaran", () => {
    expect(exportWarnings(stateWith({ signatures: "active" }, true))).toEqual([{ code: "signaturesInvalidated" }]);
  });

  it("firmas activas pero SIN cambios: exportar el original intacto no las invalida", () => {
    expect(exportWarnings(stateWith({ signatures: "active" }, false))).toEqual([]);
  });

  it("firmas desconocidas + cambios: aviso de que no se pudo comprobar (nunca «sin firmas»)", () => {
    expect(exportWarnings(stateWith({ signatures: "unknown" }, true))).toEqual([{ code: "signaturesUnknown" }]);
  });

  it("sin firmas ni cifrado: ningun aviso", () => {
    expect(exportWarnings(stateWith({}, true))).toEqual([]);
  });

  it("una copia descifrada avisa siempre, con o sin cambios", () => {
    expect(exportWarnings(stateWith({ wasEncrypted: true }, false))).toEqual([{ code: "decryptedCopy" }]);
    expect(exportWarnings(stateWith({ wasEncrypted: true, signatures: "active" }, true))).toEqual([
      { code: "signaturesInvalidated" },
      { code: "decryptedCopy" },
    ]);
  });
});
