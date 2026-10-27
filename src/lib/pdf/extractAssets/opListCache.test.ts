import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { OPERATOR_LIST_BUDGET, OperatorListCache } from "./opListCache";
import { extractWith, type ExtractEnv } from "./orchestrate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";

/** Las tres pasadas del orquestador comparten UNA lista de operadores por pagina (H11/H12): menos trabajo, menos memoria. */

const pageWith = (ops: number) => ({ getOperatorList: vi.fn(async () => ({ fnArray: new Array<number>(ops).fill(1), argsArray: new Array<unknown>(ops).fill(null) })) });

describe("OperatorListCache", () => {
  it("pide la lista una sola vez por pagina y la pide SIN anotaciones", async () => {
    const cache = new OperatorListCache();
    const page = pageWith(10);
    const first = await cache.get(page, 0);
    const second = await cache.get(page, 0);
    expect(second).toBe(first);
    expect(page.getOperatorList).toHaveBeenCalledTimes(1);
    expect(page.getOperatorList).toHaveBeenCalledWith({ annotationMode: 0 });
    await cache.get(pageWith(5), 1);
    expect(cache.size).toBe(2);
  });
  it("respeta el presupuesto: una pagina que no cabe no se guarda y se vuelve a pedir", async () => {
    const cache = new OperatorListCache(100);
    const big = pageWith(150);
    await cache.get(big, 0);
    await cache.get(big, 0);
    expect(big.getOperatorList).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    const small = pageWith(60);
    await cache.get(small, 1);
    await cache.get(small, 1);
    expect(small.getOperatorList).toHaveBeenCalledTimes(1);
    // El presupuesto es de TODAS las paginas: la segunda que cabria sola ya no cabe.
    const other = pageWith(60);
    await cache.get(other, 2);
    await cache.get(other, 2);
    expect(other.getOperatorList).toHaveBeenCalledTimes(2);
    expect(OPERATOR_LIST_BUDGET).toBe(400_000);
  });
  it("`clear` libera todo", async () => {
    const cache = new OperatorListCache();
    const page = pageWith(10);
    await cache.get(page, 0);
    cache.clear();
    expect(cache.size).toBe(0);
    await cache.get(page, 0);
    expect(page.getOperatorList).toHaveBeenCalledTimes(2);
  });
  it("un error de pdf.js se propaga y no deja nada a medias", async () => {
    const cache = new OperatorListCache();
    const page = { getOperatorList: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(cache.get(page, 0)).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
  });
});

describe("extractWith pide UNA lista de operadores por pagina", () => {
  it("un PDF de 4 paginas con texto: 4 llamadas a getOperatorList (antes 12: imagenes, anotaciones y hechos de pagina)", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i += 1) doc.addPage([300, 300]).drawText(`Pagina ${i + 1}`, { x: 40, y: 200 });
    const bytes = await doc.save();
    let calls = 0;
    const env: ExtractEnv = {
      ...nodeExtractEnv,
      openDocument: async (data) => {
        const pdf = await nodeExtractEnv.openDocument(data);
        const original = pdf.getPage.bind(pdf);
        pdf.getPage = (async (number: number) => {
          const page = await original(number);
          const ops = page.getOperatorList.bind(page);
          page.getOperatorList = ((...args: Parameters<typeof ops>) => (calls += 1, ops(...args))) as typeof page.getOperatorList;
          return page;
        }) as typeof pdf.getPage;
        return pdf;
      },
    };
    const result = await extractWith(env, bytes);
    expect(result.pageCount).toBe(4);
    expect(calls).toBe(4);
  });
});
