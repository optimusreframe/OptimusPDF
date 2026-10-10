import { describe, expect, it } from "vitest";
import { metricsFor } from "@/app/edit-pdf/editTestUtils";
import {
  DEFAULT_CHECK_WIDTH,
  DEFAULT_IMAGE_WIDTH,
  MAX_IMAGE_HEIGHT,
  TAP_SIZE_PT,
  checkAt,
  duplicateElementItem,
  duplicateOp,
  elementGeometryKey,
  elementPxRect,
  imageElementAt,
  isDrawTool,
  isTap,
  linePxPoints,
  moveLineEnd,
  normBoxToPx,
  pxRectToNormBox,
  pxToNorm,
  resizeLockedPxRect,
  shapeFromGesture,
  shiftLinePoints,
  styleFromRestyle,
  visibleCenterNorm,
  type DrawTool,
} from "@/app/edit-pdf/editElements";
import {
  applyOp,
  createEditSession,
  imageAddOp,
  shapeItem,
  type EditImageItem,
  type EditShapeElement,
} from "@/app/edit-pdf/editSession";
import {
  DEFAULT_EDIT_STYLE,
  MIN_ELEMENT_SIDE,
  MIN_LINE_LENGTH,
  type EditStyle,
  type ImageElement,
} from "@/lib/pdf/editPdf";

/** Pagina A4 a 1 px por punto: 595 x 842 px. */
const metrics = metricsFor();
const style: EditStyle = { ...DEFAULT_EDIT_STYLE };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function gesture(tool: DrawTool, start: [number, number], end: [number, number], tap = false, over: Partial<EditStyle> = {}) {
  return shapeFromGesture({
    tool,
    metrics,
    pageIndex: 2,
    id: "n1",
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
    tap,
    style: { ...style, ...over },
  });
}

