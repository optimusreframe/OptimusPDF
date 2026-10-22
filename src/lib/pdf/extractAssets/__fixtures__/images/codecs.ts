/**
 * Imagenes JPX (JPEG 2000) y JBIG2 SINTETICAS y minimas para probar los decodificadores WASM de pdf.js (U7.0) y el motor
 * de imagenes incrustadas (U7.1). Todo es reproducible y sin datos reales:
 *
 * - JPX: 32 x 20 px RGB sin perdida (5/3 reversible), generada UNA vez con Pillow y embebida en base64 (1176 bytes):
 *     im = Image.new("RGB", (32, 20)); mitad izquierda (220,30,30), derecha (30,40,220); `ImageDraw.line((0,0,31,19), white)`;
 *     `rectangle((12,6,19,13), (20,200,20))`; `im.save(buf, "JPEG2000", irreversible=False, num_resolutions=3)`.
 *   `jpxExpectedPixel(x, y)` reproduce esos pixeles para comparar la decodificacion exactamente.
 * - JBIG2: region generica con codificacion MMR (T.6) escrita a mano por `jbig2Stream` (segmentos de pagina y region
 *   inmediata, sin cabecera de archivo, como van dentro de un PDF). No hay codificador JBIG2 en el proyecto: este es un
 *   codificador T.6 minimo (modos paso, vertical y horizontal; carreras de hasta 16 px).
 */

export const JPX_WIDTH = 32;
export const JPX_HEIGHT = 20;

const JPX_BASE64 =
  "AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAFAAAACAAAwcHAAAAAAAPY29scgEAAAAA" +
  "ABAAAARLanAyY/9P/1EALwAAAAAAIAAAABQAAAAAAAAAAAAAACAAAAAUAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAIEBAAB" +
  "/1wACkBASEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS4z/5AACgAAAAADzQAB/5PfgUBKs9iCxHES" +
  "v3YuHd0g6yDndS6wiWEfSK6jpPgy1VrcSamYohJbNzcX34FIHH2YgWeZEFk1XLxp1M2bzBybjTCSExpiCIUNumZfOJMkn0eNgmpA" +
  "pJ/fgVggNQzXwUxaeWej0sjioEmmJPVsbgQZB/e1ltNI+u0v3Bg9/Ke9ppKn+Gqtz8B2PtHY/AeAHn+wKLcpLvCZr0BtefsfDYia" +
  "NkniJEAVU5SV0H8gGpmN146cCJfrNRwcOyFSH+RwjleFYH4WTA/wL1rgN98w9/lZKpKeppo5VTXoCBWSVL+9RIItZ81Mv8faPz8B" +
  "+PwIgBbi4pfcbvRDxg+EyjOkXZQhSHANP8btFIkGs8gek88YAWf61gqg2TiLyGlIj8M1NIKWR8U1BKNGvqu0cuzJFwsccpXrmuwi" +
  "J3yO0J/x9UHtj7H5/plKBjNffXc6DwPGx8faPT8B2PwHQBbkPKf7s5ss/nPCLF55D/MVr+4ZFM8IWjE/xawnnxgBc44m8IXG7Tti" +
  "djVfoEXFwO6pl0q9O+tW5Eu/FwsgTbjqb3MZNiY+lbqlzxgojhoJsBjOYP7QcgvH2n0/A1n5mQAuRVAAgStUpNzRos43HakFcCid" +
  "tH6s1QHw7+UjT1BdnpCrHBR1oPfolZiXtmFV+pmQoX8o7UaqgUBDQtdbf4d9kelLIxQylCYoUlBbMmSrHqhWq2AKAG+3XOInz4PV" +
  "ufWCTOS/1kfSrZKHWqgyUbY4ajVfxxC/cNu5QbZdzR8QnYywfHZEdtTzXrcHWZytXsZXtkZYsPpW47hRuchYBeXcuJ9LNofH2oE/" +
  "A5n5moAXUEz6aKKXRy4uVMq6h+0NQPBmzVWlWj66bplacku+8ahyIpOGMx+rqVSjj+/16V0i1uPTQROuX4QkAzSONPQ3GCooIL3Q" +
  "2x71DfCyhXNh7vwDYiVam8D1LJSfAm1bepuyvpg8MFQNPvAJkNGu+2Iu7H35/eiMv95FG7+FRnwmuwC6jxI2dHTTxfEeNlC92/wU" +
  "H2eaNfG5jgz5nWeJoeWY0RrgagCWag2dnrFFGRnH2ns/A0n5mAAXUhgwEMpUwXscVzDJE6u2aYi1hvFXnKebuDdQCxBmPNASpX91" +
  "SzedSsmBkTBfENQHX0u3qHyKJFIiwFpyGCooJltRcj5oI5Qmp4oFxu3yomB5GmJ5FaUL/BfAR8Rl9D7d/QBoY7mo8if2hdYm/zSM" +
  "Xxu/hUlmQ9yt70m8Yf3nVSVR1jPG8l2ezHciMXFfS50iSor1fPlRyIgJJz1T8AIAXP/Z";

