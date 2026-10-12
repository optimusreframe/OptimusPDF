import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PagesTab, type PagesSelectionBridge } from "@/app/pdf-pro/pages/PagesTab";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { openRichDoc, renderWithDoc, withProviders } from "@/app/pdf-pro/pages/pagesTestUtils";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { pagesApplyOperation } from "@/app/pdf-pro/pages/pagesOperation";
import { PdfError } from "@/lib/pdf/core";
import { createProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { inspectPdf, makeRichPdf, marker } from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Organizador de paginas de PDF Pro en jsdom: motores REALES (pdf-lib), miniaturas de pdf.js
 * sustituidas por un documento falso. Cubre seleccion, edicion virtual, deshacer propio, aplicar
 * como UN snapshot, descartar, atajos, anuncios, foco y es/en.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const { PDFDocument: Doc } = await import("@cantoo/pdf-lib");
  return {
    ...actual,
    openPdfDocument: async (source: Uint8Array) => {
      const loaded = await Doc.load(source, { updateMetadata: false });
      return {
        numPages: loaded.getPageCount(),
        getPage: async (n: number) => ({ index: n - 1, cleanup: () => undefined }),
        loadingTask: { destroy: async () => undefined },
      };
    },
    renderPageToDataUrl: async (page: { index: number }) => `data:image/png;base64,${page.index}`,
    downloadBlob: () => undefined,
  };
});

const S = PRO_STRINGS.es.pages;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(options: Parameters<typeof openRichDoc>[0] = { pages: 5 }, bridge?: PagesSelectionBridge) {
  const { doc, bytes } = await openRichDoc(options);
  const utils = renderWithDoc(doc, <PagesTab bridge={bridge} />);
  await screen.findAllByRole("option");
  return { doc, bytes, ...utils };
}

const cardOf = (n: number) => screen.getByRole("option", { name: new RegExp(`^Página ${n} de`) });
const cards = () => screen.getAllByRole("option");
const labelOf = (name: string) => screen.getByRole("button", { name });
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key, ...init });
const selected = () =>
  cards()
    .filter((c) => c.getAttribute("aria-selected") === "true")
    .map((c) => Number(within(c).getAllByText(/^\d+$/)[0].textContent));
const order = (store: ReturnType<typeof getPagesStore>) =>
  store.getState().plan.map((entry) => (entry.kind === "existing" ? entry.sourceIndex + 1 : 0));
const chip = () => document.querySelector("[data-pages-chip]") as HTMLElement;
const aria = (el: HTMLElement) => el.getAttribute("aria-disabled");

async function apply(ctx: Setup) {
  fireEvent.click(labelOf(S.status.apply));
  await waitFor(() => expect(ctx.doc.getState().document?.snapshots.length).toBeGreaterThan(1));
}

async function snapshotInfo(ctx: Setup) {
  const bytes = ctx.doc.current() as Uint8Array;
  return inspectPdf(bytes);
}

