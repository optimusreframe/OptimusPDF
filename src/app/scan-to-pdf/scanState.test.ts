import { describe, expect, it } from "vitest";
import { makeBarePage } from "@/lib/scan/testing/fakeEngine";
import type { ScanPage } from "@/lib/scan/types";
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  blankPageIds,
  canRedo,
  canUndo,
  clearFlag,
  duplicatePages,
  emptyState,
  fileNameFor,
  insertPages,
  isSparse,
  sparsePageIds,
  movePages,
  normalizeRotation,
  proposeName,
  qualityKinds,
  removePages,
  renderKeyOf,
  replacePage,
  rotatePages,
  scanReducer,
  sessionFromState,
  setAdjustOn,
  setCornersOn,
  setFilterOn,
  shiftPages,
  stateFromSession,
  type ScanState,
} from "@/app/scan-to-pdf/scanState";

const ids = (pages: readonly ScanPage[]) => pages.map((page) => page.id);
const make = (...names: string[]) => names.map((name) => makeBarePage(name));

describe("operaciones sobre la lista", () => {
  it("movePages: mueve antes del hueco indicado, conserva el orden relativo de varias y topa en los extremos", () => {
    const pages = make("a", "b", "c", "d", "e");
    expect(ids(movePages(pages, ["a"], 3))).toEqual(["b", "c", "a", "d", "e"]);
    expect(ids(movePages(pages, ["e"], 0))).toEqual(["e", "a", "b", "c", "d"]);
    expect(ids(movePages(pages, ["b", "d"], 5))).toEqual(["a", "c", "e", "b", "d"]);
    expect(ids(movePages(pages, ["d", "b"], 0))).toEqual(["b", "d", "a", "c", "e"]);
    expect(ids(movePages(pages, ["c"], 99))).toEqual(["a", "b", "d", "e", "c"]);
    expect(ids(movePages(pages, ["c"], -4))).toEqual(["c", "a", "b", "d", "e"]);
    expect(ids(movePages(pages, [], 2))).toEqual(ids(pages));
    expect(ids(movePages(pages, ["zz"], 2))).toEqual(ids(pages));
  });

  it("movePages: soltar una pagina en su propio hueco no cambia nada", () => {
    const pages = make("a", "b", "c");
    expect(ids(movePages(pages, ["b"], 1))).toEqual(["a", "b", "c"]);
    expect(ids(movePages(pages, ["b"], 2))).toEqual(["a", "b", "c"]);
  });

  it("shiftPages: sube y baja sin saltarse a las demas; un grupo en el borde no se mueve", () => {
    const pages = make("a", "b", "c", "d");
    expect(ids(shiftPages(pages, ["b"], 1))).toEqual(["a", "c", "b", "d"]);
    expect(ids(shiftPages(pages, ["b"], -1))).toEqual(["b", "a", "c", "d"]);
    expect(ids(shiftPages(pages, ["a"], -1))).toEqual(["a", "b", "c", "d"]);
    expect(ids(shiftPages(pages, ["d"], 1))).toEqual(["a", "b", "c", "d"]);
    expect(ids(shiftPages(pages, ["b", "c"], 1))).toEqual(["a", "d", "b", "c"]);
    expect(ids(shiftPages(pages, ["a", "b"], 1))).toEqual(["c", "a", "b", "d"]);
    // Un grupo pegado al borde no se mueve NI se reordena por dentro (c y d ya estan al final).
    expect(ids(shiftPages(pages, ["c", "d"], 1))).toEqual(["a", "b", "c", "d"]);
    expect(ids(shiftPages(pages, ["a", "b"], -1))).toEqual(["a", "b", "c", "d"]);
  });

  it("removePages / insertPages / replacePage", () => {
    const pages = make("a", "b", "c");
    expect(ids(removePages(pages, ["b"]))).toEqual(["a", "c"]);
    expect(ids(removePages(pages, ["a", "b", "c"]))).toEqual([]);
    expect(ids(insertPages(pages, 1, make("x", "y")))).toEqual(["a", "x", "y", "b", "c"]);
    expect(ids(insertPages(pages, 99, make("z")))).toEqual(["a", "b", "c", "z"]);
    expect(ids(insertPages(pages, -3, make("z")))).toEqual(["z", "a", "b", "c"]);
    const replaced = replacePage(pages, "b", makeBarePage("b", { rotation: 90 }));
    expect(replaced[1].rotation).toBe(90);
    expect(replaced[0]).toBe(pages[0]);
  });

  it("duplicatePages: la copia va justo despues, con id nuevo, sin heredar «repetida»", () => {
    const pages = [makeBarePage("a"), makeBarePage("b", { flags: { duplicateOf: "a", blurry: true } }), makeBarePage("c")];
    let n = 0;
    const out = duplicatePages(pages, ["b"], () => `copy-${(n += 1)}`);
    expect(ids(out)).toEqual(["a", "b", "copy-1", "c"]);
    expect(out[2].flags).toEqual({ blurry: true });
    expect(out[1].flags.duplicateOf).toBe("a");
  });

  it("rotatePages normaliza a 0/90/180/270 en los dos sentidos", () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    const pages = make("a", "b");
    expect(rotatePages(pages, ["a"], 90)[0].rotation).toBe(90);
    expect(rotatePages(rotatePages(pages, ["a"], 90), ["a"], -180)[0].rotation).toBe(270);
    expect(rotatePages(pages, ["a"], 90)[1]).toBe(pages[1]);
  });

  it("filtro y ajustes solo tocan las paginas indicadas; el mismo filtro no crea una copia", () => {
    const pages = make("a", "b");
    const filtered = setFilterOn(pages, ["a"], "bw");
    expect(filtered[0].filter).toBe("bw");
    expect(filtered[1]).toBe(pages[1]);
    expect(setFilterOn(filtered, ["a"], "bw")[0]).toBe(filtered[0]);
    expect(setAdjustOn(pages, ["b"], { brightness: 0.4, contrast: -0.2 })[1].adjust).toEqual({ brightness: 0.4, contrast: -0.2 });
  });

  it("setCornersOn quita el aviso «Sin documento»", () => {
    const pages = [makeBarePage("a", { flags: { noDocument: true, blurry: true } })];
    const out = setCornersOn(pages, "a", { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 }, bottomLeft: { x: 0.1, y: 0.9 }, bottomRight: { x: 0.9, y: 0.9 } });
    expect(out[0].flags).toEqual({ blurry: true });
    expect(out[0].corners?.topLeft.x).toBe(0.1);
  });

  it("renderKeyOf cambia con giro, filtro, ajuste y esquinas, y no con lo demas", () => {
    const page = makeBarePage("a");
    const key = renderKeyOf(page);
    expect(renderKeyOf({ ...page, flags: { blank: true } })).toBe(key);
    expect(renderKeyOf({ ...page, rotation: 90 })).not.toBe(key);
    expect(renderKeyOf({ ...page, filter: "bw" })).not.toBe(key);
    expect(renderKeyOf({ ...page, adjust: { brightness: 0.1, contrast: 0 } })).not.toBe(key);
    expect(renderKeyOf({ ...page, corners: { topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 }, bottomLeft: { x: 0, y: 1 }, bottomRight: { x: 1, y: 1 } } })).not.toBe(key);
  });
});