describe("conversion de pixeles a fracciones", () => {
  it("pxToNorm divide entre el tamano de la hoja y recorta a la pagina", () => {
    expect(pxToNorm(metrics, { x: 297.5, y: 421 })).toEqual({ x: 0.5, y: 0.5 });
    expect(pxToNorm(metrics, { x: -20, y: 5000 })).toEqual({ x: 0, y: 1 });
  });

  it("normBoxToPx y pxRectToNormBox son inversas", () => {
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    const rect = normBoxToPx(metrics, box);
    expect(rect.left).toBeCloseTo(59.5);
    expect(rect.top).toBeCloseTo(168.4);
    const back = pxRectToNormBox(metrics, rect);
    expect(back.x).toBeCloseTo(box.x);
    expect(back.height).toBeCloseTo(box.height);
  });

  it("en una pagina con /Rotate las fracciones siguen siendo las de la vista", () => {
    const rotated = metricsFor([0, 0, 400, 300], 90, 300);
    // La vista es 300 x 400: 1 px por punto.
    expect(rotated.cssWidth).toBe(300);
    expect(rotated.cssHeight).toBe(400);
    expect(pxToNorm(rotated, { x: 150, y: 100 })).toEqual({ x: 0.5, y: 0.25 });
  });

  it("elementPxRect da la caja envolvente de una linea", () => {
    const rect = elementPxRect(metrics, {
      id: "l",
      pageIndex: 0,
      type: "line",
      x1: 0.5,
      y1: 0.1,
      x2: 0.2,
      y2: 0.3,
      strokeColor: "#000000",
      strokeWidth: 2,
    });
    expect(rect.left).toBeCloseTo(0.2 * 595);
    expect(rect.width).toBeCloseTo(0.3 * 595);
    expect(rect.height).toBeCloseTo(0.2 * 842);
  });

  it("isTap respeta el umbral de 8 px", () => {
    expect(isTap({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true);
    expect(isTap({ x: 0, y: 0 }, { x: 9, y: 0 })).toBe(false);
  });

  it("isDrawTool solo acepta las herramientas de dibujo", () => {
    expect(["rect", "ellipse", "line", "highlight", "check"].every(isDrawTool)).toBe(true);
    expect(isDrawTool("image")).toBe(false);
    expect(isDrawTool("select")).toBe(false);
  });
});

describe("shapeFromGesture: lo que se crea al arrastrar", () => {
  it("rectangulo: caja entre dos puntos en cualquier direccion, con el estilo activo", () => {
    const el = gesture("rect", [0.5, 0.5], [0.2, 0.3], false, { strokeColor: "#0d4bff", strokeWidth: 4, fill: true, fillOpacity: 0.5 });
    expect(el).toMatchObject({
      type: "rect",
      pageIndex: 2,
      x: 0.2,
      y: 0.3,
      strokeColor: "#0d4bff",
      strokeWidth: 4,
      fill: true,
      fillOpacity: 0.5,
    });
    expect((el as { width: number }).width).toBeCloseTo(0.3);
    expect((el as { height: number }).height).toBeCloseTo(0.2);
  });

  it("elipse: igual que el rectangulo pero con su tipo", () => {
    expect(gesture("ellipse", [0.1, 0.1], [0.4, 0.3])).toMatchObject({ type: "ellipse", x: 0.1, y: 0.1 });
  });

  it("linea: conserva el sentido del arrastre y el estilo del trazo", () => {
    const el = gesture("line", [0.8, 0.2], [0.1, 0.6], false, { strokeColor: "#000000", strokeWidth: 6 });
    expect(el).toEqual({
      id: "n1",
      pageIndex: 2,
      type: "line",
      x1: 0.8,
      y1: 0.2,
      x2: 0.1,
      y2: 0.6,
      strokeColor: "#000000",
      strokeWidth: 6,
    });
  });

  it("resaltado: usa su color y su opacidad, no los de las formas", () => {
    const el = gesture("highlight", [0.1, 0.1], [0.5, 0.13], false, { highlightColor: "#9ad9ff", highlightOpacity: 0.75 });
    expect(el).toMatchObject({ type: "highlight", color: "#9ad9ff", opacity: 0.75 });
  });

  it("marca por arrastre: caja con el simbolo y el trazo activos", () => {
    const el = gesture("check", [0.1, 0.1], [0.2, 0.15], false, { checkMark: "cross", strokeWidth: 3 });
    expect(el).toMatchObject({ type: "check", mark: "cross", strokeWidth: 3 });
  });

  it("una caja por debajo del minimo del motor no crea nada", () => {
    expect(gesture("rect", [0.1, 0.1], [0.1 + MIN_ELEMENT_SIDE / 2, 0.5])).toBeNull();
    expect(gesture("highlight", [0.1, 0.1], [0.5, 0.1])).toBeNull();
  });

  it("una linea mas corta que el minimo no crea nada", () => {
    expect(gesture("line", [0.1, 0.1], [0.1 + MIN_LINE_LENGTH / 2, 0.1])).toBeNull();
  });

  it("un toque deja una figura de tamano por defecto centrada en el punto", () => {
    const el = gesture("rect", [0.5, 0.5], [0.5, 0.5], true) as { x: number; y: number; width: number; height: number };
    expect(el.width * 595).toBeCloseTo(TAP_SIZE_PT.rect.width);
    expect(el.height * 842).toBeCloseTo(TAP_SIZE_PT.rect.height);
    expect(el.x + el.width / 2).toBeCloseTo(0.5);
    expect(el.y + el.height / 2).toBeCloseTo(0.5);
  });

  it("un toque cerca del borde mantiene la figura dentro de la pagina", () => {
    const el = gesture("ellipse", [0.99, 0.99], [0.99, 0.99], true) as { x: number; y: number; width: number; height: number };
    expect(el.x + el.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(el.y + el.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("un toque con la linea deja una horizontal de 140 pt, dentro de la pagina", () => {
    const el = gesture("line", [0.02, 0.4], [0.02, 0.4], true) as { x1: number; x2: number; y1: number; y2: number };
    expect(el.y1).toBe(el.y2);
    expect((el.x2 - el.x1) * 595).toBeCloseTo(TAP_SIZE_PT.line.width);
    expect(el.x1).toBeGreaterThanOrEqual(0);
  });

  it("un toque con el resaltado deja una banda de la altura de una linea", () => {
    const el = gesture("highlight", [0.5, 0.5], [0.5, 0.5], true) as { height: number; width: number };
    expect(el.height * 842).toBeCloseTo(TAP_SIZE_PT.highlight.height);
    expect(el.width * 595).toBeCloseTo(TAP_SIZE_PT.highlight.width);
  });

  it("todo lo que sale pasa el validador de la sesion", () => {
    const tools: DrawTool[] = ["rect", "ellipse", "line", "highlight", "check"];
    for (const tool of tools) {
      const el = gesture(tool, [0.2, 0.2], [0.6, 0.5]) as EditShapeElement;
      const next = applyOp(createEditSession(), { type: "add", item: shapeItem(el) }, 1);
      expect(next.items, tool).toHaveLength(1);
    }
  });
});

describe("marca e imagen", () => {
  it("checkAt: lado fijo, cuadrado EN PANTALLA y centrado en el punto", () => {
    const el = checkAt(metrics, 0, "c", { x: 0.5, y: 0.5 }, style);
    expect(el.width).toBe(DEFAULT_CHECK_WIDTH);
    expect(el.width * metrics.cssWidth).toBeCloseTo(el.height * metrics.cssHeight);
    expect(el.x + el.width / 2).toBeCloseTo(0.5);
  });

  it("checkAt en una esquina no se sale de la pagina", () => {
    const el = checkAt(metrics, 0, "c", { x: 1, y: 1 }, style);
    expect(el.x + el.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(el.y + el.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("imageElementAt: ancho por defecto, proporcion de la imagen y centrada", () => {
    const el = imageElementAt({ metrics, pageIndex: 1, id: "i", center: { x: 0.5, y: 0.5 }, image: { bytes: PNG, previewUrl: "data:", ratio: 0.5 } });
    expect(el.width).toBe(DEFAULT_IMAGE_WIDTH);
    expect((el.height * 842) / (el.width * 595)).toBeCloseTo(0.5);
    expect(el.x + el.width / 2).toBeCloseTo(0.5);
    expect(el.pageIndex).toBe(1);
  });

  it("imageElementAt: una imagen muy alta se reduce para caber en la pagina", () => {
    const el = imageElementAt({ metrics, pageIndex: 0, id: "i", center: { x: 0.5, y: 0.5 }, image: { bytes: PNG, previewUrl: "", ratio: 6 } });
    expect(el.height).toBeCloseTo(MAX_IMAGE_HEIGHT);
    expect(el.width).toBeLessThan(DEFAULT_IMAGE_WIDTH);
    expect((el.height * 842) / (el.width * 595)).toBeCloseTo(6);
  });

  it("imageElementAt: soltada en una esquina queda dentro de la pagina", () => {
    const el = imageElementAt({ metrics, pageIndex: 0, id: "i", center: { x: 1, y: 1 }, image: { bytes: PNG, previewUrl: "", ratio: 1 } });
    expect(el.x + el.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(el.y + el.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("la imagen se anade a la sesion con sus bytes en el mapa de assets", () => {
    const el = imageElementAt({ metrics, pageIndex: 0, id: "i1", center: { x: 0.5, y: 0.5 }, image: { bytes: PNG, previewUrl: "data:x", ratio: 1 } });
    const next = applyOp(createEditSession(), imageAddOp(el), 1);
    expect(next.items).toHaveLength(1);
    expect(next.assets.i1.bytes).toBe(PNG);
  });
});

describe("visibleCenterNorm", () => {
  const host = { left: 100, top: -500, width: 600, height: 1000 };

  it("es el centro de la parte de la hoja que cae dentro de la ventana", () => {
    const center = visibleCenterNorm(host, { top: 0, bottom: 800, left: 0, right: 1280 });
    expect(center.x).toBeCloseTo(0.5);
    // Visible: de y=0 a y=500 de pantalla = de 500 a 1000 de la hoja; centro 750 -> 0.75.
    expect(center.y).toBeCloseTo(0.75);
  });

  it("si la hoja no se ve, su centro", () => {
    expect(visibleCenterNorm(host, { top: 2000, bottom: 2800, left: 0, right: 1280 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("redimensionar con proporcion bloqueada", () => {
  const rect = { left: 100, top: 100, width: 200, height: 100 };
  const bounds = { width: 600, height: 800 };

  it("la esquina inferior derecha crece conservando el alto/ancho", () => {
    const next = resizeLockedPxRect(rect, "se", 100, 0, 0.5, 10, bounds);
    expect(next.left).toBe(100);
    expect(next.top).toBe(100);
    expect(next.width).toBe(300);
    expect(next.height).toBe(150);
  });

  it("la esquina superior izquierda deja fija la inferior derecha", () => {
    const next = resizeLockedPxRect(rect, "nw", -50, -25, 0.5, 10, bounds);
    expect(next.left + next.width).toBe(300);
    expect(next.top + next.height).toBe(200);
    expect(next.height / next.width).toBeCloseTo(0.5);
  });

  it("manda el eje que mas se mueve (hasta donde cabe en la pagina)", () => {
    const next = resizeLockedPxRect(rect, "se", 10, 100, 0.5, 10, bounds);
    expect(next.height).toBeCloseTo(100 + 100);
    expect(next.width).toBeCloseTo(400);
    const capped = resizeLockedPxRect(rect, "se", 10, 200, 0.5, 10, bounds);
    expect(capped.width).toBeCloseTo(600 - 100);
    expect(capped.height).toBeCloseTo(250);
  });

  it("no baja del minimo ni cruza al otro lado", () => {
    const next = resizeLockedPxRect(rect, "se", -500, -500, 0.5, 20, bounds);
    expect(next.width).toBeGreaterThanOrEqual(20);
    expect(next.left).toBe(100);
  });

  it("no se sale de la pagina", () => {
    const next = resizeLockedPxRect(rect, "se", 2000, 2000, 0.5, 10, bounds);
    expect(next.left + next.width).toBeLessThanOrEqual(600 + 1e-9);
    expect(next.top + next.height).toBeLessThanOrEqual(800 + 1e-9);
    expect(next.height / next.width).toBeCloseTo(0.5);
  });
});

describe("lineas", () => {
  const line = { x1: 0.2, y1: 0.2, x2: 0.6, y2: 0.4 };

  it("moveLineEnd mueve solo el extremo pedido", () => {
    const next = moveLineEnd(metrics, line, "p2", { x: 595 / 2, y: 842 / 2 });
    expect(next).toEqual({ x1: 0.2, y1: 0.2, x2: 0.5, y2: 0.5 });
    const first = moveLineEnd(metrics, line, "p1", { x: 0, y: 0 });
    expect(first).toEqual({ x1: 0, y1: 0, x2: 0.6, y2: 0.4 });
  });

  it("moveLineEnd recorta a la pagina", () => {
    expect(moveLineEnd(metrics, line, "p2", { x: 9999, y: -50 })).toMatchObject({ x2: 1, y2: 0 });
  });

  it("shiftLinePoints mueve los dos extremos y no saca la linea de la pagina", () => {
    const moved = shiftLinePoints(metrics, line, 59.5, 0);
    expect(moved.x1).toBeCloseTo(0.3);
    expect(moved.x2).toBeCloseTo(0.7);
    const clamped = shiftLinePoints(metrics, line, 5000, -5000);
    expect(clamped.x2).toBeCloseTo(1);
    expect(clamped.y1).toBeCloseTo(0);
  });

  it("linePxPoints convierte a pixeles de la hoja", () => {
    expect(linePxPoints(metrics, line).x2).toBeCloseTo(0.6 * 595);
  });
});

describe("duplicar", () => {
  const rect: EditShapeElement = {
    id: "r1",
    pageIndex: 3,
    type: "rect",
    x: 0.2,
    y: 0.2,
    width: 0.3,
    height: 0.2,
    strokeColor: "#e11d48",
    strokeWidth: 2,
    fill: false,
    fillColor: "#0d4bff",
    fillOpacity: 0.3,
  };

  it("la copia lleva otro id, la misma pagina y un desplazamiento", () => {
    const copy = duplicateElementItem(shapeItem(rect), "copy");
    expect(copy.id).toBe("copy");
    expect(copy.element.id).toBe("copy");
    expect(copy.element.pageIndex).toBe(3);
    expect((copy.element as typeof rect).x).toBeCloseTo(0.22);
  });

  it("junto al borde derecho la copia no se sale", () => {
    const copy = duplicateElementItem(shapeItem({ ...rect, x: 0.7 }), "c");
    expect((copy.element as typeof rect).x + (copy.element as typeof rect).width).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("duplicar una linea desplaza los dos extremos igual", () => {
    const line: EditShapeElement = { id: "l", pageIndex: 0, type: "line", x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.3, strokeColor: "#000000", strokeWidth: 2 };
    const copy = duplicateElementItem(shapeItem(line), "c").element as typeof line;
    expect(copy.x2 - copy.x1).toBeCloseTo(0.4);
    expect(copy.y1).toBeCloseTo(0.12);
  });

  it("duplicar una imagen comparte su asset (no viajan bytes de nuevo)", () => {
    const image: ImageElement = { id: "i1", pageIndex: 0, type: "image", x: 0.1, y: 0.1, width: 0.3, height: 0.2, bytes: PNG, previewUrl: "data:x", ratio: 1 };
    const session = applyOp(createEditSession(), imageAddOp(image), 1);
    const op = duplicateOp(session.items[0]);
    expect(op).not.toBeNull();
    const next = applyOp(session, op!, 2);
    expect(next.items).toHaveLength(2);
    const [a, b] = next.items as EditImageItem[];
    expect(b.element.assetId).toBe(a.element.assetId);
    expect(Object.keys(next.assets)).toHaveLength(1);
  });

  it("el texto no se duplica con esta op", () => {
    expect(duplicateOp({ kind: "text", id: "t", edit: {} as never })).toBeNull();
  });

  it("elementGeometryKey cambia al mover", () => {
    const a = elementGeometryKey(shapeItem(rect));
    const b = elementGeometryKey(shapeItem({ ...rect, x: 0.25 }));
    expect(a).not.toBe(b);
  });
});

describe("styleFromRestyle: lo que se cambia a uno es lo que nace en el siguiente", () => {
  const rect = { id: "r", pageIndex: 0, type: "rect", x: 0, y: 0, width: 0.2, height: 0.2, strokeColor: "#000000", strokeWidth: 2, fill: false, fillColor: "#0d4bff", fillOpacity: 0.3 } as const;

  it("formas: trazo y relleno", () => {
    expect(styleFromRestyle(rect, { strokeColor: "#e11d48", fill: true, fillOpacity: 0.5, fillColor: "#0f9d68", strokeWidth: 5 })).toEqual({
      strokeColor: "#e11d48",
      fill: true,
      fillOpacity: 0.5,
      fillColor: "#0f9d68",
      strokeWidth: 5,
    });
  });

  it("resaltado: color y opacidad propios", () => {
    const highlight = { id: "h", pageIndex: 0, type: "highlight", x: 0, y: 0, width: 0.2, height: 0.05, color: "#fff176", opacity: 0.4 } as const;
    expect(styleFromRestyle(highlight, { color: "#ffb4d1", opacity: 0.75 })).toEqual({ highlightColor: "#ffb4d1", highlightOpacity: 0.75 });
  });

  it("marca: simbolo y trazo; sin campos de relleno", () => {
    const check = { id: "c", pageIndex: 0, type: "check", x: 0, y: 0, width: 0.03, height: 0.03, mark: "check", strokeColor: "#000000", strokeWidth: 2 } as const;
    expect(styleFromRestyle(check, { mark: "cross", fill: true })).toEqual({ checkMark: "cross" });
  });

  it("una imagen no tiene estilo", () => {
    expect(styleFromRestyle({ id: "i", pageIndex: 0, type: "image", x: 0, y: 0, width: 0.1, height: 0.1, ratio: 1, assetId: "a" }, { strokeColor: "#000000" })).toEqual({});
  });
});