describe("PagesTab: vista inicial", () => {
  it("pinta una tarjeta por pagina del documento, en orden", async () => {
    await setup({ pages: 6 });
    expect(cards()).toHaveLength(6);
    expect(cardOf(1).getAttribute("aria-posinset")).toBe("1");
    expect(cardOf(6).getAttribute("aria-posinset")).toBe("6");
  });

  it("sin cambios: chip «Sin cambios pendientes» y «Aplicar» desactivado (aria-disabled, sigue enfocable)", async () => {
    await setup();
    expect(chip().textContent).toBe(S.status.noChanges);
    const button = labelOf(S.status.apply);
    expect(aria(button)).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("deshacer y rehacer empiezan desactivados y no hay «Descartar»", async () => {
    await setup();
    expect(aria(labelOf(S.status.undo))).toBe("true");
    expect(aria(labelOf(S.status.redo))).toBe("true");
    expect(screen.queryByRole("button", { name: S.status.discard })).toBeNull();
  });

  it("las acciones de pagina estan desactivadas mientras no hay seleccion", async () => {
    await setup();
    for (const name of [S.actions.rotateLeft, S.actions.rotateRight, S.actions.remove, S.actions.duplicate, S.actions.moveBefore, S.actions.moveAfter]) {
      expect(aria(labelOf(name))).toBe("true");
    }
    expect(screen.getByText(S.status.none)).toBeTruthy();
  });

  it("la region tiene nombre y una sola cuadricula", async () => {
    await setup();
    expect(screen.getByRole("region", { name: S.panelTitle })).toBeTruthy();
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
  });

  it("no pinta la lista si el documento no esta abierto", () => {
    const { container } = render(withProviders(createProWorkingDoc(), <PagesTab />));
    expect(container.querySelector("[data-pages-tab]")).toBeNull();
  });
});

describe("PagesTab: seleccion", () => {
  it("clic selecciona y el contador lo dice", async () => {
    await setup({ pages: 6 });
    fireEvent.click(cardOf(2));
    expect(selected()).toEqual([2]);
    expect(screen.getByText(S.status.selected(1, 6))).toBeTruthy();
  });

  it("«Todas» selecciona todas, «Ninguna» las suelta", async () => {
    await setup({ pages: 4 });
    // En compacto estas acciones viven en «Más».
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectAll }));
    await waitFor(() => expect(selected()).toEqual([1, 2, 3, 4]));
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectNone }));
    await waitFor(() => expect(selected()).toEqual([]));
  });

  it("pares e impares se cuentan por la posicion que se ve", async () => {
    const ctx = await setup({ pages: 6 });
    const store = getPagesStore(ctx.doc);
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectEven }));
    await waitFor(() => expect(selected()).toEqual([2, 4, 6]));
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectOdd }));
    await waitFor(() => expect(selected()).toEqual([1, 3, 5]));
    expect(store.getState().selection.size).toBe(3);
  });

  it("Ctrl+A en la cuadricula selecciona todo", async () => {
    await setup({ pages: 5 });
    act(() => cardOf(1).focus());
    press(cardOf(1), "a", { ctrlKey: true });
    expect(selected()).toEqual([1, 2, 3, 4, 5]);
  });

  it("«Rango…» selecciona posiciones como 2-4, 6", async () => {
    await setup({ pages: 7 });
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectRange }));
    const input = await screen.findByLabelText(S.sheets.selectRangeLabel);
    fireEvent.change(input, { target: { value: "2-4, 6" } });
    fireEvent.click(screen.getByRole("button", { name: S.sheets.selectRangeSubmit }));
    await waitFor(() => expect(selected()).toEqual([2, 3, 4, 6]));
  });

  it("un rango invalido muestra el error y no cierra la hoja", async () => {
    await setup({ pages: 3 });
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectRange }));
    const input = await screen.findByLabelText(S.sheets.selectRangeLabel);
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: S.sheets.selectRangeSubmit }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 y 3");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("la seleccion se anuncia en la region viva unica", async () => {
    const ctx = await setup({ pages: 4 });
    fireEvent.click(cardOf(2));
    expect(ctx.doc.getState().announcement?.text).toBe(PRO_STRINGS.es.pages.announce.selected(1));
  });
});