describe("avisos de calidad", () => {
  it("orden de importancia y limpieza de uno", () => {
    expect(qualityKinds({ blurry: true, blank: true, duplicateOf: "x", glare: true, dark: true, noDocument: true })).toEqual(["blank", "duplicate", "blurry", "glare", "dark", "noDocument"]);
    expect(qualityKinds({})).toEqual([]);
    const pages = [makeBarePage("a", { flags: { blank: true, blurry: true } })];
    expect(clearFlag(pages, "a", "blank")[0].flags).toEqual({ blurry: true });
  });

  it("blankPageIds", () => {
    const pages = [makeBarePage("a"), makeBarePage("b", { flags: { blank: true } }), makeBarePage("c", { flags: { blank: true } })];
    expect(blankPageIds(pages)).toEqual(["b", "c"]);
  });
});

describe("estado con historial", () => {
  const start = (...names: string[]): ScanState => ({ ...emptyState("s1", "2026-01-01T00:00:00.000Z"), pages: make(...names) });

  it("commit + undo + redo; commit nuevo borra el futuro", () => {
    let state = start("a", "b", "c");
    state = scanReducer(state, { type: "commit", pages: removePages(state.pages, ["b"]), label: "borrar" });
    expect(ids(state.pages)).toEqual(["a", "c"]);
    expect(canUndo(state)).toBe(true);
    state = scanReducer(state, { type: "undo" });
    expect(ids(state.pages)).toEqual(["a", "b", "c"]);
    expect(canRedo(state)).toBe(true);
    state = scanReducer(state, { type: "redo" });
    expect(ids(state.pages)).toEqual(["a", "c"]);
    state = scanReducer(state, { type: "undo" });
    state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["a"], 90), label: "girar" });
    expect(canRedo(state)).toBe(false);
  });

  it("undo/redo sin historia no hace nada", () => {
    const state = start("a");
    expect(scanReducer(state, { type: "undo" })).toBe(state);
    expect(scanReducer(state, { type: "redo" })).toBe(state);
  });

  it("el historial se acota", () => {
    let state = start("a");
    for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["a"], 90), label: `g${i}` });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    // El tope es de decenas de pasos (no miles): cada paso guarda una lista de paginas.
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(20);
    expect(HISTORY_LIMIT).toBeLessThanOrEqual(100);
  });

  it("operaciones con la misma clave de fusion en pocos segundos = UN paso de deshacer; pasado el plazo, otro", () => {
    let state = start("a", "b", "c");
    const t = 1_000_000;
    state = scanReducer(state, { type: "commit", pages: shiftPages(state.pages, ["a"], 1), label: "mover", coalesce: { key: "move:a", at: t } });
    state = scanReducer(state, { type: "commit", pages: shiftPages(state.pages, ["a"], 1), label: "mover", coalesce: { key: "move:a", at: t + 500 } });
    expect(ids(state.pages)).toEqual(["b", "c", "a"]);
    expect(state.past).toHaveLength(1);
    state = scanReducer(state, { type: "commit", pages: shiftPages(state.pages, ["a"], -1), label: "mover", coalesce: { key: "move:a", at: t + 500 + COALESCE_MS + 10 } });
    expect(state.past).toHaveLength(2);
    state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["b"], 90), label: "girar", coalesce: { key: "rotate:b", at: t + 5000 } });
    expect(state.past).toHaveLength(3);
    // Una sola vez deshace los dos primeros movimientos fusionados.
    state = scanReducer(scanReducer(scanReducer(state, { type: "undo" }), { type: "undo" }), { type: "undo" });
    expect(ids(state.pages)).toEqual(["a", "b", "c"]);
  });

  it("resolve sustituye la pagina reservada en el presente y en TODO el historial, conservando el id", () => {
    let state = start("a", "p1");
    state = { ...state, pendingIds: ["p1"] };
    state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["a"], 90), label: "girar" });
    const real = makeBarePage("engine-id", { originalWidth: 1000, thumb: new Blob(["t"]) });
    state = scanReducer(state, { type: "resolve", id: "p1", page: real });
    expect(state.pages[1].id).toBe("p1");
    expect(state.pages[1].originalWidth).toBe(1000);
    expect(state.past[0].pages[1].originalWidth).toBe(1000);
    expect(state.pendingIds).toEqual([]);
  });

  it("discard quita la pagina de todas partes", () => {
    let state = start("a", "p1");
    state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["a"], 90), label: "girar" });
    state = scanReducer(state, { type: "discard", id: "p1" });
    expect(ids(state.pages)).toEqual(["a"]);
    expect(ids(state.past[0].pages)).toEqual(["a"]);
  });

  it("rendered solo aplica a la pagina cuya clave coincide (un recalculo viejo no pisa uno nuevo) y tambien al historial", () => {
    let state = start("a");
    const k0 = renderKeyOf(state.pages[0]);
    state = scanReducer(state, { type: "commit", pages: rotatePages(state.pages, ["a"], 90), label: "girar" });
    const k1 = renderKeyOf(state.pages[0]);
    const old = new Blob(["old"]);
    const fresh = new Blob(["fresh"]);
    state = scanReducer(state, { type: "rendered", id: "a", key: k0, processed: old, thumb: old });
    expect(state.pages[0].thumb).not.toBe(old);
    expect(state.past[0].pages[0].thumb).toBe(old);
    state = scanReducer(state, { type: "rendered", id: "a", key: k1, processed: fresh, thumb: fresh });
    expect(state.pages[0].thumb).toBe(fresh);
    const unchanged = scanReducer(state, { type: "rendered", id: "nope", key: k1, processed: fresh, thumb: fresh });
    expect(unchanged).toBe(state);
  });

  it("flags: aplica avisos y no crea un estado nuevo si no cambian", () => {
    let state = start("a", "b");
    state = scanReducer(state, { type: "flags", flags: { a: { blank: true }, b: { duplicateOf: "a" } } });
    expect(state.pages[0].flags.blank).toBe(true);
    expect(state.pages[1].flags.duplicateOf).toBe("a");
    expect(scanReducer(state, { type: "flags", flags: { a: { blank: true }, b: { duplicateOf: "a" } } })).toBe(state);
  });

  it("nombre, ajustes y sesion: ida y vuelta", () => {
    let state = start("a");
    state = scanReducer(state, { type: "name", name: "Mi contrato", edited: true });
    state = scanReducer(state, { type: "settings", patch: { searchable: true, mode: "receipt" } });
    const session = sessionFromState(state, "2026-02-02T00:00:00.000Z");
    expect(session.name).toBe("Mi contrato");
    expect(session.settings.searchable).toBe(true);
    const back = stateFromSession(session);
    expect(back.nameEdited).toBe(true);
    expect(back.settings.mode).toBe("receipt");
    expect(back.past).toEqual([]);
  });

  it("fork: otra pestana modifico la sesion, esta sigue con otro id y sin tocar las paginas ni el historial", () => {
    let state = start("a", "b");
    state = scanReducer(state, { type: "commit", pages: removePages(state.pages, ["b"]), label: "borrar" });
    const forked = scanReducer(state, { type: "fork", id: "scan-copia-1" });
    expect(forked.id).toBe("scan-copia-1");
    expect(forked.pages).toBe(state.pages);
    expect(forked.past).toBe(state.past);
    expect(scanReducer(forked, { type: "fork", id: "scan-copia-1" })).toBe(forked);
  });

  it("deshacer una pagina aun reservada la quita de las pendientes", () => {
    let state = start("a");
    const holder = makeBarePage("p1");
    state = scanReducer(state, { type: "commit", pages: insertPages(state.pages, 1, [holder]), label: "añadir", pending: ["p1"] });
    expect(state.pendingIds).toEqual(["p1"]);
    state = scanReducer(state, { type: "undo" });
    expect(state.pendingIds).toEqual([]);
  });
});

