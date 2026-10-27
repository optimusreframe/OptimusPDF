import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { flateImageToPng, hasDecompressionStream, reduceFlateImage, unfilterRow, type FlateSpec } from "./imagesFlate";
import { Slicer } from "./imagesPixels";
import { decodePng } from "./images.testUtils";

/** Reduccion en streaming y PNG sin pdf.js de las imagenes Flate enormes (H11): filtros PNG, promedios, flujos danados. */

const slicer = () => new Slicer();

/** Imagen de prueba: pixel (x, y) con colores que cambian en los dos ejes (para que cada filtro tenga algo que predecir). */
function pixelAt(x: number, y: number, comps: 1 | 3): number[] {
  const r = (x * 5 + y * 3) & 0xff;
  return comps === 3 ? [r, (x * 2 + y * 9) & 0xff, (x ^ y) & 0xff] : [r];
}

/** Filas crudas (sin filtro) de una imagen. */
function rawRows(width: number, height: number, comps: 1 | 3): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(width * comps);
    for (let x = 0; x < width; x += 1) row.set(pixelAt(x, y, comps), x * comps);
    rows.push(row);
  }
  return rows;
}

/** Filtra una fila con el filtro PNG `type` (el inverso de `unfilterRow`). */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let predicted = 0;
    if (type === 1) predicted = a;
    else if (type === 2) predicted = b;
    else if (type === 3) predicted = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[1 + i] = (row[i] - predicted) & 0xff;
  }
  return out;
}

function specOf(width: number, height: number, comps: 1 | 3, predictor: "none" | number[]): { spec: FlateSpec; rows: Uint8Array[] } {
  const rows = rawRows(width, height, comps);
  const parts: Uint8Array[] = [];
  let prev: Uint8Array = new Uint8Array(width * comps);
  rows.forEach((row, y) => {
    if (predictor === "none") parts.push(row);
    else parts.push(filterRow(predictor[y % predictor.length], row, prev, comps));
    prev = row;
  });
  return { spec: { bytes: new Uint8Array(zlib.deflateSync(Buffer.concat(parts))) as Uint8Array, comps, png: predictor !== "none" }, rows };
}

describe("unfilterRow · los cinco filtros PNG", () => {
  it.each([0, 1, 2, 3, 4])("filtro %i: desfiltrar devuelve la fila original (RGB)", (type) => {
    const rows = rawRows(23, 4, 3);
    let prev: Uint8Array = new Uint8Array(23 * 3);
    for (const row of rows) {
      const filtered = filterRow(type, row, prev, 3);
      const cur = filtered.slice(1);
      expect(unfilterRow(type, cur, prev, 3)).toBe(true);
      expect([...cur]).toEqual([...row]);
      prev = row;
    }
  });
  it("un filtro desconocido (5) se rechaza", () => {
    expect(unfilterRow(5, new Uint8Array(6), new Uint8Array(6), 3)).toBe(false);
  });
});

