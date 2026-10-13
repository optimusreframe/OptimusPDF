import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTextEdits } from "@/lib/pdf/editTextExport";
import type { TextEdit } from "@/lib/pdf/editTypes";
import { glyphProfile } from "@/lib/pdf/editTextProfile";
import { draftEditForBlock } from "@/app/edit-pdf/editCanvasMath";
import { analyzePageText } from "@/lib/pdf/textBlocks";
import { openWithPdfjs } from "@/lib/pdf/textBlocksFixtures";

/**
 * Wave 8 · F2, criterio 3: PDFs REALES generados por Chromium (Playwright
 * headless) desde HTML: factura con tabla, carta y formulario. Chromium
 * embebe las fuentes como TrueType/CID con subconjunto, con TJ y kerning,
 * como los PDF que suben los usuarios. Se edita un dato y se comprueba con
 * pdf.js y `pdftotext` que el original ya no se extrae y el nuevo si.
 *
 * Necesita un Chromium de Playwright; se activa con `F2_REAL_PDFS=1` para no
 * cargar la suite normal (ni CI) con un navegador.
 */

const ENABLED = process.env.F2_REAL_PDFS === "1";
const STANDARD_FONTS_URL = path.join(process.cwd(), "public", "standard_fonts") + "/";
const OUT_DIR = process.env.F2_REAL_PDFS_OUT ?? "";

const DOCS = {
  factura: {
    html: `<html><body style="font-family: Arial; padding: 40px">
      <h1>Factura 2026-0142</h1><p>Cliente: Industrias Pernía S.A.</p>
      <table border="1" cellpadding="6" style="border-collapse: collapse">
        <tr><th>Concepto</th><th>Cantidad</th><th>Importe</th></tr>
        <tr><td>Consultoría</td><td>10</td><td>1.250,00</td></tr>
        <tr><td>Soporte</td><td>3</td><td>300,00</td></tr>
        <tr><td colspan="2"><b>Total</b></td><td><b>1.550,00</b></td></tr>
      </table></body></html>`,
    target: "1.550,00",
    replacement: "1.999,00",
    untouched: ["Consultoría", "300,00", "Factura 2026-0142"],
  },
  carta: {
    html: `<html><body style="font-family: Georgia; padding: 50px; line-height: 1.5">
      <p>Caracas, 12 de octubre de 2026</p><p>Estimado señor Rodríguez:</p>
      <p>Le escribo para confirmar la cita del jueves a las 10:30 en nuestras oficinas.</p>
      <p>Expediente: EXP-7781</p>
      <p>Atentamente,<br>María González</p></body></html>`,
    target: "EXP-7781",
    replacement: "EXP-9999",
    untouched: ["Caracas, 12 de octubre de 2026", "María González"],
  },
  formulario: {
    html: `<html><body style="font-family: Helvetica, Arial; padding: 40px">
      <h2>Formulario de inscripción</h2>
      <p>Nombre: Andrés Pernía</p>
      <p>Documento: V-12345678</p>
      <p>Correo: andres@example.com</p>
      <p>Firma: ______________________</p></body></html>`,
    target: "V-12345678",
    replacement: "V-00000000",
    untouched: ["Andrés Pernía", "andres@example.com", "Formulario de inscripción"],
  },
} as const;

type Item = { str: string; x: number; y: number; width: number; height: number; ascent: number; descent: number };