describe("PagesTab: edicion virtual (sin tocar el documento)", () => {
  it("girar a la derecha: chip «1 cambio sin aplicar», insignia de 90° y el documento NO cambia", async () => {
    const ctx = await setup({ pages: 3 });
    const before = ctx.doc.getState().document!.snapshots.length;
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.rotateRight));
    expect(chip().textContent).toBe(S.status.changes(1));
    expect(cardOf(2).textContent).toContain("90°");
    expect(ctx.doc.getState().document!.snapshots.length).toBe(before);
    expect(ctx.doc.getState().dirty).toBe(false);
  });

  it("girar a la izquierda deja 270°; dos giros a la derecha suman 180°", async () => {
    await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateLeft));
    expect(cardOf(1).textContent).toContain("270°");
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.actions.rotateRight));
    // 270 + 90 + 90 = 450 = 90
    expect(cardOf(1).textContent).toContain("90°");
    fireEvent.click(labelOf(S.actions.rotateRight));
    expect(cardOf(1).textContent).toContain("180°");
  });

  it("eliminar quita las tarjetas seleccionadas y pasa el foco a una pagina", async () => {
    await setup({ pages: 5 });
    fireEvent.click(cardOf(2));
    fireEvent.click(cardOf(3), { ctrlKey: true });
    fireEvent.click(labelOf(S.actions.remove));
    expect(cards()).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.querySelector("[data-pages-tab]")!.contains(document.activeElement)).toBe(true);
  });

  it("no se pueden eliminar todas las paginas: se avisa y no cambia nada", async () => {
    const ctx = await setup({ pages: 2 });
    act(() => cardOf(1).focus());
    press(cardOf(1), "a", { ctrlKey: true });
    // El boton esta desactivado (aria-disabled) y el atajo avisa.
    expect(aria(labelOf(S.actions.remove))).toBe("true");
    press(cardOf(1), "Delete");
    expect(cards()).toHaveLength(2);
    expect(ctx.doc.getState().announcement?.text).toBe(S.announce.cannotRemoveAll);
  });

  it("Supr elimina la pagina enfocada aunque no haya seleccion", async () => {
    await setup({ pages: 4 });
    act(() => cardOf(3).focus());
    press(cardOf(3), "Delete");
    expect(cards()).toHaveLength(3);
  });

  it("R gira la pagina enfocada y D la duplica", async () => {
    await setup({ pages: 3 });
    act(() => cardOf(1).focus());
    press(cardOf(1), "r");
    expect(cardOf(1).textContent).toContain("90°");
    press(cardOf(1), "d");
    expect(cards()).toHaveLength(4);
  });

  it("duplicar pone la copia justo despues y la deja seleccionada", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.duplicate));
    expect(cards()).toHaveLength(4);
    expect(order(getPagesStore(ctx.doc))).toEqual([1, 2, 2, 3]);
    expect(selected()).toEqual([3]);
    expect(cardOf(3).textContent).toContain(S.card.copyOf(2));
  });

  it("mover antes / despues desplaza la seleccion una posicion", async () => {
    const ctx = await setup({ pages: 4 });
    const store = getPagesStore(ctx.doc);
    fireEvent.click(cardOf(3));
    fireEvent.click(labelOf(S.actions.moveBefore));
    expect(order(store)).toEqual([1, 3, 2, 4]);
    fireEvent.click(labelOf(S.actions.moveAfter));
    fireEvent.click(labelOf(S.actions.moveAfter));
    expect(order(store)).toEqual([1, 2, 4, 3]);
  });

  it("Ctrl+Mayus+flechas mueven las paginas seleccionadas con el teclado", async () => {
    const ctx = await setup({ pages: 4 });
    const store = getPagesStore(ctx.doc);
    act(() => cardOf(2).focus());
    press(cardOf(2), "Enter");
    press(cardOf(2), "ArrowRight", { ctrlKey: true, shiftKey: true });
    expect(order(store)).toEqual([1, 3, 2, 4]);
    press(document.activeElement as Element, "ArrowLeft", { ctrlKey: true, shiftKey: true });
    expect(order(store)).toEqual([1, 2, 3, 4]);
    expect(ctx.doc.getState().announcement?.text).toContain("movida");
  });

  it("arrastrar una tarjeta a otro hueco reordena (arrastre simulado)", async () => {
    const ctx = await setup({ pages: 6 });
    const store = getPagesStore(ctx.doc);
    const mouse = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 });
    // Con el contenedor sin medir, la cuadricula usa 360 px: 2 columnas.
    const first = cardOf(1) as HTMLElement;
    const x = parseFloat(first.style.left) + 10;
    const y = parseFloat(first.style.top) + 20;
    const target = cardOf(5) as HTMLElement;
    fireEvent.pointerDown(first, mouse(x, y));
    fireEvent.pointerMove(window, mouse(x + 40, y + 40));
    fireEvent.pointerMove(window, mouse(parseFloat(target.style.left) + 5, parseFloat(target.style.top) + 20));
    fireEvent.pointerUp(window, mouse(parseFloat(target.style.left) + 5, parseFloat(target.style.top) + 20));
    expect(order(store)).toEqual([2, 3, 4, 1, 5, 6]);
    expect(chip().textContent).toBe(S.status.changes(1));
  });

  it("al cambiar el plan, un cambio que se compensa vuelve a «Sin cambios»", async () => {
    await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.actions.rotateLeft));
    expect(chip().textContent).toBe(S.status.noChanges);
    expect(aria(labelOf(S.status.apply))).toBe("true");
  });
});