describe("nombre propuesto", () => {
  const now = new Date(2026, 9, 26, 14, 32);
  it("con titulo reconocido: «Titulo · fecha»", () => {
    expect(proposeName({ title: "Contrato de servicio", date: "2026-10-26", source: "ocr" }, "es", now)).toBe("Contrato de servicio · 2026-10-26");
    // La fecha que trae el documento manda sobre la de hoy.
    expect(proposeName({ title: "Contrato de servicio", date: "2026-10-20", source: "ocr" }, "es", now)).toBe("Contrato de servicio · 2026-10-20");
    expect(proposeName({ title: "Contrato de servicio", date: null, source: "ocr" }, "es", now)).toBe("Contrato de servicio · 2026-10-26");
  });
  it("sin titulo: «Escaneo fecha hora» (ES) / «Scan ...» (EN)", () => {
    expect(proposeName({ title: null, date: "2026-10-26", source: "date" }, "es", now)).toBe("Escaneo 2026-10-26 14:32");
    expect(proposeName(undefined, "en", now)).toBe("Scan 2026-10-26 14:32");
    expect(proposeName({ title: "   ", date: null, source: "ocr" }, "es", now)).toBe("Escaneo 2026-10-26 14:32");
  });
  it("nombre de archivo seguro", () => {
    expect(fileNameFor("Contrato / servicio: 2026?", "Escaneo")).toBe("Contrato servicio 2026.pdf");
    expect(fileNameFor("   ", "Escaneo")).toBe("Escaneo.pdf");
    // Sin doble extension: la persona ya la escribio (en cualquier mayuscula) o el nombre solo era «.pdf».
    expect(fileNameFor("Contrato.pdf", "Escaneo")).toBe("Contrato.pdf");
    expect(fileNameFor("Contrato.PDF ", "Escaneo")).toBe("Contrato.pdf");
    expect(fileNameFor("Contrato.pdf.pdf", "Escaneo")).toBe("Contrato.pdf");
    expect(fileNameFor(".pdf", "Escaneo")).toBe("Escaneo.pdf");
    expect(fileNameFor("informe.pdfx", "Escaneo")).toBe("informe.pdfx.pdf");
    expect(fileNameFor("a".repeat(300), "x").length).toBe(124);
  });
});

