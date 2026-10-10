import { describe, expect, it } from "vitest";
import { sampleBackgroundColor, type RgbaImage } from "@/lib/pdf/editBackground";

function solid(width: number, height: number, [r, g, b]: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function paint(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  [r, g, b]: [number, number, number],
) {
  const data = image.data as Uint8ClampedArray;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
}

describe("sampleBackgroundColor — src/lib/pdf/editBackground.ts", () => {
  it("fondo liso: devuelve su color exacto y uniform", () => {
    const image = solid(100, 60, [255, 242, 179]);
    const result = sampleBackgroundColor(image, { x: 20, y: 20, width: 40, height: 16 });
    expect(result).toMatchObject({ color: "#fff2b3", uniform: true, outliers: 0 });
    expect(result.samples).toBeGreaterThan(100);
  });

  it("ignora el texto de DENTRO de la caja (solo mira el anillo exterior)", () => {
    const image = solid(100, 60, [255, 255, 255]);
    paint(image, 22, 22, 58, 34, [0, 0, 0]);
    const result = sampleBackgroundColor(image, { x: 20, y: 20, width: 40, height: 16 });
    expect(result.color).toBe("#ffffff");
    expect(result.uniform).toBe(true);
  });

  it("un degradado horizontal no es uniforme", () => {
    const image = solid(120, 60, [0, 0, 0]);
    for (let x = 0; x < 120; x += 1) paint(image, x, 0, x + 1, 60, [x * 2, x * 2, 255]);
    const result = sampleBackgroundColor(image, { x: 30, y: 20, width: 60, height: 16 });
    expect(result.uniform).toBe(false);
    expect(result.outliers).toBeGreaterThan(0.3);
  });

  it("una linea de tabla que cruza el anillo (unas pocas muestras) se tolera, mucha no", () => {
    const image = solid(100, 60, [250, 250, 250]);
    paint(image, 18, 10, 19, 50, [0, 0, 0]); // 1 px de ancho, a la izquierda
    const thin = sampleBackgroundColor(image, { x: 20, y: 20, width: 40, height: 16 }, { ring: 6 });
    expect(thin.color).toBe("#fafafa");
    expect(thin.uniform).toBe(true);

    paint(image, 14, 10, 20, 50, [0, 0, 0]); // franja gruesa
    const wide = sampleBackgroundColor(image, { x: 20, y: 20, width: 40, height: 16 }, { ring: 6 });
    expect(wide.uniform).toBe(false);
  });

  it("recorta el anillo al borde de la imagen y sigue dando color", () => {
    const image = solid(50, 30, [10, 120, 200]);
    const result = sampleBackgroundColor(image, { x: 0, y: 0, width: 20, height: 10 });
    expect(result.color).toBe("#0a78c8");
    expect(result.uniform).toBe(true);
  });

  it("sin muestras utiles (caja = toda la imagen o todo transparente) devuelve blanco y no uniforme", () => {
    const image = solid(30, 30, [1, 2, 3]);
    expect(sampleBackgroundColor(image, { x: 0, y: 0, width: 30, height: 30 })).toMatchObject({
      color: "#ffffff",
      uniform: false,
    });
    const transparent: RgbaImage = { data: new Uint8ClampedArray(30 * 30 * 4), width: 30, height: 30 };
    expect(
      sampleBackgroundColor(transparent, { x: 10, y: 10, width: 5, height: 5 }).uniform,
    ).toBe(false);
  });
});

/*
 * Pruebas migradas desde `textBlocks.test.ts` (W5-U5): el muestreo del fondo tenia
 * DOS implementaciones (`textBlocks.ts`, que nadie usaba en produccion, y esta). Se
 * conserva esta, la que usa el editor, y se trasladan aqui los casos que seguian
 * siendo ciertos. Dos casos de la copia retirada describian comportamientos que esta
 * implementacion decide distinto y no se trasladan tal cual: el hueco de 1 px junto a la
 * caja (aqui el anillo de 3 px empieza pegado a ella) y el mezclado de pixeles
 * semitransparentes con blanco (el canvas de pdf.js es opaco; aqui el alfa 0 se ignora).
 */
describe("sampleBackgroundColor — casos migrados de textBlocks", () => {
  const box = { x: 40, y: 40, width: 60, height: 20 };

  it("fondo blanco uniforme", () => {
    expect(sampleBackgroundColor(solid(200, 100, [255, 255, 255]), box)).toMatchObject({
      color: "#ffffff",
      uniform: true,
    });
  });

  it("ignora el texto de DENTRO de la caja y devuelve el color del fondo (amarillo palido)", () => {
    const image = solid(200, 100, [255, 238, 170]);
    paint(image, 40, 40, 100, 60, [10, 10, 10]);
    const sample = sampleBackgroundColor(image, box);
    expect(sample.color).toBe("#ffeeaa");
    expect(sample.uniform).toBe(true);
    expect(sample.outliers).toBeLessThan(0.01);
  });

  it("un halo de suavizado de 1 px pegado a la caja no cambia el color mediano", () => {
    const image = solid(200, 100, [200, 220, 255]);
    // Corona de 1 px alrededor de la caja, gris.
    paint(image, 39, 39, 101, 61, [120, 120, 120]);
    paint(image, 40, 40, 100, 60, [200, 220, 255]);
    expect(sampleBackgroundColor(image, box).color).toBe("#c8dcff");
  });

  it("ruido tipo fotografia => no uniforme", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
    const image = solid(200, 100, [0, 0, 0]);
    const data = image.data as Uint8ClampedArray;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rnd();
      data[i + 1] = rnd();
      data[i + 2] = rnd();
    }
    expect(sampleBackgroundColor(image, box).uniform).toBe(false);
  });

  it("una linea oscura pegada a un lado (borde de tabla) rompe la uniformidad pero no el color", () => {
    const image = solid(200, 100, [250, 250, 250]);
    paint(image, 0, 62, 200, 65, [0, 0, 0]);
    const sample = sampleBackgroundColor(image, box);
    expect(sample.color).toBe("#fafafa");
    expect(sample.uniform).toBe(false);
  });

  it("datos insuficientes, imagen vacia o caja con numeros no validos: blanco y no uniforme, sin lanzar", () => {
    const image = solid(50, 50, [1, 2, 3]);
    expect(sampleBackgroundColor(image, { x: 500, y: 500, width: 10, height: 10 })).toMatchObject({
      color: "#ffffff",
      uniform: false,
    });
    expect(
      sampleBackgroundColor({ data: new Uint8ClampedArray(8), width: 50, height: 50 }, box),
    ).toMatchObject({ color: "#ffffff", uniform: false });
    expect(sampleBackgroundColor({ data: [], width: 0, height: 0 }, box).uniform).toBe(false);
    expect(
      sampleBackgroundColor(image, { x: Number.NaN, y: 0, width: 5, height: 5 }).uniform,
    ).toBe(false);
  });

  it("caja de 1 px o vacia no revienta", () => {
    const image = solid(100, 100, [9, 9, 9]);
    expect(sampleBackgroundColor(image, { x: 50, y: 50, width: 1, height: 1 }).color).toBe("#090909");
    expect(sampleBackgroundColor(image, { x: 50, y: 50, width: 0, height: 0 }).color).toBe("#090909");
  });

  it("una imagen grande se muestrea en tiempo lineal en el perimetro, no cuadratico (lecturas de pixel contadas)", () => {
    // Complejidad DETERMINISTA, sin reloj de pared: se cuentan las lecturas de la imagen.
    const base = solid(2400, 3200, [255, 255, 255]);
    let reads = 0;
    const counted: RgbaImage = {
      width: base.width,
      height: base.height,
      data: new Proxy(base.data as Uint8ClampedArray, {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key);
        },
      }),
    };
    const sample = sampleBackgroundColor(counted, { x: 100, y: 100, width: 2000, height: 2800 });
    expect(sample.uniform).toBe(true);
    // Anillo + filas de busqueda: perimetro (9600 px) x profundidad (<= 8 + 3) x 4 canales por pixel,
    // con holgura. El recorrido cuadratico del interior (5,6 millones de pixeles) daria > 22 millones.
    const perimeter = 2 * (2000 + 2800);
    expect(reads).toBeLessThan(perimeter * 11 * 4 * 2);
    expect(reads).toBeGreaterThan(perimeter * 3);
    // Doble de ancho y de alto: el trabajo crece con el perimetro (x2), no con el area (x4).
    const first = reads;
    reads = 0;
    const bigger = solid(4800, 6400, [255, 255, 255]);
    const countedBigger: RgbaImage = {
      width: bigger.width,
      height: bigger.height,
      data: new Proxy(bigger.data as Uint8ClampedArray, {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key);
        },
      }),
    };
    sampleBackgroundColor(countedBigger, { x: 200, y: 200, width: 4000, height: 5600 });
    expect(reads / first).toBeLessThan(2.5);
  });
});

