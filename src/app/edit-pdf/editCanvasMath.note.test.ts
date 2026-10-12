import { describe, expect, it } from "vitest";
import { NOTE_COVER_COLOR, NOTE_PADDING_PT, NOTE_TEXT_COLOR, asNoteEdit, newTextEditAt } from "@/app/edit-pdf/editCanvasMath";
import { coverShape } from "@/lib/pdf/editCover";
import { metricsFor } from "@/app/edit-pdf/editTestUtils";

/** Una nota (modo Anotar de PDF Pro) es un texto nuevo sobre fondo de nota. */

const base = () => newTextEditAt(metricsFor(), 0, { left: 100, top: 100, width: 200, height: 60 }, "tx-1");

describe("asNoteEdit", () => {
  it("pone fondo de nota y tinta oscura sin tocar lo demas", () => {
    const edit = base();
    const note = asNoteEdit(edit);
    expect(note.cover).toEqual({ color: NOTE_COVER_COLOR, padding: NOTE_PADDING_PT });
    expect(note.color).toBe(NOTE_TEXT_COLOR);
    expect(note.id).toBe(edit.id);
    expect(note.box).toEqual(edit.box);
    expect(note.text).toBe("");
    expect(note.blockId).toBeUndefined();
  });

  it("no muta la edicion de partida", () => {
    const edit = base();
    asNoteEdit(edit);
    expect(edit.cover.color).toBeNull();
    expect(edit.color).toBe("#000000");
  });

  it("un texto nuevo normal NO cubre; la nota SI cubre su propia caja con margen", () => {
    expect(coverShape(base())).toBeNull();
    const shape = coverShape(asNoteEdit(base()));
    expect(shape).not.toBeNull();
    expect(shape!.kind).toBe("rect");
  });

  it("el color de la nota es un amarillo claro con contraste alto contra la tinta", () => {
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const a = luminance(NOTE_COVER_COLOR);
    const b = luminance(NOTE_TEXT_COLOR);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(ratio).toBeGreaterThan(7);
  });

  it("conserva el giro de pagina del texto nuevo", () => {
    const rotated = newTextEditAt(metricsFor([0, 0, 595, 842], 90), 0, { left: 10, top: 10, width: 100, height: 40 }, "tx-2");
    expect(asNoteEdit(rotated).rotation).toBe(rotated.rotation);
  });

  it("los colores son #rrggbb validos", () => {
    expect(NOTE_COVER_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(NOTE_TEXT_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});
