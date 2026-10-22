import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  imageRect,
  iou,
  multiplyMatrix,
  parseFillColor,
  unionCoverage,
  walkImagePaints,
  type ImageOpNumbers,
  type Matrix,
} from "./imagesOps";

/** Numeros de operador inventados (el recorrido solo compara identidades). */
const OPS: Required<ImageOpNumbers> = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
  paintImageXObjectRepeat: 88,
  paintInlineImageXObjectGroup: 87,
  paintImageMaskXObjectGroup: 84,
  paintImageMaskXObjectRepeat: 89,
  setFillRGBColor: 59,
  beginAnnotation: 80,
  endAnnotation: 81,
};

type Op = [number, unknown];
const run = (ops: Op[], max?: number) =>
  walkImagePaints(
    ops.map((op) => op[0]),
    ops.map((op) => op[1]),
    OPS,
    max,
  );

describe("walkImagePaints — matriz y pila", () => {
  it("una imagen simple lleva la matriz de su `cm`", () => {
    const { events } = run([
      [OPS.save, null],
      [OPS.transform, [100, 0, 0, 50, 20, 30]],
      [OPS.paintImageXObject, ["img_p0_1", 10, 5]],
      [OPS.restore, null],
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "xobject", objId: "img_p0_1", opIndex: 2, entry: 0, matrix: [100, 0, 0, 50, 20, 30], width: 10, height: 5, inForm: false });
  });

  it("`restore` deshace el `cm`: la imagen siguiente NO hereda la matriz anterior", () => {
    const { events } = run([
      [OPS.save, null],
      [OPS.transform, [2, 0, 0, 2, 5, 5]],
      [OPS.paintImageXObject, ["a", 1, 1]],
      [OPS.restore, null],
      [OPS.paintImageXObject, ["b", 1, 1]],
    ]);
    expect(events.map((event) => event.matrix)).toEqual([[2, 0, 0, 2, 5, 5], IDENTITY]);
  });

  it("los `cm` se componen en orden (el ultimo se aplica primero a la imagen)", () => {
    const { events } = run([
      [OPS.transform, [1, 0, 0, 1, 100, 0]],
      [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.paintImageXObject, ["a", 1, 1]],
    ]);
    // Punto (1, 0) de la imagen -> escala 2 -> (2, 0) -> traslacion -> (102, 0).
    const m = events[0].matrix;
    expect([m[0] * 1 + m[4], m[1] * 1 + m[5]]).toEqual([102, 0]);
    expect(multiplyMatrix([1, 0, 0, 1, 100, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 100, 0]);
  });

  it("un `restore` de mas no rompe: vuelve a la identidad", () => {
    const { events } = run([
      [OPS.restore, null],
      [OPS.paintImageXObject, ["a", 1, 1]],
    ]);
    expect(events[0].matrix).toEqual(IDENTITY);
  });

  it("ignora matrices incompletas o con valores no finitos", () => {
    const { events } = run([
      [OPS.transform, [1, 0, 0]],
      [OPS.transform, [1, 0, 0, 1, Number.NaN, 0]],
      [OPS.paintImageXObject, ["a", 1, 1]],
    ]);
    expect(events[0].matrix).toEqual(IDENTITY);
  });

  it("acepta la matriz como Float32Array (lo que entrega pdf.js)", () => {
    const { events } = run([
      [OPS.transform, new Float32Array([3, 0, 0, 3, 1, 1])],
      [OPS.paintImageXObject, ["a", 1, 1]],
    ]);
    expect(events[0].matrix).toEqual([3, 0, 0, 3, 1, 1]);
  });
});

describe("walkImagePaints — Form XObjects", () => {
  it("`paintFormXObjectBegin` aplica la matriz del formulario y `End` la deshace", () => {
    const { events } = run([
      [OPS.transform, [1, 0, 0, 1, 10, 10]],
      [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 5, 0], null]],
      [OPS.paintImageXObject, ["inside", 1, 1]],
      [OPS.paintFormXObjectEnd, []],
      [OPS.paintImageXObject, ["outside", 1, 1]],
    ]);
    expect(events[0]).toMatchObject({ objId: "inside", inForm: true, matrix: [2, 0, 0, 2, 15, 10] });
    expect(events[1]).toMatchObject({ objId: "outside", inForm: false, matrix: [1, 0, 0, 1, 10, 10] });
  });

  it("formularios anidados componen sus matrices de fuera hacia dentro", () => {
    const { events } = run([
      [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], null]],
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 7, 0], null]],
      [OPS.paintImageXObject, ["deep", 1, 1]],
      [OPS.paintFormXObjectEnd, []],
      [OPS.paintFormXObjectEnd, []],
    ]);
    // Punto (0,0) de la imagen: interior traslada 7, exterior escala 2 -> 14.
    expect(events[0].matrix).toEqual([2, 0, 0, 2, 14, 0]);
    expect(events[0].inForm).toBe(true);
  });

  it("un formulario sin matriz (null) no cambia la CTM", () => {
    const { events } = run([
      [OPS.paintFormXObjectBegin, [null, null]],
      [OPS.paintImageXObject, ["x", 1, 1]],
      [OPS.paintFormXObjectEnd, []],
    ]);
    expect(events[0].matrix).toEqual(IDENTITY);
  });
});