describe("PagesTab: deshacer y rehacer DENTRO del organizador", () => {
  it("el boton Deshacer revierte el ultimo cambio virtual y Rehacer lo repite", async () => {
    const ctx = await setup({ pages: 4 });
    const store = getPagesStore(ctx.doc);
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    expect(cards()).toHaveLength(3);
    fireEvent.click(labelOf(S.status.undo));
    expect(cards()).toHaveLength(4);
    expect(ctx.doc.getState().announcement?.text).toBe(S.announce.undone("Eliminar 1 página"));
    fireEvent.click(labelOf(S.status.redo));
    expect(cards()).toHaveLength(3);
    expect(store.getState().dirty).toBe(true);
  });

  it("Ctrl+Z / Ctrl+Mayus+Z / Ctrl+Y actuan sobre el plan y NO sobre el historial del documento", async () => {
    const ctx = await setup({ pages: 3 });
    // Un snapshot previo para comprobar que el global no se toca.
    await ctx.doc.commit(await makeRichPdf({ pages: 3 }), "previo", "operation", { pageCount: 3 });
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    const cursorBefore = ctx.doc.getState().document!.cursor;
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    expect(cardOf(1).textContent).not.toContain("90°");
    expect(ctx.doc.getState().document!.cursor).toBe(cursorBefore);
    fireEvent.keyDown(document, { key: "z", ctrlKey: true, shiftKey: true });
    expect(cardOf(1).textContent).toContain("90°");
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document, { key: "y", ctrlKey: true });
    expect(cardOf(1).textContent).toContain("90°");
  });

  it("con cambios pendientes el modo «pages» declara su propio deshacer (el global no actua)", async () => {
    const ctx = await setup({ pages: 3 });
    expect(ctx.doc.isOwnUndoActive()).toBe(false);
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    expect(ctx.doc.isOwnUndoActive()).toBe(true);
    expect(ctx.doc.getState().activeModes).toContain("pages");
  });

  it("cuando no queda nada que deshacer en el organizador, Ctrl+Z pasa al historial del documento", async () => {
    const ctx = await setup({ pages: 3 });
    await ctx.doc.commit(await makeRichPdf({ pages: 3, title: "v2" }), "v2", "operation", { pageCount: 3 });
    await waitFor(() => expect(ctx.doc.getState().document!.cursor).toBe(1));
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.status.undo));
    // Ahora past esta vacio pero future no: el modo sigue activo y Ctrl+Z delega.
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    await waitFor(() => expect(ctx.doc.getState().document!.cursor).toBe(0));
  });

  it("Ctrl+Z dentro de un campo de texto no toca el plan (es del propio campo)", async () => {
    await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectRange }));
    const input = await screen.findByLabelText(S.sheets.selectRangeLabel);
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(cardOf(1).textContent).toContain("90°");
  });
});

