import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUAD,
  clampQuad,
  inverseHomography,
  isDegenerateQuad,
  isFullFrameQuad,
  projectPoint,
  quadOutputSize,
  warpImageData,
  type QuadCorners,
  type RgbaImage,
} from "@/lib/scan/perspective";

/**
 * El nucleo de `perspective.ts` es aritmetica pura sobre un buffer RGBA:
 * no necesita canvas ni `ImageData` del DOM, asi que se prueba en el
 * entorno "node" del proyecto "engines" con imagenes sinteticas. La unica
 * parte que queda fuera es `warpPerspective`, que solo une este nucleo con
 * `createImageBitmap` y `canvas.toBlob` (ver limitaciones al final).
 */

function blankImage(width: number, height: number): RgbaImage {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

function setPixel(
  image: RgbaImage,
  x: number,
  y: number,
  rgb: [number, number, number],
): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgb[0];
  image.data[offset + 1] = rgb[1];
  image.data[offset + 2] = rgb[2];
  image.data[offset + 3] = 255;
}

function getPixel(
  image: RgbaImage,
  x: number,
  y: number,
): [number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

/** Rellena el rectangulo [x0,x1) x [y0,y1) con un color solido. */
function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) setPixel(image, x, y, rgb);
  }
}

const RED: [number, number, number] = [230, 25, 25];
const GREEN: [number, number, number] = [25, 200, 60];
const BLUE: [number, number, number] = [30, 90, 230];
const YELLOW: [number, number, number] = [235, 210, 20];
const BLACK: [number, number, number] = [0, 0, 0];

/**
 * Lienzo negro de 200x200 con un "documento" de 100x100 centrado y
 * dividido en cuatro cuadrantes de color distinto. Es el equivalente
 * sintetico del fixture de camara falsa que usa el e2e: cada cuadrante
 * identifica una esquina, asi que si el warp rota o refleja la imagen las
 * aserciones lo detectan.
 */
function syntheticDocument(): { image: RgbaImage; corners: QuadCorners } {
  const image = blankImage(200, 200);
  fillRect(image, 0, 0, 200, 200, BLACK);
  fillRect(image, 50, 50, 100, 100, RED);
  fillRect(image, 100, 50, 150, 100, GREEN);
  fillRect(image, 50, 100, 100, 150, BLUE);
  fillRect(image, 100, 100, 150, 150, YELLOW);

  return {
    image,
    corners: {
      topLeft: { x: 50 / 200, y: 50 / 200 },
      topRight: { x: 150 / 200, y: 50 / 200 },
      bottomRight: { x: 150 / 200, y: 150 / 200 },
      bottomLeft: { x: 50 / 200, y: 150 / 200 },
    },
  };
}

function expectColorClose(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance = 6,
): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}

