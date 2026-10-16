import { deflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_MAX_ANCILLARY_BYTES,
  IMPORT_MAX_TEXT_CHUNK_BYTES,
  inspectPngStructure,
  validatePngForImport,
  verifyPngInflates,
} from "./pngImportGuard";
import { encodePngBytes, pngCrc32 } from "./inkPng";

/**
 * Guarda de los PNG de la importacion del respaldo (D5, U4.4-fix): PNG FORJADOS byte a byte (con CRC y zlib correctos
 * donde conviene, para que solo falle lo que se prueba) y, como contraste, un decodificador de verdad (`@napi-rs/canvas`)
 * que tiene que estar de acuerdo con el veredicto en los PNG buenos.
 */

afterEach(() => vi.unstubAllGlobals());

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer | Uint8Array, opts: { badCrc?: boolean } = {}): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((pngCrc32(body) ^ (opts.badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([head, body, crc]);
}

function ihdr(
  width: number,
  height: number,
  o: { depth?: number; color?: number; compression?: number; filter?: number; interlace?: number } = {},
): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = o.depth ?? 8;
  data[9] = o.color ?? 6;
  data[10] = o.compression ?? 0;
  data[11] = o.filter ?? 0;
  data[12] = o.interlace ?? 0;
  return chunk("IHDR", data);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Filas (con byte de filtro 0) de una imagen sin entrelazar: valores que dependen de `seed`. */
function rawRows(width: number, height: number, o: { depth?: number; color?: number; seed?: number } = {}): Buffer {
  const bits = (o.depth ?? 8) * CHANNELS[o.color ?? 6];
  const stride = 1 + Math.ceil((width * bits) / 8);
  const raw = Buffer.alloc(stride * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % stride === 0 ? 0 : ((o.seed ?? 3) * 31 + i * 7) & 0xff;
  return raw;
}

type Build = {
  width?: number;
  height?: number;
  depth?: number;
  color?: number;
  seed?: number;
  raw?: Buffer;
  /** bytes zlib ya hechos (para forjar un IDAT roto) */
  idat?: Buffer;
  before?: Buffer[];
  between?: Buffer[];
  after?: Buffer[];
  header?: Buffer;
  end?: Buffer | null;
  split?: boolean;
  interlace?: number;
};

function png(o: Build = {}): Uint8Array {
  const width = o.width ?? 24;
  const height = o.height ?? 12;
  const z = o.idat ?? deflateSync(o.raw ?? rawRows(width, height, o));
  const idats = o.split ? [chunk("IDAT", z.subarray(0, 5)), ...(o.between ?? []), chunk("IDAT", z.subarray(5))] : [chunk("IDAT", z)];
  const parts = [
    SIG,
    o.header ?? ihdr(width, height, o),
    ...(o.before ?? []),
    ...idats,
    ...(o.after ?? []),
    ...(o.end === null ? [] : [o.end ?? chunk("IEND", Buffer.alloc(0))]),
  ];
  return new Uint8Array(Buffer.concat(parts));
}

async function verdict(bytes: Uint8Array) {
  return validatePngForImport(bytes);
}

async function canvasDecodes(bytes: Uint8Array): Promise<boolean> {
  try {
    await loadImage(Buffer.from(bytes));
    return true;
  } catch {
    return false;
  }
}

describe("PNG validos — src/lib/image/pngImportGuard.ts", () => {
  it("un PNG RGBA 8 bit normal pasa y el decodificador real esta de acuerdo", async () => {
    const bytes = png();
    expect(await verdict(bytes)).toEqual({ ok: true });
    expect(await canvasDecodes(bytes)).toBe(true);
  });

  it("los PNG que fabrica la propia app (codificador de tinta y canvas) pasan", async () => {
    const data = new Uint8ClampedArray(60 * 20 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = i & 255;
      data[i + 3] = 255;
    }
    const ink = await encodePngBytes({ width: 60, height: 20, data });
    expect(await verdict(ink)).toEqual({ ok: true });
    const canvas = createCanvas(80, 30);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(3, 3, 40, 10);
    const fromCanvas = new Uint8Array(canvas.toBuffer("image/png"));
    expect(await verdict(fromCanvas)).toEqual({ ok: true });
    expect(await canvasDecodes(fromCanvas)).toBe(true);
  });

  it("otros formatos legitimos: gris, gris+alfa, RGB 16 bit, paleta de 4 bit y entrelazado Adam7", async () => {
    const palette = chunk("PLTE", Buffer.from(Array.from({ length: 16 * 3 }, (_, i) => (i * 5) & 255)));
    const cases: [string, Uint8Array][] = [
      ["gris 8", png({ color: 0 })],
      ["gris 1 bit", png({ color: 0, depth: 1, width: 19, height: 5 })],
      ["gris+alfa", png({ color: 4 })],
      ["RGB 16", png({ color: 2, depth: 16 })],
      ["paleta 4 bit", png({ color: 3, depth: 4, width: 17, height: 9, before: [palette] })],
    ];
    // Adam7: filas por pase con el ancho/alto de cada pase
    const rows: Buffer[] = [];
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
      const w = 21, h = 13;
      if (w <= x0 || h <= y0) continue;
      const pw = Math.ceil((w - x0) / dx);
      const ph = Math.ceil((h - y0) / dy);
      rows.push(rawRows(pw, ph, { color: 6 }));
    }
    cases.push(["Adam7", png({ width: 21, height: 13, interlace: 1, raw: Buffer.concat(rows) })]);
    for (const [label, bytes] of cases) {
      expect([label, await verdict(bytes), await canvasDecodes(bytes)]).toEqual([label, { ok: true }, true]);
    }
  });

  it("IDAT repartido en varios chunks contiguos y chunks auxiliares razonables (gAMA, pHYs, perfil de 3 KB, texto de 2 KB)", async () => {
    const bytes = png({
      split: true,
      before: [chunk("gAMA", Buffer.alloc(4, 1)), chunk("pHYs", Buffer.alloc(9)), chunk("iCCP", Buffer.alloc(3000, 7)), chunk("tEXt", Buffer.alloc(IMPORT_MAX_TEXT_CHUNK_BYTES, 65))],
    });
    expect(await verdict(bytes)).toEqual({ ok: true });
    expect(await canvasDecodes(bytes)).toBe(true);
  });

  it("4000x4000 (el mayor que cabe en 16 MP) pasa; 4096x4096 (16,8 MP, 64 MB) no", async () => {
    const ok = png({ width: 4000, height: 4000, raw: Buffer.alloc((1 + 4000 * 4) * 4000) });
    expect(await verdict(ok)).toEqual({ ok: true });
    const bomb = png({ width: 4096, height: 4096, raw: Buffer.alloc((1 + 4096 * 4) * 4096) });
    expect(await verdict(bomb)).toEqual({ ok: false, reason: "tooManyPixels" });
  }, 30_000);
});

describe("PNG hostiles que los validadores del baul dejaban pasar", () => {
  it("IDAT corrupto (con el CRC del chunk BIEN puesto): no se descomprime", async () => {
    const z = deflateSync(rawRows(24, 12));
    const flipped = Buffer.from(z);
    for (let i = 4; i < flipped.length - 8; i += 3) flipped[i] ^= 0xa5;
    const bytes = png({ idat: flipped });
    expect(inspectPngStructure(bytes).ok).toBe(true); // la estructura es correcta...
    expect(await verdict(bytes)).toEqual({ ok: false, reason: "undecodable" }); // ...pero los datos no
  });

  it("zlib truncado, sin Adler-32 o con basura al final", async () => {
    const z = deflateSync(rawRows(24, 12));
    for (const [label, idat] of [
      ["truncado", z.subarray(0, z.length - 9)],
      ["sin adler", z.subarray(0, z.length - 4)],
      ["adler mal", Buffer.concat([z.subarray(0, z.length - 1), Buffer.from([z[z.length - 1] ^ 0xff])])],
      ["cabecera zlib falsa", Buffer.concat([Buffer.from([0x00, 0x00]), z.subarray(2)])],
    ] as [string, Buffer][]) {
      expect([label, await verdict(png({ idat }))]).toEqual([label, { ok: false, reason: "undecodable" }]);
    }
  });

  it("datos de imagen de mas o de menos de lo que declara el IHDR", async () => {
    expect(await verdict(png({ raw: Buffer.concat([rawRows(24, 12), Buffer.alloc(1)]) }))).toEqual({ ok: false, reason: "undecodable" });
    expect(await verdict(png({ raw: rawRows(24, 11) }))).toEqual({ ok: false, reason: "undecodable" });
    expect(await verdict(png({ raw: Buffer.alloc(0) }))).toEqual({ ok: false, reason: "undecodable" });
  });

  it("IHDR pequeño pero el IDAT se infla a 64 MB+: se corta al pasar de lo declarado (sin inflar todo)", async () => {
    const bomb = png({ width: 8, height: 8, raw: Buffer.alloc(96 * 1024 * 1024) });
    const start = performance.now();
    expect(await verdict(bomb)).toEqual({ ok: false, reason: "undecodable" });
    expect(performance.now() - start).toBeLessThan(5000);
  }, 30_000);

  it("el byte de filtro de cada fila tiene que ser 0..4 (tambien en filas que cruzan trozos de lectura)", async () => {
    const raw = rawRows(24, 12);
    const stride = 1 + 24 * 4;
    for (const row of [0, 5, 11]) {
      const bad = Buffer.from(raw);
      bad[row * stride] = 5;
      expect([row, await verdict(png({ raw: bad }))]).toEqual([row, { ok: false, reason: "undecodable" }]);
    }
    const last = Buffer.from(raw);
    last[last.length - 1] = 0xff; // un byte de datos (no de filtro) puede valer lo que sea
    expect(await verdict(png({ raw: last }))).toEqual({ ok: true });
  });

  it("APNG: `acTL`, `fcTL` o `fdAT` presentes (con CRC valido) -> animado", async () => {
    for (const type of ["acTL", "fcTL", "fdAT"]) {
      const body = chunk(type, Buffer.alloc(8, 1));
      expect([type, await verdict(png({ before: [body] }))]).toEqual([type, { ok: false, reason: "animated" }]);
    }
    expect(await verdict(png({ after: [chunk("fdAT", Buffer.alloc(8))] }))).toEqual({ ok: false, reason: "animated" });
  });

  it("texto enorme: `tEXt`/`zTXt`/`iTXt` de 100 KB se rechazan; 2 KB pasa y 2 KB + 1 no", async () => {
    for (const type of ["tEXt", "zTXt", "iTXt"]) {
      expect([type, await verdict(png({ before: [chunk(type, Buffer.alloc(100_000, 65))] }))]).toEqual([type, { ok: false, reason: "oversizedMetadata" }]);
      expect([type, await verdict(png({ before: [chunk(type, Buffer.alloc(IMPORT_MAX_TEXT_CHUNK_BYTES, 65))] }))]).toEqual([type, { ok: true }]);
      expect(await verdict(png({ before: [chunk(type, Buffer.alloc(IMPORT_MAX_TEXT_CHUNK_BYTES + 1, 65))] }))).toEqual({ ok: false, reason: "oversizedMetadata" });
    }
  });

  it("metadatos auxiliares de cualquier tipo: el total no pasa de 64 KB", async () => {
    const many = Array.from({ length: 30 }, () => chunk("prVt", Buffer.alloc(2000, 1)));
    expect(many.length * 2000).toBeLessThan(IMPORT_MAX_ANCILLARY_BYTES);
    expect(await verdict(png({ before: many }))).toEqual({ ok: true });
    const tooMany = Array.from({ length: 10 }, () => chunk("prVt", Buffer.alloc(1700, 1)));
    expect(await verdict(png({ before: [...many, ...tooMany] }))).toEqual({ ok: false, reason: "oversizedMetadata" });
    expect(await verdict(png({ before: [chunk("eXIf", Buffer.alloc(IMPORT_MAX_ANCILLARY_BYTES + 1))] }))).toEqual({ ok: false, reason: "oversizedMetadata" });
  });

  it("pixeles: 4096x4096 y 4000x4001 (> 16 MP) fuera aunque el IDAT sea diminuto; lados 0 o > 4096 son malformados", async () => {
    const tiny = (w: number, h: number) => png({ width: w, height: h, idat: deflateSync(Buffer.alloc(1)) });
    expect(await verdict(tiny(4096, 4096))).toEqual({ ok: false, reason: "tooManyPixels" });
    expect(await verdict(tiny(4000, 4001))).toEqual({ ok: false, reason: "tooManyPixels" });
    for (const [w, h] of [[0, 10], [10, 0], [4097, 10], [10, 4097], [0, 0]]) {
      expect([w, h, await verdict(tiny(w, h))]).toEqual([w, h, { ok: false, reason: "malformed" }]);
    }
  });

  it("memoria descomprimida: un RGBA de 16 bit de 4096x2048 (64 MB + 2 KB) no pasa aunque quepa en pixeles", async () => {
    const result = inspectPngStructure(png({ width: 4096, height: 2048, depth: 16, color: 6, idat: deflateSync(Buffer.alloc(1)) }));
    expect(result).toEqual({ ok: false, reason: "tooManyPixels" });
  });
});

describe("estructura PNG", () => {
  it("el CRC de CUALQUIER chunk tiene que cuadrar (IHDR, auxiliar, IDAT, IEND)", async () => {
    const cases: [string, Uint8Array][] = [
      ["IHDR", png({ header: Buffer.concat([ihdr(24, 12).subarray(0, 8 + 13), Buffer.from([0, 0, 0, 0])]) })],
      ["auxiliar", png({ before: [chunk("gAMA", Buffer.alloc(4), { badCrc: true })] })],
      ["IEND", png({ end: chunk("IEND", Buffer.alloc(0), { badCrc: true }) })],
    ];
    const z = deflateSync(rawRows(24, 12));
    const idat = chunk("IDAT", z, { badCrc: true });
    cases.push(["IDAT", new Uint8Array(Buffer.concat([SIG, ihdr(24, 12), idat, chunk("IEND", Buffer.alloc(0))]))]);
    for (const [label, bytes] of cases) {
      expect([label, await verdict(bytes)]).toEqual([label, { ok: false, reason: "malformed" }]);
    }
  });

  it("no es un PNG: firma falsa, vacio, corto, tipos de chunk con basura, longitud que se sale del archivo", async () => {
    const good = png();
    const bad: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(40),
      good.subarray(0, 20),
      good.subarray(0, good.length - 1),
      Uint8Array.from(good, (b, i) => (i === 1 ? 0x51 : b)),
      new Uint8Array(Buffer.concat([SIG, chunk("IHDR", Buffer.alloc(12))])),
    ];
    for (const [i, bytes] of bad.entries()) expect([i, await verdict(bytes)]).toEqual([i, { ok: false, reason: "malformed" }]);
    expect(inspectPngStructure("no" as unknown as Uint8Array)).toEqual({ ok: false, reason: "malformed" });
    expect(await validatePngForImport(null as unknown as Uint8Array)).toEqual({ ok: false, reason: "malformed" });
  });

  it("orden: nada detras del IEND, sin IEND, IDAT separados, IHDR repetido, PLTE tras el IDAT o repetida", async () => {
    const palette = chunk("PLTE", Buffer.alloc(12, 9));
    const cases: [string, Uint8Array][] = [
      ["bytes tras IEND", new Uint8Array(Buffer.concat([png(), Buffer.from([0])]))],
      ["otro chunk tras IEND", new Uint8Array(Buffer.concat([png(), chunk("gAMA", Buffer.alloc(4))]))],
      ["sin IEND", png({ end: null })],
      ["IDAT separados", png({ split: true, between: [chunk("gAMA", Buffer.alloc(4))] })],
      ["IHDR repetido", png({ before: [ihdr(24, 12)] })],
      ["PLTE tras IDAT", png({ color: 6, after: [palette] })],
      ["PLTE repetida", png({ color: 3, depth: 8, before: [palette, palette] })],
      ["PLTE en gris", png({ color: 0, before: [palette] })],
      ["PLTE de largo no multiplo de 3", png({ color: 3, before: [chunk("PLTE", Buffer.alloc(10))] })],
      ["tipo 3 sin paleta", png({ color: 3 })],
      ["paleta con mas colores que la profundidad", png({ color: 3, depth: 1, before: [chunk("PLTE", Buffer.alloc(9))] })],
      ["sin IDAT", new Uint8Array(Buffer.concat([SIG, ihdr(24, 12), chunk("IEND", Buffer.alloc(0))]))],
      ["IEND con datos", png({ end: chunk("IEND", Buffer.alloc(3)) })],
      ["chunk critico desconocido", png({ before: [chunk("ABCD", Buffer.alloc(4))] })],
      ["IHDR no es el primero", new Uint8Array(Buffer.concat([SIG, chunk("gAMA", Buffer.alloc(4)), ihdr(24, 12), chunk("IDAT", deflateSync(rawRows(24, 12))), chunk("IEND", Buffer.alloc(0))]))],
    ];
    for (const [label, bytes] of cases) {
      expect([label, (await verdict(bytes)).ok]).toEqual([label, false]);
    }
  });

  it("combinaciones invalidas de tipo de color / profundidad y campos reservados del IHDR", async () => {
    const cases: [string, Build][] = [
      ["RGB 4 bit", { color: 2, depth: 4 }],
      ["gris+alfa 4", { color: 4, depth: 4 }],
      ["paleta 16", { color: 3, depth: 16 }],
      ["RGBA 1", { color: 6, depth: 1 }],
      ["tipo 5", { color: 5 }],
      ["profundidad 0", { depth: 0 }],
      ["compresion 1", { header: ihdr(24, 12, { compression: 1 }) }],
      ["filtro 1", { header: ihdr(24, 12, { filter: 1 }) }],
      ["entrelazado 2", { header: ihdr(24, 12, { interlace: 2 }) }],
    ];
    for (const [label, build] of cases) {
      const bytes = png({ ...build, idat: deflateSync(Buffer.alloc(8)) });
      expect([label, await verdict(bytes)]).toEqual([label, { ok: false, reason: "malformed" }]);
    }
  });
});

describe("entorno del navegador", () => {
  it("con createImageBitmap: se decodifica de verdad; si lo rechaza, la imagen no es valida; el bitmap se libera", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close })));
    expect(await verdict(png())).toEqual({ ok: true });
    expect(close).toHaveBeenCalledTimes(1);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("InvalidStateError");
    }));
    expect(await verdict(png())).toEqual({ ok: false, reason: "undecodable" });
  });

  it("sin DecompressionStream solo valen los controles de estructura (y un PNG bueno sigue pasando)", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    expect(await verdict(png())).toEqual({ ok: true });
    expect(await verdict(png({ before: [chunk("acTL", Buffer.alloc(8))] }))).toEqual({ ok: false, reason: "animated" });
    expect(await verdict(png({ before: [chunk("tEXt", Buffer.alloc(5000))] }))).toEqual({ ok: false, reason: "oversizedMetadata" });
  });

  it("verifyPngInflates no lanza con un flujo imposible y devuelve false", async () => {
    const structure = inspectPngStructure(png({ idat: Buffer.from([1, 2, 3]) }));
    expect(structure.ok).toBe(true);
    if (structure.ok) expect(await verifyPngInflates(structure)).toBe(false);
  });

  it("nunca lanza ante entradas absurdas", async () => {
    for (const value of [undefined, 5, "x", {}, [], new Uint8Array(3), new Uint8Array(100_000).fill(0x89)]) {
      expect((await validatePngForImport(value as never)).ok).toBe(false);
    }
  });
});
