import { describe, expect, it } from "vitest";
import {
  REFERENCE_UNIT_PT,
  documentUnit,
  findFillSlots,
  mergeDashes,
  underscoreSegments,
  type DashMark,
  type PaintedBox,
  type RawText,
  type Seg,
  type SlotInput,
  type SlotText,
  type VerticalSeg,
} from "@/lib/pdf/detectSlots";

/**
 * La deteccion es INVARIANTE A LA ESCALA (W6-A r3): todo se mide en la unidad tipografica del
 * documento, no en puntos. Cada escenario se define una vez (texto de 11 pt) y se evalua a
 * x0,5 ... x3: debe dar las mismas etiquetas y tipos, con las cajas escaladas en la misma proporcion.
 */

const PAGE = { pageWidth: 600, pageHeight: 800 };
const seg = (x0: number, x1: number, y: number, thickness = 0.8): Seg => ({ x0, x1, y, thickness, fromText: -1 });
const text = (value: string, left: number, baseline: number, height = 11, width?: number): SlotText => ({
  text: value,
  left,
  right: left + (width ?? value.length * height * 0.5),
  baseline,
  height,
});
const box = (x0: number, y0: number, x1: number, y1: number, extra: Partial<PaintedBox> = {}): PaintedBox => ({ x0, y0, x1, y1, ...extra });
const body = (baseline = 600) => text("Texto corriente del documento con el que se mide la letra del formulario", 50, baseline, 11, 380);

const scaleInput = (input: SlotInput, k: number): SlotInput => ({
  segments: input.segments.map((s) => ({ ...s, x0: s.x0 * k, x1: s.x1 * k, y: s.y * k, thickness: s.thickness * k })),
  verticals: input.verticals.map((v: VerticalSeg) => ({ x: v.x * k, y0: v.y0 * k, y1: v.y1 * k })),
  boxes: input.boxes.map((b) => ({ ...b, x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k })),
  texts: input.texts.map((t) => ({ ...t, left: t.left * k, right: t.right * k, baseline: t.baseline * k, height: t.height * k })),
  dashes: input.dashes?.map((d) => ({ x0: d.x0 * k, x1: d.x1 * k, y: d.y * k, thickness: d.thickness * k })),
  pageWidth: input.pageWidth * k,
  pageHeight: input.pageHeight * k,
});

const make = (parts: Partial<SlotInput>): SlotInput => ({ segments: [], verticals: [], boxes: [], texts: [], ...PAGE, ...parts });

type Scenario = { name: string; input: SlotInput; expected: Array<{ label?: string; kind: string }> };

const columns = (n: number, row: number, gap = 20) => {
  const w = (500 - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x0: 50 + i * (w + gap), x1: 50 + i * (w + gap) + w, y: row }));
};

