import { describe, expect, it } from "vitest";
import { BMP_HEADER_BYTES, bmpByteLength, encodeBmp, parseHexColor } from "@/lib/media/image/bmp";

/** Pixeles RGBA de una imagen de `width` x `height` donde `pixel(x, y)` da [r, g, b, a]. */
function rgbaOf(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  return data;
}

describe("encodeBmp", () => {
  it("escribe una cabecera BMP de 24 bits con las dimensiones y el peso correctos", () => {
    const bytes = encodeBmp(rgbaOf(3, 2, () => [10, 20, 30, 255]), 3, 2);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("BM");
    expect(view.getUint32(2, true)).toBe(bytes.length);
    expect(view.getUint32(10, true)).toBe(BMP_HEADER_BYTES);
    expect(view.getInt32(18, true)).toBe(3);
    expect(view.getInt32(22, true)).toBe(2);
    expect(view.getUint16(28, true)).toBe(24);
    // Filas de 9 bytes rellenadas a 12.
    expect(bytes.length).toBe(54 + 12 * 2);
    expect(bmpByteLength(3, 2)).toBe(bytes.length);
  });

  it("guarda las filas de abajo arriba y los canales en orden BGR", () => {
    // Fila 0 (arriba): rojo | verde. Fila 1 (abajo): azul | blanco.
    const rgba = rgbaOf(2, 2, (x, y) => (y === 0 ? (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : x === 0 ? [0, 0, 255, 255] : [255, 255, 255, 255]));
    const bytes = encodeBmp(rgba, 2, 2);
    const stride = 8; // 6 bytes de pixeles + 2 de relleno
    const pixel = (row: number, x: number): number[] => Array.from(bytes.slice(54 + row * stride + x * 3, 54 + row * stride + x * 3 + 3));
    // La primera fila guardada es la de abajo: azul (BGR = 255,0,0) y blanco.
    expect(pixel(0, 0)).toEqual([255, 0, 0]);
    expect(pixel(0, 1)).toEqual([255, 255, 255]);
    // La segunda es la de arriba: rojo (BGR = 0,0,255) y verde.
    expect(pixel(1, 0)).toEqual([0, 0, 255]);
    expect(pixel(1, 1)).toEqual([0, 255, 0]);
  });

  it("aplana la transparencia sobre el color de fondo", () => {
    const rgba = rgbaOf(2, 1, (x) => (x === 0 ? [255, 0, 0, 0] : [0, 0, 0, 128]));
    const bytes = encodeBmp(rgba, 2, 1, "#00ff00");
    // Totalmente transparente: el fondo (verde, BGR 0,255,0).
    expect(Array.from(bytes.slice(54, 57))).toEqual([0, 255, 0]);
    // Negro al 50 %: la mitad del verde de fondo.
    expect(Array.from(bytes.slice(57, 60))).toEqual([0, 127, 0]);
  });

  it("rechaza dimensiones que no cuadran con los pixeles", () => {
    expect(() => encodeBmp(new Uint8ClampedArray(4), 2, 2)).toThrow();
    expect(() => encodeBmp(new Uint8ClampedArray(0), 0, 0)).toThrow();
  });
});

describe("parseHexColor", () => {
  it("lee #rrggbb y #rgb, con o sin almohadilla", () => {
    expect(parseHexColor("#102030")).toEqual([16, 32, 48]);
    expect(parseHexColor("fff")).toEqual([255, 255, 255]);
    expect(parseHexColor("#F80")).toEqual([255, 136, 0]);
  });

  it("cualquier otra cosa es blanco", () => {
    expect(parseHexColor("rojo")).toEqual([255, 255, 255]);
    expect(parseHexColor("")).toEqual([255, 255, 255]);
  });
});
