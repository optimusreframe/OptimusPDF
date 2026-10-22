import { beforeAll, describe, expect, it } from "vitest";
import { DRAW, hexToHsv, multiply, scanPageOperators, type ViewMapper } from "./watermarkOps";
import { getLegacyOps, getLegacyPdfjs, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { makeFormStamps, makeRotatedPage, makeStampAnnot, makeTextWatermark6 } from "./__fixtures__/annots/generate";
import { makePageEnv } from "./annotationsPage";
import { napiSurfaceFactory } from "./__fixtures__/annots/nodeEnv";
import type { PdfOps } from "./annotationsTypes";

let OPS: PdfOps;
beforeAll(async () => {
  OPS = await getLegacyOps();
});

/** Mapeo de usuario a vista de una pagina de 600 x 800 sin giro (y hacia abajo). */
const view: ViewMapper = { toView: (x, y) => [x, 800 - y] };

type Op = [string, unknown?];
function run(list: Op[], map: ViewMapper = view) {
  return scanPageOperators(
    list.map(([name]) => OPS[name]),
    list.map(([, args]) => args ?? null),
    OPS,
    map,
  );
}

const glyphs = (text: string, width = 600) => [[...text].map((char) => ({ unicode: char, width }))];

describe("constantes de pdf.js que usa el recorrido", () => {
  it("los nombres de operadores existen en pdf.js (DrawOPS no se exporta: lo cubre la prueba con paginas reales de abajo)", async () => {
    const pdfjs = await getLegacyPdfjs();
    expect(pdfjs.OPS).toBeDefined();
    expect(DRAW).toEqual({ moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 });
    for (const name of [
      "save", "restore", "transform", "setGState", "setFillRGBColor", "setStrokeRGBColor", "beginText", "endText", "setFont", "setTextRenderingMode",
      "setLeading", "setTextMatrix", "moveText", "setLeadingMoveText", "nextLine", "showText", "beginMarkedContent", "beginMarkedContentProps",
      "endMarkedContent", "paintFormXObjectBegin", "paintFormXObjectEnd", "constructPath", "paintImageXObject", "paintInlineImageXObject",
      "paintImageMaskXObject", "stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke",
    ]) {
      expect(OPS[name], name).toBeTypeOf("number");
    }
  });
});

describe("texto", () => {
  it("lee opacidad (ca), tamano efectivo, angulo y caja de un texto girado", () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const graphics = run([
      ["save"],
      ["setGState", [[["ca", 0.2]]]],
      ["beginText"],
      ["setFont", ["f1", 50]],
      ["setTextMatrix", [[c, s, -s, c, 100, 200]]],
      ["showText", glyphs("MARCA")],
      ["endText"],
      ["restore"],
    ]);
    expect(graphics.textRuns).toHaveLength(1);
    const run1 = graphics.textRuns[0];
    expect(run1.text).toBe("MARCA");
    expect(run1.alpha).toBe(0.2);
    expect(run1.angleDeg).toBeCloseTo(30, 0);
    expect(run1.fontSizePt).toBe(50);
    expect(run1.bbox.width).toBeGreaterThan(100);
    expect(run1.bbox.height).toBeGreaterThan(100);
  });

  it("la opacidad vuelve a 1 tras restore", () => {
    const graphics = run([
      ["save"],
      ["setGState", [[["ca", 0.3]]]],
      ["restore"],
      ["beginText"],
      ["setFont", ["f1", 12]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 10]]],
      ["showText", glyphs("normal")],
    ]);
    expect(graphics.textRuns[0].alpha).toBe(1);
  });

  it("el cm (transform) escala el cuerpo y el angulo se mide en la VISTA", () => {
    const graphics = run([
      ["save"],
      ["transform", [2, 0, 0, 2, 0, 0]],
      ["beginText"],
      ["setFont", ["f1", 10]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 10]]],
      ["showText", glyphs("doble")],
    ]);
    expect(graphics.textRuns[0].fontSizePt).toBe(20);
    // Una vista girada 90 grados (x_vista = y_usuario) convierte el texto horizontal en vertical.
    const rotated = run([["beginText"], ["setFont", ["f1", 10]], ["setTextMatrix", [[1, 0, 0, 1, 10, 10]]], ["showText", glyphs("vertical")]], { toView: (x, y) => [y, x] });
    expect(Math.abs(rotated.textRuns[0].angleDeg)).toBe(90);
  });

  it("junta Tj consecutivos de una linea, y suma las repeticiones de un mosaico", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("HOLA", 500)],
      ["showText", glyphs("MUNDO", 500)],
      ["endText"],
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 300]]],
      ["showText", glyphs("HOLAMUNDO", 500)],
      ["endText"],
    ]);
    expect(graphics.textRuns).toHaveLength(1);
    expect(graphics.textRuns[0].text).toBe("HOLAMUNDO");
    expect(graphics.textRuns[0].count).toBe(2);
  });

  it("separa con espacio cuando hay hueco entre dos Tj", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("UNO", 500)],
      ["moveText", [40, 0]],
      ["showText", glyphs("DOS", 500)],
    ]);
    expect(graphics.textRuns.map((r) => r.text)).toEqual(["UNO DOS"]);
  });

  it("el texto invisible (modo 3, capas de OCR) y el solo de recorte no cuentan", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 40]],
      ["setTextRenderingMode", [3]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("OCR invisible")],
      ["setTextRenderingMode", [7]],
      ["showText", glyphs("recorte")],
    ]);
    expect(graphics.textRuns).toEqual([]);
  });

  it("no junta textos contiguos que estan en capas opcionales distintas", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["beginMarkedContentProps", ["OC", { type: "OCG", id: "7R" }]],
      ["showText", glyphs("CAPA", 500)],
      ["endMarkedContent"],
      ["showText", glyphs("LIBRE", 500)],
    ]);
    expect(graphics.textRuns.map((r) => [r.text, r.ocIds])).toEqual([["CAPA", ["7R"]], ["LIBRE", []]]);
  });

  it("T* y TD usan el interlineado; los ajustes numericos de TJ mueven el cursor", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 10]],
      ["setLeading", [20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 300]]],
      ["showText", glyphs("a")],
      ["nextLine"],
      ["showText", glyphs("b")],
      ["setLeadingMoveText", [0, -30]],
      ["showText", [[{ unicode: "c", width: 500 }, -1000, { unicode: "d", width: 500 }]]],
    ]);
    expect(graphics.textRuns.map((r) => r.text)).toEqual(["a", "b", "c d"]);
    expect(graphics.textRuns[1].bbox.y).toBeGreaterThan(graphics.textRuns[0].bbox.y); // bajó una linea en la vista
  });

  it("argumentos inesperados no hacen lanzar y se siguen leyendo los demas operadores", () => {
    const graphics = run([
      ["setGState", null],
      ["setTextMatrix", [[1, 2]]],
      ["showText", ["no son glifos"]],
      ["transform", ["x"]],
      ["beginText"],
      ["setFont", ["f1", 10]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("sigue")],
    ]);
    expect(graphics.textRuns.map((r) => r.text)).toEqual(["sigue"]);
  });
});