describe("sampleBackgroundColor con cuadrilatero girado (W5-U5)", () => {
  /** Rectangulo de 60 x 16 girado `deg` grados, centrado en (cx, cy): sus 4 esquinas en pixeles. */
  function quad(cx: number, cy: number, deg: number, w = 60, h = 16) {
    const r = (deg * Math.PI) / 180;
    const ux = Math.cos(r);
    const uy = Math.sin(r);
    const pts: Array<[number, number]> = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ];
    return pts.map(([x, y]) => ({ x: cx + x * ux - y * uy, y: cy + x * uy + y * ux }));
  }
  const envelope = (poly: { x: number; y: number }[]) => {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  };

  it("un vecino que cae pegado a la caja envolvente pero LEJOS del texto girado no da falso «fondo no uniforme»", () => {
    const poly = quad(100, 60, 30);
    const box = envelope(poly);
    const image = solid(200, 120, [255, 255, 255]);
    // Vecino oscuro pegado al borde superior de la envolvente, en su mitad derecha: fuera del cuadrilatero y
    // a mas de 10 px de el (lo atraviesa el anillo de la envolvente, no el del texto).
    const top = Math.floor(box.y);
    const right = Math.ceil(box.x + box.width);
    paint(image, right - 40, top - 3, right, top, [0, 0, 0]);
    const viaEnvelope = sampleBackgroundColor(image, box);
    expect(viaEnvelope.uniform).toBe(false); // el comportamiento anterior: falso aviso
    const viaQuad = sampleBackgroundColor(image, box, { polygon: poly });
    expect(viaQuad.uniform).toBe(true);
    expect(viaQuad.color).toBe("#ffffff");
  });

  it("un vecino pegado al borde del cuadrilatero (a menos de 3 px) SI cuenta: se avisa", () => {
    const poly = quad(100, 60, 30);
    const box = envelope(poly);
    const image = solid(200, 120, [255, 255, 255]);
    // Franja oscura que roza el lado largo inferior del texto girado (pasa por el centro del lado).
    const r = (30 * Math.PI) / 180;
    const mid = { x: 100 - 8 * Math.sin(r), y: 60 + 8 * Math.cos(r) };
    for (let t = -26; t <= 26; t += 1) {
      const x = Math.round(mid.x + t * Math.cos(r) - 1.5 * Math.sin(r));
      const y = Math.round(mid.y + t * Math.sin(r) + 1.5 * Math.cos(r));
      paint(image, x - 1, y - 1, x + 2, y + 2, [0, 0, 0]);
    }
    expect(sampleBackgroundColor(image, box, { polygon: poly }).uniform).toBe(false);
  });

  it("el interior del cuadrilatero (el texto) nunca se lee, y el color es el del fondo", () => {
    const poly = quad(100, 60, 45);
    const box = envelope(poly);
    const image = solid(200, 120, [200, 220, 255]);
    paint(image, 96, 56, 104, 64, [0, 0, 0]); // tinta en el centro (dentro del texto girado)
    const sample = sampleBackgroundColor(image, box, { polygon: poly });
    expect(sample.color).toBe("#c8dcff");
    expect(sample.uniform).toBe(true);
  });

  it("poligono con numeros no validos: sin lanzar, no uniforme", () => {
    const image = solid(50, 50, [1, 2, 3]);
    const sample = sampleBackgroundColor(image, { x: 10, y: 10, width: 20, height: 20 }, {
      polygon: [{ x: Number.NaN, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 1 }],
    });
    expect(sample.uniform).toBe(false);
  });

  it("sin poligono todo sigue igual (anillo alrededor de la caja)", () => {
    const image = solid(100, 60, [255, 242, 179]);
    expect(sampleBackgroundColor(image, { x: 20, y: 20, width: 40, height: 16 })).toMatchObject({ color: "#fff2b3", uniform: true });
  });
});

