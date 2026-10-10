import { describe, expect, it } from "vitest";
import {
  applyOp,
  canRedo,
  createEditSession,
  editSessionFromJSON,
  editSessionToJSON,
  findFlattenItem,
  flattenItem,
  flattenedPages,
  newTextEdit,
  pendingChangeCount,
  redo,
  sanitizeEditItem,
  shapeItem,
  splitForExport,
  textItem,
  undo,
} from "@/app/edit-pdf/editSession";

/** «Aplanar pagina» como item de la sesion (W5-U5): historial, borradores y exportacion. */

const flat = (page: number, id = `fl-${page}`) => ({ ...flattenItem(page), id });

describe("aplanar pagina — modelo de sesion", () => {
  it("anadir un aplanado es un cambio pendiente y se deshace/rehace como cualquier op", () => {
    let session = createEditSession();
    expect(pendingChangeCount(session)).toBe(0);
    session = applyOp(session, { type: "add", item: flat(1) });
    expect(pendingChangeCount(session)).toBe(1);
    expect(flattenedPages(session)).toEqual([1]);
    session = undo(session);
    expect(flattenedPages(session)).toEqual([]);
    expect(canRedo(session)).toBe(true);
    session = redo(session);
    expect(flattenedPages(session)).toEqual([1]);
  });

  it("solo hay UN aplanado por pagina: repetirlo no cambia la sesion ni el historial", () => {
    const first = applyOp(createEditSession(), { type: "add", item: flat(0, "a") });
    const again = applyOp(first, { type: "add", item: flat(0, "b") });
    expect(again).toBe(first);
    expect(findFlattenItem(first, 0)?.id).toBe("a");
  });

  it("quitar el aplanado (remove) lo retira y se puede deshacer", () => {
    let session = applyOp(createEditSession(), { type: "add", item: flat(2, "x") });
    session = applyOp(session, { type: "remove", id: "x" });
    expect(flattenedPages(session)).toEqual([]);
    session = undo(session);
    expect(flattenedPages(session)).toEqual([2]);
  });

  it("splitForExport devuelve las paginas aplanadas ordenadas y sin repetidos, aparte de textos y elementos", () => {
    let session = createEditSession();
    session = applyOp(session, { type: "add", item: flat(3) });
    session = applyOp(session, { type: "add", item: flat(1) });
    session = applyOp(session, {
      type: "add",
      item: textItem(newTextEdit({ id: "t", pageIndex: 1, box: { x: 1, y: 1, width: 50, height: 10 }, fontKey: "helvetica", text: "Hola" })),
    });
    const split = splitForExport(session);
    expect(split.flattenPages).toEqual([1, 3]);
    expect(split.textEdits).toHaveLength(1);
    expect(split.elements).toHaveLength(0);
  });

  it("mover, redimensionar, actualizar o restilar un aplanado no hace nada (misma sesion)", () => {
    const session = applyOp(createEditSession(), { type: "add", item: flat(0, "f") });
    expect(applyOp(session, { type: "move", id: "f", dx: 0.1, dy: 0.1 })).toBe(session);
    expect(applyOp(session, { type: "resize", id: "f", box: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toBe(session);
    expect(applyOp(session, { type: "update", id: "f", patch: { text: "x" } })).toBe(session);
    expect(applyOp(session, { type: "restyle", id: "f", patch: { color: "#ff0000" } })).toBe(session);
  });

  it("el JSON de un borrador conserva el aplanado y descarta el de una pagina que ya no existe", () => {
    const session = applyOp(applyOp(createEditSession(), { type: "add", item: flat(0) }), {
      type: "add",
      item: flat(5),
    });
    const json = editSessionToJSON(session, { inlineAssets: false });
    const restored = editSessionFromJSON(json, { pageCount: 3 });
    expect(flattenedPages(restored.session)).toEqual([0]);
    expect(restored.discarded).toBe(1);
    expect(restored.status).toBe("partial");
  });

  it("un aplanado mal formado no pasa la validacion", () => {
    expect(sanitizeEditItem({ kind: "flatten", id: "", pageIndex: 0 })).toBeNull();
    expect(sanitizeEditItem({ kind: "flatten", id: "f", pageIndex: -1 })).toBeNull();
    expect(sanitizeEditItem({ kind: "flatten", id: "f", pageIndex: 1.5 })).toBeNull();
    expect(sanitizeEditItem({ kind: "flatten", id: "f", pageIndex: 2, extra: true })).toEqual({
      kind: "flatten",
      id: "f",
      pageIndex: 2,
    });
  });
});

describe("un texto que se escribe = UNA entrada de historial (W5-U5 · N2)", () => {
  const edit = (text: string) =>
    textItem(newTextEdit({ id: "t1", pageIndex: 0, box: { x: 10, y: 10, width: 100, height: 20 }, fontKey: "helvetica", text }));
  const typed = (steps: Array<[number, string]>) => {
    let session = applyOp(createEditSession(), { type: "add", item: edit(steps[0][1]) }, steps[0][0]);
    for (const [at, text] of steps.slice(1)) session = applyOp(session, { type: "update", id: "t1", patch: { text } }, at);
    return session;
  };

  it("el add del primer caracter y los update seguidos dentro de la ventana se funden en una entrada", () => {
    const session = typed([[0, "P"], [100, "Pr"], [200, "Pru"], [300, "Prue"]]);
    expect(session.history).toHaveLength(1);
    const undone = undo(session);
    expect(undone.items).toHaveLength(0); // vuelve al original: no hay edicion (ni «P» a medias)
    expect(redo(undone).items[0]).toMatchObject({ edit: { text: "Prue" } });
  });

  it("un Ctrl+Z basta aunque el texto se anada al final (no hay un primer Ctrl+Z invisible)", () => {
    const session = typed([[0, "A"], [50, "AB"]]);
    expect(undo(session).items).toHaveLength(0);
    expect(canRedo(undo(session))).toBe(true);
  });

  it("pasada la ventana (500 ms) se abre una entrada nueva: deshacer vuelve a lo escrito antes de la pausa", () => {
    const session = typed([[0, "A"], [100, "AB"], [900, "ABC"]]);
    expect(session.history).toHaveLength(2);
    expect(undo(session).items[0]).toMatchObject({ edit: { text: "AB" } });
    expect(undo(undo(session)).items).toHaveLength(0);
  });

  it("otra operacion (restyle) en medio rompe el grupo: no se funde con el tecleo", () => {
    let session = typed([[0, "A"], [50, "AB"]]);
    session = applyOp(session, { type: "restyle", id: "t1", patch: { color: "#ff0000" } }, 100);
    session = applyOp(session, { type: "update", id: "t1", patch: { text: "ABC" } }, 150);
    expect(session.history).toHaveLength(3);
  });

  it("anadir imagenes o formas no abre grupo de tecleo", () => {
    const rect = applyOp(createEditSession(), { type: "add", item: shapeItem({ type: "rect", id: "r", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2, strokeColor: "#000000", strokeWidth: 1, fill: false, fillColor: "#000000", fillOpacity: 0.3 }) }, 0);
    expect(rect.group).toBeNull();
  });
});