describe("contenido opcional", () => {
  it("anota los grupos OCG y OCMD que usa la pagina y los de cada texto", () => {
    const graphics = run([
      ["beginMarkedContentProps", ["OC", { type: "OCG", id: "7R" }]],
      ["beginText"],
      ["setFont", ["f1", 40]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("DENTRO")],
      ["endMarkedContent"],
      ["beginMarkedContentProps", ["OC", { type: "OCMD", ids: ["8R", "9R"] }]],
      ["endMarkedContent"],
      ["beginMarkedContent", ["Span"]],
      ["endMarkedContent"],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 400]]],
      ["showText", glyphs("FUERA")],
    ]);
    expect([...graphics.ocgRefs].sort()).toEqual(["7R", "8R", "9R"]);
    expect(graphics.textRuns.find((r) => r.text === "DENTRO")?.ocIds).toEqual(["7R"]);
    expect(graphics.textRuns.find((r) => r.text === "FUERA")?.ocIds).toEqual([]);
  });
});

describe("Form XObjects", () => {
  const circle = [DRAW.moveTo, 150, 100, DRAW.curveTo, 150, 120, 130, 140, 100, 140, DRAW.curveTo, 70, 140, 50, 120, 50, 100, DRAW.curveTo, 50, 80, 70, 60, 100, 60, DRAW.curveTo, 130, 60, 150, 80, 150, 100];

  it("recoge la caja de lo que pinta, el color dominante y la forma", () => {
    const graphics = run([
      ["save"],
      ["paintFormXObjectBegin", [null, [0, 0, 200, 200]]],
      ["setStrokeRGBColor", ["#d90d0d"]],
      ["constructPath", [OPS.stroke, [circle], new Float32Array([50, 60, 150, 140])]],
      ["paintFormXObjectEnd"],
      ["restore"],
    ]);
    expect(graphics.forms).toHaveLength(1);
    const form = graphics.forms[0];
    expect(form.dominantColor).toBe("#d90d0d");
    expect(form.dominantShare).toBe(1);
    expect(form.curves).toBe(4);
    expect(form.bbox).toEqual({ x: 50, y: 660, width: 100, height: 80 });
  });

  it("un Form dentro de otro se cuenta como uno solo (el externo)", () => {
    const graphics = run([
      ["paintFormXObjectBegin", [null, null]],
      ["paintFormXObjectBegin", [[1, 0, 0, 1, 10, 10], null]],
      ["setStrokeRGBColor", ["#0000ff"]],
      ["constructPath", [OPS.stroke, [[DRAW.moveTo, 0, 0, DRAW.lineTo, 10, 0, DRAW.lineTo, 10, 10, DRAW.lineTo, 0, 10, DRAW.closePath]], new Float32Array([0, 0, 10, 10])]],
      ["paintFormXObjectEnd"],
      ["paintFormXObjectEnd"],
    ]);
    expect(graphics.forms).toHaveLength(1);
    expect(graphics.forms[0].lines).toBe(3);
    expect(graphics.forms[0].bbox.x).toBe(10);
  });

  it("el color dominante se pondera por operaciones de pintura y el texto cuenta como pintura", () => {
    const graphics = run([
      ["paintFormXObjectBegin", [null, null]],
      ["setStrokeRGBColor", ["#ff0000"]],
      ["setFillRGBColor", ["#000000"]],
      ["constructPath", [OPS.stroke, [[DRAW.moveTo, 0, 0, DRAW.lineTo, 50, 50]], new Float32Array([0, 0, 50, 50])]],
      ["beginText"],
      ["setFont", ["f1", 10]],
      ["showText", glyphs("TEXTO")],
      ["paintFormXObjectEnd"],
    ]);
    const form = graphics.forms[0];
    expect(form.hasText).toBe(true);
    expect(form.text).toBe("TEXTO");
    expect(form.dominantColor).toBe("#000000");
    expect(form.dominantShare).toBeCloseTo(2 / 3, 2);
  });

  it("formas con las mismas operaciones tienen la misma huella aunque esten en otra posicion", () => {
    const make = (dx: number) =>
      run([
        ["save"],
        ["transform", [1, 0, 0, 1, dx, 0]],
        ["paintFormXObjectBegin", [null, null]],
        ["setStrokeRGBColor", ["#d90d0d"]],
        ["constructPath", [OPS.stroke, [circle], new Float32Array([50, 60, 150, 140])]],
        ["paintFormXObjectEnd"],
        ["restore"],
      ]).forms[0];
    expect(make(0).fingerprint).toBe(make(300).fingerprint);
    expect(make(0).bbox.x).not.toBe(make(300).bbox.x);
  });

  it("un Form sin pintura no es candidato", () => {
    expect(run([["paintFormXObjectBegin", [null, null]], ["paintFormXObjectEnd"]]).forms).toEqual([]);
  });
});

