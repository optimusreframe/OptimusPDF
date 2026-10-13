import { describe, expect, it } from "vitest";
import { StandardFonts } from "@cantoo/pdf-lib";
import { draftEditForBlock } from "@/app/edit-pdf/editCanvasMath";
import { applyTextEdits } from "@/lib/pdf/editTextExport";
import { analyzePageText } from "@/lib/pdf/textBlocks";
import { drawLine, newDoc, openWithPdfjs } from "@/lib/pdf/textBlocksFixtures";
import type { TextBlock } from "@/lib/pdf/editTypes";

/**
 * Viaje de ida y vuelta REAL (pdf.js -> bloque -> edicion -> applyTextEdits ->
 * pdf.js): reeditar un bloque SIN cambiar su texto debe dejar la primera linea
 * base donde estaba (posicion y giro) y sin partir el texto en mas lineas, para
 * cualquier angulo, incluido el entorno de 45 grados donde la caja envolvente
 * no basta para recuperar el tamano sin girar.
 */

const H = StandardFonts.Helvetica;
const T = StandardFonts.TimesRoman;

type Item = { str: string; x: number; y: number; angle: number };

async function items(bytes: Uint8Array): Promise<{ items: Item[]; blocks: TextBlock[] }> {
  const opened = await openWithPdfjs(bytes);
  try {
    const page = await opened.page(1);
    const content = await page.getTextContent();
    const analysis = await analyzePageText(page, 0, { OPS: opened.OPS });
    return {
      items: content.items
        .filter((item: { str: string }) => item.str.trim().length > 0)
        .map((item: { str: string; transform: number[] }) => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          angle: (Math.atan2(item.transform[1], item.transform[0]) * 180) / Math.PI,
        })),
      blocks: analysis.blocks,
    };
  } finally {
    await opened.close();
  }
}

async function build(spec: { text: string; x: number; y: number; size: number; rotate?: number; font?: StandardFonts }) {
  const { doc, font } = await newDoc();
  const page = doc.addPage([595, 842]);
  await drawLine(page, font, spec);
  return new Uint8Array(await doc.save());
}

function angleDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe("draftEditForBlock + applyTextEdits: reeditar sin cambiar el texto no mueve nada", () => {
  const cases = [
    { name: "horizontal", rotate: 0 },
    { name: "30 grados", rotate: 30 },
    { name: "45 grados (zona degenerada de la caja envolvente)", rotate: 45 },
    { name: "44 grados", rotate: 44 },
    { name: "60 grados", rotate: 60 },
    { name: "90 grados", rotate: 90 },
    { name: "180 grados", rotate: 180 },
    { name: "270 grados", rotate: 270 },
    { name: "135 grados", rotate: 135 },
  ];

  it.each(cases)("$name", async ({ rotate }) => {
    const text = "Reeditando sin cambios este texto";
    const original = await build({ text, x: 300, y: 400, size: 14, rotate, font: H });
    const before = await items(original);
    expect(before.blocks).toHaveLength(1);
    const block = before.blocks[0];

    const edit = draftEditForBlock(block, { coverColor: "#ffffff" });
    const exported = await applyTextEdits(original, [edit]);
    const after = await items(exported.bytes);

    // Wave 8 · F2: el original ya NO queda bajo la cobertura (se quita del flujo); el
    // redibujado se compara con la posicion del original extraida ANTES de editar.
    expect(exported.warningsByEdit[edit.id]).toContainEqual({ kind: "original-text-removed" });
    const [first] = before.items.filter((item) => item.str === text);
    const redrawn = after.items.filter((item) => item.str === text);
    expect(redrawn).toHaveLength(1);
    const [second] = redrawn;
    // El texto redibujado NO se parte en lineas.
    expect(after.items.filter((item) => text.startsWith(item.str.trim()) && item.str.trim() !== text)).toHaveLength(0);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThan(0.75);
    expect(angleDelta(second.angle, first.angle)).toBeLessThan(0.5);
  });

  it("alineado a la derecha se ancla en el extremo del original", async () => {
    // Texto horizontal corto: la caja del bloque coincide con el texto.
    const original = await build({ text: "Total: 1.250,00", x: 400, y: 500, size: 12, font: T });
    const before = await items(original);
    const block = { ...before.blocks[0], align: "right" as const };
    const edit = draftEditForBlock(block, { coverColor: "#ffffff" });
    const exported = await applyTextEdits(original, [edit]);
    const after = await items(exported.bytes);
    // F2: el original se quita; se compara con el extraido antes de editar.
    const [first] = before.items.filter((item) => item.str === "Total: 1.250,00");
    const [second] = after.items.filter((item) => item.str === "Total: 1.250,00");
    expect(after.items.filter((item) => item.str === "Total: 1.250,00")).toHaveLength(1);
    // A la derecha, el borde derecho se conserva: el inicio coincide salvo la diferencia
    // de ancho entre las metricas de pdf.js y las de pdf-lib (menos de 1,5 pt).
    expect(Math.abs(second.x - first.x)).toBeLessThan(1.5);
    expect(Math.abs(second.y - first.y)).toBeLessThan(0.75);
  });

  it("un texto mas largo se reparte en el ancho del bloque, no se sale", async () => {
    const original = await build({ text: "Linea corta", x: 100, y: 300, size: 12, font: H });
    const block = (await items(original)).blocks[0];
    const edit = draftEditForBlock(block, { coverColor: "#ffffff", overrides: { text: "Linea corta que ahora es bastante mas larga que antes" } });
    const exported = await applyTextEdits(original, [edit]);
    const after = await items(exported.bytes);
    const pieces = after.items.filter((item) => item.str !== "Linea corta");
    expect(pieces.length).toBeGreaterThan(1); // se partio en varias lineas dentro del ancho
    expect(pieces.every((item) => Math.abs(item.x - 100) < 0.75)).toBe(true);
  });
});
