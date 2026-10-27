import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { findImageAssets, renderImageAsset } from "./images";
import type { ImageOpNumbers } from "./imagesOps";
import { blobBytes, decodePng } from "./images.testUtils";

/**
 * El motor contra un pdf.js de MENTIRA: lo que no se puede provocar con un PDF real (objetos que llegan tarde, objetos
 * globales en `commonObjs`, un objeto que nunca llega, una pagina que falla, imagenes del navegador en `ImageBitmap`).
 */

const OPS: Required<ImageOpNumbers> = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
  paintImageXObjectRepeat: 88,
  paintInlineImageXObjectGroup: 87,
  paintImageMaskXObjectGroup: 84,
  paintImageMaskXObjectRepeat: 89,
  setFillRGBColor: 59,
  beginAnnotation: 80,
  endAnnotation: 81,
};

type Store = { has: (id: string) => boolean; get: (id: string, callback?: (data: unknown) => void) => unknown };

type FakePageSpec = {
  /** [fn, args][] de la lista de operadores. */
  ops: Array<[number, unknown]>;
  objs?: Record<string, unknown>;
  common?: Record<string, unknown>;
  /** Objetos que llegan DESPUES de pedirlos (milisegundos). */
  late?: Record<string, { after: number; data: unknown }>;
  /** Objetos que no llegan nunca. */
  never?: string[];
  failOperatorList?: boolean;
  text?: string[];
  size?: [number, number];
};

function fakeStore(resolved: Record<string, unknown>, late: FakePageSpec["late"], never: string[]): Store {
  const arrived = new Set<string>(Object.keys(resolved));
  return {
    has: (id) => arrived.has(id),
    get: (id, callback) => {
      if (arrived.has(id)) {
        if (callback) callback(resolved[id]);
        return resolved[id];
      }
      if (!callback) throw new Error(`Requesting object that isn't resolved yet ${id}.`);
      if (never.includes(id)) return undefined;
      const entry = late?.[id];
      if (entry) setTimeout(() => callback(entry.data), entry.after);
      return undefined;
    },
  };
}

function fakeDoc(pages: FakePageSpec[]): { doc: PDFDocumentProxy; cleaned: number[] } {
  const cleaned: number[] = [];
  const doc = {
    numPages: pages.length,
    getData: async () => new Uint8Array(0),
    getPage: async (number: number) => {
      const spec = pages[number - 1];
      const [w, h] = spec.size ?? [100, 100];
      return {
        getOperatorList: async () => {
          if (spec.failOperatorList) throw new Error("pagina rota");
          return { fnArray: spec.ops.map((op) => op[0]), argsArray: spec.ops.map((op) => op[1]) };
        },
        getViewport: () => ({ transform: [1, 0, 0, -1, 0, h], width: w, height: h }),
        getTextContent: async () => ({ items: (spec.text ?? []).map((str) => ({ str })) }),
        objs: fakeStore(spec.objs ?? {}, spec.late, spec.never ?? []),
        commonObjs: fakeStore(spec.common ?? {}, undefined, []),
        cleanup: () => cleaned.push(number),
      };
    },
  };
  return { doc: doc as unknown as PDFDocumentProxy, cleaned };
}

const rgba = (w: number, h: number, value: [number, number, number, number]): { width: number; height: number; kind: number; data: Uint8ClampedArray } => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set(value, i * 4);
  return { width: w, height: h, kind: 3, data };
};

const place = (id: string, w: number, h: number): Array<[number, unknown]> => [
  [OPS.save, null],
  [OPS.transform, [w, 0, 0, h, 10, 10]],
  [OPS.paintImageXObject, [id, 4, 4]],
  [OPS.restore, null],
];

afterEach(() => {
  vi.useRealTimers();
});

