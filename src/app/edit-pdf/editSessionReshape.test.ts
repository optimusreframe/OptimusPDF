import { describe, expect, it } from "vitest";
import {
  applyOp,
  canUndo,
  createEditSession,
  redo,
  shapeItem,
  undo,
  type EditSession,
  type EditShapeItem,
} from "@/app/edit-pdf/editSession";
import type { EditShapeElement } from "@/app/edit-pdf/editSession";

const line: EditShapeElement = {
  id: "l1",
  pageIndex: 0,
  type: "line",
  x1: 0.2,
  y1: 0.2,
  x2: 0.6,
  y2: 0.4,
  strokeColor: "#e11d48",
  strokeWidth: 2,
};
const rect: EditShapeElement = {
  id: "r1",
  pageIndex: 0,
  type: "rect",
  x: 0.1,
  y: 0.1,
  width: 0.3,
  height: 0.2,
  strokeColor: "#e11d48",
  strokeWidth: 2,
  fill: false,
  fillColor: "#0d4bff",
  fillOpacity: 0.3,
};

function withLine(): EditSession {
  return applyOp(createEditSession(), { type: "add", item: shapeItem(line) }, 1000);
}

const lineOf = (session: EditSession) => (session.items[0] as EditShapeItem).element as typeof line;

describe("op reshape (extremos de una linea)", () => {
  it("mueve los dos extremos a la vez", () => {
    const next = applyOp(withLine(), { type: "reshape", id: "l1", points: { x1: 0.1, y1: 0.5, x2: 0.7, y2: 0.1 } }, 2000);
    expect(lineOf(next)).toMatchObject({ x1: 0.1, y1: 0.5, x2: 0.7, y2: 0.1 });
  });

  it("puede voltear la diagonal, lo que `resize` no representa", () => {
    const next = applyOp(withLine(), { type: "reshape", id: "l1", points: { x1: 0.6, y1: 0.2, x2: 0.2, y2: 0.4 } }, 2000);
    expect(lineOf(next).x1).toBeGreaterThan(lineOf(next).x2);
  });

  it("admite una horizontal perfecta (sin inclinacion minima)", () => {
    const next = applyOp(withLine(), { type: "reshape", id: "l1", points: { x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.3 } }, 2000);
    expect(lineOf(next).y1).toBe(lineOf(next).y2);
  });

  it("entra en el historial y se deshace y rehace", () => {
    const next = applyOp(withLine(), { type: "reshape", id: "l1", points: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 } }, 2000);
    expect(next.history).toHaveLength(2);
    expect(next.history[1].op).toBe("reshape");
    const back = undo(next);
    expect(lineOf(back)).toMatchObject({ x2: 0.6, y2: 0.4 });
    expect(lineOf(redo(back))).toMatchObject({ x2: 0.9, y2: 0.9 });
    expect(canUndo(back)).toBe(true);
  });

  it("dos reshape seguidos NO se funden (cada arrastre es un paso)", () => {
    let session = withLine();
    session = applyOp(session, { type: "reshape", id: "l1", points: { x1: 0.2, y1: 0.2, x2: 0.7, y2: 0.4 } }, 1100);
    session = applyOp(session, { type: "reshape", id: "l1", points: { x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.4 } }, 1150);
    expect(session.history).toHaveLength(3);
  });

  it("una linea demasiado corta se rechaza y la sesion no cambia", () => {
    const session = withLine();
    const next = applyOp(session, { type: "reshape", id: "l1", points: { x1: 0.2, y1: 0.2, x2: 0.2, y2: 0.201 } }, 2000);
    expect(next).toBe(session);
  });

  it("recorta los extremos a la pagina", () => {
    const next = applyOp(withLine(), { type: "reshape", id: "l1", points: { x1: -1, y1: 0.2, x2: 4, y2: 0.4 } }, 2000);
    expect(lineOf(next)).toMatchObject({ x1: 0, x2: 1 });
  });

  it("ignora valores no numericos", () => {
    const session = withLine();
    const next = applyOp(session, { type: "reshape", id: "l1", points: { x1: NaN, y1: 0, x2: 1, y2: 1 } }, 2000);
    expect(next).toBe(session);
  });

  it("solo vale para lineas: en un rectangulo no hace nada", () => {
    const session = applyOp(createEditSession(), { type: "add", item: shapeItem(rect) }, 1000);
    const next = applyOp(session, { type: "reshape", id: "r1", points: { x1: 0, y1: 0, x2: 1, y2: 1 } }, 2000);
    expect(next).toBe(session);
  });

  it("un id inexistente no cambia nada", () => {
    const session = withLine();
    expect(applyOp(session, { type: "reshape", id: "nope", points: { x1: 0, y1: 0, x2: 1, y2: 1 } }, 2000)).toBe(session);
  });
});