describe("PagesTab: aplicar crea UN snapshot", () => {
  it("girar + aplicar: un snapshot, etiqueta descriptiva, paginas giradas y plan reiniciado", async () => {
    const ctx = await setup({ pages: 3, title: "Informe" });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.rotateRight));
    await apply(ctx);
    const document = ctx.doc.getState().document!;
    expect(document.snapshots).toHaveLength(2);
    expect(document.snapshots[1].label).toBe("Girar 1 página");
    expect(document.snapshots[1].opId).toBe("pages-apply");
    const info = await snapshotInfo(ctx);
    expect(info.rotations).toEqual([0, 90, 0]);
    expect(info.title).toBe("Informe");
    await waitFor(() => expect(chip().textContent).toBe(S.status.noChanges));
    expect(cards()).toHaveLength(3);
  });

  it("reordenar y eliminar varias: UNA sola etiqueta «Reordenar N páginas, eliminar M páginas»", async () => {
    const ctx = await setup({ pages: 6 });
    fireEvent.click(cardOf(6));
    fireEvent.click(labelOf(S.actions.moveBefore));
    fireEvent.click(labelOf(S.actions.moveBefore));
    fireEvent.click(cardOf(1));
    fireEvent.click(cardOf(2), { ctrlKey: true });
    fireEvent.click(labelOf(S.actions.remove));
    await apply(ctx);
    const document = ctx.doc.getState().document!;
    expect(document.snapshots).toHaveLength(2);
    expect(document.snapshots[1].label).toBe("Reordenar 1 página, eliminar 2 páginas");
    const info = await snapshotInfo(ctx);
    expect(info.markers).toEqual([marker(2), marker(5), marker(3), marker(4)]);
    expect(info.pageCount).toBe(4);
  });

  it("el documento aplicado conserva metadatos, formulario y marcadores", async () => {
    const ctx = await setup({ pages: 4, title: "Mi libro", author: "Yo", form: true, outline: true });
    fireEvent.click(cardOf(4));
    fireEvent.click(labelOf(S.actions.moveBefore));
    await apply(ctx);
    const info = await snapshotInfo(ctx);
    expect(info.title).toBe("Mi libro");
    expect(info.author).toBe("Yo");
    expect(info.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3", "campo-4"]);
    expect(info.outlineTitles).toHaveLength(4);
    expect(info.markers).toEqual([marker(0), marker(1), marker(3), marker(2)]);
  });

  it("el recuento del snapshot es el de la salida y la pestana lo refleja", async () => {
    const ctx = await setup({ pages: 5 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.duplicate));
    await apply(ctx);
    expect(ctx.doc.getState().pageCount).toBe(6);
    await waitFor(() => expect(cards()).toHaveLength(6));
  });

  it("anuncia lo aplicado por la region viva del documento", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    await apply(ctx);
    expect(ctx.doc.getState().announcement?.text).toContain("Girar 1 página");
  });

  it("DESPUES de aplicar, Ctrl+Z global deshace TODO el cambio de paginas de una vez", async () => {
    const ctx = await setup({ pages: 4 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    await apply(ctx);
    expect(ctx.doc.getState().pageCount).toBe(3);
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    expect(ctx.doc.getState().document!.cursor).toBe(0);
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect((await inspectPdf(ctx.doc.current() as Uint8Array)).rotations).toEqual([0, 0, 0, 0]);
  });

  it("tras aplicar se puede organizar de nuevo con su propia pila", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(3));
    fireEvent.click(labelOf(S.actions.moveBefore));
    await apply(ctx);
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.remove));
    expect(chip().textContent).toBe(S.status.changes(1));
    await apply(ctx);
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(3);
    expect(ctx.doc.getState().pageCount).toBe(2);
  });

  it("el foco queda dentro de la pestana (nunca en <body>) tras aplicar", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.rotateRight));
    await apply(ctx);
    await waitFor(() => expect(document.querySelector("[data-pages-tab]")!.contains(document.activeElement)).toBe(true));
  });

  it("un plan que no cambia nada no se puede aplicar", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(labelOf(S.status.apply));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("no hay avisos del motor cuando no se perdio nada", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.rotateRight));
    await apply(ctx);
    expect(document.querySelector("[data-pages-notices]")).toBeNull();
  });

  it("al eliminar una pagina con marcador, el aviso del motor se muestra y se puede cerrar", async () => {
    const ctx = await setup({ pages: 4, outline: true });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    await apply(ctx);
    const notices = await screen.findByRole("region", { name: S.status.warningsTitle });
    expect(notices.textContent).toContain("1 marcadores");
    fireEvent.click(within(notices).getByRole("button", { name: S.status.dismissWarnings }));
    expect(document.querySelector("[data-pages-notices]")).toBeNull();
  });
});

