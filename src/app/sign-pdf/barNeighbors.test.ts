import { describe, expect, it } from "vitest";
import { pickBarSpot } from "@/app/sign-pdf/barNeighbors";

const base = {
  anchor: { x: 200, y: 400, width: 120, height: 16 },
  bar: { width: 300, height: 44 },
  safe: { x: 0, y: 60, width: 1200, height: 700 },
  stage: { left: 8, right: 1192 },
  gap: 8,
};

describe("pickBarSpot (la barra no tapa al bloque de al lado)", () => {
  it("sin vecinos tapados no mueve nada", () => {
    const placed = { x: 110, y: 348, side: "top" as const };
    expect(pickBarSpot({ ...base, placed, neighbors: [{ x: 200, y: 600, width: 100, height: 16 }] })).toBe(placed);
  });

  it("si arriba tapa al vecino y abajo no, pasa abajo", () => {
    const placed = { x: 110, y: 348, side: "top" as const };
    const above = { x: 200, y: 370, width: 150, height: 20 };
    const spot = pickBarSpot({ ...base, placed, neighbors: [above] });
    expect(spot.side).toBe("bottom");
    expect(spot.y).toBe(400 + 16 + 8);
  });

  it("con vecinos arriba y abajo (tabla apretada) la barra va al lado del bloque, sin tapar a nadie", () => {
    const anchor = { x: 300, y: 400, width: 60, height: 16 };
    const placed = { x: 180, y: 348, side: "top" as const };
    const above = { x: 250, y: 372, width: 90, height: 20 };
    const below = { x: 250, y: 424, width: 90, height: 20 };
    const spot = pickBarSpot({ ...base, anchor, placed, neighbors: [above, below] });
    // Sin solaparse con nadie (mas arriba, a un lado...) y SIN cubrir el bloque seleccionado.
    const coversAnchor =
      spot.x < anchor.x + anchor.width &&
      spot.x + 300 > anchor.x &&
      spot.y < anchor.y + anchor.height &&
      spot.y + 44 > anchor.y;
    expect(coversAnchor).toBe(false);
    for (const neighbor of [above, below]) {
      const overlaps =
        spot.x < neighbor.x + neighbor.width &&
        spot.x + 300 > neighbor.x &&
        spot.y < neighbor.y + neighbor.height &&
        spot.y + 44 > neighbor.y;
      expect(overlaps).toBe(false);
    }
  });

  it("prefiere NO tapar por completo a ningun vecino aunque roce a otro (lista de lineas apretadas)", () => {
    // Lineas de 16 px cada 18 px: arriba y abajo hay tres lineas completas; a la derecha, hueco.
    const anchor = { x: 100, y: 400, width: 200, height: 16 };
    const lines = [-3, -2, -1, 1, 2, 3].map((k) => ({ x: 100, y: 400 + k * 18, width: 180, height: 16 }));
    const placed = { x: 0, y: 400 - 8 - 44, side: "top" as const };
    const spot = pickBarSpot({ ...base, anchor, placed, neighbors: lines });
    const full = lines.filter((n) => {
      const w = Math.min(spot.x + 300, n.x + n.width) - Math.max(spot.x, n.x);
      const h = Math.min(spot.y + 44, n.y + n.height) - Math.max(spot.y, n.y);
      return w > 0 && h > 0 && (w * h) / (n.width * n.height) >= 0.9;
    });
    expect(full).toHaveLength(0);
  });

  it("lineas apretadas (35 px de paso, barra de 50): con el margen del ancla se va junto a la linea, sobresaliendo del escenario si hace falta", () => {
    // Medidas reales de un PDF denso a 1280 x 800: bloque 448..687, tiradores externos 420..716.
    const anchor = { x: 420, y: 285, width: 296, height: 28 };
    const lines = [-3, -2, -1, 1, 2, 3].map((k) => ({ x: 448, y: 300 + k * 35, width: 239, height: 12 }));
    const placed = { x: 357, y: 285 - 20 - 8 - 50, side: "top" as const };
    const spot = pickBarSpot({
      anchor,
      anchorPad: { top: 20, bottom: 14, right: 12 },
      placed,
      bar: { width: 526, height: 50 },
      safe: { x: 0, y: 60, width: 1280, height: 740 },
      stage: { left: 364, right: 1235 },
      gap: 8,
      neighbors: lines,
    });
    expect(spot.x).toBeGreaterThanOrEqual(anchor.x + anchor.width + 8);
    expect(spot.x + 526).toBeLessThanOrEqual(1280 - 8);
    for (const n of lines) {
      const w = Math.min(spot.x + 526, n.x + n.width) - Math.max(spot.x, n.x);
      const h = Math.min(spot.y + 50, n.y + n.height) - Math.max(spot.y, n.y);
      expect(w > 0 && h > 0).toBe(false);
    }
  });

  it("si todo tapa a alguien elige lo que menos tapa", () => {
    const placed = { x: 110, y: 348, side: "top" as const };
    const big = { x: 0, y: 340, width: 1200, height: 100 };
    const small = { x: 0, y: 424, width: 120, height: 10 };
    const spot = pickBarSpot({ ...base, placed, neighbors: [big, small] });
    expect(spot).toBeDefined();
  });
});