describe("walkImagePaints — las demas formas de pintar una imagen", () => {
  it("imagen en linea: guarda sus datos y ninguna referencia de objeto", () => {
    const data = { width: 8, height: 8, kind: 3, data: new Uint8ClampedArray(256) };
    const { events } = run([
      [OPS.transform, [8, 0, 0, 8, 1, 2]],
      [OPS.paintInlineImageXObject, [data]],
    ]);
    expect(events[0]).toMatchObject({ kind: "inline", objId: null, width: 8, height: 8 });
    expect(events[0].inline).toBe(data);
  });

  it("mascara de 1 bit: el id del objeto va en `data` y el color es el de relleno vigente", () => {
    const { events } = run([
      [OPS.setFillRGBColor, ["#ff8000"]],
      [OPS.paintImageMaskXObject, [{ data: "mask_p0_2", width: 16, height: 16 }]],
    ]);
    expect(events[0]).toMatchObject({ kind: "mask", objId: "mask_p0_2", fill: [255, 128, 0] });
  });

  it("el color de relleno se restaura con `restore`", () => {
    const { events } = run([
      [OPS.save, null],
      [OPS.setFillRGBColor, ["#00ff00"]],
      [OPS.paintImageMaskXObject, [{ data: "m1", width: 1, height: 1 }]],
      [OPS.restore, null],
      [OPS.paintImageMaskXObject, [{ data: "m2", width: 1, height: 1 }]],
    ]);
    expect(events.map((event) => event.fill)).toEqual([[0, 255, 0], [0, 0, 0]]);
  });

  it("`paintImageXObjectRepeat`: una aparicion por posicion, con escala y traslacion de cada una", () => {
    const { events } = run([
      [OPS.transform, [1, 0, 0, 1, 100, 200]],
      [OPS.paintImageXObjectRepeat, ["img", 50, 40, new Float32Array([0, 0, 60, 0, 120, 10])]],
    ]);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.entry)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.matrix)).toEqual([
      [50, 0, 0, 40, 100, 200],
      [50, 0, 0, 40, 160, 200],
      [50, 0, 0, 40, 220, 210],
    ]);
    expect(new Set(events.map((event) => event.opIndex)).size).toBe(1);
  });

  it("`paintImageMaskXObjectRepeat` usa las cuatro componentes de la matriz", () => {
    const { events } = run([[OPS.paintImageMaskXObjectRepeat, [{ data: "m", width: 4, height: 4 }, 10, 0, 0, 12, new Float32Array([5, 6, 7, 8])]]]);
    expect(events.map((event) => event.matrix)).toEqual([
      [10, 0, 0, 12, 5, 6],
      [10, 0, 0, 12, 7, 8],
    ]);
  });

  it("`paintImageMaskXObjectGroup`: cada mascara trae su transformacion", () => {
    const { events } = run([
      [OPS.transform, [1, 0, 0, 1, 1, 1]],
      [
        OPS.paintImageMaskXObjectGroup,
        [
          [
            { data: "a", width: 2, height: 2, transform: [4, 0, 0, 4, 10, 10] },
            { data: "b", width: 2, height: 2, transform: [5, 0, 0, 5, 20, 20] },
          ],
        ],
      ],
    ]);
    expect(events.map((event) => [event.objId, event.entry, event.matrix])).toEqual([
      ["a", 0, [4, 0, 0, 4, 11, 11]],
      ["b", 1, [5, 0, 0, 5, 21, 21]],
    ]);
  });

  it("`paintInlineImageXObjectGroup`: casillas del atlas con su transformacion", () => {
    const atlas = { width: 20, height: 10, kind: 3, data: new Uint8ClampedArray(800) };
    const { events } = run([
      [
        OPS.paintInlineImageXObjectGroup,
        [
          atlas,
          [
            { transform: [8, 0, 0, 8, 0, 0], x: 1, y: 1, w: 8, h: 8 },
            { transform: [8, 0, 0, 8, 10, 0], x: 11, y: 1, w: 8, h: 8 },
          ],
        ],
      ],
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "inline", entry: 1, atlas: { x: 11, y: 1, w: 8, h: 8 }, matrix: [8, 0, 0, 8, 10, 0] });
    expect(events[0].inline).toBe(atlas);
  });

  it("`paintSolidColorImageMask` (un relleno) y los operadores ajenos no cuentan", () => {
    const { events } = run([
      [90, []],
      [44, ["texto"]],
      [OPS.paintImageXObject, [42, 1, 1]], // sin id de objeto valido
    ]);
    expect(events).toEqual([]);
  });

  it("respeta el tope de pinturas y avisa de que se corto", () => {
    const ops: Op[] = [];
    for (let i = 0; i < 20; i += 1) ops.push([OPS.paintImageXObject, [`img${i}`, 1, 1]]);
    const result = run(ops, 5);
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(run(ops, 20).truncated).toBe(false);
  });

  it("un grupo se corta a mitad al llegar al tope", () => {
    const positions = new Float32Array(200);
    const result = run([[OPS.paintImageXObjectRepeat, ["img", 1, 1, positions]]], 10);
    expect(result.events).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe("walkImagePaints — anotaciones", () => {
  it("dentro de una anotacion la CTM parte de la identidad de la pagina y aplica su transformacion y su matriz", () => {
    const { events } = run([
      [OPS.transform, [9, 0, 0, 9, 99, 99]], // el contenido deja una matriz puesta (sin q/Q de cierre)
      [OPS.paintImageXObject, ["page", 1, 1]],
      [OPS.paintFormXObjectBegin, [[3, 0, 0, 3, 0, 0], null]], // y un formulario sin cerrar
      [OPS.beginAnnotation, ["9R", [150, 150, 210, 210], [1, 0, 0, 1, 150, 150], [2, 0, 0, 2, 1, 1], false]],
      [OPS.save, null],
      [OPS.transform, [60, 0, 0, 60, 0, 0]],
      [OPS.paintImageXObject, ["annot", 1, 1]],
      [OPS.restore, null],
      [OPS.endAnnotation, []],
      [OPS.paintImageXObject, ["after", 1, 1]],
    ]);
    expect(events.map((event) => [event.objId, event.inAnnotation])).toEqual([["page", false], ["annot", true], ["after", false]]);
    // transformacion [1,0,0,1,150,150], despues la matriz [2,0,0,2,1,1] (traslada 1 * 1) y despues el cm [60,...]
    expect(events[1].matrix).toEqual([120, 0, 0, 120, 151, 151]);
    expect(events[1].inForm).toBe(false);
    expect(events[2].matrix).toEqual(IDENTITY);
  });

  it("un `restore` de mas dentro de la anotacion no recupera una matriz del contenido anterior", () => {
    const { events } = run([
      [OPS.transform, [5, 0, 0, 5, 1, 1]],
      [OPS.paintFormXObjectBegin, [[7, 0, 0, 7, 40, 40], null]], // formulario sin cerrar: deja una entrada (con la matriz de antes) en la pila
      [OPS.beginAnnotation, ["9R", [0, 0, 1, 1], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], false]],
      [OPS.restore, null],
      [OPS.paintImageXObject, ["annot", 1, 1]],
      [OPS.endAnnotation, []],
    ]);
    expect(events[0].matrix).toEqual(IDENTITY);
  });

  it("sin los numeros de operador de anotacion (pdf.js sin ellos) no pasa nada", () => {
    const partial: ImageOpNumbers = { ...OPS };
    delete partial.beginAnnotation;
    delete partial.endAnnotation;
    const result = walkImagePaints([OPS.paintImageXObject], [["a", 1, 1]], partial);
    expect(result.events).toHaveLength(1);
  });
});

describe("parseFillColor", () => {
  it("lee #rrggbb, rrggbb y [r, g, b]", () => {
    expect(parseFillColor("#102030")).toEqual([16, 32, 48]);
    expect(parseFillColor("FF0000")).toEqual([255, 0, 0]);
    expect(parseFillColor([300, -5, 12.4])).toEqual([255, 0, 12]);
    expect(parseFillColor("rojo")).toBeNull();
    expect(parseFillColor(7)).toBeNull();
  });
});

describe("imageRect — caja normalizada sobre la pagina", () => {
  // Visor sin girar de una pagina de 200 x 100: x' = x, y' = 100 - y.
  const view = { transform: [1, 0, 0, -1, 0, 100], width: 200, height: 100 };

  it("coloca el cuadrado unidad con origen ARRIBA-izquierda", () => {
    const rect = imageRect([50, 0, 0, 20, 10, 30], view);
    expect(rect.x).toBeCloseTo(0.05);
    expect(rect.width).toBeCloseTo(0.25);
    expect(rect.y).toBeCloseTo((100 - 50) / 100);
    expect(rect.height).toBeCloseTo(0.2);
  });

  it("una imagen girada 90 grados ocupa la caja que la contiene", () => {
    const m: Matrix = [0, 40, -20, 0, 100, 10]; // 20 de ancho x 40 de alto tras girar
    const rect = imageRect(m, view);
    expect(rect.width * 200).toBeCloseTo(20);
    expect(rect.height * 100).toBeCloseTo(40);
    expect(rect.x * 200).toBeCloseTo(80);
  });

  it("recorta a la pagina lo que se sale", () => {
    const rect = imageRect([300, 0, 0, 300, -50, -50], view);
    expect(rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("con el visor de una pagina girada (Rotate 90) intercambia ejes", () => {
    // Rotate 90 de pdf.js sobre una pagina de 200 x 100: ancho 100, alto 200.
    const rotated = { transform: [0, 1, 1, 0, 0, 0], width: 100, height: 200 };
    const rect = imageRect([40, 0, 0, 20, 10, 10], rotated);
    expect(rect.width * 100).toBeCloseTo(20);
    expect(rect.height * 200).toBeCloseTo(40);
  });
});

describe("unionCoverage e iou", () => {
  it("una imagen a pagina completa cubre 1; la mitad, 0,5", () => {
    expect(unionCoverage([{ x: 0, y: 0, width: 1, height: 1 }])).toBe(1);
    expect(unionCoverage([{ x: 0, y: 0, width: 0.5, height: 1 }])).toBeCloseTo(0.5);
    expect(unionCoverage([])).toBe(0);
  });

  it("la UNION no suma dos veces lo que se solapa (dos cajas iguales = una)", () => {
    const half = { x: 0, y: 0, width: 1, height: 0.5 };
    expect(unionCoverage([half, half, half])).toBeCloseTo(0.5);
  });

  it("dos mitades que se tocan cubren la pagina", () => {
    expect(unionCoverage([{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }])).toBeCloseTo(1);
  });

  it("iou: iguales = 1, disjuntas = 0, solapadas a la mitad = 1/3", () => {
    const a = { x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x: 0.6, y: 0.6, width: 0.2, height: 0.2 })).toBe(0);
    expect(iou(a, { x: 0.25, y: 0, width: 0.5, height: 0.5 })).toBeCloseTo(1 / 3);
    expect(iou({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBe(0);
  });
});