/** Retiene el motor hasta soltar la puerta: el «mientras se aplica» pasa a ser determinista. */
function holdEngine() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = pagesApplyOperation.run.bind(pagesApplyOperation);
  vi.spyOn(pagesApplyOperation, "run").mockImplementation(async (...args) => {
    await gate;
    return original(...args);
  });
  return release;
}

describe("PagesTab: el documento cambia mientras se aplica", () => {
  it("un resultado que llega tarde (otro snapshot ya se confirmo) se descarta y se avisa; no se crea un snapshot de mas", async () => {
    const ctx = await setup({ pages: 6 });
    const release = holdEngine();
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.status.apply));
    await screen.findByRole("button", { name: S.status.cancel });
    // Mientras el motor trabaja, otra via confirma un snapshot distinto.
    await ctx.doc.commit(await makeRichPdf({ pages: 7 }), "otra cosa", "operation", { pageCount: 7 });
    release();
    await waitFor(() => expect(ctx.doc.getState().announcement?.text).toBe(S.announce.documentChanged), { timeout: 15_000 });
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(2);
    expect(ctx.doc.getState().document!.snapshots[1].label).toBe("otra cosa");
    await waitFor(() => expect(cards()).toHaveLength(7));
    expect(chip().textContent).toBe(S.status.noChanges);
  });

  it("cancelar mientras se aplica no crea snapshot y deja los cambios pendientes", async () => {
    const ctx = await setup({ pages: 5 });
    const release = holdEngine();
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.status.apply));
    fireEvent.click(await screen.findByRole("button", { name: S.status.cancel }));
    await waitFor(() => expect(screen.queryByRole("button", { name: S.status.cancel })).toBeNull());
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(1);
    expect(chip().textContent).toBe(S.status.changes(1));
  });

  it("mientras se aplica, el plan no se edita (botones desactivados, atajos y arrastre ignorados) y hay barra de progreso", async () => {
    const ctx = await setup({ pages: 5 });
    const release = holdEngine();
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.rotateRight));
    fireEvent.click(labelOf(S.status.apply));
    await screen.findByRole("button", { name: S.status.cancel });
    expect(labelOf(S.actions.remove).getAttribute("aria-disabled")).toBe("true");
    expect(labelOf(S.actions.rotateRight).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("progressbar")).toBeTruthy();
    act(() => cardOf(2).focus());
    press(cardOf(2), "Delete");
    press(cardOf(2), "r");
    expect(cards()).toHaveLength(5);
    expect(getPagesStore(ctx.doc).getState().past).toHaveLength(1);
    release();
    await waitFor(() => expect(ctx.doc.getState().document!.snapshots).toHaveLength(2));
  });

  it("un error del motor se muestra con su mensaje claro y los cambios siguen pendientes", async () => {
    const ctx = await setup({ pages: 4 });
    vi.spyOn(pagesApplyOperation, "run").mockRejectedValue(new PdfError("corrupt"));
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    fireEvent.click(labelOf(S.status.apply));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(S.status.errorTitle);
    expect(alert.textContent).toContain("dañado");
    expect(chip().textContent).toBe(S.status.changes(1));
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(1);
    expect(ctx.doc.getState().announcement?.text).toBe(S.announce.couldNotApply);
  });
});

