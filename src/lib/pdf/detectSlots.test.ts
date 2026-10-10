import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SLOTS_PER_PAGE,
  MAX_THIN_SEGMENTS_PER_PAGE,
  findFillSlots,
  nearestLabel,
  underscoreSegments,
  type PaintedBox,
  type RawText,
  type Seg,
  type SlotInput,
  type SlotText,
  type VerticalSeg,
} from "@/lib/pdf/detectSlots";

/**
 * Reglas de la deteccion CONSERVADORA de huecos (W6-A), probadas con geometria
 * a mano (sin pdf.js): una raya solo es un hueco si esta aislada, lleva
 * etiqueta, no forma parte de una tabla, no borda cajas ni cruza texto y no
 * ocupa media pagina. Las pruebas con PDF reales estan en
 * `detectFieldsConservative.test.ts`.
 */

/** Escala con la que se ejecuta la bateria entera (ver el final del archivo): ningun resultado depende de los puntos absolutos. */
let K = 1;
const page = () => ({ pageWidth: 600 * K, pageHeight: 800 * K });

function seg(x0: number, x1: number, y: number, thickness = 0.8): Seg {
  return { x0: x0 * K, x1: x1 * K, y: y * K, thickness: thickness * K, fromText: -1 };
}

function text(textValue: string, left: number, baseline: number, height = 11, width?: number): SlotText {
  return {
    text: textValue,
    left: left * K,
    right: (left + (width ?? textValue.length * height * 0.5)) * K,
    baseline: baseline * K,
    height: height * K,
  };
}

function input(parts: Partial<SlotInput>): SlotInput {
  return { segments: [], verticals: [], boxes: [], texts: [], ...page(), ...parts };
}

