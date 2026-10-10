import { describe, expect, it } from "vitest";
import { orientedClipPath } from "@/app/edit-pdf/coverClip";
import { coverShape } from "@/lib/pdf/editCover";
import type { CoverShape } from "@/lib/pdf/editCover";
import type { TextEdit } from "@/lib/pdf/editTypes";

/** Vista previa == exportacion: el rectangulo girado MENOS los vecinos, con relleno par-impar (W5-U5). */

type Oriented = Extract<CoverShape, { kind: "oriented" }>;

describe("orientedClipPath", () => {
  it("sin huecos no hay recorte", () => {
    const shape: Oriented = { kind: "oriented", origin: { x: 0, y: 0 }, width: 100, height: 16, rotation: 40, holes: [] };
    expect(orientedClipPath(shape, 2)).toBeNull();
  });

  it("un hueco: path par-impar con el rectangulo entero y el poligono del vecino en coordenadas LOCALES (px)", () => {
    // Sin giro, para poder calcular a mano: el hueco ocupa x 10..20, y 4..10 (hacia arriba desde el borde inferior).
    const shape: Oriented = {
      kind: "oriented",
      origin: { x: 100, y: 200 },
      width: 80,
      height: 16,
      rotation: 0,
      holes: [
        {
          id: "p0-b1",
          polygon: [
            { x: 110, y: 204 },
            { x: 120, y: 204 },
            { x: 120, y: 210 },
            { x: 110, y: 210 },
          ],
        },
      ],
    };
    const path = orientedClipPath(shape, 2)!;
    expect(path.startsWith('path(evenodd, "')).toBe(true);
    expect(path).toContain("M0 0H160V32H0Z");
    // y local = (alto - subida) * escala: subida 4 -> 24, subida 10 -> 12.
    expect(path).toContain("M20 24L40 24L40 12L20 12Z");
  });

  it("varios huecos: un subtrazado por vecino", () => {
    const square = (x: number) => [
      { x, y: 2 },
      { x: x + 4, y: 2 },
      { x: x + 4, y: 6 },
      { x, y: 6 },
    ];
    const shape: Oriented = {
      kind: "oriented",
      origin: { x: 0, y: 0 },
      width: 60,
      height: 10,
      rotation: 0,
      holes: [
        { id: "a", polygon: square(5) },
        { id: "b", polygon: square(30) },
      ],
    };
    expect(orientedClipPath(shape, 1)!.match(/M/g)).toHaveLength(3);
  });

  it("con un texto a 40 grados cruzado por un vecino, la cobertura de la vista previa tiene hueco", () => {
    const edit = {
      box: { x: 60, y: 60, width: 130, height: 70 },
      coverBox: { x: 60, y: 60, width: 130, height: 70 },
      coverOriented: { origin: { x: 60, y: 60 }, width: 90, height: 16, rotation: 40 },
      cover: { color: "#ffffff", padding: 1 },
      obstacles: [{ id: "p0-b1", box: { x: 92, y: 104, width: 70, height: 12 } }],
    } as Pick<TextEdit, "box" | "coverBox" | "coverOriented" | "cover" | "obstacles">;
    const shape = coverShape(edit);
    expect(shape?.kind).toBe("oriented");
    const path = orientedClipPath(shape as Oriented, 1.5);
    expect(path).not.toBeNull();
    expect((shape as Oriented).holes.length).toBeGreaterThan(0);
  });
});
