import { describe, expect, it } from "vitest";
import {
  COVER_PADDING_PT,
  NEW_TEXT_FONT_SIZE,
  NEW_TEXT_WIDTH_PT,
  clampPxRect,
  draftEditForBlock,
  excerpt,
  geometryFromPdfJsPage,
  makeMetrics,
  newTextEditAt,
  newTextPxRect,
  nextFocusKey,
  nudgeDelta,
  pxRectToUserBox,
  resizePxRect,
  sampleCanvasBackground,
  textFrame,
  userBoxToPx,
  userDeltaFromView,
} from "@/app/edit-pdf/editCanvasMath";
import { CALIBRI, makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import { exportBaselineFromTop, previewBaselineShift } from "@/app/edit-pdf/previewMetrics";

describe("geometryFromPdfJsPage", () => {
  it("normaliza /Rotate y respeta un CropBox con origen no cero", () => {
    const g = geometryFromPdfJsPage({ view: [20, 10, 380, 290], rotate: 90 });
    expect(g.box).toEqual({ x: 20, y: 10, width: 360, height: 280 });
    expect(g.rotation).toBe(90);
    expect(g.viewWidth).toBe(280);
    expect(g.viewHeight).toBe(360);
  });

  it("normaliza giros negativos o por encima de 360", () => {
    expect(geometryFromPdfJsPage({ view: [0, 0, 10, 20], rotate: -90 }).rotation).toBe(270);
    expect(geometryFromPdfJsPage({ view: [0, 0, 10, 20], rotate: 450 }).rotation).toBe(90);
    expect(geometryFromPdfJsPage({ view: [0, 0, 10, 20], rotate: 180 }).viewWidth).toBe(10);
  });

  it("tolera un view con las esquinas al reves", () => {
    const g = geometryFromPdfJsPage({ view: [100, 200, 0, 0], rotate: 0 });
    expect(g.box).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });
});

describe("userBoxToPx / pxRectToUserBox", () => {
  const box = { x: 70, y: 40, width: 60, height: 20 };

  it.each([0, 90, 180, 270])("ida y vuelta exactas con /Rotate %i y CropBox desplazado", (rotate) => {
    const m = metricsFor([20, 10, 380, 290], rotate, 540);
    const px = userBoxToPx(m, box);
    const back = pxRectToUserBox(m, px);
    expect(back.x).toBeCloseTo(box.x, 6);
    expect(back.y).toBeCloseTo(box.y, 6);
    expect(back.width).toBeCloseTo(box.width, 6);
    expect(back.height).toBeCloseTo(box.height, 6);
  });

  it("sin giro, el origen arriba-izquierda invierte el eje Y", () => {
    const m = metricsFor([0, 0, 200, 100], 0, 200);
    const px = userBoxToPx(m, { x: 10, y: 80, width: 50, height: 10 });
    expect(px.left).toBeCloseTo(10, 6);
    expect(px.top).toBeCloseTo(10, 6);
    expect(px.width).toBeCloseTo(50, 6);
    expect(px.height).toBeCloseTo(10, 6);
  });

  it("con /Rotate 90 el ancho de la hoja es el alto del CropBox", () => {
    const m = metricsFor([0, 0, 200, 100], 90, 100);
    expect(m.cssWidth).toBe(100);
    expect(m.cssHeight).toBe(200);
    // Esquina inferior izquierda del contenido = esquina superior izquierda de la vista.
    const px = userBoxToPx(m, { x: 0, y: 0, width: 20, height: 10 });
    expect(px.left).toBeCloseTo(0, 6);
    expect(px.top).toBeCloseTo(0, 6);
    expect(px.width).toBeCloseTo(10, 6);
    expect(px.height).toBeCloseTo(20, 6);
  });
});

describe("userDeltaFromView y nudgeDelta", () => {
  it("sin giro, bajar en pantalla es restar en Y de usuario", () => {
    const m = metricsFor([0, 0, 200, 100], 0, 400);
    const d = userDeltaFromView(m, 20, 40);
    expect(d.dx).toBeCloseTo(10, 6);
    expect(d.dy).toBeCloseTo(-20, 6);
  });

  it("con /Rotate 90 la derecha de la vista es +Y de usuario y la subida es -X", () => {
    const m = metricsFor([0, 0, 200, 100], 90, 100);
    const right = userDeltaFromView(m, 10, 0);
    expect(right.dx).toBeCloseTo(0, 6);
    expect(right.dy).toBeCloseTo(10, 6);
    const up = userDeltaFromView(m, 0, -10);
    expect(up.dx).toBeCloseTo(-10, 6);
    expect(up.dy).toBeCloseTo(0, 6);
  });

  it("la flecha mueve 1 pt y con Mayus 10 pt, a cualquier zoom", () => {
    const m = metricsFor([0, 0, 200, 100], 0, 400);
    expect(nudgeDelta(m, "right", false).dx).toBeCloseTo(1, 6);
    expect(nudgeDelta(m, "right", true).dx).toBeCloseTo(10, 6);
    expect(nudgeDelta(m, "up", false).dy).toBeCloseTo(1, 6);
    expect(nudgeDelta(m, "down", true).dy).toBeCloseTo(-10, 6);
    expect(nudgeDelta(m, "left", false).dx).toBeCloseTo(-1, 6);
  });
});

describe("textFrame", () => {
  it("texto horizontal en pagina sin girar: el marco es la propia caja", () => {
    const m = metricsFor([0, 0, 200, 100], 0, 200);
    const f = textFrame(m, { x: 10, y: 50, width: 80, height: 12 }, 0);
    expect(f).toEqual({ left: 10, top: 38, width: 80, height: 12, angle: 0 });
  });

  it("una pagina con /Rotate 90 gira el marco 90 grados y conserva el centro", () => {
    const m = metricsFor([0, 0, 200, 100], 90, 100);
    const box = { x: 20, y: 30, width: 80, height: 12 };
    const f = textFrame(m, box, 0);
    expect(f.angle).toBe(90);
    expect(f.width).toBeCloseTo(80, 6);
    expect(f.height).toBeCloseTo(12, 6);
    const rect = userBoxToPx(m, box);
    // Centro del marco girado = centro de la caja envolvente.
    const rad = (f.angle * Math.PI) / 180;
    const cx = f.left + (f.width / 2) * Math.cos(rad) - (f.height / 2) * Math.sin(rad);
    const cy = f.top + (f.width / 2) * Math.sin(rad) + (f.height / 2) * Math.cos(rad);
    expect(cx).toBeCloseTo(rect.left + rect.width / 2, 5);
    expect(cy).toBeCloseTo(rect.top + rect.height / 2, 5);
  });

  it("texto nuevo con rotation = /Rotate se ve recto (angulo 0)", () => {
    const m = metricsFor([0, 0, 200, 100], 90, 100);
    const f = textFrame(m, { x: 20, y: 30, width: 12, height: 80 }, 90);
    expect(f.angle).toBe(0);
    expect(f.width).toBeCloseTo(80, 6);
    expect(f.height).toBeCloseTo(12, 6);
  });

  it("texto a 45 grados: angulo CSS negativo (antihorario) y tamano sin girar", () => {
    const m = metricsFor([0, 0, 200, 200], 0, 200);
    const side = 100;
    const f = textFrame(m, { x: 50, y: 50, width: side, height: side }, 45);
    expect(f.angle).toBe(-45);
    expect(f.width).toBeGreaterThan(0);
    expect(f.height).toBeGreaterThan(0);
  });
});

describe("resizePxRect, clampPxRect y newTextPxRect", () => {
  const rect = { left: 100, top: 100, width: 100, height: 40 };
  const bounds = { width: 400, height: 300 };

  it("cada esquina deja fija la opuesta", () => {
    expect(resizePxRect(rect, "se", 20, 10, 10, bounds)).toEqual({ left: 100, top: 100, width: 120, height: 50 });
    expect(resizePxRect(rect, "nw", 20, 10, 10, bounds)).toEqual({ left: 120, top: 110, width: 80, height: 30 });
    expect(resizePxRect(rect, "ne", 20, -10, 10, bounds)).toEqual({ left: 100, top: 90, width: 120, height: 50 });
    expect(resizePxRect(rect, "sw", -20, 10, 10, bounds)).toEqual({ left: 80, top: 100, width: 120, height: 50 });
  });

  it("respeta el minimo y los limites de la hoja", () => {
    const small = resizePxRect(rect, "se", -500, -500, 12, bounds);
    expect(small.width).toBe(12);
    expect(small.height).toBe(12);
    const big = resizePxRect(rect, "se", 900, 900, 12, bounds);
    expect(big.left + big.width).toBe(400);
    expect(big.top + big.height).toBe(300);
    const out = resizePxRect(rect, "nw", -900, -900, 12, bounds);
    expect(out.left).toBe(0);
    expect(out.top).toBe(0);
  });

  it("clampPxRect mantiene el rectangulo dentro", () => {
    expect(clampPxRect({ left: 390, top: -5, width: 50, height: 20 }, bounds)).toEqual({
      left: 350,
      top: 0,
      width: 50,
      height: 20,
    });
  });

  it("un clic crea un texto de 200 pt y el arrastre crea el rectangulo trazado", () => {
    const m = metricsFor([0, 0, 595, 842], 0, 595);
    const click = newTextPxRect(m, { x: 100, y: 100 }, { x: 102, y: 101 });
    expect(click.width).toBe(NEW_TEXT_WIDTH_PT);
    expect(click.height).toBeCloseTo(NEW_TEXT_FONT_SIZE * 1.2, 6);
    const drag = newTextPxRect(m, { x: 300, y: 200 }, { x: 150, y: 260 });
    expect(drag).toEqual({ left: 150, top: 200, width: 150, height: 60 });
  });

  it("un clic pegado al borde derecho no se sale de la hoja", () => {
    const m = metricsFor([0, 0, 595, 842], 0, 595);
    const r = newTextPxRect(m, { x: 560, y: 100 }, { x: 560, y: 100 });
    expect(r.left + r.width).toBeLessThanOrEqual(595);
  });
});

describe("draftEditForBlock", () => {
  it("cubre la caja original con 1 pt de margen y reemplaza el bloque", () => {
    const block = makeBlock("p0-b1", { text: "Hola" });
    const edit = draftEditForBlock(block, { coverColor: "#fefefe" });
    expect(edit.blockId).toBe("p0-b1");
    expect(edit.coverBox).toEqual(block.box);
    expect(edit.cover).toEqual({ color: "#fefefe", padding: COVER_PADDING_PT });
    expect(edit.text).toBe("Hola");
    expect(edit.sourceFont).toBe(block.font);
  });

  it("la fuente se elige con mapSourceFont y negrita/cursiva salen del nombre", () => {
    const block = makeBlock("p0-b2", {
      font: { ...CALIBRI, pdfName: "ABCDEF+Calibri-BoldItalic", bold: false, italic: false },
    });
    const edit = draftEditForBlock(block, { coverColor: null });
    expect(edit.fontKey).toBe("liberation-sans");
    expect(edit.bold).toBe(true);
    expect(edit.italic).toBe(true);
  });

  it("copia el interlineado del parrafo y lo valida", () => {
    expect(draftEditForBlock(makeBlock("a", { lineHeight: 1.5 }), { coverColor: null }).lineHeight).toBe(1.5);
    expect(draftEditForBlock(makeBlock("b"), { coverColor: null }).lineHeight).toBeUndefined();
    expect(draftEditForBlock(makeBlock("c", { lineHeight: 99 }), { coverColor: null }).lineHeight).toBeUndefined();
  });

  it("la primera linea base redibujada cae en la del original", () => {
    const block = makeBlock("p0-b3", {
      box: { x: 50, y: 700, width: 200, height: 14 },
      fontSize: 12,
    });
    block.lines[0].baseline = 703;
    const edit = draftEditForBlock(block, { coverColor: null });
    const top = edit.box.y + edit.box.height;
    const exported = top - exportBaselineFromTop("helvetica", 1.2) * 12;
    expect(exported).toBeCloseTo(703, 6);
  });

  it("da holgura de ancho segun la alineacion (izquierda, centro, derecha)", () => {
    const left = draftEditForBlock(makeBlock("l", { align: "left" }), { coverColor: null });
    const right = draftEditForBlock(makeBlock("r", { align: "right" }), { coverColor: null });
    const center = draftEditForBlock(makeBlock("c", { align: "center" }), { coverColor: null });
    expect(left.box.x).toBe(50);
    expect(left.box.width).toBeGreaterThan(200);
    expect(right.box.x + right.box.width).toBeCloseTo(250, 6);
    expect(center.box.x + center.box.width / 2).toBeCloseTo(150, 6);
  });

  it("el texto girado no recoloca su caja en vertical", () => {
    const block = makeBlock("rot", { rotation: 90, box: { x: 10, y: 10, width: 14, height: 100 } });
    const edit = draftEditForBlock(block, { coverColor: null });
    expect(edit.box.y).toBe(10);
    expect(edit.box.height).toBe(100);
    expect(edit.rotation).toBe(90);
  });

  it("los overrides mandan sobre todo", () => {
    const edit = draftEditForBlock(makeBlock("o"), {
      coverColor: "#ffffff",
      overrides: { text: "", fontSize: 30, bold: true },
    });
    expect(edit.text).toBe("");
    expect(edit.fontSize).toBe(30);
    expect(edit.bold).toBe(true);
  });
});

describe("newTextEditAt", () => {
  it("Helvetica 12 pt negro, sin cobertura y con la rotacion de la pagina", () => {
    const m = metricsFor([0, 0, 200, 100], 90, 100);
    const edit = newTextEditAt(m, 1, { left: 10, top: 10, width: 50, height: 14 }, "tx-1");
    expect(edit).toMatchObject({
      id: "tx-1",
      pageIndex: 1,
      text: "",
      fontSize: 12,
      color: "#000000",
      fontKey: "helvetica",
      bold: false,
      italic: false,
      align: "left",
      rotation: 90,
      cover: { color: null, padding: 0 },
    });
    expect(edit.blockId).toBeUndefined();
  });
});

describe("sampleCanvasBackground", () => {
  function solid(width: number, height: number, rgb: [number, number, number]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = rgb[0];
      data[i * 4 + 1] = rgb[1];
      data[i * 4 + 2] = rgb[2];
      data[i * 4 + 3] = 255;
    }
    return { data, width, height };
  }

  it("lee una ventana pequena alrededor de la caja y devuelve su color", () => {
    const calls: number[][] = [];
    const sample = sampleCanvasBackground(
      {
        getImageData: (x, y, w, h) => {
          calls.push([x, y, w, h]);
          return solid(w, h, [240, 244, 255]);
        },
      },
      { width: 1000, height: 1000 },
      { x: 100, y: 100, width: 50, height: 20 },
    );
    expect(sample?.color).toBe("#f0f4ff");
    expect(sample?.uniform).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBeLessThan(100);
  });

  it("sin contexto, fuera del canvas o si la lectura lanza devuelve null", () => {
    const box = { x: 10, y: 10, width: 10, height: 10 };
    expect(sampleCanvasBackground(null, { width: 100, height: 100 }, box)).toBeNull();
    expect(
      sampleCanvasBackground({ getImageData: () => solid(1, 1, [0, 0, 0]) }, { width: 100, height: 100 }, {
        x: 500,
        y: 500,
        width: 10,
        height: 10,
      }),
    ).toBeNull();
    expect(
      sampleCanvasBackground(
        {
          getImageData: () => {
            throw new Error("tainted");
          },
        },
        { width: 100, height: 100 },
        box,
      ),
    ).toBeNull();
  });
});