describe("«casi vacia» (flags.sparse, aditivo del motor)", () => {
  const sparse = { sparse: true } as unknown as ScanPage["flags"];
  it("solo cuenta si el motor lo trae y nunca junto a «en blanco»", () => {
    expect(isSparse({})).toBe(false);
    expect(isSparse(sparse)).toBe(true);
    expect(isSparse({ ...sparse, blank: true })).toBe(false);
    expect(qualityKinds(sparse)).toEqual(["sparse"]);
    expect(qualityKinds({ blank: true, ...sparse })).toEqual(["blank"]);
    expect(qualityKinds({})).toEqual([]);
  });

  it("sparsePageIds y clearFlag", () => {
    const pages = [makeBarePage("a"), { ...makeBarePage("b"), flags: sparse }, { ...makeBarePage("c"), flags: { blank: true } }];
    expect(sparsePageIds(pages)).toEqual(["b"]);
    expect(blankPageIds(pages)).toEqual(["c"]);
    const cleared = clearFlag(pages, "b", "sparse");
    expect(isSparse(cleared[1].flags)).toBe(false);
  });

  it("el analisis que cambia SOLO `sparse` se aplica a la pagina", () => {
    const state = stateFromSession({ id: "scan-test-0001", createdAt: "", updatedAt: "", name: "", settings: { mode: "document", filter: "auto" } as never, pages: [makeBarePage("a")] } as never);
    const next = scanReducer(state, { type: "flags", flags: { a: sparse } });
    expect(isSparse(next.pages[0].flags)).toBe(true);
  });
});