function suite() {
  describe("findFillSlots — una raya aislada con etiqueta es un hueco", () => {
    it("«Nombre: ____»: etiqueta a la izquierda en la misma linea", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(100, 300, 698)],
          texts: [text("Nombre:", 50, 700, 11, 42)],
        }),
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].label).toBe("Nombre:");
      expect(slots[0].kind).toBe("left");
      expect(slots[0].box.x).toBeCloseTo(100 * K, 3);
      expect(slots[0].box.width).toBeCloseTo(200 * K, 3);
    });

    it("rotulo ENCIMA de la raya (con el espacio de escritura entre ambos)", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(50, 250, 440)],
          texts: [text("Firma del solicitante", 50, 470, 9, 80)],
        }),
      );
      expect(slots.map((s) => s.label)).toEqual(["Firma del solicitante"]);
      expect(slots[0].kind).toBe("above");
    });

    it("leyenda DEBAJO de una linea fina de firma", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(50, 250, 440, 0.6)],
          texts: [text("Firma", 50, 428, 9, 25)],
        }),
      );
      expect(slots.map((s) => s.label)).toEqual(["Firma"]);
      expect(slots[0].kind).toBe("below");
    });

    it("une el texto contiguo de una etiqueta partida («Fecha de» + «nacimiento:»)", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(160, 300, 698)],
          texts: [text("Fecha de", 50, 700, 11, 40), text("nacimiento:", 94, 700, 11, 60)],
        }),
      );
      expect(slots[0].label).toBe("Fecha de nacimiento:");
    });
  });

  describe("findFillSlots — lo que NO es un hueco", () => {
    it("una raya sin etiqueta (regla decorativa) se descarta", () => {
      expect(findFillSlots(input({ segments: [seg(100, 300, 500)], texts: [] }))).toEqual([]);
    });

    it("una raya de mas del 50 % del ancho de la pagina es un separador (salvo con una etiqueta corta pegada a su izquierda o un rotulo de campo encima con sitio para escribir)", () => {
      // Rotulo ENCIMA pegado a la raya (sin sitio para escribir): un separador.
      expect(
        findFillSlots(input({ segments: [seg(50, 400, 698)], texts: [text("Nombre", 50, 704, 9, 30)] })),
      ).toEqual([]);
      // Sin etiqueta: decoracion.
      expect(findFillSlots(input({ segments: [seg(50, 400, 698)] }))).toEqual([]);
    });

    it("... con un rotulo de campo encima y sitio para escribir (la linea de respuesta de una encuesta) si es un hueco", () => {
      const slots = findFillSlots(
        input({ segments: [seg(50, 400, 698)], texts: [text("Nombre completo", 50, 716, 9, 70)] }),
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].kind).toBe("above");
    });

    it("una raya demasiado corta (< 30 pt) o demasiado gruesa (> 6 pt) no cuenta", () => {
      expect(
        findFillSlots(input({ segments: [seg(100, 120, 698)], texts: [text("A:", 80, 700, 11, 10)] })),
      ).toEqual([]);
      expect(
        findFillSlots(input({ segments: [seg(100, 300, 698, 8)], texts: [text("A:", 80, 700, 11, 10)] })),
      ).toEqual([]);
    });

    it("tres rayas equidistantes sin etiqueta a la izquierda (tabla, papel pautado) se descartan, aunque tengan rotulo encima", () => {
      const rows = [600, 570, 540, 510];
      const slots = findFillSlots(
        input({
          segments: rows.map((y) => seg(50, 250, y)),
          texts: rows.map((y, index) => text(`Item ${index}`, 56, y + 10, 10, 30)),
        }),
      );
      expect(slots).toEqual([]);
    });

    it("tres rayas equidistantes CON etiqueta a la izquierda (un formulario) se conservan", () => {
      const rows = [600, 570, 540];
      const slots = findFillSlots(
        input({
          segments: rows.map((y) => seg(120, 320, y - 2)),
          texts: [text("Nombre:", 50, 600, 11, 42), text("Apellidos:", 50, 570, 11, 48), text("DNI:", 50, 540, 11, 22)],
        }),
      );
      expect(slots.map((s) => s.label).sort()).toEqual(["Apellidos:", "DNI:", "Nombre:"]);
    });

    it("la raya que toca una vertical por un extremo o la cruza (celda de cuadricula) se descarta", () => {
      const base = { segments: [seg(100, 300, 500)], texts: [text("Cliente:", 50, 502, 11, 40)] };
      const edge: VerticalSeg[] = [{ x: 100 * K, y0: 470 * K, y1: 530 * K }];
      const cross: VerticalSeg[] = [{ x: 200 * K, y0: 470 * K, y1: 530 * K }];
      expect(findFillSlots(input({ ...base, verticals: edge }))).toEqual([]);
      expect(findFillSlots(input({ ...base, verticals: cross }))).toEqual([]);
      expect(findFillSlots(input(base))).toHaveLength(1);
    });

    it("la raya sobre el borde de una caja (superior o inferior) se descarta", () => {
      const boxes: PaintedBox[] = [box(90, 500, 310, 560)];
      const bottom = findFillSlots(
        input({ segments: [seg(100, 300, 500)], boxes, texts: [text("Cliente:", 50, 502, 11, 40)] }),
      );
      const top = findFillSlots(
        input({ segments: [seg(100, 300, 560)], boxes, texts: [text("Cliente:", 50, 562, 11, 40)] }),
      );
      // La raya del borde no es un campo; solo la CAJA vacia con etiqueta lo es (una vez, con su alto).
      expect(bottom.every((slot) => slot.box.height > 10)).toBe(true);
      expect(top.every((slot) => slot.box.height > 10)).toBe(true);
    });

    it("el subrayado de un texto (el texto se apoya en la raya, >= 50 %) no es un hueco", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(100, 220, 497)],
          texts: [text("Ver condiciones", 100, 500, 11, 120), text("Nota:", 60, 500, 11, 30)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("la raya que atraviesa un texto (tachado) no es un hueco", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(100, 220, 505)],
          texts: [text("Precio antiguo", 100, 500, 11, 120), text("Nota:", 60, 500, 11, 30)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("una barra decorativa gruesa bajo un titular no es una linea de firma", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(60, 180, 384, 4)],
          texts: [text("Capitulo uno", 60, 360, 9, 60)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("un rotulo encima del tamano de un titular no vale como etiqueta", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(60, 260, 400)],
          texts: [text("Titulo grande", 60, 420, 30, 150)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("el texto de una celda 10 pt por encima del borde no cuenta como etiqueta a la izquierda", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(200, 330, 400)],
          // Celda de la izquierda: base 10 pt por encima del borde de la celda de la derecha.
          texts: [text("Item", 150, 410, 10, 30)],
        }),
      );
      expect(slots.filter((s) => s.kind === "left")).toEqual([]);
    });

    it("una pagina con mas de 600 rayas finas (degradado) no se analiza", () => {
      const strips = Array.from({ length: MAX_THIN_SEGMENTS_PER_PAGE + 1 }, (_, i) => seg(10, 200, 10 + i * 1.2, 0.4));
      expect(
        findFillSlots(input({ segments: strips, texts: [text("Titulo:", 5, 300, 11, 30)] })),
      ).toEqual([]);
    });

    it("una raya dibujada dos veces cuenta como una sola", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(100, 300, 698, 0.5), seg(100, 300, 698.8, 0.5)],
          texts: [text("Nombre:", 50, 700, 11, 42)],
        }),
      );
      expect(slots).toHaveLength(1);
    });
  });

  describe("findFillSlots — topes y prioridad", () => {
    it("respeta el tope por pagina y se queda con los de mayor confianza", () => {
      const labelled = Array.from({ length: 10 }, (_, i) => ({
        seg: seg(150, 300, 700 - i * 40),
        label: text(`Campo ${i}:`, 60, 700 - i * 40 + 2, 11, 60),
      }));
      // Mas los de «rotulo encima» (peor confianza).
      const above = Array.from({ length: 6 }, (_, i) => ({
        seg: seg(320, 500, 700 - i * 40 - 3),
        label: text(`Nota ${i}`, 320, 700 - i * 40 + 14, 9, 30),
      }));
      const all = [...labelled, ...above];
      const slots = findFillSlots(
        input({ segments: all.map((a) => a.seg), texts: all.map((a) => a.label) }),
        10,
      );
      expect(slots).toHaveLength(10);
      // Los diez con etiqueta a la izquierda ganan a los de rotulo encima.
      expect(slots.every((s) => s.kind === "left")).toBe(true);
      expect(MAX_SLOTS_PER_PAGE).toBeGreaterThanOrEqual(12);
    });

    it("devuelve los huecos en orden de lectura (arriba abajo)", () => {
      const rows = [300, 700, 500];
      const slots = findFillSlots(
        input({
          segments: rows.map((y, i) => seg(150, 300 + i * 10, y - 2)),
          texts: rows.map((y, i) => text(`L${i}:`, 60, y, 11, 20)),
        }),
      );
      expect(slots.map((s) => Math.round(s.box.y / K))).toEqual([698, 498, 298]);
    });
  });

  describe("underscoreSegments — «Nombre: ________»", () => {
    function raw(value: string, left: number, baseline: number, height: number, width: number): RawText {
      return { text: value.trim(), raw: value, left, right: left + width, baseline, height };
    }

    it("un hueco al final del texto abarca los guiones bajos y lleva por etiqueta lo que tiene delante", () => {
      const segs = underscoreSegments([raw("Observaciones: ________________________________", 50, 380, 11, 275)]);
      expect(segs).toHaveLength(1);
      expect(segs[0].inlineLabel).toBe("Observaciones:");
      expect(segs[0].x1).toBeCloseTo(325, 5);
      expect(segs[0].x1 - segs[0].x0).toBeGreaterThan(150);
      expect(segs[0].fromText).toBe(0);
    });

    it("varios huecos en el mismo texto, cada uno con su etiqueta", () => {
      const segs = underscoreSegments([raw("Dia: ________ Mes: ________ Ano: ________", 50, 300, 11, 330)]);
      expect(segs).toHaveLength(3);
      expect(segs.map((s) => s.inlineLabel)).toEqual(["Dia:", "Mes:", "Ano:"]);
      expect(segs[0].x0).toBeLessThan(segs[1].x0);
      expect(segs[1].x0).toBeLessThan(segs[2].x0);
    });

    it("menos de cinco guiones bajos o un hueco de menos de 30 pt no es una raya", () => {
      expect(underscoreSegments([raw("A: ____", 50, 300, 11, 60)])).toEqual([]);
      expect(underscoreSegments([raw("x _____", 50, 300, 4, 14)])).toEqual([]);
    });

    it("un hueco de guiones bajos pasa por las mismas reglas y sale como «inline»", () => {
      const underscores = underscoreSegments([raw("Observaciones: ________________________________", 50, 380, 11, 275)]);
      const slots = findFillSlots(
        input({ segments: underscores, texts: [text("Observaciones: ____", 50, 380, 11, 275)] }),
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].kind).toBe("inline");
    });
  });

  describe("nearestLabel — compatibilidad", () => {
    it("elige la etiqueta mas cercana a la izquierda y descarta las lejanas", () => {
      const items: SlotText[] = [text("Lejos", 0, 150, 10, 20), text("Cliente:", 50, 150, 10, 40)];
      expect(nearestLabel(items, { x: 100 * K, y: 148 * K, width: 100 * K, height: 1.5 * K })).toBe("Cliente:");
    });
  });

  /* ------------------------------------------------------------------ *
   * Segunda ronda (W6-A r2): cajas, rotulos encima en listas, filas de totales...
   * ------------------------------------------------------------------ */

  function box(x0: number, y0: number, x1: number, y1: number): PaintedBox {
    return { x0: x0 * K, y0: y0 * K, x1: x1 * K, y1: y1 * K };
  }

  describe("cajas vacias con etiqueta (un recuadro, un <input> de Chromium, un <textarea>)", () => {
    it("una caja vacia con etiqueta a la izquierda (su base cae dentro del alto de la caja) es un campo", () => {
      const slots = findFillSlots(
        input({ boxes: [box(160, 720, 410, 742)], texts: [text("Nombre", 60, 728, 10, 36)] }),
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].kind).toBe("left");
      expect(slots[0].box.x).toBeCloseTo(160 * K, 3);
      expect(slots[0].box.y).toBeCloseTo(720 * K, 3);
      expect(slots[0].box.width).toBeCloseTo(250 * K, 3);
      expect(slots[0].box.height).toBeCloseTo(22 * K, 3);
    });

    it("una caja vacia con etiqueta ENCIMA (pegada) es un campo", () => {
      const slots = findFillSlots(
        input({ boxes: [box(60, 700, 330, 724)], texts: [text("Direccion", 60, 727, 8, 38)] }),
      );
      expect(slots.map((s) => s.kind)).toEqual(["above"]);
    });

    it("la raya del borde inferior de esa caja NO cuenta ademas: un campo, no dos", () => {
      const slots = findFillSlots(
        input({
          boxes: [box(56, 786.6, 251, 800.1)],
          segments: [seg(56, 251, 787, 0.7)],
          texts: [text("Nombre:", 6, 790.4, 12, 43)],
        }),
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].box.height).toBeGreaterThan(10);
    });

    it("el mismo rectangulo pintado dos veces (relleno + borde) cuenta una vez", () => {
      const same = box(52, 785.5, 246, 800.5);
      const slots = findFillSlots(input({ boxes: [same, { ...same }], texts: [text("Nombre:", 6, 789.6, 12, 43)] }));
      expect(slots).toHaveLength(1);
    });

    it("una caja con texto dentro (celda con contenido, panel) no es un campo", () => {
      const slots = findFillSlots(
        input({
          boxes: [box(160, 720, 410, 742)],
          texts: [text("Nombre", 60, 728, 10, 36), text("Ana Garcia", 170, 728, 10, 60)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("las cajas que se tocan (celdas de una tabla) no son campos aunque lleven etiqueta", () => {
      const cells = [box(160, 720, 410, 742), box(160, 698, 410, 720), box(160, 676, 410, 698)];
      const slots = findFillSlots(input({ boxes: cells, texts: [text("Nombre", 60, 728, 10, 36)] }));
      expect(slots).toEqual([]);
    });

    it("una caja que contiene otras (un panel) o que ocupa casi toda la pagina no es un campo", () => {
      const panel = box(100, 600, 500, 700);
      const inner = box(120, 620, 300, 640);
      expect(
        findFillSlots(input({ boxes: [panel, inner], texts: [text("Panel", 40, 650, 10, 30)] })).map((s) => Math.round(s.box.width / K)),
      ).not.toContain(400);
      // Casi toda la pagina (mas del 93 %): un marco, no un campo.
      expect(findFillSlots(input({ boxes: [box(15, 600, 585, 640)], texts: [text("Nombre", 5, 610, 10, 30)] }))).toEqual([]);
    });

    it("una caja vacia sin etiqueta es decoracion", () => {
      expect(findFillSlots(input({ boxes: [box(160, 720, 410, 742)], texts: [] }))).toEqual([]);
    });

    it("una caja alta (un <textarea> de 70 pt) con etiqueta encima es un campo; mas de 16 em (un marco de pagina) ya no", () => {
      expect(findFillSlots(input({ boxes: [box(60, 600, 480, 670)], texts: [text("Observaciones", 60, 674, 10, 70)] }))).toHaveLength(1);
      expect(findFillSlots(input({ boxes: [box(60, 400, 480, 600)], texts: [text("Observaciones", 60, 604, 10, 70)] }))).toEqual([]);
    });

    it("una lista de cajas con la etiqueta a la izquierda (varias filas) se conserva; con rotulo encima en UNA columna tambien", () => {
      const rows = [0, 1, 2, 3, 4].map((i) => ({ y: 700 - i * 40 }));
      const left = findFillSlots(
        input({ boxes: rows.map((r) => box(160, r.y, 410, r.y + 22)), texts: rows.map((r, i) => text(`L${i}`, 60, r.y + 8, 10, 20)) }),
      );
      expect(left).toHaveLength(5);
      const above = findFillSlots(
        input({ boxes: rows.map((r) => box(60, r.y, 330, r.y + 24)), texts: rows.map((r, i) => text(`Rotulo ${i}`, 60, r.y + 27, 8, 40)) }),
      );
      expect(above).toHaveLength(5);
    });

    it("una cuadricula de cajas SEPARADAS con su rotulo encima en 3 columnas y varias filas es un formulario (12 campos)", () => {
      const boxesIn: PaintedBox[] = [];
      const labels: SlotText[] = [];
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          boxesIn.push(box(50 + c * 170, 700 - r * 70, 200 + c * 170, 724 - r * 70));
          labels.push(text(`Celda ${r}${c}`, 50 + c * 170, 727 - r * 70, 8, 40));
        }
      }
      expect(findFillSlots(input({ boxes: boxesIn, texts: labels }))).toHaveLength(12);
    });

    it("... pero si solo la primera fila lleva rotulo (encabezados de una cuadricula de celdas vacias) nada es un campo", () => {
      const boxesIn: PaintedBox[] = [];
      const labels: SlotText[] = [];
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          boxesIn.push(box(50 + c * 170, 700 - r * 70, 200 + c * 170, 724 - r * 70));
          if (r === 0) labels.push(text(`Columna ${c}`, 50 + c * 170, 727, 8, 40));
        }
      }
      // Solo la fila de arriba tiene rotulos: las demas cajas no tienen etiqueta; la fila de arriba (3 cajas) si.
      expect(findFillSlots(input({ boxes: boxesIn, texts: labels })).length).toBeLessThanOrEqual(3);
    });
  });

  describe("rayas anchas con etiqueta pegada, grosor, prosa, separadores y totales", () => {
    it("una raya de mas de media pagina con una etiqueta corta PEGADA a su izquierda sigue siendo un hueco", () => {
      const slots = findFillSlots(
        input({ segments: [seg(150, 545, 698)], texts: [text("Nombre y apellidos:", 50, 700, 11, 95)] }),
      );
      expect(slots).toHaveLength(1);
    });

    it("... pero una raya larga con un titular a la izquierda (o con un rotulo pegado encima) es un separador", () => {
      // El titular (el doble que el texto corriente del documento) no etiqueta un campo.
      const body = text("Texto corriente del documento con el que se mide la letra", 50, 600, 11, 300);
      expect(
        findFillSlots(input({ segments: [seg(220, 545, 698)], texts: [body, text("Resumen ejecutivo", 50, 700, 22, 160)] })),
      ).toEqual([]);
      expect(
        findFillSlots(input({ segments: [seg(60, 545, 698)], texts: [text("Nombre", 60, 704, 8, 30)] })),
      ).toEqual([]);
    });

    it("una barra gruesa (mas de ~0,22 em: Gantt, acento) no es una raya de relleno aunque lleve etiqueta", () => {
      expect(findFillSlots(input({ segments: [seg(140, 260, 758.5, 5)], texts: [text("Tarea 1", 60, 760, 11, 31)] }))).toEqual([]);
      expect(findFillSlots(input({ segments: [seg(140, 260, 758.5, 3)], texts: [text("Tarea 1", 60, 760, 11, 31)] }))).toEqual([]);
      expect(findFillSlots(input({ segments: [seg(140, 260, 758.5, 2)], texts: [text("Tarea 1", 60, 760, 11, 31)] }))).toHaveLength(1);
    });

    it("un rotulo que es una frase (9+ palabras, o 5+ con punto final) no etiqueta un campo; uno largo con dos puntos si", () => {
      expect(
        findFillSlots(input({ segments: [seg(20, 170, 735)], texts: [text("Incluye soporte y 10 usuarios.", 20, 750, 12, 144)] })),
      ).toEqual([]);
      expect(
        findFillSlots(input({ segments: [seg(60, 330, 735)], texts: [text("Firma del representante legal de la empresa contratante en este acto", 60, 751, 8, 250)] })),
      ).toEqual([]);
      expect(
        findFillSlots(input({ segments: [seg(60, 330, 735)], texts: [text("Nombre y apellidos del representante legal de la empresa:", 60, 751, 8, 250)] })),
      ).toHaveLength(1);
      // Un rotulo largo SIN puntuacion (7 palabras: «Firma del representante legal de la empresa») sigue siendo un rotulo.
      expect(
        findFillSlots(input({ segments: [seg(60, 330, 735)], texts: [text("Firma del representante legal de la empresa", 60, 751, 8, 150)] })),
      ).toHaveLength(1);
      expect(
        findFillSlots(input({ segments: [seg(60, 330, 735)], texts: [text("Firma del solicitante", 60, 751, 8, 80)] })),
      ).toHaveLength(1);
    });

    it("una raya con rotulo encima y texto JUSTO debajo separa dos contenidos: no es un hueco", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(60, 330, 735)],
          texts: [text("Seccion", 60, 751, 8, 30), text("Texto que empieza justo despues de la raya", 60, 726, 9, 200)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("la raya de la columna de importes con rotulo de totales («Subtotal», «IVA») no es un hueco; en el margen izquierdo si", () => {
      const right = findFillSlots(input({ segments: [seg(440, 535, 396, 0.5)], texts: [text("Subtotal", 400, 400, 10, 37)] }));
      expect(right).toEqual([]);
      const left = findFillSlots(input({ segments: [seg(110, 300, 396, 0.5)], texts: [text("Total:", 60, 400, 10, 30)] }));
      expect(left).toHaveLength(1);
    });

    it("una fila de totales (etiqueta + importe alineado a la derecha en la misma base, raya debajo) deja el sitio ocupado", () => {
      const slots = findFillSlots(
        input({
          segments: [seg(370, 535, 530, 0.5)],
          texts: [text("Pagado", 380, 535, 11, 37), text("66.40", 480, 535, 11, 28)],
        }),
      );
      expect(slots).toEqual([]);
    });

    it("una raya de puntos entre un concepto y una cifra (indice, carta) es una linea guia", () => {
      const leader = findFillSlots(
        input({ segments: [seg(150, 480, 762)], texts: [text("Capitulo 3", 60, 760, 11, 55), text("45", 500, 760, 11, 12)] }),
      );
      expect(leader).toEqual([]);
      // Con otra etiqueta a la derecha (formulario de 2 columnas) la raya SI es un hueco.
      const twoCols = findFillSlots(
        input({ segments: [seg(100, 270, 698)], texts: [text("Nombre:", 50, 700, 11, 42), text("Ciudad:", 310, 700, 11, 38)] }),
      );
      expect(twoCols).toHaveLength(1);
    });
  });

  describe("pilas de rayas: lista de campos frente a tabla", () => {
    const ys = [735, 685, 635, 585, 535, 485];

    it("UNA columna de rayas equidistantes con un rotulo corto distinto encima de cada una (formulario) se conserva", () => {
      const slots = findFillSlots(
        input({
          segments: ys.map((y) => seg(60, 330, y, 0.5)),
          texts: ys.map((y, i) => text(`Campo ${["uno", "dos", "tres", "cuatro", "cinco", "seis"][i]}`, 60, y + 16, 8, 40)),
        }),
      );
      expect(slots).toHaveLength(6);
    });

    it("... pero con el rotulo pegado a la raya (texto de fila, no sitio para escribir) es una tabla", () => {
      const slots = findFillSlots(
        input({
          segments: ys.map((y) => seg(60, 330, y, 0.5)),
          texts: ys.map((y, i) => text(`Fila ${i}`, 60, y + 8, 10, 30)),
        }),
      );
      expect(slots).toEqual([]);
    });

    it("TRES columnas de rayas con rotulo encima en TODAS las filas es una lista de campos (formulario de 3 columnas)", () => {
      const segments: Seg[] = [];
      const texts: SlotText[] = [];
      for (const y of [735, 685, 635, 585]) {
        for (const x of [50, 220, 390]) {
          segments.push(seg(x, x + 150, y, 0.5));
          texts.push(text("Dato", x, y + 16, 8, 24));
        }
      }
      expect(findFillSlots(input({ segments, texts }))).toHaveLength(12);
    });

    it("... pero si solo la primera fila lleva rotulo (encabezado de una tabla con renglones) es una cuadricula: nada", () => {
      const segments: Seg[] = [];
      const texts: SlotText[] = [];
      for (const y of [735, 685, 635, 585]) {
        for (const x of [50, 220, 390]) {
          segments.push(seg(x, x + 150, y, 0.5));
          if (y === 735) texts.push(text("Dato", x, y + 16, 8, 24));
        }
      }
      expect(findFillSlots(input({ segments, texts }))).toEqual([]);
    });

    it("TRES columnas con la etiqueta a la izquierda de cada raya (formulario de 3 columnas) se conserva", () => {
      const segments: Seg[] = [];
      const texts: SlotText[] = [];
      for (const y of [735, 695, 655]) {
        for (const x of [50, 220, 390]) {
          texts.push(text("Dia", x, y, 10, 18));
          segments.push(seg(x + 24, x + 150, y - 2, 0.5));
        }
      }
      expect(findFillSlots(input({ segments, texts }))).toHaveLength(9);
    });
  });

  describe("tope por pagina por defecto", () => {
    it("sin `limit` el tope es MAX_SLOTS_PER_PAGE (20), no 10: 30 huecos con etiqueta dan 20", () => {
      const rows = Array.from({ length: 30 }, (_, i) => ({ y: 800 - i * 25 }));
      const slots = findFillSlots(
        input({
          pageHeight: 842,
          segments: rows.map((r) => seg(150, 300, r.y - 2)),
          texts: rows.map((r, i) => text(`Campo ${i}:`, 60, r.y, 11, 60)),
        }),
      );
      expect(MAX_SLOTS_PER_PAGE).toBe(20);
      expect(slots).toHaveLength(20);
    });
  });
}

// Toda la bateria se ejecuta a varias escalas: la deteccion mide en la unidad tipografica del documento, no en puntos.
describe.each([1, 0.8, 1.25, 1.5, 2])("escala x%s", (k) => {
  beforeEach(() => {
    K = k;
  });
  afterAll(() => {
    K = 1;
  });
  suite();
});