/** `setTimeout` REAL, guardado antes de que ninguna prueba instale el reloj falso. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Espera una promesa del motor con el reloj FALSO.
 *
 * El motor mezcla DOS esperas distintas: los temporizadores (el plazo de un objeto que no llega, los cedes de hilo con
 * `setTimeout(0)`), que manda el reloj falso, y trabajo REAL que ningun reloj controla: la compresion de la miniatura
 * (`CompressionStream` -> zlib en el pool de hilos de Node). Un bucle con un numero fijo de vueltas de `advanceTimersByTimeAsync`
 * (la version anterior: 120 y 200 vueltas, unos milisegundos reales en total) asumia que ese trabajo terminaba dentro del bucle; con
 * la CPU repartida (el runner de CI de 2 nucleos con otros workers de Vitest quemando CPU) no terminaba, el bucle se acababa con la
 * promesa a medias y, al volver el trabajo real, el motor pedia un `setTimeout(0)` falso que nadie volvia a adelantar: la prueba se
 * colgaba hasta el plazo de 30 s (reproducido en Linux: ~50 % de las ejecuciones con dos procesos quemando CPU).
 *
 * Aqui el reloj falso avanza de a segundo SOLO mientras haya un temporizador pendiente; si no hay ninguno, el motor espera
 * trabajo real y se deja pasar un turno del bucle de eventos REAL. El tope es de reloj falso y de tiempo real, no de vueltas, y
 * falla con un mensaje claro en vez de colgarse (el plazo real de un objeto que no llega es de 20 s).
 */
async function drain<T>(promise: Promise<T>, limits: { fakeMs?: number; realMs?: number } = {}): Promise<T> {
  const { fakeMs = 120_000, realMs = 20_000 } = limits;
  let finished = false;
  void promise.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  const startedReal = vi.getRealSystemTime();
  const startedFake = Date.now();
  while (!finished) {
    if (Date.now() - startedFake > fakeMs) throw new Error(`el motor no termino en ${fakeMs} ms de reloj falso (algo espera mas de lo previsto)`);
    if (vi.getRealSystemTime() - startedReal > realMs) throw new Error(`el motor no termino en ${realMs} ms reales (espera algo que no es un temporizador ni trabajo del pool de hilos)`);
    if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1_000);
    else await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
  return promise;
}