describe("imagenes", () => {
  it("anota la caja, el nombre del objeto y la opacidad vigente", () => {
    const graphics = run([
      ["save"],
      ["setGState", [[["ca", 0.25]]]],
      ["transform", [300, 0, 0, 200, 50, 100]],
      ["paintImageXObject", ["img_p0_1", 100, 100]],
      ["restore"],
      ["paintInlineImageXObject", [{}]],
    ]);
    expect(graphics.images).toHaveLength(2);
    expect(graphics.images[0]).toMatchObject({ objectId: "img_p0_1", alpha: 0.25, bbox: { x: 50, width: 300, height: 200 } });
    expect(graphics.images[1].objectId).toBeNull();
    expect(graphics.images[1].alpha).toBe(1);
  });
});

describe("anotaciones dentro de la lista de operadores", () => {
  it("lo que va entre beginAnnotation y endAnnotation no es contenido de la pagina", () => {
    const graphics = run([
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 100]]],
      ["showText", glyphs("PAGINA", 500)],
      ["endText"],
      ["beginAnnotation", ["13R", [0, 0, 10, 10], [1, 0, 0, 1, 0, 0]]],
      ["paintFormXObjectBegin", [null, null]],
      ["setStrokeRGBColor", ["#ff0000"]],
      ["constructPath", [OPS.stroke, [[DRAW.moveTo, 0, 0, DRAW.lineTo, 10, 10]], new Float32Array([0, 0, 10, 10])]],
      ["paintFormXObjectEnd"],
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 300]]],
      ["showText", glyphs("SELLO", 500)],
      ["endAnnotation"],
      ["beginText"],
      ["setFont", ["f1", 20]],
      ["setTextMatrix", [[1, 0, 0, 1, 10, 500]]],
      ["showText", glyphs("DESPUES", 500)],
    ]);
    expect(graphics.textRuns.map((r) => r.text)).toEqual(["PAGINA", "DESPUES"]);
    expect(graphics.forms).toEqual([]);
  });

  it("con una pagina real y las anotaciones ACTIVAS, el texto del sello (anotacion) no se cuenta como texto de la pagina", async () => {
    const fixture = await makeStampAnnot();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const env = makePageEnv(doc, page, 0, napiSurfaceFactory);
      const list = await page.getOperatorList();
      const names = Object.entries(OPS).filter(([, value]) => list.fnArray.includes(value as never)).map(([name]) => name);
      expect(names).toContain("beginAnnotation");
      const graphics = scanPageOperators(list.fnArray as never, list.argsArray as never, OPS, env);
      expect(graphics.textRuns.some((r) => r.text === "APROBADO")).toBe(false);
      expect(graphics.textRuns.some((r) => r.text.startsWith("Linea 1"))).toBe(true);
    });
  });
});