describe("PagesTab: descartar y documento cambiado", () => {
  it("«Descartar cambios» pide confirmacion y vuelve al documento tal cual", async () => {
    const ctx = await setup({ pages: 4 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    fireEvent.click(labelOf(S.status.discard));
    fireEvent.click(await screen.findByRole("button", { name: S.status.discardConfirm }));
    await waitFor(() => expect(cards()).toHaveLength(4));
    expect(chip().textContent).toBe(S.status.noChanges);
    expect(ctx.doc.getState().announcement?.text).toBe(S.announce.discarded);
  });

  it("cancelar el descarte conserva los cambios", async () => {
    await setup({ pages: 4 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    fireEvent.click(labelOf(S.status.discard));
    fireEvent.click(await screen.findByRole("button", { name: S.status.keep }));
    expect(cards()).toHaveLength(3);
  });

  it("si el documento cambia por otro camino se descartan los cambios sin aplicar y se avisa", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.remove));
    await ctx.doc.commit(await makeRichPdf({ pages: 5 }), "otra cosa", "operation", { pageCount: 5 });
    await waitFor(() => expect(cards()).toHaveLength(5));
    expect(chip().textContent).toBe(S.status.noChanges);
    expect(ctx.doc.getState().announcement?.text).toBe(S.announce.documentChanged);
  });

  it("los cambios sin aplicar sobreviven a cambiar de pestana (desmontar y volver)", async () => {
    const ctx = await setup({ pages: 4 });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    cleanup();
    renderWithDoc(ctx.doc, <PagesTab />);
    await screen.findAllByRole("option");
    expect(cards()).toHaveLength(3);
    expect(chip().textContent).toBe(S.status.changes(1));
  });
});

describe("PagesTab: puente con el visor", () => {
  it("seleccionar en el organizador publica las paginas originales y, con una sola, lleva el visor a ella", async () => {
    const onSelectPages = vi.fn();
    const scrollToPage = vi.fn();
    await setup({ pages: 5 }, { onSelectPages, scrollToPage });
    fireEvent.click(cardOf(3));
    expect(onSelectPages).toHaveBeenLastCalledWith([2]);
    expect(scrollToPage).toHaveBeenCalledWith(2);
    fireEvent.click(cardOf(5), { ctrlKey: true });
    expect(onSelectPages).toHaveBeenLastCalledWith([2, 4]);
  });

  it("la seleccion del visor se refleja en las tarjetas mientras no hay cambios sin aplicar", async () => {
    const { doc } = await openRichDoc({ pages: 5 });
    const view = render(withProviders(doc, <PagesTab bridge={{ selectedPages: new Set<number>() }} />));
    await screen.findAllByRole("option");
    view.rerender(withProviders(doc, <PagesTab bridge={{ selectedPages: new Set([1, 3]) }} />));
    await waitFor(() => expect(selected()).toEqual([2, 4]));
  });

  it("con cambios sin aplicar no se publica la seleccion (el plan ya no coincide con el documento)", async () => {
    const onSelectPages = vi.fn();
    await setup({ pages: 4 }, { onSelectPages });
    fireEvent.click(cardOf(2));
    fireEvent.click(labelOf(S.actions.remove));
    onSelectPages.mockClear();
    fireEvent.click(cardOf(1));
    expect(onSelectPages).not.toHaveBeenCalled();
  });
});

describe("PagesTab: 500 paginas", () => {
  it("pinta unas decenas de tarjetas, selecciona todo, elimina las pares y aplica sin perder ninguna impar", async () => {
    const ctx = await setup({ pages: 500 });
    expect(cards().length).toBeLessThan(60);
    act(() => cards()[0].focus());
    press(cards()[0], "a", { ctrlKey: true });
    expect(getPagesStore(ctx.doc).getState().selection.size).toBe(500);
    // Mantener solo las impares: seleccionar las pares y borrarlas.
    fireEvent.click(labelOf(S.actions.more));
    fireEvent.click(await screen.findByRole("button", { name: S.actions.selectEven }));
    await waitFor(() => expect(getPagesStore(ctx.doc).getState().selection.size).toBe(250));
    act(() => cards()[0].focus());
    press(cards()[0], "Delete");
    expect(getPagesStore(ctx.doc).getState().plan).toHaveLength(250);
    fireEvent.click(labelOf(S.status.apply));
    await waitFor(() => expect(ctx.doc.getState().pageCount).toBe(250), { timeout: 20_000 });
    const info = await snapshotInfo(ctx);
    expect(info.markers.slice(0, 3)).toEqual([marker(0), marker(2), marker(4)]);
    expect(info.pageObjects).toBe(250);
  }, 40_000);
});

describe("PagesTab: documento de una sola pagina", () => {
  it("no deja eliminar la unica pagina", async () => {
    await setup({ pages: 1 });
    act(() => cardOf(1).focus());
    press(cardOf(1), "Delete");
    expect(cards()).toHaveLength(1);
  });
});