describe("objetos de imagen de pdf.js", () => {
  it("un objeto que llega DESPUES de pedirlo se espera", async () => {
    const { doc } = fakeDoc([{ ops: place("img_p0_1", 40, 40), late: { img_p0_1: { after: 30, data: rgba(4, 4, [9, 9, 9, 255]) } } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("una imagen global (commonObjs) se lee de ahi", async () => {
    vi.useFakeTimers();
    const { doc } = fakeDoc([{ ops: place("g_doc_img_p0_1", 40, 40), common: { g_doc_img_p0_1: rgba(4, 4, [1, 2, 3, 255]) } }]);
    const result = await drain(findImageAssets(doc, { ops: OPS, jpegIndex: null }));
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].pixel).toEqual({ width: 4, height: 4, hasAlpha: false });
  });

  it("un objeto que no llega nunca: tras el plazo da `decode-failed` y el resto sigue", async () => {
    vi.useFakeTimers();
    const { doc } = fakeDoc([
      {
        ops: [...place("img_never", 40, 40), ...place("img_ok", 30, 30)],
        objs: { img_ok: rgba(4, 4, [5, 5, 5, 255]) },
        never: ["img_never"],
      },
    ]);
    // El reloj falso salta el plazo de 20 s; los cedes de hilo (`setTimeout(0)`) que se vayan encolando se dejan correr tambien.
    const result = await drain(findImageAssets(doc, { ops: OPS, jpegIndex: null }), { fakeMs: 25_000 });
    expect(result.assets).toHaveLength(1);
    expect(result.warnings).toEqual([{ code: "decode-failed", pageIndex: 0, detail: "img_never" }]);
  });

  it("cancelar mientras se espera un objeto que no llega rechaza con AbortError (no espera al plazo)", async () => {
    const { doc } = fakeDoc([{ ops: place("img_never", 40, 40), never: ["img_never"] }]);
    const controller = new AbortController();
    const promise = findImageAssets(doc, { ops: OPS, jpegIndex: null, options: { signal: controller.signal } });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("tras un objeto que no llego, el siguiente espera menos (un documento roto no tarda minutos)", async () => {
    vi.useFakeTimers();
    const { doc } = fakeDoc([{ ops: [...place("never_1", 40, 40), ...place("never_2", 30, 30)], never: ["never_1", "never_2"] }]);
    const promise = findImageAssets(doc, { ops: OPS, jpegIndex: null });
    let finished = false;
    void promise.finally(() => {
      finished = true;
    });
    // 20 s del primero + 3 s del segundo = 23 s (y no 40 s).
    for (let i = 0; i < 24 && !finished; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(true);
    const result = await promise;
    expect(result.warnings.map((w) => w.code)).toEqual(["decode-failed", "decode-failed"]);
  });

  it("`drain` no se cuelga si el motor espera trabajo REAL que tarda mas que unas vueltas del bucle y despues cede el hilo con el reloj falso (el fallo del CI)", async () => {
    vi.useFakeTimers();
    // Lo que hace el motor con la miniatura: espera algo real (zlib en el pool de hilos; aqui, 400 ms de reloj REAL, mas de lo que
    // duraban las 120-200 vueltas del bucle anterior) y DESPUES pide un `setTimeout(0)` (el cede de hilo), que es del reloj falso.
    const engine = (async () => {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 400));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return "fin";
    })();
    expect(await drain(engine)).toBe("fin");
  });

  it("`drain` falla con un mensaje claro (no se cuelga) si el motor espera algo que no es ni temporizador ni trabajo real", async () => {
    vi.useFakeTimers();
    await expect(drain(new Promise<never>(() => undefined), { realMs: 300 })).rejects.toThrow(/no termino en 300 ms reales/);
    await expect(drain(new Promise<never>((resolve) => setTimeout(resolve, 60_000)), { fakeMs: 5_000 })).rejects.toThrow(/no termino en 5000 ms de reloj falso/);
  });

  it("un objeto nulo (pdf.js no pudo decodificarlo) da `decode-failed` UNA sola vez aunque se pinte varias", async () => {
    const { doc } = fakeDoc([{ ops: [...place("img_bad", 40, 40), ...place("img_bad", 20, 20)], objs: { img_bad: null } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["decode-failed"]);
  });

  it("una pagina cuya lista de operadores falla no rompe las demas", async () => {
    const { doc, cleaned } = fakeDoc([
      { ops: place("img_a", 40, 40), objs: { img_a: rgba(4, 4, [1, 1, 1, 255]) } },
      { ops: [], failOperatorList: true },
      { ops: place("img_c", 40, 40), objs: { img_c: rgba(4, 4, [200, 1, 1, 255]) } },
    ]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(2);
    expect(result.warnings).toEqual([{ code: "decode-failed", pageIndex: 1, detail: "pagina rota" }]);
    expect(cleaned).toEqual([1, 2, 3]);
  });

  it("el mismo objeto en dos paginas (objId global) se decodifica una vez y suma las dos apariciones", async () => {
    vi.useFakeTimers();
    const shared = rgba(4, 4, [7, 7, 7, 255]);
    const { doc } = fakeDoc([
      { ops: place("g_d_img_p0_1", 40, 40), common: { g_d_img_p0_1: shared } },
      { ops: place("g_d_img_p0_1", 50, 50), common: { g_d_img_p0_1: shared } },
    ]);
    const result = await drain(findImageAssets(doc, { ops: OPS, jpegIndex: null }));
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 1]);
  });

  it("dos objetos con la misma referencia de PDF (`ref`) son el mismo elemento aunque cambien los pixeles leidos", async () => {
    const a = { ...rgba(4, 4, [10, 20, 30, 255]), ref: "12R" };
    const b = { ...rgba(4, 4, [99, 20, 30, 255]), ref: "12R" };
    const { doc } = fakeDoc([
      { ops: place("img_1", 40, 40), objs: { img_1: a } },
      { ops: place("img_2", 40, 40), objs: { img_2: b } },
    ]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].occurrences).toHaveLength(2);
  });

  it("la ref de pdf.js tambien se entiende como objeto { num, gen }", async () => {
    const a = { ...rgba(4, 4, [10, 20, 30, 255]), ref: { num: 5, gen: 0 } };
    const b = { ...rgba(4, 4, [11, 20, 30, 255]), ref: { num: 5, gen: 0 } };
    const { doc } = fakeDoc([{ ops: [...place("img_1", 40, 40), ...place("img_2", 20, 20)], objs: { img_1: a, img_2: b } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(1);
  });

  it("dos imagenes grandes que solo difieren en un detalle mas fino que una celda de la miniatura NO se agrupan (muestra de pixeles)", async () => {
    const a = rgba(1000, 1000, [100, 100, 100, 255]);
    const b = rgba(1000, 1000, [100, 100, 100, 255]);
    b.data.set([102, 100, 100, 255], 12 * 4); // el pixel 13: dentro de la muestra, pero invisible en la miniatura (media de ~15 pixeles)
    const { doc } = fakeDoc([{ ops: [...place("a", 40, 40), ...place("b", 20, 20)], objs: { a, b } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(2);
  });

  it("imagenes distintas con otras medidas NO se agrupan aunque se parezcan", async () => {
    const { doc } = fakeDoc([{ ops: [...place("a", 40, 40), ...place("b", 20, 20)], objs: { a: rgba(4, 4, [10, 20, 30, 255]), b: rgba(8, 2, [10, 20, 30, 255]) } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(2);
  });
});

describe("pagina escaneada (con un pdf.js de mentira)", () => {
  const fullPage: Array<[number, unknown]> = [
    [OPS.save, null],
    [OPS.transform, [100, 0, 0, 100, 0, 0]],
    [OPS.paintImageXObject, ["img_scan", 4, 4]],
    [OPS.restore, null],
  ];

  it("imagen a pagina completa y sin texto: escaneada", async () => {
    const { doc } = fakeDoc([{ ops: fullPage, objs: { img_scan: rgba(4, 4, [200, 200, 200, 255]) } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.scannedPages).toEqual([0]);
  });

  it("con poco texto (menos de 24 caracteres: un numero de pagina) sigue siendo escaneada; con 24 o mas, no", async () => {
    const short = fakeDoc([{ ops: fullPage, objs: { img_scan: rgba(4, 4, [200, 200, 200, 255]) }, text: ["Pag. 3", "  "] }]);
    expect((await findImageAssets(short.doc, { ops: OPS, jpegIndex: null })).scannedPages).toEqual([0]);
    const long = fakeDoc([{ ops: fullPage, objs: { img_scan: rgba(4, 4, [200, 200, 200, 255]) }, text: ["x".repeat(24)] }]);
    expect((await findImageAssets(long.doc, { ops: OPS, jpegIndex: null })).scannedPages).toEqual([]);
  });

  it("una imagen que cubre el 80 % no es un escaneo; dos mitades que suman el 100 % si", async () => {
    const eighty: Array<[number, unknown]> = [
      [OPS.transform, [80, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ["img_scan", 4, 4]],
    ];
    const a = fakeDoc([{ ops: eighty, objs: { img_scan: rgba(4, 4, [1, 1, 1, 255]) } }]);
    expect((await findImageAssets(a.doc, { ops: OPS, jpegIndex: null })).scannedPages).toEqual([]);
    const halves: Array<[number, unknown]> = [
      [OPS.save, null], [OPS.transform, [100, 0, 0, 50, 0, 0]], [OPS.paintImageXObject, ["top", 4, 4]], [OPS.restore, null],
      [OPS.save, null], [OPS.transform, [100, 0, 0, 50, 0, 50]], [OPS.paintImageXObject, ["bottom", 4, 4]], [OPS.restore, null],
    ];
    const b = fakeDoc([{ ops: halves, objs: { top: rgba(4, 4, [1, 1, 1, 255]), bottom: rgba(4, 4, [9, 9, 9, 255]) } }]);
    expect((await findImageAssets(b.doc, { ops: OPS, jpegIndex: null })).scannedPages).toEqual([0]);
  });
});

describe("imagenes del navegador (ImageBitmap) con un canvas de mentira", () => {
  const original = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  afterEach(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = original;
  });

  function fakeBitmap(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): { width: number; height: number; data: Uint8ClampedArray; close: () => void } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
    return { width, height, data, close: vi.fn() };
  }

  function installCanvas(): void {
    class FakeCanvas {
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.pixels = new Uint8ClampedArray(width * height * 4);
      }
      getContext(): unknown {
        const self: { width: number; pixels: Uint8ClampedArray } = { width: this.width, pixels: this.pixels };
        return {
          clearRect: () => self.pixels.fill(0),
          drawImage: (bitmap: { data: Uint8ClampedArray }, ...a: number[]) => {
            if (a.length === 2) {
              self.pixels.set(bitmap.data.subarray(0, self.pixels.length));
              return;
            }
            const [, sy, , sh, , dy] = a;
            for (let r = 0; r < sh; r += 1) self.pixels.set(bitmap.data.subarray((sy + r) * self.width * 4, (sy + r + 1) * self.width * 4), (dy + r) * self.width * 4);
          },
          getImageData: (_x: number, y: number, _w: number, h: number) => ({ data: self.pixels.slice(y * self.width * 4, (y + h) * self.width * 4) }),
        };
      }
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
      }
    }
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeCanvas;
  }

  it("encuentra la imagen, ve su alfa y NO cierra el bitmap de pdf.js", async () => {
    installCanvas();
    const bitmap = fakeBitmap(6, 4, (x) => [x * 40, 10, 10, x === 0 ? 0 : 255]);
    const { doc } = fakeDoc([{ ops: place("img_b", 60, 40), objs: { img_b: { width: 6, height: 4, bitmap } } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].pixel).toEqual({ width: 6, height: 4, hasAlpha: true });
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("el PNG de un bitmap sale del canvas nativo", async () => {
    installCanvas();
    const bitmap = fakeBitmap(2, 2, () => [1, 2, 3, 255]);
    const { doc } = fakeDoc([{ ops: place("img_b", 20, 20), objs: { img_b: { width: 2, height: 2, bitmap } } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    const blob = await renderImageAsset(doc, result.assets[0], "png", { ops: OPS });
    expect([...(await blobBytes(blob))]).toEqual([137, 80, 78, 71]);
  });

  it("una mascara en bitmap se colorea con el color de relleno vigente", async () => {
    installCanvas();
    const bitmap = fakeBitmap(2, 1, (x) => [0, 0, 0, x === 0 ? 255 : 0]);
    const ops: Array<[number, unknown]> = [
      [OPS.setFillRGBColor, ["#0000ff"]],
      [OPS.paintImageMaskXObject, [{ data: "mask_1", width: 2, height: 1 }]],
    ];
    const { doc } = fakeDoc([{ ops, objs: { mask_1: { width: 2, height: 1, bitmap } } }]);
    const result = await findImageAssets(doc, { ops: OPS, jpegIndex: null });
    expect(result.assets[0].source).toBe("mask");
    // Sin canvas nativo para una mascara recoloreada: sale por el codificador PNG de JS, con los pixeles de la fuente.
    const png = decodePng(await blobBytes(await renderImageAsset(doc, result.assets[0], "png", { ops: OPS })));
    expect([...png.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 0]);
  });
});