describe("nextFocusKey y excerpt", () => {
  it("al quitar una clave pasa a la siguiente y, si era la ultima, a la anterior", () => {
    expect(nextFocusKey(["a", "b", "c"], "b")).toBe("c");
    expect(nextFocusKey(["a", "b", "c"], "c")).toBe("b");
    expect(nextFocusKey(["a"], "a")).toBeNull();
    expect(nextFocusKey(["a", "b"], "zz")).toBe("a");
  });

  it("recorta y aplana el texto para anunciarlo", () => {
    expect(excerpt("  hola \n  mundo ")).toBe("hola mundo");
    expect(excerpt("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});

describe("previewMetrics", () => {
  it("la linea base del exportador sale de las metricas AFM / hhea de cada fuente", () => {
    expect(exportBaselineFromTop("helvetica", 1.2)).toBeCloseTo((1.2 - 0.925) / 2 + 0.718, 6);
    expect(exportBaselineFromTop("times", 1.2)).toBeCloseTo((1.2 - 0.9) / 2 + 0.683, 6);
    expect(exportBaselineFromTop("courier", 1)).toBeCloseTo((1 - 0.786) / 2 + 0.629, 6);
    // hhea de Liberation Serif 2.1.5 (1825 / 443 sobre 2048).
    expect(exportBaselineFromTop("liberation-serif", 1.2)).toBeCloseTo(
      (1.2 - (1825 + 443) / 2048) / 2 + 1825 / 2048,
      6,
    );
    expect(exportBaselineFromTop("liberation-mono", 1)).toBeCloseTo(
      (1 - (1705 + 615) / 2048) / 2 + 1705 / 2048,
      6,
    );
  });

  it("sin canvas (Node, jsdom) no hay correccion de la vista previa", () => {
    expect(
      previewBaselineShift({ fontKey: "helvetica", bold: false, italic: false, fontSize: 12, lineHeight: 1.2 }, 1.5),
    ).toBe(0);
  });
});

describe("makeMetrics", () => {
  it("la escala es px CSS por punto y el alto sigue la proporcion", () => {
    const g = geometryFromPdfJsPage({ view: [0, 0, 400, 200], rotate: 0 });
    const m = makeMetrics(g, 800);
    expect(m.scale).toBe(2);
    expect(m.cssHeight).toBe(400);
  });
});
