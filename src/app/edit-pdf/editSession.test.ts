import { describe, expect, it } from "vitest";
import {
  EDIT_GROUP_WINDOW_MS,
  EDIT_HISTORY_LIMIT,
  EDIT_SESSION_SCHEMA,
  applyOp,
  blockToTextEdit,
  canRedo,
  canUndo,
  createEditSession,
  editSessionFromJSON,
  editSessionToJSON,
  findEditForBlock,
  fromJSON,
  getItem,
  getSelectedItem,
  imageAddOp,
  itemsOnPage,
  newTextEdit,
  pendingChangeCount,
  redo,
  referencedAssets,
  resetSession,
  selectItem,
  shapeItem,
  splitForExport,
  textItem,
  toJSON,
  undo,
  type EditOp,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import type { ImageElement, RectElement, LineElement } from "@/lib/pdf/editPdf";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";

/**
 * Sesion de edicion pura: operaciones, historial con cursor, agrupado de
 * tecleo con tiempo inyectado, seleccion, exportacion y JSON validado.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

function textEdit(id: string, overrides: Partial<TextEdit> = {}): TextEdit {
  return newTextEdit({
    id,
    pageIndex: 0,
    box: { x: 50, y: 700, width: 200, height: 20 },
    fontKey: "helvetica",
    text: "Hola",
    ...overrides,
  });
}

function rect(id: string, overrides: Partial<RectElement> = {}): RectElement {
  return {
    type: "rect",
    id,
    pageIndex: 0,
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.2,
    strokeColor: "#e11d48",
    strokeWidth: 2,
    fill: false,
    fillColor: "#0d4bff",
    fillOpacity: 0.3,
    ...overrides,
  };
}

function line(id: string): LineElement {
  return {
    type: "line",
    id,
    pageIndex: 0,
    x1: 0.1,
    y1: 0.2,
    x2: 0.5,
    y2: 0.6,
    strokeColor: "#000000",
    strokeWidth: 2,
  };
}

function image(id: string, bytes = PNG): ImageElement {
  return {
    type: "image",
    id,
    pageIndex: 0,
    x: 0.2,
    y: 0.2,
    width: 0.3,
    height: 0.3,
    bytes,
    previewUrl: "data:image/png;base64,AAAA",
    ratio: 1,
  };
}

function run(session: EditSession, ...ops: [EditOp, number?][]): EditSession {
  let current = session;
  let clock = 0;
  for (const [op, at] of ops) {
    clock = at ?? clock + 10_000;
    current = applyOp(current, op, clock);
  }
  return current;
}

const add = (edit: TextEdit): EditOp => ({ type: "add", item: textItem(edit) });

describe("editSession — add / remove / consultas", () => {
  it("una sesion nueva esta vacia y no se puede deshacer ni rehacer", () => {
    const s = createEditSession();
    expect(s.schema).toBe(EDIT_SESSION_SCHEMA);
    expect(s.items).toEqual([]);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
    expect(pendingChangeCount(s)).toBe(0);
  });

  it("add inserta, selecciona el item nuevo y abre una entrada de historial", () => {
    const s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    expect(s.items).toHaveLength(1);
    expect(s.selectedId).toBe("t1");
    expect(getSelectedItem(s)?.id).toBe("t1");
    expect(canUndo(s)).toBe(true);
  });

  it("add con un id repetido o un item invalido devuelve la MISMA sesion", () => {
    const s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    expect(applyOp(s, add(textEdit("t1")), 1)).toBe(s);
    const bad = { type: "add", item: { kind: "text", id: "x", edit: { id: "x" } } } as unknown as EditOp;
    expect(applyOp(s, bad, 1)).toBe(s);
  });

  it("remove quita el item, deselecciona si era el seleccionado y se puede deshacer", () => {
    let s = run(createEditSession(), [add(textEdit("t1"))], [add(textEdit("t2"))]);
    s = applyOp(s, { type: "remove", id: "t2" }, 50_000);
    expect(s.items.map((i) => i.id)).toEqual(["t1"]);
    expect(s.selectedId).toBeNull();
    s = undo(s);
    expect(s.items.map((i) => i.id)).toEqual(["t1", "t2"]);
  });

  it("remove de un id inexistente es un no-op", () => {
    const s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    expect(applyOp(s, { type: "remove", id: "nope" }, 1)).toBe(s);
  });

  it("itemsOnPage filtra por pagina y conserva el orden de creacion", () => {
    const s = run(
      createEditSession(),
      [add(textEdit("a", { pageIndex: 1 }))],
      [{ type: "add", item: shapeItem(rect("b")) }],
      [add(textEdit("c", { pageIndex: 1 }))],
    );
    expect(itemsOnPage(s, 1).map((i) => i.id)).toEqual(["a", "c"]);
    expect(itemsOnPage(s, 0).map((i) => i.id)).toEqual(["b"]);
    expect(itemsOnPage(s, 5)).toEqual([]);
  });

  it("el id del item se fuerza al del contenido que envuelve", () => {
    const wrong = { kind: "text", id: "otro", edit: textEdit("real") } as const;
    const s = applyOp(createEditSession(), { type: "add", item: wrong }, 0);
    expect(s.items[0].id).toBe("real");
  });
});

describe("editSession — undo / redo con cursor", () => {
  it("deshacer y rehacer recorren las entradas y no tocan el resto", () => {
    let s = run(createEditSession(), [add(textEdit("a"))], [add(textEdit("b"))], [add(textEdit("c"))]);
    expect(s.items).toHaveLength(3);
    s = undo(s);
    s = undo(s);
    expect(s.items.map((i) => i.id)).toEqual(["a"]);
    expect(canRedo(s)).toBe(true);
    s = redo(s);
    expect(s.items.map((i) => i.id)).toEqual(["a", "b"]);
    s = redo(s);
    s = redo(s); // de mas: no-op
    expect(s.items).toHaveLength(3);
    expect(canRedo(s)).toBe(false);
  });

  it("deshacer sin historial y rehacer sin pila devuelven la misma sesion", () => {
    const s = createEditSession();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });

  it("una op nueva tras deshacer descarta lo rehacible", () => {
    let s = run(createEditSession(), [add(textEdit("a"))], [add(textEdit("b"))]);
    s = undo(s);
    s = applyOp(s, add(textEdit("z")), 90_000);
    expect(canRedo(s)).toBe(false);
    expect(s.items.map((i) => i.id)).toEqual(["a", "z"]);
    expect(s.history).toHaveLength(2);
  });

  it("deshacer deselecciona si el item seleccionado deja de existir", () => {
    let s = run(createEditSession(), [add(textEdit("a"))]);
    expect(s.selectedId).toBe("a");
    s = undo(s);
    expect(s.selectedId).toBeNull();
  });

  it("el historial se acota a EDIT_HISTORY_LIMIT olvidando lo mas antiguo", () => {
    let s = createEditSession();
    for (let i = 0; i < EDIT_HISTORY_LIMIT + 25; i += 1) {
      s = applyOp(s, add(textEdit(`t${i}`)), i * 10_000);
    }
    expect(s.history).toHaveLength(EDIT_HISTORY_LIMIT);
    expect(s.cursor).toBe(EDIT_HISTORY_LIMIT);
    expect(s.items).toHaveLength(EDIT_HISTORY_LIMIT + 25);
    let back = s;
    while (canUndo(back)) back = undo(back);
    expect(back.items).toHaveLength(25);
  });

  it("la sesion es inmutable: aplicar una op no altera la anterior", () => {
    const s0 = applyOp(createEditSession(), add(textEdit("a")), 0);
    const snapshot = JSON.stringify(s0.items);
    applyOp(s0, { type: "update", id: "a", patch: { text: "otro" } }, 10_000);
    applyOp(s0, { type: "remove", id: "a" }, 10_000);
    expect(JSON.stringify(s0.items)).toBe(snapshot);
  });
});

describe("editSession — agrupado determinista de tecleo", () => {
  const keystrokes = (s: EditSession, texts: string[], start: number, step: number) =>
    texts.reduce(
      (acc, text, i) =>
        applyOp(acc, { type: "update", id: "t1", patch: { text } }, start + i * step),
      s,
    );

  it("tres teclazos dentro de la ventana son UNA entrada", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    const s = keystrokes(base, ["H", "Ho", "Hol"], 10_000, 100);
    expect(s.history).toHaveLength(2); // add + un grupo
    expect(canUndo(s)).toBe(true);
    const back = undo(s);
    expect((back.items[0] as { edit: TextEdit }).edit.text).toBe("");
    expect(redo(back).items).toEqual(s.items);
  });

  it("la ventana es deslizante: 400 ms entre teclazos mantiene el grupo aunque el total pase de 500", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    const s = keystrokes(base, ["a", "ab", "abc", "abcd"], 10_000, EDIT_GROUP_WINDOW_MS - 100);
    expect(s.history).toHaveLength(2);
  });

  it("una pausa mayor que la ventana abre otra entrada", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    let s = keystrokes(base, ["a", "ab"], 10_000, 50);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "abc" } }, 10_050 + EDIT_GROUP_WINDOW_MS + 1);
    expect(s.history).toHaveLength(3);
    expect((undo(s).items[0] as { edit: TextEdit }).edit.text).toBe("ab");
  });

  it("justo en el limite de la ventana todavia funde", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    let s = applyOp(base, { type: "update", id: "t1", patch: { text: "a" } }, 1000);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "ab" } }, 1000 + EDIT_GROUP_WINDOW_MS);
    expect(s.history).toHaveLength(2);
  });

  it("updates sobre items distintos no se funden", () => {
    let s = run(createEditSession(), [add(textEdit("t1"))], [add(textEdit("t2"))]);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "uno" } }, 100_000);
    s = applyOp(s, { type: "update", id: "t2", patch: { text: "dos" } }, 100_010);
    expect(s.history).toHaveLength(4);
  });

  it("deshacer rompe el grupo: teclear despues no se funde con lo anterior", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    let s = applyOp(base, { type: "update", id: "t1", patch: { text: "a" } }, 10_000);
    s = undo(s);
    s = redo(s);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "ab" } }, 10_020);
    expect(s.history).toHaveLength(3);
  });

  it("otra op entre medias (mover) rompe el grupo", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    let s = applyOp(base, { type: "update", id: "t1", patch: { text: "a" } }, 10_000);
    s = applyOp(s, { type: "move", id: "t1", dx: 5, dy: 0 }, 10_010);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "ab" } }, 10_020);
    expect(s.history).toHaveLength(4);
  });

  it("restyle de las mismas propiedades se funde (arrastrar un control); de otras no", () => {
    let s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    s = applyOp(s, { type: "restyle", id: "t1", patch: { fontSize: 14 } }, 10_000);
    s = applyOp(s, { type: "restyle", id: "t1", patch: { fontSize: 15 } }, 10_050);
    s = applyOp(s, { type: "restyle", id: "t1", patch: { fontSize: 16 } }, 10_100);
    expect(s.history).toHaveLength(2);
    s = applyOp(s, { type: "restyle", id: "t1", patch: { bold: true } }, 10_150);
    expect(s.history).toHaveLength(3);
    expect((undo(undo(s)).items[0] as { edit: TextEdit }).edit.fontSize).toBe(12);
  });

  it("un update que no cambia nada no crea entrada ni rompe el grupo", () => {
    const base = applyOp(createEditSession(), add(textEdit("t1", { text: "" })), 0);
    let s = applyOp(base, { type: "update", id: "t1", patch: { text: "a" } }, 10_000);
    const same = applyOp(s, { type: "update", id: "t1", patch: { text: "a" } }, 10_100);
    expect(same).toBe(s);
    s = applyOp(s, { type: "update", id: "t1", patch: { text: "ab" } }, 10_200);
    expect(s.history).toHaveLength(2);
  });
});

describe("editSession — ops sobre bloques existentes y texto nuevo", () => {
  const block: TextBlock = {
    id: "p0-b3",
    pageIndex: 0,
    box: { x: 72, y: 600, width: 300, height: 14 },
    text: "Texto original",
    lines: [{ text: "Texto original", box: { x: 72, y: 600, width: 300, height: 14 }, baseline: 603 }],
    fontSize: 11,
    color: "#112233",
    rotation: 0,
    align: "left",
    font: {
      pdfName: "ABCDEF+Arial-BoldMT",
      family: "sans",
      bold: true,
      italic: false,
      subset: true,
      embedded: true,
      symbolic: false,
      type3: false,
    },
    editable: true,
    origHash: "abc",
  };

  it("blockToTextEdit cubre la caja original y hereda el estilo del bloque", () => {
    const edit = blockToTextEdit(block, { fontKey: "liberation-sans", cover: { color: "#ffffff", padding: 1 } });
    expect(edit.blockId).toBe("p0-b3");
    expect(edit.coverBox).toEqual(block.box);
    expect(edit.box).toEqual(block.box);
    expect(edit.box).not.toBe(block.box); // copia, no la caja del bloque
    expect(edit.text).toBe("Texto original");
    expect(edit.bold).toBe(true);
    expect(edit.fontSize).toBe(11);
  });

  it("editar un bloque existente: findEditForBlock lo localiza y cuenta como cambio aunque quede vacio", () => {
    const edit = blockToTextEdit(block, { fontKey: "helvetica", cover: { color: "#fff000", padding: 0 }, id: "e1" });
    let s = applyOp(createEditSession(), { type: "add", item: textItem(edit) }, 0);
    expect(findEditForBlock(s, "p0-b3")?.id).toBe("e1");
    expect(findEditForBlock(s, "otro")).toBeUndefined();
    s = applyOp(s, { type: "update", id: "e1", patch: { text: "" } }, 10_000);
    expect(pendingChangeCount(s)).toBe(1);
  });

  it("un texto NUEVO vacio no cuenta como cambio pendiente ni se exporta", () => {
    const s = applyOp(createEditSession(), add(textEdit("n1", { text: "   " })), 0);
    expect(pendingChangeCount(s)).toBe(0);
    expect(splitForExport(s).textEdits).toEqual([]);
  });

  it("move de texto suma el desplazamiento en espacio de usuario (y hacia arriba)", () => {
    let s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    s = applyOp(s, { type: "move", id: "t1", dx: 10, dy: 25 }, 10_000);
    expect((s.items[0] as { edit: TextEdit }).edit.box).toMatchObject({ x: 60, y: 725 });
  });

  it("move con valores no finitos se ignora", () => {
    const s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    expect(applyOp(s, { type: "move", id: "t1", dx: Number.NaN, dy: 1 }, 1)).toBe(s);
    expect(applyOp(s, { type: "move", id: "t1", dx: Infinity, dy: 1 }, 1)).toBe(s);
  });

  it("resize de texto fija la caja y nunca la deja con lado menor que 1 pt", () => {
    let s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    s = applyOp(s, { type: "resize", id: "t1", box: { x: 10, y: 20, width: 0, height: -5 } }, 10_000);
    expect((s.items[0] as { edit: TextEdit }).edit.box).toEqual({ x: 10, y: 20, width: 1, height: 1 });
  });

  it("restyle de texto toma solo claves validas e ignora las ajenas", () => {
    let s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    s = applyOp(
      s,
      {
        type: "restyle",
        id: "t1",
        patch: { color: "#ABCDEF", fontSize: -3, align: "right", fontKey: "nope" as never, strokeColor: "#000000" },
      },
    );
    const edit = (s.items[0] as { edit: TextEdit }).edit;
    expect(edit.color).toBe("#abcdef");
    expect(edit.align).toBe("right");
    expect(edit.fontSize).toBe(12); // -3 rechazado
    expect(edit.fontKey).toBe("helvetica");
  });

  it("restyle con solo basura no cambia nada (misma sesion)", () => {
    const s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    expect(applyOp(s, { type: "restyle", id: "t1", patch: { color: "rojo", bold: "si" as never } }, 5)).toBe(s);
  });

  it("restyle de cover cambia el color de relleno del fondo", () => {
    let s = applyOp(createEditSession(), add(textEdit("t1")), 0);
    s = applyOp(s, { type: "restyle", id: "t1", patch: { cover: { color: "#fefefe", padding: 2 } } }, 10_000);
    expect((s.items[0] as { edit: TextEdit }).edit.cover).toEqual({ color: "#fefefe", padding: 2 });
  });

  it("update de un item que no es texto no hace nada", () => {
    const s = applyOp(createEditSession(), { type: "add", item: shapeItem(rect("r1")) }, 0);
    expect(applyOp(s, { type: "update", id: "r1", patch: { text: "x" } }, 5)).toBe(s);
  });
});

describe("editSession — formas e imagenes (coordenadas normalizadas)", () => {
  it("move de una forma se recorta a la pagina", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(rect("r1")) }, 0);
    s = applyOp(s, { type: "move", id: "r1", dx: 5, dy: -5 }, 10_000);
    const el = (s.items[0] as { element: RectElement }).element;
    expect(el.x).toBeCloseTo(0.7);
    expect(el.y).toBe(0);
  });

  it("move de una linea desplaza ambos extremos con el mismo delta", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(line("l1")) }, 0);
    s = applyOp(s, { type: "move", id: "l1", dx: 0.1, dy: 0.1 }, 10_000);
    const el = (s.items[0] as { element: LineElement }).element;
    expect(el).toMatchObject({ x1: 0.2, x2: 0.6 });
    expect(el.y1).toBeCloseTo(0.3);
    expect(el.y2).toBeCloseTo(0.7);
  });

  it("move de una linea contra el borde no la deforma", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(line("l1")) }, 0);
    s = applyOp(s, { type: "move", id: "l1", dx: 5, dy: 0 }, 10_000);
    const el = (s.items[0] as { element: LineElement }).element;
    expect(el.x2).toBeCloseTo(1);
    expect(el.x2 - el.x1).toBeCloseTo(0.4);
  });

  it("resize de una forma recorta y respeta el lado minimo", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(rect("r1")) }, 0);
    s = applyOp(s, { type: "resize", id: "r1", box: { x: 0.9, y: 0.9, width: 0.5, height: 0 } }, 10_000);
    const el = (s.items[0] as { element: RectElement }).element;
    expect(el.x + el.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(el.height).toBeGreaterThan(0);
  });

  it("resize de una linea conserva su sentido", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(line("l1")) }, 0);
    s = applyOp(s, { type: "resize", id: "l1", box: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } }, 10_000);
    const el = (s.items[0] as { element: LineElement }).element;
    expect(el).toMatchObject({ x1: 0.2, y1: 0.2, x2: 0.7, y2: 0.7 });
  });

  it("restyle de formas: solo las claves de su tipo", () => {
    let s = applyOp(createEditSession(), { type: "add", item: shapeItem(rect("r1")) }, 0);
    s = applyOp(s, { type: "restyle", id: "r1", patch: { fill: true, fillOpacity: 9, opacity: 0.5, mark: "cross" } }, 10_000);
    const el = (s.items[0] as { element: RectElement & { opacity?: number; mark?: string } }).element;
    expect(el.fill).toBe(true);
    expect(el.fillOpacity).toBe(1); // recortado
    expect(el.opacity).toBeUndefined();
    expect(el.mark).toBeUndefined();
  });

  it("una imagen entra con sus bytes UNA vez en assets y los items solo llevan assetId", () => {
    const s = applyOp(createEditSession(), imageAddOp(image("im1")), 0);
    const item = s.items[0];
    expect(item.kind).toBe("image");
    expect(JSON.stringify(item)).not.toContain("previewUrl");
    expect(Object.keys(s.assets)).toEqual(["im1"]);
    expect(s.assets.im1.bytes).toBe(PNG);
    // Mover no duplica ni toca el asset.
    const moved = applyOp(s, { type: "move", id: "im1", dx: 0.1, dy: 0 }, 10_000);
    expect(moved.assets).toBe(s.assets);
  });

  it("una imagen sin asset ni bytes validos no entra", () => {
    const op = imageAddOp(image("im1"));
    const noAsset = { type: "add", item: (op as unknown as { item: never }).item } as EditOp;
    expect(applyOp(createEditSession(), noAsset, 0).items).toHaveLength(0);
    const tiny = imageAddOp(image("im2", new Uint8Array([1, 2])));
    expect(applyOp(createEditSession(), tiny, 0).items).toHaveLength(0);
  });

  it("el asset sobrevive a deshacer/rehacer y se descarta cuando ya no se puede rehacer", () => {
    let s = applyOp(createEditSession(), imageAddOp(image("im1")), 0);
    s = undo(s);
    expect(s.items).toHaveLength(0);
    expect(s.assets.im1).toBeDefined();
    s = redo(s);
    expect(s.items).toHaveLength(1);
    s = undo(s);
    s = applyOp(s, add(textEdit("t1")), 20_000); // descarta lo rehacible
    expect(s.assets.im1).toBeUndefined();
  });

  it("splitForExport reparte textos y elementos, y rehidrata los bytes de las imagenes", () => {
    const s = run(
      createEditSession(),
      [add(textEdit("t1"))],
      [{ type: "add", item: shapeItem(rect("r1")) }],
      [imageAddOp(image("im1", JPG))],
    );
    const { textEdits, elements } = splitForExport(s);
    expect(textEdits.map((t) => t.id)).toEqual(["t1"]);
    expect(elements.map((e) => e.type)).toEqual(["rect", "image"]);
    const img = elements[1] as ImageElement;
    expect(img.bytes).toBe(JPG);
    expect(img.previewUrl).toContain("data:");
    expect("assetId" in img).toBe(false);
  });
});

describe("editSession — seleccion, reset y contador", () => {
  it("selectItem no entra en el historial y un id desconocido deselecciona", () => {
    let s = run(createEditSession(), [add(textEdit("a"))], [add(textEdit("b"))]);
    const len = s.history.length;
    s = selectItem(s, "a");
    expect(s.selectedId).toBe("a");
    expect(s.history).toHaveLength(len);
    expect(selectItem(s, "a")).toBe(s);
    expect(selectItem(s, "zzz").selectedId).toBeNull();
    expect(selectItem(s, null).selectedId).toBeNull();
  });

  it("pendingChangeCount cuenta textos con contenido, bloques editados, formas e imagenes", () => {
    const s = run(
      createEditSession(),
      [add(textEdit("t1"))],
      [add(textEdit("t2", { text: "" }))],
      [add(textEdit("t3", { text: "", blockId: "p0-b1" }))],
      [{ type: "add", item: shapeItem(rect("r1")) }],
      [imageAddOp(image("im1"))],
    );
    expect(pendingChangeCount(s)).toBe(4);
  });

  it("resetSession vacia items, historial y seleccion; sobre una sesion vacia devuelve la misma", () => {
    const s = run(createEditSession(), [add(textEdit("a"))], [imageAddOp(image("im1"))]);
    const r = resetSession(s);
    expect(r.items).toEqual([]);
    expect(r.assets).toEqual({});
    expect(canUndo(r)).toBe(false);
    expect(r.selectedId).toBeNull();
    expect(resetSession(r)).toBe(r);
  });

  it("getItem devuelve el item o undefined", () => {
    const s = applyOp(createEditSession(), add(textEdit("a")), 0);
    expect(getItem(s, "a")?.kind).toBe("text");
    expect(getItem(s, "b")).toBeUndefined();
  });

  it("applyOp nunca lanza con ops basura", () => {
    const s = createEditSession();
    for (const op of [null, undefined, 3, "x", {}, { type: "wat" }, { type: "move" }, { type: "add" }]) {
      expect(() => applyOp(s, op as unknown as EditOp, 0)).not.toThrow();
      expect(applyOp(s, op as unknown as EditOp, 0)).toBe(s);
    }
    expect(applyOp(s, add(textEdit("a")), Number.NaN)).toBe(s);
  });
});

describe("editSession — JSON validado", () => {
  function fullSession() {
    return run(
      createEditSession(),
      [add(textEdit("t1", { blockId: "p0-b1", coverBox: { x: 1, y: 2, width: 3, height: 4 }, lineHeight: 1.4 }))],
      [{ type: "add", item: shapeItem(rect("r1")) }],
      [{ type: "add", item: shapeItem(line("l1")) }],
      [imageAddOp(image("im1"))],
    );
  }

  it("ida y vuelta conserva items y bytes de imagen, con historial vacio", () => {
    const s = fullSession();
    const json = editSessionToJSON(s);
    const wire = JSON.parse(JSON.stringify(json));
    const back = editSessionFromJSON(wire);
    expect(back.status).toBe("ok");
    expect(back.discarded).toBe(0);
    expect(back.session.items).toEqual(s.items);
    expect(Array.from(back.session.assets.im1.bytes)).toEqual(Array.from(PNG));
    expect(back.session.assets.im1.previewUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(canUndo(back.session)).toBe(false);
  });

  it("acepta tambien texto JSON y expone los alias toJSON/fromJSON", () => {
    const s = fullSession();
    const text = JSON.stringify(toJSON(s));
    expect(fromJSON(text).session.items).toHaveLength(4);
  });

  it("inlineAssets:false deja fuera los bytes y se rehidratan con assetBytes", () => {
    const s = fullSession();
    const json = editSessionToJSON(s, { inlineAssets: false });
    expect(json.assets.im1.data).toBeUndefined();
    expect(json.assets.im1.size).toBe(PNG.byteLength);
    const files = referencedAssets(s);
    expect(files.map((f) => f.assetId)).toEqual(["im1"]);
    const back = editSessionFromJSON(JSON.parse(JSON.stringify(json)), {
      assetBytes: { im1: files[0].bytes },
    });
    expect(back.session.items).toHaveLength(4);
    // Sin los bytes, la imagen se descarta (no queda una referencia rota).
    const without = editSessionFromJSON(JSON.parse(JSON.stringify(json)));
    expect(without.session.items).toHaveLength(3);
    expect(without.discarded).toBe(1);
    expect(without.status).toBe("partial");
  });

  it("serializar es barato: la codificacion base64 de un asset se cachea", () => {
    const s = fullSession();
    const a = editSessionToJSON(s).assets.im1.data;
    const b = editSessionToJSON(s).assets.im1.data;
    expect(a).toBe(b);
  });

  it("basura en la raiz devuelve una sesion vacia con status invalid, sin lanzar", () => {
    for (const raw of [null, undefined, 42, "no es json", "[]", [], {}, { schema: "1" }, { schema: 1 }, true]) {
      const result = editSessionFromJSON(raw);
      expect(result.session.items).toEqual([]);
      expect(result.status).toBe("invalid");
    }
  });

  it("un schema desconocido (mas nuevo) no se interpreta", () => {
    const result = editSessionFromJSON({ schema: 99, items: [] });
    expect(result.status).toBe("unsupported");
    expect(result.session.items).toEqual([]);
  });

  it("descarta los items invalidos y conserva los buenos", () => {
    const good = textItem(textEdit("ok"));
    const raw = {
      schema: 1,
      items: [
        good,
        null,
        7,
        "x",
        { kind: "text" },
        { kind: "text", id: "a", edit: { ...textEdit("a"), fontSize: -2 } },
        { kind: "text", id: "b", edit: { ...textEdit("b"), color: "rojo" } },
        { kind: "text", id: "c", edit: { ...textEdit("c"), box: { x: 0, y: 0, width: 0, height: 5 } } },
        { kind: "text", id: "d", edit: { ...textEdit("d"), fontKey: "comic-sans" } },
        { kind: "text", id: "e", edit: { ...textEdit("e"), pageIndex: -1 } },
        { kind: "text", id: "f", edit: { ...textEdit("f"), pageIndex: 1.5 } },
        { kind: "text", id: "g", edit: { ...textEdit("g"), text: 5 } },
        { kind: "shape", id: "s", element: { ...rect("s"), x: 7 } },
        { kind: "shape", id: "s2", element: { type: "triangle", id: "s2", pageIndex: 0 } },
        { kind: "shape", id: "s3", element: { ...rect("s3"), strokeColor: "red" } },
        { kind: "image", id: "i", element: { type: "image", id: "i", pageIndex: 0, x: 0, y: 0, width: 0.2, height: 0.2, ratio: 1, assetId: "../x" } },
        { kind: "video", id: "v" },
      ],
      assets: {},
    };
    const result = editSessionFromJSON(raw);
    expect(result.session.items.map((i) => i.id)).toEqual(["ok"]);
    expect(result.discarded).toBe(raw.items.length - 1);
    expect(result.status).toBe("partial");
  });

  it("descarta ids duplicados (queda el primero)", () => {
    const a1 = textItem(textEdit("dup", { text: "primero" }));
    const a2 = textItem(textEdit("dup", { text: "segundo" }));
    const result = editSessionFromJSON({ schema: 1, items: [a1, a2], assets: {} });
    expect(result.session.items).toHaveLength(1);
    expect((result.session.items[0] as { edit: TextEdit }).edit.text).toBe("primero");
    expect(result.discarded).toBe(1);
  });

  it("descarta los items de paginas que ya no existen cuando se conoce pageCount", () => {
    const raw = {
      schema: 1,
      items: [textItem(textEdit("a", { pageIndex: 0 })), textItem(textEdit("b", { pageIndex: 3 }))],
      assets: {},
    };
    const result = editSessionFromJSON(raw, { pageCount: 2 });
    expect(result.session.items.map((i) => i.id)).toEqual(["a"]);
    expect(result.discarded).toBe(1);
  });

  it("assets corruptos: base64 roto, tipo que no coincide con los bytes, id invalido", () => {
    const imageItem = {
      kind: "image",
      id: "i",
      element: { type: "image", id: "i", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2, ratio: 1, assetId: "a1" },
    };
    for (const assets of [
      { a1: { mime: "image/png", size: 3, data: "***no-base64***" } },
      { a1: { mime: "image/png", size: 3, data: "AAAA" } }, // bytes que no son PNG
      { a1: { mime: "image/gif", size: 3, data: "AAAA" } },
      { "../a1": { mime: "image/png", size: 1, data: "AAAA" } },
      { a1: null },
      "no-objeto",
    ]) {
      const result = editSessionFromJSON({ schema: 1, items: [imageItem], assets });
      expect(result.session.items).toEqual([]);
      expect(result.discarded).toBe(1);
    }
  });

  it("claves ajenas y __proto__ no contaminan los items reconstruidos", () => {
    const evil = JSON.parse(
      `{"schema":1,"items":[{"kind":"text","id":"x","extra":1,"edit":${JSON.stringify(textEdit("x"))},"__proto__":{"polluted":true}}],"assets":{}}`,
    );
    const result = editSessionFromJSON(evil);
    expect(result.session.items).toHaveLength(1);
    expect(Object.keys(result.session.items[0]).sort()).toEqual(["edit", "id", "kind"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("solo se serializan las imagenes que los items usan", () => {
    let s = fullSession();
    s = applyOp(s, imageAddOp(image("im2", JPG)), 90_000);
    s = applyOp(s, { type: "remove", id: "im2" }, 100_000);
    const json = editSessionToJSON(s);
    expect(Object.keys(json.assets)).toEqual(["im1"]);
  });
});