const SCENARIOS: Scenario[] = [
  {
    name: "etiqueta a la izquierda",
    input: make({ segments: [seg(150, 340, 698)], texts: [body(), text("Nombre completo:", 50, 700)] }),
    expected: [{ label: "Nombre completo:", kind: "left" }],
  },
  {
    name: "etiqueta a la izquierda LEJOS (hueco de 14 em, una columna de rayas alineadas)",
    input: make({
      segments: [seg(330, 540, 698), seg(330, 540, 668)],
      texts: [body(), text("Dirección de correspondencia actual:", 50, 700, 11, 190), text("Edad:", 50, 670, 11, 28)],
    }),
    expected: [
      { label: "Dirección de correspondencia actual:", kind: "left" },
      { label: "Edad:", kind: "left" },
    ],
  },
  {
    name: "raya larga (mas de media pagina) con una etiqueta ancha pegada a la izquierda",
    input: make({ segments: [seg(225, 540, 698)], texts: [body(), text("Nombre y apellidos del solicitante:", 50, 700, 11, 170)] }),
    expected: [{ label: "Nombre y apellidos del solicitante:", kind: "left" }],
  },
  {
    name: "etiqueta de 14 pt con texto corriente de 11 pt y una raya de 300 pt",
    input: make({ segments: [seg(50, 350, 698)], texts: [body(), text("Nombre completo", 50, 716, 14, 100)] }),
    expected: [{ label: "Nombre completo", kind: "above" }],
  },
  {
    name: "rotulo encima de una linea de respuesta de borde a borde (encuesta)",
    input: make({ segments: [seg(50, 550, 698)], texts: [body(), text("1. ¿Cómo conoció nuestro servicio?", 50, 730, 11, 190)] }),
    expected: [{ label: "1. ¿Cómo conoció nuestro servicio?", kind: "above" }],
  },
  {
    name: "rotulo encima con el texto pegado a la raya (regla bajo un titulo): nada",
    input: make({ segments: [seg(50, 550, 698)], texts: [body(), text("Resumen", 50, 703, 11, 50)] }),
    expected: [],
  },
  {
    name: "leyenda debajo de una raya (firma)",
    input: make({ segments: [seg(60, 280, 698, 0.7)], texts: [body(), text("Firma del solicitante", 60, 684, 9, 90)] }),
    expected: [{ label: "Firma del solicitante", kind: "below" }],
  },
  {
    name: "tres columnas de rayas con su rotulo encima en todas las filas",
    input: make({
      segments: [735, 685, 635].flatMap((y) => columns(3, y).map((c) => seg(c.x0, c.x1, y, 0.5))),
      texts: [body(), ...[735, 685, 635].flatMap((y) => columns(3, y).map((c, i) => text(`Dato ${i}`, c.x0, y + 16, 9, 30)))],
    }),
    expected: Array.from({ length: 9 }, (_, i) => ({ label: `Dato ${i % 3}`, kind: "above" })),
  },
  {
    name: "tres columnas, solo el encabezado lleva rotulo (tabla con renglones): nada",
    input: make({
      segments: [735, 685, 635, 585].flatMap((y) => columns(3, y).map((c) => seg(c.x0, c.x1, y, 0.5))),
      texts: [body(), ...columns(3, 735).map((c, i) => text(`Col ${i}`, c.x0, 751, 9, 30))],
    }),
    expected: [],
  },
  {
    name: "caja vacia con etiqueta a la izquierda",
    input: make({ boxes: [box(160, 720, 410, 742)], texts: [body(), text("Nombre", 60, 728, 10, 36)] }),
    expected: [{ label: "Nombre", kind: "left" }],
  },
  {
    name: "cuadricula de cajas SEPARADAS con rotulo encima (3 columnas x 3 filas)",
    input: make({
      boxes: [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => box(50 + c * 170, 700 - r * 70, 200 + c * 170, 724 - r * 70))),
      texts: [body(300), ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => text(`Celda ${r}${c}`, 50 + c * 170, 727 - r * 70, 9, 40)))],
    }),
    expected: [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ label: `Celda ${r}${c}`, kind: "above" }))),
  },
  {
    name: "celdas de una tabla que se tocan: nada",
    input: make({ boxes: [box(160, 720, 410, 742), box(160, 698, 410, 720), box(160, 676, 410, 698)], texts: [body(), text("Nombre", 60, 728, 10, 36)] }),
    expected: [],
  },
  {
    name: "barra de progreso (pista + relleno) con su valor: nada",
    input: make({
      boxes: [box(150, 700, 450, 710, { fill: true, stroke: false, shade: 0.9 }), box(150, 700, 330, 710, { fill: true, stroke: false, shade: 0.4 })],
      texts: [body(), text("Desarrollo", 50, 701, 11, 60), text("60%", 460, 701, 11, 20)],
    }),
    expected: [],
  },
  {
    name: "barra de Gantt apoyada en su raya de fila: nada",
    input: make({
      segments: [seg(150, 560, 700, 0.5)],
      boxes: [box(200, 700, 330, 708, { fill: true, stroke: false, shade: 0.4 })],
      texts: [body(), text("Diseño", 50, 701, 11, 36)],
    }),
    expected: [],
  },
  {
    name: "barras gruesas con etiqueta (progreso dibujado con rayas): nada",
    input: make({ segments: [seg(150, 450, 700, 3.2)], texts: [body(), text("Python", 50, 702, 11, 36)] }),
    expected: [],
  },
  {
    name: "tarjeta de precios: regla bajo el precio (titular grande): nada",
    input: make({
      segments: [seg(70, 190, 650, 0.6)],
      boxes: [box(60, 560, 200, 760)],
      texts: [body(), text("Básico", 70, 740, 14, 40), text("$9/mes", 70, 665, 22, 70)],
    }),
    expected: [],
  },
  {
    name: "eje de una grafica: rotulos solo numericos con su rejilla: nada",
    input: make({ segments: [seg(80, 560, 700, 0.4), seg(80, 560, 660, 0.4), seg(80, 560, 620, 0.4)], texts: [body(), text("20", 50, 702, 9, 12), text("40", 50, 662, 9, 12), text("60", 50, 622, 9, 12)] }),
    expected: [],
  },
  {
    name: "fila de totales: importe a la derecha y raya debajo: nada",
    input: make({ segments: [seg(370, 535, 530, 0.5)], texts: [body(), text("Pagado", 380, 535, 11, 37), text("66.40", 480, 535, 11, 28)] }),
    expected: [],
  },
  {
    name: "linea guia de un indice (puntos hasta la cifra): nada",
    input: make({ segments: [seg(150, 480, 762)], texts: [body(), text("Capitulo 3", 60, 760, 11, 55), text("45", 500, 760, 11, 12)] }),
    expected: [],
  },
  {
    name: "barra de progreso dibujada con DOS rayas finas superpuestas (pista y relleno): nada",
    input: make({ segments: [seg(150, 450, 700, 1.5), seg(150, 330, 700, 1.5)], texts: [body(), text("Desarrollo", 50, 702, 11, 60)] }),
    expected: [],
  },
  {
    name: "barra sin borde y poco alta con etiqueta a la izquierda: nada",
    input: make({ boxes: [box(150, 700, 450, 710, { fill: true, stroke: false, shade: 0.9 })], texts: [body(), text("Desarrollo", 50, 701, 11, 60)] }),
    expected: [],
  },
  {
    name: "campo sombreado claro, sin borde y alto como un campo, con etiqueta a la izquierda: hueco",
    input: make({ boxes: [box(150, 700, 450, 724, { fill: true, stroke: false, shade: 0.93 })], texts: [body(), text("Nombre", 50, 708, 11, 36)] }),
    expected: [{ label: "Nombre", kind: "left" }],
  },
  {
    name: "relleno oscuro (un boton) con etiqueta a la izquierda: nada",
    input: make({ boxes: [box(150, 700, 450, 724, { fill: true, stroke: false, shade: 0.3 })], texts: [body(), text("Enviar", 50, 708, 11, 36)] }),
    expected: [],
  },
  {
    name: "caja con borde y una cifra pegada a su derecha (60 %): nada; sin la cifra, hueco",
    input: make({ boxes: [box(150, 700, 450, 722, { fill: false, stroke: true })], texts: [body(), text("Avance", 50, 708, 11, 36), text("60%", 460, 708, 11, 20)] }),
    expected: [],
  },
  {
    name: "caja con borde sin cifra a la derecha: hueco",
    input: make({ boxes: [box(150, 700, 450, 722, { fill: false, stroke: true })], texts: [body(), text("Avance", 50, 708, 11, 36), text("lo que sea", 460, 708, 11, 50)] }),
    expected: [{ label: "Avance", kind: "left" }],
  },
  {
    name: "una barra pintada entre el rotulo y la raya ocupa el sitio de escritura: nada",
    input: make({ segments: [seg(60, 330, 690, 0.6)], boxes: [box(60, 696, 250, 708, { fill: true, stroke: false, shade: 0.5 })], texts: [body(), text("Diseño", 60, 724, 11, 36)] }),
    expected: [],
  },
  {
    name: "la etiqueta de otra tarjeta (una caja las separa) no etiqueta la raya",
    input: make({
      segments: [seg(230, 330, 690, 0.6)],
      boxes: [box(40, 640, 200, 760), box(210, 640, 370, 760)],
      texts: [body(), text("$96/mes", 60, 692, 11, 40), text("Pro", 230, 752, 11, 20)],
    }),
    expected: [],
  },
  {
    name: "un titular grande encima del rotulo no lo convierte en la ultima linea de un parrafo",
    input: make({ segments: [seg(50, 400, 715, 0.7)], texts: [body(), text("Boleta de inscripción", 50, 765, 16, 150), text("1. ¿Cómo se llama?", 50, 746, 11, 100)] }),
    expected: [{ label: "1. ¿Cómo se llama?", kind: "above" }],
  },
  {
    name: "una respuesta de cuatro renglones (rotulo solo sobre el primero): el resto continua la respuesta",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(50, 550, 650 - i * 28, 0.7)),
      texts: [body(300), text("Comentarios adicionales:", 50, 676, 11, 130)],
    }),
    expected: [{ label: "Comentarios adicionales:", kind: "above" }],
  },
  {
    name: "papel pautado bajo un rotulo corriente («Notas:») con muchos renglones: ningun hueco",
    input: make({
      segments: Array.from({ length: 12 }, (_, i) => seg(50, 550, 650 - i * 28, 0.7)),
      texts: [body(300), text("Notas:", 50, 676, 11, 30)],
    }),
    expected: [],
  },
  {
    name: "filas altas sin verticales (tabla de campos): la etiqueta centrada en la fila queda mas arriba de la raya",
    input: make({
      segments: [0, 1, 2].map((i) => seg(250, 540, 600 - i * 36, 0.8)),
      texts: [body(400), ...[0, 1, 2].map((i) => text(`Campo ${i}:`, 50, 611 - i * 36, 11, 40))],
    }),
    expected: [0, 1, 2].map((i) => ({ label: `Campo ${i}:`, kind: "left" })),
  },
  {
    name: "una sola raya con una palabra a su derecha no es una lista de campos: nada",
    input: make({ segments: [seg(50, 300, 698)], texts: [body(), text("Fecha", 310, 700, 10, 26)] }),
    expected: [],
  },
  {
    name: "tabla de dos columnas sin sombrear: etiqueta | celda vacia en tres filas (cuadro de Word)",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(50, 450, 700 - i * 30, 0.7)),
      verticals: [50, 190, 450].map((x) => ({ x, y0: 610, y1: 700 })),
      texts: [body(300), ...["Nombre", "Cargo", "Oficina"].map((label, i) => text(label, 56, 680 - i * 30, 11, 40))],
    }),
    expected: [{ label: "Nombre", kind: "left" }, { label: "Cargo", kind: "left" }, { label: "Oficina", kind: "left" }],
  },
  {
    name: "tabla de dos columnas hecha con CAJAS pegadas (etiqueta | vacia) en tres filas",
    input: make({
      boxes: [0, 1, 2].flatMap((i) => [box(50, 670 - i * 30, 190, 700 - i * 30), box(190, 670 - i * 30, 450, 700 - i * 30)]),
      texts: [body(300), ...["Nombre", "Cargo", "Oficina"].map((label, i) => text(label, 56, 680 - i * 30, 11, 40))],
    }),
    expected: [{ label: "Nombre", kind: "left" }, { label: "Cargo", kind: "left" }, { label: "Oficina", kind: "left" }],
  },
  {
    name: "r4 · tarjeta con titulo y un texto que se sale de la tarjeta por la derecha: la celda no esta vacia",
    input: make({
      boxes: [box(40, 600, 300, 680), box(40, 500, 300, 580)],
      texts: [body(300), text("Carlos Díaz", 50, 664, 12, 70), text("Responsable de operaciones con diez años de experiencia", 50, 640, 11, 300), text("Marta Ruiz", 50, 564, 12, 65), text("Analista senior del área comercial con larga trayectoria", 50, 540, 11, 310)],
    }),
    expected: [],
  },
  {
    name: "r4 · tabla de cajas pegadas con DOS pares por fila (etiqueta | vacia | etiqueta | vacia), tres filas",
    input: make({
      boxes: [0, 1, 2].flatMap((i) => [box(40, 670 - i * 30, 120, 700 - i * 30), box(120, 670 - i * 30, 300, 700 - i * 30), box(300, 670 - i * 30, 380, 700 - i * 30), box(380, 670 - i * 30, 560, 700 - i * 30)]),
      texts: [body(300), ...[0, 1, 2].flatMap((i) => [text(`Nombre ${i}`, 46, 680 - i * 30, 11, 50), text(`Cargo ${i}`, 306, 680 - i * 30, 11, 45)])],
    }),
    expected: [0, 1, 2].flatMap((i) => [{ label: `Nombre ${i}`, kind: "left" }, { label: `Cargo ${i}`, kind: "left" }]),
  },
  {
    name: "horario de seis columnas con la ultima vacia (la etiqueta tiene muchas columnas a su izquierda): nada",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(50, 450, 700 - i * 30, 0.7)),
      verticals: [50, 100, 150, 200, 250, 300, 450].map((x) => ({ x, y0: 610, y1: 700 })),
      texts: [body(300), ...["Lunes", "Martes", "Jueves"].flatMap((label, i) => [text(label, 56, 680 - i * 30, 9, 30), text("Clase", 256, 680 - i * 30, 9, 30)])],
    }),
    expected: [],
  },
  {
    name: "la misma tabla con solo dos filas: nada",
    input: make({
      segments: [0, 1, 2].map((i) => seg(50, 450, 700 - i * 30, 0.7)),
      verticals: [50, 190, 450].map((x) => ({ x, y0: 640, y1: 700 })),
      texts: [body(300), ...["Nombre", "Cargo"].map((label, i) => text(label, 56, 680 - i * 30, 11, 40))],
    }),
    expected: [],
  },
  {
    name: "tabla de cuatro columnas con la ultima vacia (horario, datos): nada",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(50, 450, 700 - i * 30, 0.7)),
      verticals: [50, 140, 230, 340, 450].map((x) => ({ x, y0: 610, y1: 700 })),
      texts: [body(300), ...["Lunes", "Martes", "Jueves"].flatMap((label, i) => [text(label, 56, 680 - i * 30, 11, 40), text("Clase", 146, 680 - i * 30, 11, 30)])],
    }),
    expected: [],
  },
  {
    name: "celdas pegadas con el rotulo pequeno arriba a la izquierda y el resto vacio (formulario oficial)",
    input: make({
      boxes: [0, 1, 2].flatMap((r) => [0, 1].map((c) => box(50 + c * 250, 650 - r * 50, 300 + c * 250, 700 - r * 50))),
      texts: [body(300), ...[0, 1, 2].flatMap((r) => [0, 1].map((c) => text(`${r * 2 + c + 1} Campo ${r}${c}`, 56 + c * 250, 690 - r * 50, 8, 50)))],
    }),
    expected: [0, 1, 2].flatMap((r) => [0, 1].map((c) => ({ label: `${r * 2 + c + 1} Campo ${r}${c}`, kind: "above" }))),
  },
  {
    name: "calendario: celdas con un numero arriba a la izquierda y el resto vacio: nada",
    input: make({
      boxes: [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => box(50 + c * 120, 650 - r * 50, 170 + c * 120, 700 - r * 50))),
      texts: [body(300), ...[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => text(String(r * 4 + c + 1), 56 + c * 120, 690 - r * 50, 8, 8)))],
    }),
    expected: [],
  },
  {
    name: "tarjeta con titulo, regla con margen y texto: no es una celda de formulario",
    input: make({
      segments: [seg(70, 330, 700, 0.5), seg(70, 330, 610, 0.4)],
      boxes: [box(60, 600, 340, 760), box(60, 480, 340, 590)],
      verticals: [],
      texts: [body(300), text("Ana Gómez", 70, 708, 12, 60), text("Analista senior del área", 70, 685, 11, 120)],
    }),
    expected: [],
  },
  {
    name: "linea de firma algo gruesa (1,9 pt) con una leyenda de 14 pt debajo: la raya se mide contra su leyenda",
    input: make({ segments: [seg(60, 300, 698, 1.9)], texts: [body(), text("Firma del solicitante", 60, 681, 14, 120)] }),
    expected: [{ label: "Firma del solicitante", kind: "below" }],
  },
  {
    name: "r4 · caja rellena con su raya en la base y la leyenda DEBAJO centrada (dos columnas)",
    input: make({
      segments: [seg(40, 290, 700, 0.7), seg(310, 560, 700, 0.7)],
      boxes: [box(40, 700, 290, 724, { fill: true, stroke: false, shade: 0.95 }), box(310, 700, 560, 724, { fill: true, stroke: false, shade: 0.95 })],
      texts: [body(300), text("Autorización de excursión", 40, 780, 18, 200), text("Nombre del alumno", 130, 686, 9, 80), text("Curso", 420, 686, 9, 25)],
    }),
    expected: [{ label: "Nombre del alumno", kind: "below" }, { label: "Curso", kind: "below" }],
  },
  {
    name: "r4 · un parrafo que pasa por encima de la primera fila no es su rotulo: manda la leyenda de debajo",
    input: make({
      segments: [0, 1].flatMap((i) => [seg(40, 290, 640 - i * 56, 0.7), seg(310, 560, 640 - i * 56, 0.7)]),
      texts: [
        ...[0, 1, 2].map((i) => text("Las partes acuerdan los términos y condiciones recogidos en el presente documento, comprometiéndose a su cumplimiento", 40, 720 - i * 14, 11, 520)),
        ...[0, 1].flatMap((i) => [text(`Número ${i}`, 120, 626 - i * 56, 9, 50), text(`Fecha ${i}`, 400, 626 - i * 56, 9, 40)]),
      ],
    }),
    expected: [0, 1].flatMap((i) => [{ label: `Número ${i}`, kind: "below" }, { label: `Fecha ${i}`, kind: "below" }]),
  },
  {
    name: "r4 · rayas con la leyenda debajo y poco espacio entre filas: la leyenda de una fila no es el rotulo de la siguiente",
    input: make({
      segments: [0, 1, 2].map((i) => seg(60, 340, 700 - i * 50, 0.7)),
      texts: [body(300), ...[0, 1, 2].map((i) => text(`Campo ${i}`, 60, 688 - i * 50, 9, 40))],
    }),
    expected: [0, 1, 2].map((i) => ({ label: `Campo ${i}`, kind: "below" })),
  },
  {
    name: "r4 · Gantt: filas rotuladas con pistas, barras de color y reglas de fila: nada",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(40, 560, 700 - i * 28, 0.5)),
      boxes: [
        box(40, 600, 560, 728, { fill: false, stroke: true }),
        ...[0, 1, 2, 3].flatMap((i) => [
          box(130, 700 - i * 28, 560, 728 - i * 28, { fill: true, stroke: false, shade: 0.93 }),
          box(150 + i * 60, 708 - i * 28, 260 + i * 60, 720 - i * 28, { fill: true, stroke: false, shade: 0.4 }),
        ]),
      ],
      texts: [body(300), ...["Análisis", "Diseño", "Desarrollo", "Pruebas"].map((n, i) => text(n, 46, 710 - i * 28, 11, 45))],
    }),
    expected: [],
  },
  {
    name: "r4 · progreso: la barra de relleno (10 %) mide menos de 30 pt dentro de la pista: nada",
    input: make({
      boxes: [box(130, 700, 560, 720, { fill: true, stroke: false, shade: 0.9 }), box(131, 701, 150, 719, { fill: true, stroke: false, shade: 0.4 })],
      texts: [body(300), text("Despliegue", 40, 706, 11, 60)],
    }),
    expected: [],
  },
  {
    name: "r4 · tarjeta con un titulo grande (1,7 em) y una regla decorativa debajo, sin campo: nada",
    input: make({
      segments: [seg(60, 200, 690, 1)],
      boxes: [box(50, 600, 210, 740)],
      texts: [body(300), text("Gratis", 60, 708, 19, 50), text("1 usuario", 60, 660, 11, 50)],
    }),
    expected: [],
  },
  {
    name: "r4 · hora ........ evento: una guia de marcas sueltas entre un texto numerico y otro texto: nada",
    input: make({
      dashes: Array.from({ length: 60 }, (_, i) => ({ x0: 90 + i * 4.5, x1: 91 + i * 4.5, y: 702, thickness: 0.8 })),
      texts: [body(300), text("09:00", 40, 700, 11, 30), text("Registro", 380, 700, 11, 45), text("10:00", 40, 670, 11, 30), text("Comida", 380, 670, 11, 40)],
    }),
    expected: [],
  },
  {
    name: "r4 · guia de un menu con el precio a la derecha y la linea sobre la linea base del texto: nada",
    input: make({
      segments: [seg(110, 360, 701.4, 0.6)],
      texts: [body(300), text("Paella valenciana", 40, 698, 11, 70), text("14.50 €", 380, 698, 11, 35)],
    }),
    expected: [],
  },
  {
    name: "r4 · margenes de 0,25 pulgadas: una linea de respuesta de casi borde a borde (96 %) con el rotulo encima",
    input: make({ segments: [seg(14, 590, 698, 0.7)], texts: [body(300), text("Número de póliza", 14, 730, 11, 85)] }),
    expected: [{ label: "Número de póliza", kind: "above" }],
  },
  {
    name: "r4 · margenes de 0,25 pulgadas: etiqueta a la izquierda y raya hasta el borde",
    input: make({ segments: [seg(150, 590, 698, 0.7)], texts: [body(300), text("Nombre:", 14, 700, 11, 45)] }),
    expected: [{ label: "Nombre:", kind: "left" }],
  },
  {
    name: "r4 · una regla de casi borde a borde bajo una linea de texto (1,3 alturas), sin sitio para escribir: nada",
    input: make({ segments: [seg(14, 590, 698, 0.7)], texts: [body(300), text("Contenido 1 lorem ipsum dolor sit amet", 14, 712, 11, 170)] }),
    expected: [],
  },
  {
    name: "r4 · un rotulo grande (1,4 em) sin sitio para escribir no es un campo; con 1,6 alturas de sitio, si",
    input: make({
      segments: [seg(60, 300, 698, 0.7), seg(60, 300, 600, 0.7)],
      texts: [body(300), text("Cargo", 60, 712, 15, 30), text("Empresa", 60, 625, 15, 45)],
    }),
    expected: [{ label: "Empresa", kind: "above" }],
  },
  {
    name: "r4 · numero de pagina como leyenda DEBAJO de una raya corta: nada",
    input: make({ segments: [seg(100, 300, 400, 0.6)], texts: [body(300), text("Página 2 de 5", 100, 388, 9, 55)] }),
    expected: [],
  },
  {
    name: "r4 · un parrafo cuya linea pasa POR ENCIMA de la columna (sus palabras empiezan antes) tapa el rotulo lejano: manda la leyenda de debajo",
    input: make({
      segments: [seg(310, 560, 640, 0.7)],
      texts: [
        body(300),
        text("comprometiéndose a su cumplimiento íntegro de los términos", 40, 660, 11, 290),
        text("el presente documento", 330, 686, 11, 110),
        text("Fecha", 400, 626, 9, 30),
      ],
    }),
    expected: [{ label: "Fecha", kind: "below" }],
  },
  {
    name: "r4 · una regla bajo un titular no es duena de la pregunta que le sigue pegada: la pregunta etiqueta su propia linea",
    input: make({
      segments: [seg(50, 550, 730, 0.7), seg(50, 550, 686, 0.7)],
      texts: [body(300), text("Encuesta de satisfacción", 50, 742, 16, 150), text("1. ¿Cómo se llama?", 50, 716, 11, 100)],
    }),
    expected: [{ label: "1. ¿Cómo se llama?", kind: "above" }],
  },
  {
    name: "r4 · cajas con su rotulo ENCIMA muy juntas: el rotulo de la fila siguiente no es la leyenda de la anterior",
    input: make({
      boxes: [0, 1, 2].map((i) => box(50, 700 - i * 40, 300, 724 - i * 40)),
      texts: [body(300), ...[0, 1, 2].map((i) => text(`Campo ${i}`, 50, 727 - i * 40, 9, 40))],
    }),
    expected: [0, 1, 2].map((i) => ({ label: `Campo ${i}`, kind: "above" })),
  },
  {
    name: "r4 · filas de celda de etiqueta sombreada con una barra de color en la celda de valor (Gantt): nada",
    input: make({
      segments: [0, 1, 2, 3].map((i) => seg(40, 560, 700 - i * 30, 0.6)),
      boxes: [0, 1, 2].flatMap((i) => [
        box(40, 670 - i * 30, 130, 700 - i * 30, { fill: true, stroke: false, shade: 0.9 }),
        box(200, 678 - i * 30, 330, 692 - i * 30, { fill: true, stroke: false, shade: 0.4 }),
      ]),
      texts: [body(300), ...["Análisis", "Diseño", "Pruebas"].map((n, i) => text(n, 46, 680 - i * 30, 11, 45))],
    }),
    expected: [],
  },
  {
    name: "r4 · una fila de cajas despues de un parrafo (cuya ultima linea esta pegada): los rotulos son las leyendas de debajo",
    input: make({
      boxes: [box(40, 640, 290, 664), box(310, 640, 560, 664)],
      segments: [seg(40, 290, 640, 0.7), seg(310, 560, 640, 0.7)],
      texts: [
        body(300),
        text("Las partes acuerdan los términos y condiciones del presente documento.", 40, 690, 11, 300),
        text("Se comprometen a su cumplimiento íntegro.", 40, 676, 11, 200),
        text("Número", 140, 626, 9, 35),
        text("Fecha", 420, 626, 9, 30),
      ],
    }),
    expected: [{ label: "Número", kind: "below" }, { label: "Fecha", kind: "below" }],
  },
  {
    name: "linea de firma ancha (65 % de la pagina) con su leyenda debajo y sitio libre encima",
    input: make({ segments: [seg(100, 490, 500, 0.7)], texts: [body(), text("Firma del representante legal", 100, 486, 9, 120)] }),
    expected: [{ label: "Firma del representante legal", kind: "below" }],
  },
  {
    name: "la misma regla ancha con leyenda en la banda de pie de pagina: nada",
    input: make({ segments: [seg(100, 490, 60, 0.7)], texts: [body(), text("Firma del representante legal", 100, 46, 9, 120)] }),
    expected: [],
  },
  {
    name: "regla de pie de pagina con su numero: nada",
    input: make({ segments: [seg(50, 550, 770, 0.5)], texts: [body(), text("Página 1 de 3", 50, 784, 8, 50)] }),
    expected: [],
  },
  {
    name: "etiqueta a la derecha de la raya (varias rayas): hueco",
    input: make({
      segments: [seg(50, 300, 698), seg(50, 300, 668)],
      texts: [body(), text("Fecha", 310, 700, 10, 26), text("Lugar", 310, 670, 10, 26)],
    }),
    expected: [
      { label: "Fecha", kind: "right" },
      { label: "Lugar", kind: "right" },
    ],
  },
];

