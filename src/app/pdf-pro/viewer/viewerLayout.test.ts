import { describe, expect, it } from "vitest";
import {
  FALLBACK_ASPECT,
  HARD_MAX_MOUNTED,
  baseWidthFor,
  bucketViewerZoom,
  captureAnchor,
  clampAspect,
  clampZoom,
  computeLayout,
  contentWidthFor,
  currentPageFor,
  imagePages,
  mountedPages,
  nextZoomStep,
  pageAtOffset,
  pageLeftFor,
  pageWidthFor,
  restoreAnchor,
  scrollTopForPage,
  visiblePages,
  visibleRange,
  zoomFromPinch,
  zoomFromWheel,
  zoomPercent,
} from "@/app/pdf-pro/viewer/viewerLayout";
import {
  VIEWER_MAX_FIT_WIDTH,
  VIEWER_MAX_MOUNTED,
  VIEWER_MAX_ZOOM,
  VIEWER_MIN_FIT_WIDTH,
  VIEWER_MIN_ZOOM,
  VIEWER_PAD_X,
  VIEWER_PAD_Y,
  VIEWER_PAGE_GAP,
  VIEWER_ZOOM_STEPS,
} from "@/app/pdf-pro/viewer/viewerTypes";

/** 500 paginas de tamanos distintos (retrato, apaisada, cuadrada, estrecha, enorme): la mezcla del visor real. */
function mixedAspects(count: number): Float32Array {
  const shapes = [842 / 595, 595 / 842, 792 / 612, 1, 800 / 200, 1684 / 1190, 595 / 420];
  const aspects = new Float32Array(count);
  for (let i = 0; i < count; i += 1) aspects[i] = shapes[i % shapes.length];
  return aspects;
}

