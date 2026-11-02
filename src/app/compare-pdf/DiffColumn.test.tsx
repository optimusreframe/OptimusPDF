import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DiffColumn } from "@/app/compare-pdf/DiffColumn";
import type { DiffToken } from "@/lib/pdf/compare";

/*
 * W-RESP-A: el significado de la diferencia no puede depender solo del color (WCAG 1.4.1): lo insertado va en verde Y subrayado,
 * lo eliminado en rojo Y tachado. jsdom no pinta: el contrato se comprueba por clases.
 */
const tokens: DiffToken[] = [
  { op: "equal", text: "igual" },
  { op: "insert", text: "nuevo" },
  { op: "delete", text: "viejo" },
];
const has = (el: Element, token: string) => el.className.split(/\s+/).includes(token);

describe("DiffColumn: insertado y eliminado se distinguen sin color", () => {
  it("lo insertado lleva subrayado, lo eliminado tachado y lo igual ningun adorno", () => {
    const { container } = render(<DiffColumn title="A" tokens={tokens} emptyMessage="vacia" />);
    const spans = [...container.querySelectorAll("p > span")];
    const byText = (text: string) => spans.find((span) => span.textContent?.trim() === text)!;
    expect(has(byText("nuevo"), "underline")).toBe(true);
    expect(has(byText("nuevo"), "line-through")).toBe(false);
    expect(has(byText("viejo"), "line-through")).toBe(true);
    expect(has(byText("viejo"), "underline")).toBe(false);
    expect(has(byText("igual"), "underline")).toBe(false);
    expect(has(byText("igual"), "line-through")).toBe(false);
  });
});