const SCALES = [0.5, 0.7, 0.8, 1.25, 1.5, 2, 3];

describe("findFillSlots es invariante a la escala", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const reference = findFillSlots(scenario.input);
      it("a escala 1 da el resultado esperado", () => {
        expect(reference.map((slot) => ({ label: slot.label, kind: slot.kind })).sort((a, b) => String(a.label).localeCompare(String(b.label)))).toEqual(
          [...scenario.expected].sort((a, b) => String(a.label).localeCompare(String(b.label))),
        );
      });
      for (const k of SCALES) {
        it(`a x${k} da lo mismo, con las cajas en proporcion`, () => {
          const scaled = findFillSlots(scaleInput(scenario.input, k));
          expect(scaled.map((slot) => `${slot.kind}|${slot.label}`)).toEqual(reference.map((slot) => `${slot.kind}|${slot.label}`));
          scaled.forEach((slot, i) => {
            expect(slot.box.x).toBeCloseTo(reference[i].box.x * k, 3);
            expect(slot.box.y).toBeCloseTo(reference[i].box.y * k, 3);
            expect(slot.box.width).toBeCloseTo(reference[i].box.width * k, 3);
          });
        });
      }
    });
  }
});

describe("documentUnit: la unidad tipografica del documento", () => {
  it("es la altura de letra mediana ponderada por caracteres (un titular grande no la cambia)", () => {
    const texts = [text("Titular enorme", 50, 100, 30, 200), body(200), body(220), body(240)];
    expect(documentUnit(texts)).toBe(11);
  });

  it("sin texto devuelve la unidad de referencia", () => {
    expect(documentUnit([])).toBe(REFERENCE_UNIT_PT);
  });

  it("escala con el documento", () => {
    const texts = [body(200), body(220)].map((item) => ({ ...item, height: item.height * 1.5 }));
    expect(documentUnit(texts)).toBeCloseTo(16.5, 5);
  });
});