export function jpxBytes(): Uint8Array {
  const binary = atob(JPX_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Pixeles blancos de la diagonal que dibujo Pillow (la parte que tapa el rectangulo verde no cuenta). */
const JPX_WHITE_LINE = new Set(
  [
    [0, 0], [1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 4], [7, 4], [8, 5], [9, 6], [10, 6], [11, 7],
    [20, 12], [21, 13], [22, 13], [23, 14], [24, 15], [25, 15], [26, 16], [27, 17], [28, 17], [29, 18], [30, 18], [31, 19],
  ].map(([x, y]) => y * JPX_WIDTH + x),
);

/** Pixel (r, g, b) esperado de la imagen JPX de arriba. */
export function jpxExpectedPixel(x: number, y: number): [number, number, number] {
  if (x >= 12 && x <= 19 && y >= 6 && y <= 13) return [20, 200, 20];
  if (JPX_WHITE_LINE.has(y * JPX_WIDTH + x)) return [255, 255, 255];
  return x < JPX_WIDTH / 2 ? [220, 30, 30] : [30, 40, 220];
}

/* ------------------------------------------------------------------ *
 * JBIG2 (region generica MMR)
 * ------------------------------------------------------------------ */

const WHITE_RUNS = [
  "00110101", "000111", "0111", "1000", "1011", "1100", "1110", "1111", "10011", "10100", "00111", "01000", "001000",
  "000011", "110100", "110101", "101010",
];
const BLACK_RUNS = [
  "0000110111", "010", "11", "10", "011", "0011", "0010", "00011", "000101", "000100", "0000100", "0000101", "0000111",
  "00000100", "00000111", "000011000", "0000010111",
];
const VERTICAL: Record<number, string> = { 0: "1", 1: "011", 2: "000011", 3: "0000011", [-1]: "010", [-2]: "000010", [-3]: "0000010" };

/** Mapa de bits: `rows[y][x]` es `true` si el pixel es NEGRO. */
export type Bitmap1 = boolean[][];

function changing(row: boolean[], from: number, color: boolean): number {
  // Primer elemento cambiante a la derecha de `from` (el pixel -1 es blanco) cuyo color es distinto de `color`.
  const width = row.length;
  for (let x = from + 1; x < width; x += 1) {
    const prev = x === 0 ? false : row[x - 1];
    if (row[x] !== prev && row[x] !== color) return x;
  }
  return width;
}

function nextChange(row: boolean[], from: number): number {
  // Primer pixel a la derecha de `from` cuyo color difiere del de `row[from]`.
  const width = row.length;
  const color = row[from];
  for (let x = from + 1; x < width; x += 1) if (row[x] !== color) return x;
  return width;
}

/** Codifica un mapa de bits en MMR (T.6) sin fin de bloque. Carreras horizontales de hasta 16 px. */
export function encodeMmr(bitmap: Bitmap1): Uint8Array {
  const width = bitmap[0]?.length ?? 0;
  let bits = "";
  const run = (color: boolean, length: number): string => {
    if (length > 16) throw new Error("carrera mayor de 16 px: no soportada por este codificador minimo");
    return (color ? BLACK_RUNS : WHITE_RUNS)[length];
  };
  let reference: boolean[] = new Array<boolean>(width).fill(false);
  for (const row of bitmap) {
    let a0 = -1;
    let color = false;
    while (a0 < width) {
      // a1: siguiente cambio de color en la linea actual; b1/b2: en la de referencia.
      const a1 = changing(row, a0, color);
      const b1 = changing(reference, a0, color);
      const b2 = b1 >= width ? width : nextChange(reference, b1);
      if (b2 < a1) {
        bits += "0001";
        a0 = b2;
        continue;
      }
      const delta = a1 - b1;
      if (Math.abs(delta) <= 3) {
        bits += VERTICAL[delta];
        a0 = a1;
        color = !color;
        continue;
      }
      const a2 = a1 >= width ? width : nextChange(row, a1);
      bits += "001" + run(color, a1 - Math.max(a0, 0)) + run(!color, a2 - a1);
      a0 = a2;
    }
    reference = row;
  }
  while (bits.length % 8 !== 0) bits += "0";
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function segment(number: number, type: number, data: number[]): number[] {
  // Cabecera: numero (4), banderas (1: tipo, asociacion a pagina de 1 byte), segmentos referidos (1: ninguno),
  // pagina (1), longitud de datos (4).
  return [...u32(number), type, 0, 1, ...u32(data.length), ...data];
}

/** Flujo `/JBIG2Decode` de un PDF: pagina (segmento 48) + region generica inmediata MMR (segmento 38). */
export function jbig2Stream(bitmap: Bitmap1): Uint8Array {
  const height = bitmap.length;
  const width = bitmap[0]?.length ?? 0;
  const page = segment(0, 48, [...u32(width), ...u32(height), ...u32(0), ...u32(0), 0, 0, 0]);
  const region = segment(1, 38, [
    ...u32(width),
    ...u32(height),
    ...u32(0),
    ...u32(0),
    0, // combinacion OR
    1, // banderas de region generica: MMR = 1
    ...encodeMmr(bitmap),
  ]);
  return new Uint8Array([...page, ...region]);
}

/** Un dibujo de 16 x 12 con una «F» gruesa: sirve de verdad para comprobar el decodificador. */
export function jbig2SampleBitmap(): Bitmap1 {
  const rows = [
    "................",
    ".##########.....",
    ".##########.....",
    ".##.............",
    ".##.............",
    ".#########......",
    ".#########......",
    ".##.............",
    ".##.............",
    ".##.....##......",
    ".##.....##......",
    "................",
  ];
  return rows.map((r) => [...r].map((c) => c === "#"));
}