describe("reduceFlateImage", () => {
  it("existe DecompressionStream (Node 18+ y todos los navegadores actuales)", () => {
    expect(hasDecompressionStream()).toBe(true);
  });

  it("sin predictor: promedia cada celda de la rejilla reducida (RGB, 100 x 60 -> 50 x 30)", async () => {
    const { spec, rows } = specOf(100, 60, 3, "none");
    const reduced = await reduceFlateImage(spec, { width: 100, height: 60 }, 50, slicer());
    expect(reduced).not.toBeNull();
    expect([reduced!.width, reduced!.height]).toEqual([50, 30]);
    // Celda (ox, oy) = promedio de los 2 x 2 pixeles que cubre.
    for (const [ox, oy] of [[0, 0], [10, 7], [49, 29], [25, 15]]) {
      for (let c = 0; c < 3; c += 1) {
        const sum = rows[oy * 2][ox * 6 + c] + rows[oy * 2][ox * 6 + 3 + c] + rows[oy * 2 + 1][ox * 6 + c] + rows[oy * 2 + 1][ox * 6 + 3 + c];
        expect(reduced!.data[(oy * 50 + ox) * 4 + c], `celda ${ox},${oy} canal ${c}`).toBe(Math.round(sum / 4));
      }
      expect(reduced!.data[(oy * 50 + ox) * 4 + 3]).toBe(255);
    }
  });

  it("con predictor PNG (los cinco filtros alternados) da el MISMO resultado que sin predictor", async () => {
    const plain = specOf(64, 40, 3, "none").spec;
    const filtered = specOf(64, 40, 3, [0, 1, 2, 3, 4]).spec;
    const a = await reduceFlateImage(plain, { width: 64, height: 40 }, 32, slicer());
    const b = await reduceFlateImage(filtered, { width: 64, height: 40 }, 32, slicer());
    expect(a).not.toBeNull();
    expect([...b!.data]).toEqual([...a!.data]);
  });

  it("gris de 8 bits: los tres canales iguales", async () => {
    const { spec, rows } = specOf(40, 20, 1, [4]);
    const reduced = await reduceFlateImage(spec, { width: 40, height: 20 }, 20, slicer());
    const sum = rows[0][0] + rows[0][1] + rows[1][0] + rows[1][1];
    expect([...reduced!.data.subarray(0, 4)]).toEqual([Math.round(sum / 4), Math.round(sum / 4), Math.round(sum / 4), 255]);
  });

  it("no agranda: una imagen mas pequena que el lado maximo sale a su tamano, y tamanos que no dividen exacto tambien funcionan", async () => {
    const small = specOf(30, 18, 3, "none").spec;
    expect((await reduceFlateImage(small, { width: 30, height: 18 }, 1024, slicer()))!.width).toBe(30);
    const odd = await reduceFlateImage(specOf(101, 67, 3, [2]).spec, { width: 101, height: 67 }, 33, slicer());
    expect([odd!.width, odd!.height]).toEqual([33, 22]);
    expect(odd!.data.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
  });

  it("un flujo truncado, danado o con un filtro desconocido da `null` (la imagen sin miniatura, no un error)", async () => {
    const { spec } = specOf(64, 40, 3, [1]);
    expect(await reduceFlateImage({ ...spec, bytes: spec.bytes.subarray(0, Math.floor(spec.bytes.length / 2)) }, { width: 64, height: 40 }, 32, slicer())).toBeNull();
    expect(await reduceFlateImage({ ...spec, bytes: new Uint8Array([1, 2, 3, 4, 5]) }, { width: 64, height: 40 }, 32, slicer())).toBeNull();
    const badFilter = new Uint8Array(zlib.deflateSync(Buffer.concat(Array.from({ length: 40 }, () => Buffer.from([9, ...new Uint8Array(64 * 3)])))));
    expect(await reduceFlateImage({ bytes: badFilter, comps: 3, png: true }, { width: 64, height: 40 }, 32, slicer())).toBeNull();
  });

  it("una bomba de descompresion no se lee mas alla de la ultima fila", async () => {
    const huge = new Uint8Array(zlib.deflateSync(Buffer.alloc(64 * 3 * 400)));
    const reduced = await reduceFlateImage({ bytes: huge, comps: 3, png: false }, { width: 64, height: 40 }, 32, slicer());
    expect(reduced).not.toBeNull();
    expect(reduced!.height).toBe(20);
  });

  it("cancelar rechaza con AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { spec } = specOf(64, 40, 3, "none");
    await expect(reduceFlateImage(spec, { width: 64, height: 40 }, 32, new Slicer(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function pixelsOfPng(blob: Blob): Promise<{ width: number; height: number; data: Uint8Array }> {
  return decodePng(new Uint8Array(await blob.arrayBuffer()));
}

describe("flateImageToPng · PNG sin decodificar con pdf.js", () => {
  const width = 70;
  const height = 41;
  it.each([
    ["RGB con predictor PNG (se envuelve tal cual)", 3 as const, [1, 2, 3, 4, 0]],
    ["RGB sin predictor (se recomprime con el filtro Sub)", 3 as const, "none" as const],
    ["gris con predictor PNG", 1 as const, [2]],
    ["gris sin predictor", 1 as const, "none" as const],
  ])("%s: los pixeles salen iguales", async (_name, comps, predictor) => {
    const { spec, rows } = specOf(width, height, comps, predictor);
    const png = await flateImageToPng(spec, { width, height }, slicer());
    expect(png).not.toBeNull();
    expect(png!.type).toBe("image/png");
    const decoded = await pixelsOfPng(png!);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [17, 23], [40, 5]]) {
      const expected = comps === 3 ? [...rows[y].subarray(x * 3, x * 3 + 3)] : [rows[y][x], rows[y][x], rows[y][x]];
      expect([...decoded.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)], `${x},${y}`).toEqual(expected);
      expect(decoded.data[(y * width + x) * 4 + 3]).toBe(255);
    }
    // Un navegador de verdad lo abre: lo comprueba tambien el decodificador de @napi-rs/canvas.
    const image = await loadImage(Buffer.from(await png!.arrayBuffer()));
    expect([image.width, image.height]).toEqual([width, height]);
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    expect([...canvas.getContext("2d").getImageData(17, 23, 1, 1).data].slice(0, 3)).toEqual(comps === 3 ? [...rows[23].subarray(51, 54)] : [rows[23][17], rows[23][17], rows[23][17]]);
  });

  it("un predictor PNG con una fila de menos o de mas NO se envuelve (flujo danado): `null`", async () => {
    const { spec } = specOf(width, height, 3, [1]);
    const short = new Uint8Array(zlib.deflateSync(Buffer.concat(Array.from({ length: height - 3 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)])))));
    expect(await flateImageToPng({ ...spec, bytes: short }, { width, height }, slicer())).toBeNull();
    const long = new Uint8Array(zlib.deflateSync(Buffer.concat(Array.from({ length: height + 3 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)])))));
    expect(await flateImageToPng({ ...spec, bytes: long }, { width, height }, slicer())).toBeNull();
    expect(await flateImageToPng({ ...spec, bytes: new Uint8Array([1, 2, 3]) }, { width, height }, slicer())).toBeNull();
  });
  it("sin predictor, un flujo truncado da `null`", async () => {
    const { spec } = specOf(width, height, 3, "none");
    expect(await flateImageToPng({ ...spec, bytes: spec.bytes.subarray(0, Math.floor(spec.bytes.length / 3)) }, { width, height }, slicer())).toBeNull();
  });
});