async function items(bytes: Uint8Array): Promise<Item[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_URL }).promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const styles = content.styles as Record<string, { ascent?: number; descent?: number }>;
    const out: Item[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.length === 0) continue;
      out.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        ascent: styles[item.fontName]?.ascent ?? 0.8,
        descent: styles[item.fontName]?.descent ?? -0.2,
      });
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function pdftotext(bytes: Uint8Array): string | null {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimus-f2-real-"));
  const file = path.join(dir, "in.pdf");
  fs.writeFileSync(file, bytes);
  try {
    return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ENABLED)("F2 sobre PDFs reales de Chromium (F2_REAL_PDFS=1)", () => {
  it.each(Object.entries(DOCS))("%s: el dato editado desaparece de pdf.js y pdftotext, el nuevo aparece y el resto queda", async (name, spec) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    let bytes: Uint8Array;
    try {
      const page = await browser.newPage();
      await page.setContent(spec.html);
      bytes = new Uint8Array(await page.pdf({ format: "A4", printBackground: true }));
      await page.close();
    } finally {
      await browser.close();
    }
    const before = await items(bytes);
    const hit = before.find((i) => i.str.includes(spec.target));
    expect(hit, `fragmento con ${spec.target}`).toBeDefined();
    const size = hit!.height;
    const box = {
      x: hit!.x - 0.5,
      y: hit!.y + hit!.descent * size - 0.5,
      width: hit!.width + 1,
      height: (hit!.ascent - hit!.descent) * size + 1,
    };
    const edit: TextEdit = {
      id: "e1",
      blockId: "p0-b0",
      pageIndex: 0,
      box,
      coverBox: box,
      text: spec.replacement,
      fontSize: size,
      color: "#000000",
      align: "left",
      fontKey: "helvetica",
      bold: false,
      italic: false,
      rotation: 0,
      cover: { color: "#ffffff", padding: 1 },
      // Con el perfil del texto original la exportacion valida los glifos quitados (ToUnicode real de Chromium).
      originalGlyphs: glyphProfile(hit!.str),
    };
    const result = await applyTextEdits(bytes, [edit]);
    expect(result.warningsByEdit.e1).toContainEqual({ kind: "original-text-removed" });

    const after = await items(result.bytes);
    const afterText = after.map((i) => i.str).join(" ");
    expect(before.map((i) => i.str).join(" ")).toContain(spec.target);
    expect(afterText).not.toContain(spec.target);
    expect(afterText).toContain(spec.replacement);
    for (const text of spec.untouched) expect(afterText).toContain(text);
    // Lo que no se toco conserva su posicion exacta.
    for (const item of before) {
      if (item === hit) continue;
      const same = after.find((o) => o.str === item.str && Math.abs(o.x - item.x) < 0.01 && Math.abs(o.y - item.y) < 0.01);
      expect(same, `fragmento intacto: ${item.str}`).toBeDefined();
    }
    const text = pdftotext(result.bytes);
    if (text !== null) {
      expect(text).not.toContain(spec.target);
      expect(text).toContain(spec.replacement);
      for (const kept of spec.untouched) expect(text).toContain(kept);
    }
    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${name}.pdf`), bytes);
      fs.writeFileSync(path.join(OUT_DIR, `${name}.edited.pdf`), result.bytes);
    }
  });

  it.each(Object.entries(DOCS))(
    "%s: TODOS los bloques que detecta el editor se quitan del flujo (la validacion de glifos no da falsos negativos)",
    async (name, spec) => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      let bytes: Uint8Array;
      try {
        const page = await browser.newPage();
        await page.setContent(spec.html);
        bytes = new Uint8Array(await page.pdf({ format: "A4", printBackground: true }));
        await page.close();
      } finally {
        await browser.close();
      }
      const opened = await openWithPdfjs(bytes);
      const analysis = await analyzePageText(await opened.page(1), 0, { OPS: opened.OPS });
      await opened.close();
      const editable = analysis.blocks.filter((block) => block.editable);
      expect(editable.length, `${name}: bloques editables`).toBeGreaterThan(2);
      for (const block of editable) {
        const edit = draftEditForBlock(block, { coverColor: "#ffffff" });
        expect(edit.originalGlyphs?.chars).toBeGreaterThan(0);
        const result = await applyTextEdits(bytes, [{ ...edit, text: "Zz" }]);
        const warnings = result.warningsByEdit[edit.id] ?? [];
        expect(warnings, `${name}: bloque "${block.text}"`).toContainEqual({ kind: "original-text-removed" });
      }
    },
  );
});