describe("mergeDashes: una raya punteada o discontinua marca a marca es una sola raya", () => {
  const dots = (x0: number, count: number, pitch: number, y = 700, size = 1): DashMark[] =>
    Array.from({ length: count }, (_, i) => ({ x0: x0 + i * pitch, x1: x0 + i * pitch + size, y, thickness: size }));

  it("funde puntos con paso regular en una raya", () => {
    const merged = mergeDashes(dots(100, 60, 3));
    expect(merged).toHaveLength(1);
    expect(merged[0].x0).toBeCloseTo(100);
    expect(merged[0].x1).toBeCloseTo(100 + 59 * 3 + 1);
    expect(merged[0].dashed).toBe(true);
  });

  it("funde guiones (marcas mas largas con huecos)", () => {
    expect(mergeDashes(dots(100, 25, 8, 700, 5))).toHaveLength(1);
  });

  it("no funde pocas marcas (menos de 6) ni marcas con un hueco enorme en medio", () => {
    expect(mergeDashes(dots(100, 5, 3))).toEqual([]);
    expect([...dots(100, 20, 3), ...dots(300, 20, 3)].length).toBe(40);
    expect(mergeDashes([...dots(100, 20, 3), ...dots(300, 20, 3)])).toHaveLength(2);
  });

  it("marcas en ordenadas distintas no se mezclan", () => {
    expect(mergeDashes([...dots(100, 20, 3, 700), ...dots(100, 20, 3, 740)])).toHaveLength(2);
  });

  it("una raya punteada con etiqueta a la izquierda es un hueco a cualquier escala", () => {
    for (const k of [0.8, 1, 1.5]) {
      const input = scaleInput(make({ dashes: dots(110, 70, 3, 698), texts: [body(), text("Telefono:", 50, 700, 11, 45)] }), k);
      const slots = findFillSlots(input);
      expect(slots).toHaveLength(1);
      expect(slots[0].label).toBe("Telefono:");
    }
  });
});

