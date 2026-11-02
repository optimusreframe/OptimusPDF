import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NumberField, TextField } from "@/app/organize-pdf/pageToolkit";

// `pageToolkit` importa el motor de PDF solo para sus miniaturas; aqui no se usa.
vi.mock("@/lib/pdf/core", () => ({
  closePdfDocument: vi.fn(),
  openPdfDocument: vi.fn(),
  renderPageToDataUrl: vi.fn(),
  toPdfError: vi.fn(),
}));

/*
 * W-RESP-A (iOS): dos defectos que solo se ven en un iPhone y que Chromium de escritorio no delata.
 *  1. Un campo de texto con fuente < 16 px hace que Safari amplie la pagina al enfocarlo. Con puntero grueso los campos suben
 *     a `text-base` (16 px); con raton se quedan en 14 px.
 *  2. La lista de paginas («1-3, 5, 8-10») no se puede escribir con el teclado `numeric` de iOS (solo cifras, sin «-» ni «,»):
 *     el campo usa `inputMode="text"`. jsdom no pinta ni abre teclados: el contrato se comprueba por atributos y clases.
 */
const has = (cls: string, token: string) => cls.split(/\s+/).includes(token);

describe("pageToolkit: campos del panel de opciones en iOS", () => {
  it("la lista de paginas usa teclado de texto (con «-» y «,»), sin autocorreccion", () => {
    render(<TextField label="Paginas" value="1-3" onChange={() => {}} />);
    const input = screen.getByLabelText("Paginas") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("text");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("enterkeyhint")).toBe("done");
  });

  it("el campo de texto sube a 16 px con puntero grueso (Safari no amplia la pagina)", () => {
    render(<TextField label="Paginas" value="" onChange={() => {}} />);
    const cls = screen.getByLabelText("Paginas").className;
    expect(has(cls, "text-sm")).toBe(true);
    expect(has(cls, "pointer-coarse:text-base")).toBe(true);
  });

  it("el campo numerico (Desde / Hasta) tambien sube a 16 px y conserva el teclado numerico", () => {
    render(<NumberField label="Desde" value={1} max={9} onChange={() => {}} />);
    const input = screen.getByLabelText("Desde") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(has(input.className, "pointer-coarse:text-base")).toBe(true);
  });
});