describe("anchos y zoom base", () => {
  it("el ancho base es el del contenedor menos los margenes", () => {
    expect(baseWidthFor(600)).toBe(600 - 2 * VIEWER_PAD_X);
  });

  it("nunca pasa del ancho maximo de ajuste (un monitor enorme no pinta paginas gigantes)", () => {
    expect(baseWidthFor(4000)).toBe(VIEWER_MAX_FIT_WIDTH);
  });

  it("ni baja del minimo legible (un panel estrecho hace scroll horizontal)", () => {
    expect(baseWidthFor(120)).toBe(VIEWER_MIN_FIT_WIDTH);
    expect(baseWidthFor(0)).toBe(VIEWER_MIN_FIT_WIDTH);
    expect(baseWidthFor(Number.NaN)).toBe(VIEWER_MIN_FIT_WIDTH);
  });

  it("el ancho de hoja es base x zoom acotado", () => {
    expect(pageWidthFor(632, 1)).toBe(600);
    expect(pageWidthFor(632, 2)).toBe(1200);
    expect(pageWidthFor(632, 10)).toBe(600 * VIEWER_MAX_ZOOM);
    expect(pageWidthFor(632, 0.01)).toBe(600 * VIEWER_MIN_ZOOM);
  });

  it("clampZoom acota a 0,5-4 y trata lo no numerico como 1", () => {
    expect(clampZoom(0.1)).toBe(VIEWER_MIN_ZOOM);
    expect(clampZoom(9)).toBe(VIEWER_MAX_ZOOM);
    expect(clampZoom(1.7)).toBe(1.7);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("clampAspect acota paginas degeneradas y usa A4 si falta el dato", () => {
    expect(clampAspect(0)).toBe(FALLBACK_ASPECT);
    expect(clampAspect(-3)).toBe(FALLBACK_ASPECT);
    expect(clampAspect(Number.NaN)).toBe(FALLBACK_ASPECT);
    expect(clampAspect(0.0001)).toBe(0.05);
    expect(clampAspect(5000)).toBe(20);
    expect(clampAspect(1.5)).toBe(1.5);
  });

  it("el ancho del contenido crece con el zoom y las hojas se centran", () => {
    expect(contentWidthFor(800, 600)).toBe(800);
    expect(contentWidthFor(800, 1200)).toBe(1200 + 2 * VIEWER_PAD_X);
    expect(pageLeftFor(800, 600)).toBe(100);
    expect(pageLeftFor(800, 1200)).toBe(VIEWER_PAD_X);
  });
});

describe("computeLayout", () => {
  it("reserva el alto con la proporcion real de cada pagina", () => {
    const layout = computeLayout(new Float32Array([1.5, 1, 0.5]), 3, 400);
    expect(Array.from(layout.heights)).toEqual([600, 400, 200]);
  });

  it("las paginas se apilan con el hueco entre ellas y los margenes arriba y abajo", () => {
    const layout = computeLayout(new Float32Array([1, 1, 1]), 3, 100);
    expect(layout.tops[0]).toBe(VIEWER_PAD_Y);
    expect(layout.tops[1]).toBe(VIEWER_PAD_Y + 100 + VIEWER_PAGE_GAP);
    expect(layout.tops[2]).toBe(VIEWER_PAD_Y + 2 * (100 + VIEWER_PAGE_GAP));
    expect(layout.total).toBe(2 * VIEWER_PAD_Y + 300 + 2 * VIEWER_PAGE_GAP);
  });

  it("una pagina aun sin medir (0) usa la proporcion de reserva", () => {
    const layout = computeLayout(new Float32Array([0, 2]), 2, 100, 1.2);
    expect(layout.heights[0]).toBeCloseTo(120);
    expect(layout.heights[1]).toBe(200);
  });

  it("menos medidas que paginas: el resto usa la reserva", () => {
    const layout = computeLayout(new Float32Array([2]), 4, 100, 1.5);
    expect(Array.from(layout.heights)).toEqual([200, 150, 150, 150]);
  });

  it("0 paginas: contenido vacio", () => {
    const layout = computeLayout(new Float32Array(0), 0, 100);
    expect(layout.total).toBe(0);
    expect(layout.count).toBe(0);
  });

  it("1 pagina: sin hueco sobrante", () => {
    const layout = computeLayout(new Float32Array([1]), 1, 100);
    expect(layout.total).toBe(2 * VIEWER_PAD_Y + 100);
  });

  it("500 paginas mixtas: el alto total es la suma exacta y los desplazamientos crecen", () => {
    const aspects = mixedAspects(500);
    const layout = computeLayout(aspects, 500, 640);
    let expected = 2 * VIEWER_PAD_Y + 499 * VIEWER_PAGE_GAP;
    for (let i = 0; i < 500; i += 1) expected += 640 * aspects[i];
    expect(layout.total).toBeCloseTo(expected, 3);
    for (let i = 1; i < 500; i += 1) expect(layout.tops[i]).toBeGreaterThan(layout.tops[i - 1]);
  });

  it("un cambio de ancho reescala todos los altos por igual (la barra de scroll sigue siendo proporcional)", () => {
    const aspects = mixedAspects(500);
    const a = computeLayout(aspects, 500, 400);
    const b = computeLayout(aspects, 500, 800);
    const gaps = 2 * VIEWER_PAD_Y + 499 * VIEWER_PAGE_GAP;
    expect((b.total - gaps) / (a.total - gaps)).toBeCloseTo(2, 6);
  });

  it("una pagina apaisada rotada reserva menos alto que una vertical", () => {
    const layout = computeLayout(new Float32Array([842 / 595, 595 / 842]), 2, 500);
    expect(layout.heights[1]).toBeLessThan(layout.heights[0]);
  });
});

describe("pageAtOffset y ventana visible", () => {
  const layout = computeLayout(new Float32Array([1, 1, 1, 1, 1]), 5, 100);
  // tops: 16, 132, 248, 364, 480 ; cada hoja 100 de alto y 16 de hueco.

  it("encuentra la pagina que contiene un desplazamiento", () => {
    expect(pageAtOffset(layout, 0)).toBe(0);
    expect(pageAtOffset(layout, 16)).toBe(0);
    expect(pageAtOffset(layout, 131)).toBe(0);
    expect(pageAtOffset(layout, 132)).toBe(1);
    expect(pageAtOffset(layout, 10_000)).toBe(4);
    expect(pageAtOffset(layout, -50)).toBe(0);
  });

  it("sin paginas devuelve -1", () => {
    expect(pageAtOffset(computeLayout(new Float32Array(0), 0, 100), 10)).toBe(-1);
  });

  it("el rango visible cubre solo lo que se ve", () => {
    expect(visibleRange(layout, 0, 100)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(layout, 0, 200)).toEqual({ first: 0, last: 1 });
    expect(visibleRange(layout, 100, 150)).toEqual({ first: 0, last: 2 });
  });

  it("estando en el hueco entre dos paginas, la primera visible es la siguiente", () => {
    // 116..132 es el hueco tras la pagina 0.
    expect(visibleRange(layout, 120, 10)).toEqual({ first: 1, last: 1 });
  });

  it("el borde inferior exacto de una pagina no cuenta la siguiente", () => {
    expect(visibleRange(layout, 0, 132)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(layout, 0, 133)).toEqual({ first: 0, last: 1 });
  });

  it("sin alto de visor o sin paginas no hay rango", () => {
    expect(visibleRange(layout, 0, 0)).toBeNull();
    expect(visibleRange(computeLayout(new Float32Array(0), 0, 100), 0, 500)).toBeNull();
  });

  it("al final del documento el rango se acota", () => {
    expect(visibleRange(layout, layout.total - 100, 100)).toEqual({ first: 4, last: 4 });
  });

  it("visiblePages lista los indices del rango", () => {
    expect(visiblePages({ first: 3, last: 6 })).toEqual([3, 4, 5, 6]);
    expect(visiblePages(null)).toEqual([]);
  });

  it("con 500 paginas mixtas el rango visible tiene solo unas pocas paginas", () => {
    const big = computeLayout(mixedAspects(500), 500, 640);
    for (const top of [0, 12_345, 99_999, 200_000, big.total - 800]) {
      const range = visibleRange(big, top, 800)!;
      expect(range.last - range.first).toBeLessThan(6);
      // Coherencia: la primera termina despues del borde superior y la ultima empieza antes del inferior.
      expect(big.tops[range.first] + big.heights[range.first]).toBeGreaterThan(top);
      expect(big.tops[range.last]).toBeLessThan(top + 800);
    }
  });
});

describe("pagina actual", () => {
  const layout = computeLayout(new Float32Array([1, 1, 1, 1]), 4, 100);

  it("es la que ocupa mas del area visible", () => {
    expect(currentPageFor(layout, 0, 300)).toBe(0);
    // Mas de la mitad de la vista es de la pagina 1.
    expect(currentPageFor(layout, 100, 150)).toBe(1);
  });

  it("en un empate gana la primera", () => {
    expect(currentPageFor(layout, 16 + 50, 100)).toBe(0);
  });

  it("una pagina fijada (salto reciente) gana mientras siga a la vista", () => {
    // Con paginas bajas la siguiente podria ocupar mas: el salto debe quedar en la pedida.
    expect(currentPageFor(layout, 16, 300, 0)).toBe(0);
    expect(currentPageFor(layout, 16, 300, 2)).toBe(2);
  });

  it("una pagina fijada fuera de la vista se ignora", () => {
    expect(currentPageFor(layout, 0, 120, 3)).toBe(0);
  });

  it("sin rango devuelve 0", () => {
    expect(currentPageFor(computeLayout(new Float32Array(0), 0, 100), 0, 100)).toBe(0);
  });
});

describe("paginas montadas y con imagen", () => {
  it("monta el rango visible mas el margen a cada lado", () => {
    expect(mountedPages({ first: 10, last: 11 }, 100, 2, 16)).toEqual([8, 9, 10, 11, 12, 13]);
  });

  it("se acota al documento", () => {
    expect(mountedPages({ first: 0, last: 1 }, 3, 2, 16)).toEqual([0, 1, 2]);
    expect(mountedPages({ first: 98, last: 99 }, 100, 2, 16)).toEqual([96, 97, 98, 99]);
  });

  it("el margen se recorta para no pasar del tope, pero lo visible nunca se desmonta", () => {
    const pages = mountedPages({ first: 20, last: 29 }, 100, 5, 12);
    expect(pages.length).toBe(12);
    for (let page = 20; page <= 29; page += 1) expect(pages).toContain(page);
    // Con un margen que no cabe se recorta primero el lado mas ancho.
    const tight = mountedPages({ first: 20, last: 29 }, 100, 5, 10);
    expect(tight).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it("con paginas visibles de sobra se conservan las del centro (tope duro)", () => {
    const pages = mountedPages({ first: 0, last: 99 }, 100, 2, 12);
    expect(pages.length).toBeLessThanOrEqual(HARD_MAX_MOUNTED);
    expect(pages).toContain(50);
    expect(pages).not.toContain(0);
  });

  it("las paginas fijadas (con el foco) se mantienen montadas aunque salgan del rango", () => {
    expect(mountedPages({ first: 50, last: 51 }, 100, 1, 16, [3])).toEqual([3, 49, 50, 51, 52]);
    expect(mountedPages({ first: 50, last: 51 }, 100, 1, 16, [500, -1])).toEqual([49, 50, 51, 52]);
  });

  it("sin rango solo quedan las fijadas", () => {
    expect(mountedPages(null, 10, 2, 16, [4])).toEqual([4]);
    expect(mountedPages(null, 10, 2, 16)).toEqual([]);
  });

  it("con 500 paginas y zoom minimo se montan pocas (visibles + margen acotado) y nunca mas del tope duro", () => {
    const small = computeLayout(mixedAspects(500), 500, 300);
    const range = visibleRange(small, 5_000, 1_000)!;
    expect(mountedPages(range, 500, 2, VIEWER_MAX_MOUNTED).length).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
    // Documento de paginas diminutas: muchas visibles a la vez.
    const tiny = computeLayout(new Float32Array(500).fill(0.3), 500, 40);
    const tinyRange = visibleRange(tiny, 5_000, 3_000)!;
    expect(tinyRange.last - tinyRange.first).toBeGreaterThan(VIEWER_MAX_MOUNTED);
    expect(mountedPages(tinyRange, 500, 2, VIEWER_MAX_MOUNTED).length).toBeLessThanOrEqual(HARD_MAX_MOUNTED);
  });

  it("las imagenes cubren lo visible mas un margen y se limitan a las mas cercanas al centro", () => {
    expect(imagePages({ first: 10, last: 11 }, 100, 1, 10, 10)).toEqual([9, 10, 11, 12]);
    const limited = imagePages({ first: 10, last: 30 }, 100, 1, 6, 20);
    expect(limited).toHaveLength(6);
    expect(limited).toEqual([...limited].sort((a, b) => a - b));
    expect(limited).toContain(20);
    expect(limited).not.toContain(10);
    expect(imagePages(null, 10, 1, 4, 0)).toEqual([]);
  });
});

describe("saltos de pagina", () => {
  const layout = computeLayout(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]), 8, 100);

  it("deja la pagina arriba con un respiro del tamano del hueco", () => {
    expect(scrollTopForPage(layout, 2, 300)).toBe(layout.tops[2] - VIEWER_PAGE_GAP);
  });

  it("la pagina 0 salta al borde superior", () => {
    expect(scrollTopForPage(layout, 0, 300)).toBe(0);
  });

  it("la ultima pagina no pasa del final del contenido", () => {
    const top = scrollTopForPage(layout, 7, 300);
    expect(top).toBe(layout.total - 300);
  });

  it("centrada deja el centro de la pagina en el centro del visor", () => {
    const top = scrollTopForPage(layout, 4, 300, "center");
    expect(top + 150).toBeCloseTo(layout.tops[4] + layout.heights[4] / 2);
  });

  it("los indices fuera de rango se acotan y no hay paginas = 0", () => {
    expect(scrollTopForPage(layout, -5, 300)).toBe(0);
    expect(scrollTopForPage(layout, 99, 300)).toBe(layout.total - 300);
    expect(scrollTopForPage(computeLayout(new Float32Array(0), 0, 100), 3, 300)).toBe(0);
  });

  it("un documento mas corto que el visor no se desplaza", () => {
    const short = computeLayout(new Float32Array([0.5, 0.5]), 2, 100);
    expect(scrollTopForPage(short, 1, 5_000)).toBe(0);
  });

  it("en 500 paginas, saltar a cualquiera deja esa pagina como la actual", () => {
    const big = computeLayout(mixedAspects(500), 500, 640);
    for (const page of [0, 1, 137, 250, 333, 498, 499]) {
      const top = scrollTopForPage(big, page, 800);
      expect(currentPageFor(big, top, 800, page)).toBe(page);
      const range = visibleRange(big, top, 800)!;
      expect(range.first).toBeLessThanOrEqual(page);
      expect(range.last).toBeGreaterThanOrEqual(page);
    }
  });
});

describe("anclas de desplazamiento", () => {
  const aspects = mixedAspects(60);

  it("captura y restaura el mismo punto cuando nada cambia", () => {
    const layout = computeLayout(aspects, 60, 600);
    const anchor = captureAnchor(layout, 800, 7_000, 0, 0, 0)!;
    const restored = restoreAnchor(layout, 800, 700, anchor);
    expect(restored.scrollTop).toBeCloseTo(7_000, 3);
  });

  it("tras duplicar el ancho de la hoja el punto sigue en la misma pagina y fraccion", () => {
    const small = computeLayout(aspects, 60, 400);
    const big = computeLayout(aspects, 60, 800);
    const anchor = captureAnchor(small, 800, 9_000, 0, 0, 120)!;
    const next = restoreAnchor(big, 800, 700, anchor);
    const after = captureAnchor(big, 800, next.scrollTop, next.scrollLeft, 0, 120)!;
    expect(after.page).toBe(anchor.page);
    expect(after.fy).toBeCloseTo(anchor.fy, 4);
  });

  it("el ancla horizontal mantiene el punto bajo el cursor", () => {
    const small = computeLayout(aspects, 60, 600);
    const big = computeLayout(aspects, 60, 1200);
    const anchor = captureAnchor(small, 700, 3_000, 0, 350, 200)!;
    const next = restoreAnchor(big, 700, 700, anchor);
    const left = pageLeftFor(700, big.pageWidth);
    const pointX = left + anchor.fx * big.pageWidth;
    expect(pointX - next.scrollLeft).toBeCloseTo(350, 3);
  });

  it("cambiar las medidas de paginas de arriba no mueve lo que se esta viendo", () => {
    const before = computeLayout(new Float32Array(60).fill(1.4), 60, 600);
    const measured = new Float32Array(60).fill(1.4);
    for (let i = 0; i < 20; i += 1) measured[i] = 0.7;
    const after = computeLayout(measured, 60, 600);
    const anchor = captureAnchor(before, 800, 30 * 800, 0, 0, 0)!;
    const restored = restoreAnchor(after, 800, 700, anchor);
    const check = captureAnchor(after, 800, restored.scrollTop, restored.scrollLeft, 0, 0)!;
    expect(check.page).toBe(anchor.page);
    expect(check.fy).toBeCloseTo(anchor.fy, 4);
  });

  it("si el documento tiene menos paginas, el ancla se acota a la ultima", () => {
    const long = computeLayout(aspects, 60, 600);
    const short = computeLayout(aspects.subarray(0, 10), 10, 600);
    const anchor = captureAnchor(long, 800, 40_000, 0, 0, 0)!;
    const restored = restoreAnchor(short, 800, 700, anchor);
    expect(restored.scrollTop).toBeLessThanOrEqual(short.total);
    expect(restored.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it("sin paginas no hay ancla", () => {
    expect(captureAnchor(computeLayout(new Float32Array(0), 0, 100), 800, 0, 0, 0, 0)).toBeNull();
  });

  it("el desplazamiento restaurado nunca sale del contenido", () => {
    const layout = computeLayout(aspects, 60, 600);
    const anchor = { page: 59, fy: 5, fx: 3, vy: 0, vx: 0 };
    const restored = restoreAnchor(layout, 800, 700, anchor);
    expect(restored.scrollTop).toBeLessThanOrEqual(layout.total - 700);
    expect(restored.scrollLeft).toBeLessThanOrEqual(Math.max(0, contentWidthFor(800, 600) - 800));
  });
});

describe("zoom", () => {
  it("los pasos siguen la lista oficial y los extremos se quedan", () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(4, 1)).toBe(4);
    expect(nextZoomStep(0.5, -1)).toBe(0.5);
  });

  it("desde un valor intermedio salta al siguiente paso en esa direccion", () => {
    expect(nextZoomStep(1.1, 1)).toBe(1.25);
    expect(nextZoomStep(1.1, -1)).toBe(1);
    expect(nextZoomStep(1.9, 1)).toBe(2);
  });

  it("recorrer todos los pasos hacia arriba y hacia abajo es consistente", () => {
    let zoom: number = VIEWER_MIN_ZOOM;
    const up: number[] = [zoom];
    for (let i = 0; i < 12; i += 1) {
      zoom = nextZoomStep(zoom, 1);
      if (up[up.length - 1] !== zoom) up.push(zoom);
    }
    expect(up).toEqual([...VIEWER_ZOOM_STEPS]);
  });

  it("la rueda con Ctrl hacia arriba acerca y hacia abajo aleja", () => {
    expect(zoomFromWheel(1, -50)).toBeGreaterThan(1);
    expect(zoomFromWheel(1, 50)).toBeLessThan(1);
  });

  it("un giro enorme de rueda se limita (no salta de golpe al maximo)", () => {
    expect(zoomFromWheel(1, -10_000)).toBeLessThan(1.5);
    expect(zoomFromWheel(1, 10_000)).toBeGreaterThan(0.7);
  });

  it("la rueda en modo lineas pesa mas que en pixeles", () => {
    expect(zoomFromWheel(1, -1, 1)).toBeGreaterThan(zoomFromWheel(1, -1, 0));
  });

  it("la rueda acota a 0,5-4", () => {
    let zoom = 1;
    for (let i = 0; i < 200; i += 1) zoom = zoomFromWheel(zoom, -100);
    expect(zoom).toBe(VIEWER_MAX_ZOOM);
    for (let i = 0; i < 400; i += 1) zoom = zoomFromWheel(zoom, 100);
    expect(zoom).toBe(VIEWER_MIN_ZOOM);
  });

  it("el pellizco es proporcional a la distancia entre los dedos", () => {
    expect(zoomFromPinch(1, 100, 200)).toBe(2);
    expect(zoomFromPinch(2, 200, 100)).toBe(1);
    expect(zoomFromPinch(1, 100, 100)).toBe(1);
  });

  it("el pellizco acota y descarta distancias invalidas", () => {
    expect(zoomFromPinch(2, 10, 1000)).toBe(VIEWER_MAX_ZOOM);
    expect(zoomFromPinch(1, 1000, 10)).toBe(VIEWER_MIN_ZOOM);
    expect(zoomFromPinch(1.5, 0, 100)).toBe(1.5);
    expect(zoomFromPinch(1.5, 100, 0)).toBe(1.5);
  });

  it("el zoom del bitmap sube al paso de 0,25 (el pellizco no lanza un render por pixel)", () => {
    expect(bucketViewerZoom(1)).toBe(1);
    expect(bucketViewerZoom(1.01)).toBe(1.25);
    expect(bucketViewerZoom(1.25)).toBe(1.25);
    expect(bucketViewerZoom(0.5)).toBe(0.5);
    expect(bucketViewerZoom(0.51)).toBe(0.75);
    expect(bucketViewerZoom(4)).toBe(4);
    expect(bucketViewerZoom(0)).toBe(0.25);
    expect(bucketViewerZoom(Number.NaN)).toBe(0.25);
  });

  it("el porcentaje mostrado se redondea y acota", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.505)).toBe(151);
    expect(zoomPercent(9)).toBe(400);
    expect(zoomPercent(0)).toBe(50);
  });
});
