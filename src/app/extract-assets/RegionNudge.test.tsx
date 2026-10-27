import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import type { CropFraction } from "@/app/sign-pdf/inkImportModel";
import { RegionNudge } from "@/app/extract-assets/RegionNudge";

/** «Ajustar sin arrastrar» (H13): ocho botones de 44 px, un toque cada uno, con la region viva. */

const START: CropFraction = { x: 0.2, y: 0.4, width: 0.3, height: 0.1 };

function Harness({ onAnnounce, strings = es.extract }: { onAnnounce?: (text: string) => void; strings?: typeof es.extract }) {
  const [rect, setRect] = useState(START);
  return (
    <>
      <RegionNudge rect={rect} onChange={setRect} strings={strings} onAnnounce={onAnnounce ?? (() => {})} />
      <output data-testid="rect">{`${Math.round(rect.x * 100)},${Math.round(rect.y * 100)},${Math.round(rect.width * 100)},${Math.round(rect.height * 100)}`}</output>
    </>
  );
}
const rect = () => screen.getByTestId("rect").textContent;

describe("RegionNudge", () => {
  it("un grupo con titulo y ocho botones con nombre accesible (iconos decorativos), de 44 px de alto", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Ajustar sin arrastrar" });
    const buttons = group.querySelectorAll("button");
    expect(buttons).toHaveLength(8);
    expect([...buttons].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Mover a la izquierda",
      "Mover a la derecha",
      "Mover hacia arriba",
      "Mover hacia abajo",
      "Más ancho",
      "Menos ancho",
      "Más alto",
      "Menos alto",
    ]);
    for (const button of buttons) {
      expect(button.className).toContain("h-11");
      expect(button.className).toContain("min-w-11");
      expect(button.getAttribute("type")).toBe("button");
    }
  });
  it("cada toque cambia la region 2 % y la anuncia", () => {
    const onAnnounce = vi.fn();
    render(<Harness onAnnounce={onAnnounce} />);
    fireEvent.click(screen.getByRole("button", { name: "Mover a la derecha" }));
    expect(rect()).toBe("22,40,30,10");
    expect(onAnnounce).toHaveBeenLastCalledWith("Región: izquierda 22 %, arriba 40 %, ancho 30 %, alto 10 %");
    fireEvent.click(screen.getByRole("button", { name: "Mover hacia abajo" }));
    expect(rect()).toBe("22,42,30,10");
    fireEvent.click(screen.getByRole("button", { name: "Más ancho" }));
    expect(rect()).toBe("21,42,32,10");
    fireEvent.click(screen.getByRole("button", { name: "Más alto" }));
    expect(rect()).toBe("21,41,32,12");
    fireEvent.click(screen.getByRole("button", { name: "Menos ancho" }));
    fireEvent.click(screen.getByRole("button", { name: "Menos alto" }));
    expect(rect()).toBe("22,42,30,10");
    fireEvent.click(screen.getByRole("button", { name: "Mover a la izquierda" }));
    fireEvent.click(screen.getByRole("button", { name: "Mover hacia arriba" }));
    expect(rect()).toBe("20,40,30,10");
    expect(onAnnounce).toHaveBeenCalledTimes(8);
  });
  it("en ingles", () => {
    render(<Harness strings={en.extract} />);
    expect(screen.getByRole("group", { name: "Adjust without dragging" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move right" }));
    expect(rect()).toBe("22,40,30,10");
    expect(screen.getByRole("button", { name: "Taller" })).toBeTruthy();
  });
});