describe("matematicas", () => {
  it("multiply aplica primero la segunda matriz", () => {
    expect(multiply([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 10, 0]);
    expect(multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 0])).toEqual([2, 0, 0, 2, 20, 0]);
  });

  it("hexToHsv", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#0000ff")?.h).toBe(240);
    expect(hexToHsv("#808080")).toMatchObject({ s: 0 });
    expect(hexToHsv("rojo")).toBeNull();
  });
});

describe("con paginas reales de pdf.js", () => {
  it("el texto translucido de pdf-lib sale con ca, giro de 40 grados y tamano 64", async () => {
    const fixture = await makeTextWatermark6();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const env = makePageEnv(doc, page, 0, napiSurfaceFactory);
      const list = await page.getOperatorList({ annotationMode: 0 } as never);
      const graphics = scanPageOperators(list.fnArray as never, list.argsArray as never, OPS, env);
      const mark = graphics.textRuns.find((r) => r.text === "USO INTERNO");
      expect(mark).toBeDefined();
      expect(mark?.alpha).toBeCloseTo(0.2, 3);
      expect(mark?.angleDeg).toBeCloseTo(40, 0);
      expect(mark?.fontSizePt).toBeCloseTo(64, 0);
      expect(graphics.textRuns.filter((r) => r.alpha === 1).length).toBeGreaterThan(5);
    });
  });

  it("en una pagina girada 90 el texto horizontal del usuario se ve vertical, y las cajas estan en la vista", async () => {
    const fixture = await makeRotatedPage();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const env = makePageEnv(doc, page, 0, napiSurfaceFactory);
      expect([env.viewWidth, env.viewHeight]).toEqual([792, 612]);
      const list = await page.getOperatorList({ annotationMode: 0 } as never);
      const graphics = scanPageOperators(list.fnArray as never, list.argsArray as never, OPS, env);
      const title = graphics.textRuns.find((r) => r.text.startsWith("Pagina girada"));
      expect(Math.abs(title?.angleDeg ?? 0)).toBe(90);
      for (const r of graphics.textRuns) {
        expect(r.bbox.x).toBeGreaterThanOrEqual(0);
        expect(r.bbox.x + r.bbox.width).toBeLessThanOrEqual(792.5);
      }
    });
  });

  it("los Form XObjects del corpus dan color, forma y texto", async () => {
    const fixture = await makeFormStamps();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const page = await doc.getPage(1);
      const env = makePageEnv(doc, page, 0, napiSurfaceFactory);
      const list = await page.getOperatorList({ annotationMode: 0 } as never);
      const forms = scanPageOperators(list.fnArray as never, list.argsArray as never, OPS, env).forms;
      expect(forms).toHaveLength(3);
      const red = forms.find((f) => f.text === "RECIBIDO");
      expect(red).toMatchObject({ dominantColor: "#d90d0d", curves: 4, hasText: true });
      expect(forms.find((f) => f.text === "GRIS")?.lines).toBeGreaterThanOrEqual(3);
    });
  });
});