/*
 * N6 (verificacion B2): las celdas de tabla con borde NO son fondo no uniforme.
 * El borde de 1-2 px cae dentro del anillo de muestreo; se descarta como linea
 * fina (coherente a lo largo del lado) sin ocultar degradados, rayados ni fotos.
 */
describe("sampleBackgroundColor — lineas finas (bordes de celda)", () => {
  const W = 160;
  const H = 70;
  const cell = { x: 40, y: 25, width: 80, height: 20 };

  function plain(color: [number, number, number] = [255, 255, 255]): RgbaImage {
    return solid(W, H, color);
  }

  /** Borde rectangular de `thickness` px, con su borde interior a `gap` px de la caja. */
  function frame(image: RgbaImage, gap: number, thickness: number, color: [number, number, number]) {
    const x0 = cell.x - gap - thickness;
    const y0 = cell.y - gap - thickness;
    const x1 = cell.x + cell.width + gap + thickness;
    const y1 = cell.y + cell.height + gap + thickness;
    paint(image, x0, y0, x1, y0 + thickness, color);
    paint(image, x0, y1 - thickness, x1, y1, color);
    paint(image, x0, y0, x0 + thickness, y1, color);
    paint(image, x1 - thickness, y0, x1, y1, color);
  }

  it.each([
    [1, 0, [60, 60, 60]],
    [1, 1, [0, 0, 0]],
    [1, 2, [200, 40, 40]],
    [2, 0, [90, 90, 90]],
    [2, 1, [20, 60, 200]],
  ] as const)("borde de %i px a %i px de la caja (%j): fondo liso y color intacto", (thickness, gap, color) => {
    const image = plain();
    frame(image, gap, thickness, [...color]);
    const sample = sampleBackgroundColor(image, cell);
    expect(sample.color).toBe("#ffffff");
    expect(sample.uniform).toBe(true);
    // Control (comportamiento anterior): el borde dentro del anillo marcaba el fondo como no liso.
    if (gap < 3) expect(sampleBackgroundColor(image, cell, { thinLines: false }).uniform).toBe(false);
  });

  it("una celda coloreada con borde de otro color da el color de la celda", () => {
    const image = plain([253, 241, 200]);
    frame(image, 1, 1, [30, 30, 30]);
    const sample = sampleBackgroundColor(image, cell);
    expect(sample.color).toBe("#fdf1c8");
    expect(sample.uniform).toBe(true);
  });

  it("un borde de 3 px (banda) sigue marcandose", () => {
    const image = plain();
    frame(image, 0, 3, [0, 0, 0]);
    expect(sampleBackgroundColor(image, cell).uniform).toBe(false);
  });

  it("tabla con filas alternas (cebra) y lineas entre filas: cada celda es lisa", () => {
    const image = plain();
    // Filas de 26 px: gris claro / blanco; linea de 1 px entre ellas.
    for (let row = 0; row < 3; row += 1) {
      paint(image, 0, row * 26 + 1, W, (row + 1) * 26, row % 2 === 0 ? [243, 244, 246] : [255, 255, 255]);
      paint(image, 0, row * 26, W, row * 26 + 1, [180, 180, 180]);
    }
    for (const [i, color] of [[0, "#f3f4f6"], [1, "#ffffff"], [2, "#f3f4f6"]] as const) {
      const box = { x: 40, y: i * 26 + 6, width: 80, height: 14 };
      const sample = sampleBackgroundColor(image, box);
      expect(sample.color, `fila ${i}`).toBe(color);
      expect(sample.uniform, `fila ${i}`).toBe(true);
    }
  });

  it("no oculta lo real: degradado fuerte, rayado claro/fuerte (diagonal y horizontal) y foto siguen avisando", () => {
    const gradient = solid(W, H, [0, 0, 0]);
    for (let x = 0; x < W; x += 1) paint(gradient, x, 0, x + 1, H, [255 - x, 0, x]);
    expect(sampleBackgroundColor(gradient, cell).uniform).toBe(false);

    for (const [a, b] of [[[221, 221, 221], [255, 255, 255]], [[60, 60, 60], [255, 255, 255]]] as const) {
      const diagonal = solid(W, H, [255, 255, 255]);
      const horizontal = solid(W, H, [255, 255, 255]);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          paint(diagonal, x, y, x + 1, y + 1, [...((x + y) % 12 < 6 ? a : b)]);
          paint(horizontal, x, y, x + 1, y + 1, [...(y % 8 < 4 ? a : b)]);
        }
      }
      expect(sampleBackgroundColor(diagonal, cell).uniform).toBe(false);
      expect(sampleBackgroundColor(horizontal, cell).uniform).toBe(false);
    }

    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
    const photo = solid(W, H, [0, 0, 0]);
    const data = photo.data as Uint8ClampedArray;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rnd();
      data[i + 1] = rnd();
      data[i + 2] = rnd();
    }
    expect(sampleBackgroundColor(photo, cell).uniform).toBe(false);
  });

  it("un degradado muy suave (1 nivel cada ~40 px) y el fondo plano siguen siendo lisos", () => {
    const soft = solid(W, H, [0, 0, 0]);
    for (let x = 0; x < W; x += 1) {
      const v = 238 + Math.round(x / 40);
      paint(soft, x, 0, x + 1, H, [v, v, v]);
    }
    expect(sampleBackgroundColor(soft, cell).uniform).toBe(true);
    expect(sampleBackgroundColor(plain(), cell).uniform).toBe(true);
  });
});