describe("quadOutputSize", () => {
  it("toma el lado mas largo de cada par opuesto", () => {
    const { corners } = syntheticDocument();
    expect(quadOutputSize(corners, 200, 200)).toEqual({
      width: 100,
      height: 100,
    });
  });

  it("no deja que un quad casi plano produzca un tamano cero", () => {
    const flat: QuadCorners = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 0.0001 },
      bottomLeft: { x: 0, y: 0.0001 },
    };
    const size = quadOutputSize(flat, 100, 100);
    expect(size.width).toBe(100);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe("inverseHomography", () => {
  it("lleva las esquinas del destino a las del cuadrilatero de origen", () => {
    const { corners } = syntheticDocument();
    const homography = inverseHomography(corners, 200, 200, 100, 100);
    expect(homography).not.toBeNull();
    if (!homography) return;

    const cases: Array<[number, number, number, number]> = [
      [0, 0, 50, 50],
      [100, 0, 150, 50],
      [100, 100, 150, 150],
      [0, 100, 50, 150],
    ];
    for (const [u, v, x, y] of cases) {
      const point = projectPoint(homography, u, v);
      expect(point.x).toBeCloseTo(x, 6);
      expect(point.y).toBeCloseTo(y, 6);
    }
  });

  it("resuelve tambien un quad genuinamente inclinado (trapecio)", () => {
    // Un trapecio obliga a que h6/h7 sean no nulos: si la solucion fuese
    // solo afin, el punto medio del lado superior no caeria donde toca.
    const trapezoid: QuadCorners = {
      topLeft: { x: 0.2, y: 0.1 },
      topRight: { x: 0.8, y: 0.2 },
      bottomRight: { x: 0.95, y: 0.9 },
      bottomLeft: { x: 0.05, y: 0.8 },
    };
    const homography = inverseHomography(trapezoid, 100, 100, 60, 80);
    expect(homography).not.toBeNull();
    if (!homography) return;

    expect(projectPoint(homography, 0, 0).x).toBeCloseTo(20, 6);
    expect(projectPoint(homography, 0, 0).y).toBeCloseTo(10, 6);
    expect(projectPoint(homography, 60, 80).x).toBeCloseTo(95, 6);
    expect(projectPoint(homography, 60, 80).y).toBeCloseTo(90, 6);
  });

  it("devuelve null cuando el cuadrilatero es degenerado", () => {
    const collapsed: QuadCorners = {
      topLeft: { x: 0.5, y: 0.5 },
      topRight: { x: 0.5, y: 0.5 },
      bottomRight: { x: 0.5, y: 0.5 },
      bottomLeft: { x: 0.5, y: 0.5 },
    };
    expect(inverseHomography(collapsed, 100, 100, 50, 50)).toBeNull();
  });
});

describe("warpImageData", () => {
  it("extrae el documento y conserva la orientacion de sus cuadrantes", () => {
    const { image, corners } = syntheticDocument();
    const warped = warpImageData(image, corners);
    expect(warped).not.toBeNull();
    if (!warped) return;

    expect(warped.width).toBe(100);
    expect(warped.height).toBe(100);

    // Se muestrea el centro de cada cuadrante de la salida: lejos de los
    // bordes, donde el filtrado bilineal no mezcla colores vecinos.
    expectColorClose(getPixel(warped, 25, 25), RED);
    expectColorClose(getPixel(warped, 75, 25), GREEN);
    expectColorClose(getPixel(warped, 25, 75), BLUE);
    expectColorClose(getPixel(warped, 75, 75), YELLOW);

    // Y el negro del fondo quedo fuera: el recorte no arrastro el marco.
    for (let index = 3; index < warped.data.length; index += 4) {
      expect(warped.data[index]).toBe(255);
    }
  });

  it("respeta el tamano de salida pedido", () => {
    const { image, corners } = syntheticDocument();
    const warped = warpImageData(image, corners, { width: 40, height: 20 });
    expect(warped?.width).toBe(40);
    expect(warped?.height).toBe(20);
    if (!warped) return;
    expectColorClose(getPixel(warped, 10, 5), RED);
    expectColorClose(getPixel(warped, 30, 15), YELLOW);
  });

  it("endereza un quad inclinado hasta un rectangulo recto", () => {
    // Documento romboidal: la fila superior se desplaza 20 px a la
    // derecha respecto de la inferior. Tras enderezarlo, la mitad
    // izquierda debe ser roja y la derecha verde en TODAS las filas.
    const image = blankImage(200, 200);
    fillRect(image, 0, 0, 200, 200, BLACK);
    for (let y = 20; y < 120; y += 1) {
      const shift = Math.round(((119 - y) / 99) * 20);
      fillRect(image, 40 + shift, y, 90 + shift, y + 1, RED);
      fillRect(image, 90 + shift, y, 140 + shift, y + 1, GREEN);
    }

    const corners: QuadCorners = {
      topLeft: { x: 60 / 200, y: 20 / 200 },
      topRight: { x: 160 / 200, y: 20 / 200 },
      bottomRight: { x: 140 / 200, y: 120 / 200 },
      bottomLeft: { x: 40 / 200, y: 120 / 200 },
    };

    const warped = warpImageData(image, corners, { width: 100, height: 100 });
    expect(warped).not.toBeNull();
    if (!warped) return;

    for (const y of [10, 50, 90]) {
      expectColorClose(getPixel(warped, 25, y), RED, 12);
      expectColorClose(getPixel(warped, 75, y), GREEN, 12);
    }
  });

  it("devuelve null si la homografia no se puede resolver", () => {
    const image = blankImage(10, 10);
    const collapsed: QuadCorners = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 0, y: 0 },
      bottomRight: { x: 0, y: 0 },
      bottomLeft: { x: 0, y: 0 },
    };
    expect(warpImageData(image, collapsed, { width: 5, height: 5 })).toBeNull();
  });

  it("el quad completo reproduce la imagen original", () => {
    const { image } = syntheticDocument();
    const warped = warpImageData(image, DEFAULT_QUAD, {
      width: 200,
      height: 200,
    });
    expect(warped).not.toBeNull();
    if (!warped) return;
    expectColorClose(getPixel(warped, 60, 60), RED);
    expectColorClose(getPixel(warped, 140, 140), YELLOW);
    expectColorClose(getPixel(warped, 10, 10), BLACK);
  });
});

describe("validacion del cuadrilatero", () => {
  it("acepta un quad convexo normal", () => {
    const { corners } = syntheticDocument();
    expect(isDegenerateQuad(corners)).toBe(false);
  });

  it("rechaza un quad con dos esquinas cruzadas", () => {
    const crossed: QuadCorners = {
      topLeft: { x: 0.1, y: 0.1 },
      topRight: { x: 0.9, y: 0.1 },
      bottomRight: { x: 0.1, y: 0.9 },
      bottomLeft: { x: 0.9, y: 0.9 },
    };
    expect(isDegenerateQuad(crossed)).toBe(true);
  });

  it("rechaza un quad con area insignificante", () => {
    const tiny: QuadCorners = {
      topLeft: { x: 0.5, y: 0.5 },
      topRight: { x: 0.51, y: 0.5 },
      bottomRight: { x: 0.51, y: 0.51 },
      bottomLeft: { x: 0.5, y: 0.51 },
    };
    expect(isDegenerateQuad(tiny)).toBe(true);
  });

  it("reconoce el quad que cubre la foto entera", () => {
    expect(isFullFrameQuad(DEFAULT_QUAD)).toBe(true);
    expect(isFullFrameQuad(syntheticDocument().corners)).toBe(false);
  });

  it("clampQuad devuelve las esquinas al interior de la imagen", () => {
    const clamped = clampQuad({
      topLeft: { x: -0.3, y: -1 },
      topRight: { x: 1.4, y: 0 },
      bottomRight: { x: 1, y: 2 },
      bottomLeft: { x: 0, y: 1 },
    });
    expect(clamped).toEqual({
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    });
  });
});

/**
 * Limitaciones conocidas
 *
 * - `warpPerspective` (el envoltorio con canvas) no se prueba aqui: en el
 *   entorno "node" no existen `createImageBitmap` ni `canvas.toBlob`. Lo
 *   que si se prueba es todo lo que ese envoltorio calcula --
 *   `quadOutputSize`, `inverseHomography` y `warpImageData` -- de modo que
 *   solo queda sin cubrir el pegamento con el DOM.
 * - La deteccion automatica (`documentDetection.ts`) tampoco es
 *   ejercitable en Node: depende de `scanic`, que necesita canvas y WASM
 *   del navegador. Su contrato (devolver `null` ante cualquier fallo) esta
 *   pensado justo para que el flujo siga siendo el crudo si no carga.
 */