describe("underscoreSegments: hileras de puntos como rayas", () => {
  const raw = (value: string, left: number, width: number): RawText => ({ ...text(value, left, 700, 11, width), raw: value });

  it("una hilera de puntos tras una etiqueta es una raya con su etiqueta", () => {
    const [line] = underscoreSegments([raw(`Nombre: ${".".repeat(40)}`, 50, 260)]);
    expect(line.inlineLabel).toBe("Nombre:");
    expect(line.x1 - line.x0).toBeGreaterThan(80);
  });

  it("una guia de indice (puntos y una cifra en el mismo texto) no es una raya", () => {
    expect(underscoreSegments([raw(`Capitulo 3 ${".".repeat(40)} 45`, 50, 300)])).toEqual([]);
  });

  it("una hilera corta de 8 puntos dentro de una frase («a ........ de») es un hueco aunque mida menos de 30 pt", () => {
    const value = `En ${".".repeat(20)}, a ${".".repeat(8)} de ${".".repeat(11)}`;
    const lines = underscoreSegments([raw(value, 36, 243)]);
    expect(lines).toHaveLength(3);
    expect(lines[1].inlineLabel).toBe(", a");
    expect(lines[1].x1 - lines[1].x0).toBeGreaterThan(22);
    expect(lines[1].x1 - lines[1].x0).toBeLessThan(45);
    // La posicion no se desplaza: los espacios y las comas no miden como letras (la hilera central empieza hacia el pt 166).
    expect(lines[1].x0).toBeGreaterThan(164);
    expect(lines[1].x0).toBeLessThan(169);
  });

  it("una hilera de 8 puntos de menos de 30 pt («Año ........», 25 pt) cuenta como hueco de una frase", () => {
    const lines = underscoreSegments([raw("Año ........", 50, 45)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].x1 - lines[0].x0).toBeGreaterThan(22);
    expect(lines[0].x1 - lines[0].x0).toBeLessThan(30);
  });

  it("con muchos espacios y comas antes de los puntos, estos no se estrechan hasta desaparecer", () => {
    const lines = underscoreSegments([raw("a, b, c, d, e, f, ........", 50, 96)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].x1 - lines[0].x0).toBeGreaterThan(22);
  });

  it("pocos puntos (una elipsis) no cuentan", () => {
    expect(underscoreSegments([raw("Continuara.....", 50, 80)])).toEqual([]);
  });
});

describe("rendimiento", () => {
  it("una pagina densa (550 rayas separadas y 950 textos) se analiza en menos de 1,5 s", () => {
    const segments: Seg[] = [];
    const texts: SlotText[] = [];
    for (let r = 0; r < 55; r += 1) {
      for (let c = 0; c < 10; c += 1) {
        segments.push(seg(30 + c * 55, 80 + c * 55, 780 - r * 14, 0.5));
        texts.push(text(`v${r}${c}`, 34 + c * 55, 783 - r * 14, 9, 26));
      }
    }
    for (let i = 0; i < 400; i += 1) texts.push(text("palabra suelta de relleno", 40 + (i % 9) * 60, 20 + i, 9, 60));
    const started = performance.now();
    const slots = findFillSlots(make({ segments, texts }));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(slots.length).toBeLessThanOrEqual(20);
  });
});
