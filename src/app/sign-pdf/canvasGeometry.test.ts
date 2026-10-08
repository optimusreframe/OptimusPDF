import { describe, expect, it } from "vitest";
import {
  expandHitTargets,
  findFreeSpot,
  placeFloatingBar,
  type Insets,
  type PxRect,
} from "@/app/sign-pdf/canvasGeometry";

const zoneOf = (rect: PxRect, insets: Insets): PxRect => ({
  x: rect.x - insets.left,
  y: rect.y - insets.top,
  width: rect.width + insets.left + insets.right,
  height: rect.height + insets.top + insets.bottom,
});

const overlap = (a: PxRect, b: PxRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("expandHitTargets", () => {
  const page = { width: 343, height: 460 };

  it("un campo aislado de 13 px crece hasta 44 px de alto sin salirse de la pagina", () => {
    const rect = { x: 20, y: 200, width: 200, height: 13 };
    const insets = expandHitTargets([{ id: "a", rect }], page).get("a")!;
    const zone = zoneOf(rect, insets);
    expect(zone.height).toBeCloseTo(44, 5);
    expect(zone.width).toBe(200); // ya mide mas de 44 de ancho: no crece
    expect(insets.top).toBeCloseTo(insets.bottom, 5);
  });

  it("no crece por fuera de la pagina (campo pegado al borde superior)", () => {
    const rect = { x: 20, y: 2, width: 100, height: 13 };
    const insets = expandHitTargets([{ id: "a", rect }], page).get("a")!;
    expect(insets.top).toBeLessThanOrEqual(2);
    expect(rect.y - insets.top).toBeGreaterThanOrEqual(0);
  });

  it("dos campos separados 20 px se reparten el hueco por la mitad", () => {
    const a = { x: 20, y: 100, width: 200, height: 13 };
    const b = { x: 20, y: 133, width: 200, height: 13 };
    const result = expandHitTargets(
      [
        { id: "a", rect: a },
        { id: "b", rect: b },
      ],
      page,
    );
    const za = zoneOf(a, result.get("a")!);
    const zb = zoneOf(b, result.get("b")!);
    expect(za.y + za.height).toBeCloseTo(123, 5); // punto medio del hueco 113..133
    expect(zb.y).toBeCloseTo(123, 5);
    expect(overlap(za, zb)).toBe(false);
    expect(za.height).toBeGreaterThanOrEqual(24);
    expect(zb.height).toBeGreaterThanOrEqual(24);
  });

  it("formulario denso (14 campos de 13 px cada 33 px): todos >= 24 px y cero solapes", () => {
    const items = Array.from({ length: 14 }, (_, index) => ({
      id: `f${index}`,
      rect: { x: 20, y: 10 + index * 33, width: 180 + (index % 3) * 20, height: 13 },
    }));
    const result = expandHitTargets(items, { width: 343, height: 480 });
    const zones = items.map((item) => zoneOf(item.rect, result.get(item.id)!));
    for (const zone of zones) expect(zone.height).toBeGreaterThanOrEqual(24);
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        expect(overlap(zones[i], zones[j])).toBe(false);
      }
    }
  });

  it("nunca invade la caja original de otro elemento", () => {
    const small = { x: 100, y: 100, width: 40, height: 13 };
    const big = { x: 100, y: 120, width: 120, height: 60 }; // 7 px debajo
    const result = expandHitTargets(
      [
        { id: "small", rect: small },
        { id: "big", rect: big },
      ],
      page,
    );
    const zone = zoneOf(small, result.get("small")!);
    expect(overlap(zone, big)).toBe(false);
    expect(zone.y + zone.height).toBeLessThanOrEqual(120 + 1e-9);
  });

  it("vecinos en diagonal: las zonas no se solapan", () => {
    const a = { x: 50, y: 50, width: 20, height: 13 };
    const b = { x: 80, y: 70, width: 20, height: 13 };
    const result = expandHitTargets(
      [
        { id: "a", rect: a },
        { id: "b", rect: b },
      ],
      page,
    );
    expect(overlap(zoneOf(a, result.get("a")!), zoneOf(b, result.get("b")!))).toBe(false);
  });

  it("cajas originales solapadas: no se imponen restricciones mutuas y no revienta", () => {
    const a = { x: 50, y: 50, width: 60, height: 20 };
    const b = { x: 70, y: 55, width: 60, height: 20 };
    const result = expandHitTargets(
      [
        { id: "a", rect: a },
        { id: "b", rect: b },
      ],
      page,
    );
    expect(result.get("a")!.top).toBeGreaterThanOrEqual(0);
    expect(result.get("b")!.bottom).toBeGreaterThanOrEqual(0);
  });

  it("con un objetivo menor (zoom 2x: 24/2 = 12 px) un campo de 13 px no necesita ampliarse", () => {
    const rect = { x: 20, y: 200, width: 200, height: 13 };
    const insets = expandHitTargets([{ id: "a", rect }], page, 12).get("a")!;
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("placeFloatingBar", () => {
  const safe = { x: 0, y: 56, width: 375, height: 500 };
  const page = { x: 16, y: 100, width: 343, height: 460 };
  const stage = { left: 8, right: 367 };
  const bar = { width: 300, height: 48 };

  it("por defecto va arriba y centrada sobre el elemento", () => {
    const anchor = { x: 120, y: 300, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page, safe, stage });
    expect(placed.side).toBe("top");
    expect(placed.y).toBe(300 - 8 - 48);
    expect(placed.x + bar.width / 2).toBeCloseTo(180, 5);
  });

  it("deja sitio a la etiqueta que sobresale por arriba del elemento", () => {
    const anchor = { x: 120, y: 300, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, anchorPad: { top: 20 }, bar, page, safe, stage });
    expect(placed.y + bar.height).toBeLessThanOrEqual(300 - 20);
  });

  it("se voltea hacia abajo cerca del borde superior de la pagina", () => {
    const anchor = { x: 120, y: 112, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page, safe, stage });
    expect(placed.side).toBe("bottom");
    expect(placed.y).toBe(112 + 30 + 8);
  });

  it("se queda arriba en la ultima fila de la pagina (abajo se saldria de la hoja)", () => {
    const anchor = { x: 120, y: 520, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page, safe, stage });
    expect(placed.side).toBe("top");
  });

  it("no se sale por los lados del escenario", () => {
    const left = placeFloatingBar({
      anchor: { x: 16, y: 300, width: 40, height: 30 },
      bar,
      page,
      safe,
      stage,
    });
    expect(left.x).toBe(8);
    const right = placeFloatingBar({
      anchor: { x: 320, y: 300, width: 38, height: 30 },
      bar,
      page,
      safe,
      stage,
    });
    expect(right.x + bar.width).toBe(367);
  });

  it("respeta la region util de la ventana: bajo la cabecera fija no cabe y se voltea", () => {
    // El elemento esta en la hoja (y = 140) pero la ventana util empieza en 56:
    // arriba sobran 140-56-8 = 76 > 48, cabe. Con la cabecera en 120 ya no.
    const anchor = { x: 120, y: 140, width: 120, height: 30 };
    const tall = placeFloatingBar({
      anchor,
      bar,
      page,
      safe: { ...safe, y: 120, height: 436 },
      stage,
    });
    expect(tall.side).toBe("bottom");
  });

  it("prefer=bottom invierte la preferencia cuando caben los dos lados", () => {
    const anchor = { x: 120, y: 300, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page, safe, stage, prefer: "bottom" });
    expect(placed.side).toBe("bottom");
  });

  it("si la hoja no ofrece sitio pero la ventana si, sale de la hoja (nunca recortada)", () => {
    const smallPage = { x: 16, y: 280, width: 343, height: 80 };
    const anchor = { x: 120, y: 300, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page: smallPage, safe, stage });
    expect(placed.side === "top" || placed.side === "bottom").toBe(true);
    expect(placed.y).toBeGreaterThanOrEqual(safe.y);
    expect(placed.y + bar.height).toBeLessThanOrEqual(safe.y + safe.height);
  });

  it("sin sitio a ningun lado cae en overlay dentro de la ventana util", () => {
    const tiny = { x: 0, y: 56, width: 375, height: 70 };
    const anchor = { x: 120, y: 80, width: 120, height: 30 };
    const placed = placeFloatingBar({ anchor, bar, page, safe: tiny, stage });
    expect(placed.side).toBe("overlay");
    expect(placed.y).toBeGreaterThanOrEqual(tiny.y);
    expect(placed.y + bar.height).toBeLessThanOrEqual(tiny.y + tiny.height);
  });
});

describe("findFreeSpot", () => {
  const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.05 };

  it("prefiere justo debajo", () => {
    const spot = findFreeSpot(rect, [rect]);
    expect(spot.x).toBe(rect.x);
    expect(spot.y).toBeCloseTo(0.158, 5);
  });

  it("si debajo esta ocupado, prueba arriba y luego a los lados", () => {
    const below = { ...rect, y: 0.158 };
    const spot = findFreeSpot(rect, [rect, below]);
    expect(spot.y).toBeLessThan(rect.y);
  });

  it("sin hueco libre, desplaza en diagonal sin salirse de la pagina", () => {
    const others = [
      rect,
      { x: 0, y: 0, width: 1, height: 1 }, // todo ocupado
    ];
    const spot = findFreeSpot({ x: 0.8, y: 0.9, width: 0.2, height: 0.1 }, others);
    expect(spot.x + spot.width).toBeLessThanOrEqual(1.0000001);
    expect(spot.y + spot.height).toBeLessThanOrEqual(1.0000001);
    expect(spot.x).toBeGreaterThanOrEqual(0);
    expect(spot.y).toBeGreaterThanOrEqual(0);
  });
});
