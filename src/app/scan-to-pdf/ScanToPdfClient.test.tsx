import "fake-indexeddb/auto";
import { useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { __resetNavigationGuardForTests, interceptNavigation } from "@/lib/navigationGuard";
import { createFakeEngine, createFakeOcr, makeBarePage, newControls, type FakeEngine } from "@/lib/scan/testing/fakeEngine";
import { createFakeStore, type FakeStore } from "@/lib/scan/testing/fakeStore";
import { tinyJpegBytes, tinyJpegFile } from "@/lib/scan/testing/testImages";
import { DEFAULT_SCAN_SETTINGS, type ScanSession } from "@/lib/scan/types";
import { ScanToPdfClient } from "@/app/scan-to-pdf/ScanToPdfClient";
import { OCR_MODEL_MB, STRINGS } from "@/app/scan-to-pdf/strings";

/**
 * Interfaz del Escaner contra el MOTOR y el ALMACEN falsos inyectados con los ganchos de pruebas (como en el E2E). Sin canvas
 * (jsdom) el motor falso no tiene pixeles: las paginas son validas pero sin recorte; la logica de la interfaz se prueba igual.
 */
let engine: FakeEngine;
let store: FakeStore;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof window.matchMedia;
  // jsdom no calcula cajas: el foco solo se da a elementos pintados.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  let count = 0;
  URL.createObjectURL = () => `blob:test-${(count += 1)}`;
  URL.revokeObjectURL = () => {};
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  // jsdom: `Blob.arrayBuffer` (el PDF falso lee los bytes de las paginas).
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

beforeEach(() => {
  // jsdom no implementa el desplazamiento de la ventana (cada paso nuevo vuelve arriba): se anota, no se imprime.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  engine = createFakeEngine(newControls());
  store = createFakeStore({ backend: "memory" });
  globalThis.__optimusScanEngine = engine;
  globalThis.__optimusScanStore = store;
  globalThis.__optimusScanOcr = createFakeOcr(engine.controls);
});

afterEach(() => {
  delete globalThis.__optimusScanEngine;
  delete globalThis.__optimusScanStore;
  delete globalThis.__optimusScanOcr;
  __resetNavigationGuardForTests();
});

const es = STRINGS.es;
const en = STRINGS.en;

/** El idioma vive en un almacen del modulo: se cambia por el propio selector (`setLanguage`), no tocando localStorage. */
function SetLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}

function mount(language: Language = "es") {
  return render(
    <LanguageProvider>
      <SetLanguage language={language} />
      <ScanToPdfClient />
    </LanguageProvider>,
  );
}

function libraryInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[data-scan-input="library"]')!;
}

async function importFiles(names: string[]) {
  const files = names.map((name, index) => tinyJpegFile(name, 64, 80, index + 1));
  fireEvent.change(libraryInput(), { target: { files } });
  await waitFor(() => expect(document.querySelectorAll("[data-page-grid] [data-page-id]")).toHaveLength(names.length));
  await waitFor(() => expect(document.querySelectorAll("[data-tile-processing]")).toHaveLength(0));
}

const tiles = () => Array.from(document.querySelectorAll<HTMLElement>("[data-page-grid] [data-page-id]"));
const order = () => tiles().map((tile) => tile.getAttribute("data-page-id"));

describe("inicio", () => {
  it("un solo camino principal (camara), las fotos como alternativa, los modos y el resumen de privacidad", () => {
    mount();
    expect(screen.getAllByRole("button", { name: es.startButton })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: es.pickPhotos })).toHaveLength(1);
    const group = screen.getByRole("group", { name: es.modeLabel });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Documento", "Identificación", "Recibo", "Libro", "Pizarra", "Foto"]);
    expect(within(group).getByRole("button", { name: "Documento" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(es.privacy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /guardar pdf/i })).toBeNull();
  });

  it("en ingles todo esta traducido", async () => {
    mount("en");
    expect(await screen.findByRole("button", { name: en.startButton })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.pickPhotos })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ID card" })).toBeTruthy();
  });

  it("elegir un modo cambia su descripcion y se recuerda en este dispositivo", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Recibo" }));
    expect(document.querySelector("[data-mode-hint]")?.textContent).toBe(es.modes.receipt.hint);
    expect(JSON.parse(window.localStorage.getItem("optimuspdf.scan.prefs") ?? "{}").mode).toBe("receipt");
  });

  it("los dos inputs de archivo ocultos tienen nombre propio, estan fuera de Tab y fuera del arbol de accesibilidad", () => {
    mount();
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const input of inputs) {
      expect(input.getAttribute("aria-label")).toBeTruthy();
      expect(input.getAttribute("aria-hidden")).toBe("true");
      expect(input.tabIndex).toBe(-1);
    }
    expect(new Set(inputs.map((input) => input.getAttribute("aria-label"))).size).toBe(inputs.length);
    expect(libraryInput().multiple).toBe(true);
    expect(libraryInput().accept).toBe("image/*");
  });
});

describe("importar y revisar", () => {
  it("varias fotos a la vez: una tarjeta por foto, en el orden elegido, con nombre accesible «Pagina n de N»", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg", "c.jpg"]);
    expect(engine.controls.createLog).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(screen.getByRole("button", { name: "Página 1 de 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Página 3 de 3" })).toBeTruthy();
    // El motor procesa una foto a la vez.
    expect(engine.controls.peakConcurrent).toBe(1);
    expect(screen.getByRole("button", { name: es.save(3) })).toBeTruthy();
  });

  it("un archivo que no es imagen se omite con aviso y el resto sigue", async () => {
    mount();
    const files = [tinyJpegFile("a.jpg"), new File(["hola"], "nota.txt", { type: "text/plain" })];
    fireEvent.change(libraryInput(), { target: { files } });
    await waitFor(() => expect(tiles()).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("[data-scan-live]")?.textContent).toContain("nota.txt"));
    // El aviso nombra el archivo y dice por que no se anadio.
    const row = await waitFor(() => {
      const found = document.querySelector('[data-banner="import-problems"] [data-import-problem="notImage"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain("nota.txt");
    expect(row.textContent).toContain(es.importProblems.kinds.notImage);
  });

  it("chips de calidad con accion de un toque: «En blanco → Quitar» y «Quitar hojas en blanco»", async () => {
    mount();
    await importFiles(["a.jpg", "b-blank.jpg", "c.jpg", "d-blank.jpg"]);
    expect(document.querySelectorAll('[data-quality-chip="blank"]')).toHaveLength(2);
    expect(document.querySelector('[data-banner="blanks"]')?.textContent).toContain("2 hojas parecen estar en blanco");
    const ids = order();
    fireEvent.click(screen.getByRole("button", { name: "Página 2: En blanco. Quitar" }));
    expect(order()).toEqual([ids[0], ids[2], ids[3]]);
    fireEvent.click(screen.getByRole("button", { name: es.removeBlanks(1) }));
    expect(order()).toEqual([ids[0], ids[2]]);
    // Deshacer y rehacer.
    fireEvent.click(screen.getByRole("button", { name: es.undo }));
    expect(order()).toEqual([ids[0], ids[2], ids[3]]);
    fireEvent.click(screen.getByRole("button", { name: es.redo }));
    expect(order()).toEqual([ids[0], ids[2]]);
  });

  it("«Repetida → Quitar», «Borrosa» y «Sin documento» muestran su accion", async () => {
    mount();
    await importFiles(["a.jpg", "b-blurry.jpg", "c-dup.jpg", "d-nodoc.jpg"]);
    expect(screen.getByRole("button", { name: "Página 2: Borrosa. Repetir" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Página 3: Repetida. Quitar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Página 4: Sin documento detectado. Ajusta el recorte" })).toBeTruthy();
  });

  it("girar, duplicar y borrar con las acciones de la tarjeta; borrar es deshacible y se anuncia en la region viva", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg", "c.jpg"]);
    const ids = order();
    fireEvent.click(screen.getByRole("button", { name: "Girar la página 2" }));
    await waitFor(() => expect(engine.controls.calls.renderPage).toBeGreaterThanOrEqual(1));
    fireEvent.click(screen.getByRole("button", { name: "Más acciones de la página 1" }));
    fireEvent.click(await screen.findByRole("button", { name: es.duplicate }));
    await waitFor(() => expect(tiles()).toHaveLength(4));
    expect(order()[0]).toBe(ids[0]);
    expect(order()[2]).toBe(ids[1]);
    fireEvent.click(screen.getByRole("button", { name: "Borrar la página 3" }));
    expect(tiles()).toHaveLength(3);
    await waitFor(() => expect(document.querySelector("[data-scan-live]")?.textContent).toContain("1 página borrada"));
    fireEvent.click(screen.getByRole("button", { name: es.undo }));
    expect(tiles()).toHaveLength(4);
  });

  it("una sola region viva en toda la herramienta", async () => {
    mount();
    await importFiles(["a.jpg"]);
    expect(document.querySelectorAll("[role=status][aria-live]")).toHaveLength(1);
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  it("orientacion automatica: gira las de lado, avisa y el aviso se deshace", async () => {
    mount();
    await importFiles(["a.jpg", "b-sideways.jpg"]);
    await waitFor(() => expect(document.querySelector('[data-banner="orientation"]')?.textContent).toContain("Giramos 1 página que estaba de lado."));
    fireEvent.click(screen.getByRole("button", { name: es.orientationUndo }));
    expect(document.querySelector('[data-banner="orientation"]')).toBeNull();
  });

  it("seleccion multiple: la barra contextual borra lo marcado", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    const ids = order();
    fireEvent.click(screen.getByRole("button", { name: es.select }));
    fireEvent.click(screen.getByRole("button", { name: /Página 2 de 4/ }));
    fireEvent.click(screen.getByRole("button", { name: /Página 3 de 4/ }));
    expect(document.querySelector("[data-selected-count]")?.textContent).toBe("2 seleccionadas");
    fireEvent.click(screen.getByRole("button", { name: es.bulkDelete }));
    expect(order()).toEqual([ids[0], ids[3]]);
  });

  it("reordenar con el teclado desde el asa: flechas y UN solo paso de deshacer", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg", "c.jpg"]);
    const ids = order();
    const handle = () => document.querySelector<HTMLElement>(`[data-page-id="${ids[0]}"] [data-drag-handle]`)!;
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(order()).toEqual([ids[1], ids[2], ids[0]]);
    fireEvent.click(screen.getByRole("button", { name: es.undo }));
    expect(order()).toEqual(ids);
  });
});

describe("fotos que no se pueden anadir", () => {
  it("la que falla al procesarse se NOMBRA como danada, el plural es correcto y las demas siguen", async () => {
    mount();
    const files = [tinyJpegFile("a.jpg", 64, 80, 1), tinyJpegFile("roto-fail.jpg", 64, 80, 2), tinyJpegFile("c-fail.jpg", 64, 80, 3), tinyJpegFile("d.jpg", 64, 80, 4)];
    fireEvent.change(libraryInput(), { target: { files } });
    await waitFor(() => expect(document.querySelector('[data-banner="import-problems"]')).not.toBeNull(), { timeout: 8000 });
    await waitFor(() => expect(tiles()).toHaveLength(2));
    const banner = document.querySelector('[data-banner="import-problems"]')!;
    expect(banner.textContent).toContain(es.importProblems.title(2));
    expect(banner.textContent).toContain("roto-fail.jpg");
    expect(banner.textContent).toContain("c-fail.jpg");
    expect(banner.querySelectorAll('[data-import-problem="damaged"]')).toHaveLength(2);
    expect(banner.textContent).toContain(es.importProblems.kinds.damaged);
    // Cerrar el aviso lo quita.
    fireEvent.click(within(banner as HTMLElement).getByRole("button", { name: es.importProblems.dismiss }));
    expect(document.querySelector('[data-banner="import-problems"]')).toBeNull();
  });

  it("una foto HEIC que el navegador no lee se nombra como HEIC (no como danada)", async () => {
    mount();
    const heic = new File([new Uint8Array(40)], "IMG_0001-fail.HEIC", { type: "image/heic" });
    fireEvent.change(libraryInput(), { target: { files: [tinyJpegFile("a.jpg", 64, 80, 1), heic] } });
    await waitFor(() => expect(document.querySelector('[data-import-problem="heic"]')).not.toBeNull(), { timeout: 8000 });
    expect(document.querySelector('[data-import-problem="heic"]')?.textContent).toContain("IMG_0001-fail.HEIC");
    expect(document.querySelector('[data-import-problem="damaged"]')).toBeNull();
    expect(document.querySelector('[data-banner="import-problems"]')?.textContent).toContain(es.importProblems.title(1));
  });
});

describe("sin documento detectado", () => {
  it("el chip dice «Sin documento detectado · ajusta el recorte» y abre el ajuste de esquinas (con «Toda la foto»)", async () => {
    mount();
    await importFiles(["a.jpg", "c-nodoc.jpg"]);
    const chip = await screen.findByRole("button", { name: es.chipAction(2, es.quality.noDocument.label, es.quality.noDocument.action) }, { timeout: 8000 });
    expect(es.quality.noDocument.label).toBe("Sin documento detectado");
    fireEvent.click(chip);
    await waitFor(() => expect(document.querySelector("[data-corner-editor]")).not.toBeNull());
    expect(screen.getByRole("button", { name: es.cornersReset })).toBeTruthy();
  });
});

describe("guardado inmediato (stage / flush)", () => {
  it("cada cambio se APUNTA en el almacen al instante (sin esperar el autoguardado) y al salir se vuelca", async () => {
    const view = mount();
    await importFiles(["a.jpg", "b.jpg"]);
    const staged = store.controls.stageLog.length;
    expect(staged).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Girar la página 1" }));
    // Apuntado en el MISMO turno del cambio: antes de que pasen los 500 ms del autoguardado.
    expect(store.controls.stageLog.length).toBeGreaterThan(staged);
    const last = store.controls.stageLog[store.controls.stageLog.length - 1];
    expect(last.pages).toBe(2);
    expect(store.controls.calls.flush ?? 0).toBe(0);
    view.unmount();
    expect(store.controls.calls.flush).toBeGreaterThanOrEqual(1);
  });
});

describe("el escaner no se pudo cargar (sin red)", () => {
  it("importar: UN mensaje claro con «Reintentar», nunca «dañada», y al reintentar las fotos entran", async () => {
    engine.controls.engineUnavailable = true;
    mount();
    fireEvent.change(libraryInput(), { target: { files: [tinyJpegFile("a.jpg", 64, 80, 1), tinyJpegFile("b.jpg", 64, 80, 2)] } });
    const banner = await waitFor(() => {
      const found = document.querySelector('[data-banner="import-problems"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    }, { timeout: 8000 });
    expect(banner.textContent).toContain(es.importProblems.engineUnavailable);
    expect(banner.textContent).not.toMatch(/dañada|incompleta/i);
    expect(banner.querySelector('[data-import-problem]')).toBeNull();
    expect(tiles()).toHaveLength(0);
    // Vuelve la red: Reintentar procesa las DOS fotos.
    engine.controls.engineUnavailable = false;
    fireEvent.click(within(banner).getByRole("button", { name: es.importProblems.retry }));
    await waitFor(() => expect(tiles()).toHaveLength(2), { timeout: 8000 });
    expect(document.querySelector('[data-banner="import-problems"]')).toBeNull();
  });

  it("crear el PDF: mismo mensaje con «Reintentar» (no «No se pudo crear el PDF») y el reintento lo crea", async () => {
    mount();
    await importFiles(["a.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(1) }));
    engine.controls.engineUnavailable = true;
    fireEvent.click(await screen.findByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-save-error]")?.textContent).toBe(es.importProblems.engineUnavailable));
    engine.controls.engineUnavailable = false;
    fireEvent.click(screen.getByRole("button", { name: es.importProblems.retry }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
  });
});

describe("persistencia", () => {
  it("se guarda sola: la sesion esta en el almacen con sus paginas y «Guardado ✓» es visible", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg"]);
    await waitFor(() => expect(document.querySelector("[data-save-status]")?.textContent).toBe(es.statusSaved), { timeout: 5000 });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].pageCount).toBe(2);
  });

  it("una sesion que se queda sin paginas se borra del almacen (no queda un «escaneo sin terminar» vacio)", async () => {
    mount();
    await importFiles(["a.jpg"]);
    await waitFor(async () => expect(await store.list()).toHaveLength(1), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Borrar la página 1" }));
    await waitFor(async () => expect(await store.list()).toHaveLength(0), { timeout: 5000 });
    expect(screen.getByText(es.emptyTitle)).toBeTruthy();
  });

  it("«Retomar escaneo»: banner con nº de paginas; Retomar restaura y «Empezar de nuevo» borra tras confirmar", async () => {
    const saved: ScanSession = {
      id: "scan-prev-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: "Contrato",
      settings: DEFAULT_SCAN_SETTINGS,
      pages: [makeBarePage("p1"), makeBarePage("p2"), makeBarePage("p3")],
    };
    await store.save(saved);
    mount();
    const banner = await screen.findByRole("region", { name: es.resumeTitle });
    expect(banner.textContent).toContain("3 páginas");
    expect(banner.textContent).toContain("Contrato");
    fireEvent.click(within(banner).getByRole("button", { name: es.resumeAction }));
    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(order()).toEqual(["p1", "p2", "p3"]);
  });

  it("otra pestaña modifico la sesion: la copia de esta se guarda con otro id, con «(copia)» en el nombre y un aviso (Recientes no repite filas identicas)", async () => {
    await store.save({
      id: "scan-prev-fork",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: "Contrato",
      settings: DEFAULT_SCAN_SETTINGS,
      pages: [makeBarePage("p1"), makeBarePage("p2")],
    });
    mount();
    const banner = await screen.findByRole("region", { name: es.resumeTitle });
    fireEvent.click(within(banner).getByRole("button", { name: es.resumeAction }));
    await waitFor(() => expect(tiles()).toHaveLength(2));
    store.controls.forkNext = "scan-fork-0001";
    fireEvent.click(screen.getByRole("button", { name: "Borrar la página 2" }));
    await waitFor(async () => expect((await store.list()).map((item) => item.name).sort()).toEqual(["Contrato", "Contrato (copia)"]), { timeout: 8000 });
    await waitFor(() => expect(document.querySelector("[data-scan-live]")?.textContent).toContain(es.said.forked));
  });

  it("«Empezar de nuevo» pide confirmacion antes de borrar", async () => {
    await store.save({ id: "scan-prev-2", createdAt: "", updatedAt: new Date().toISOString(), name: "", settings: DEFAULT_SCAN_SETTINGS, pages: [makeBarePage("p1")] });
    mount();
    const banner = await screen.findByRole("region", { name: es.resumeTitle });
    fireEvent.click(within(banner).getByRole("button", { name: es.resumeDiscard }));
    fireEvent.click(await screen.findByRole("button", { name: es.resumeKeep }));
    expect(await store.list()).toHaveLength(1);
    fireEvent.click(within(banner).getByRole("button", { name: es.resumeDiscard }));
    fireEvent.click(await screen.findByRole("button", { name: es.resumeDiscardConfirm }));
    await waitFor(async () => expect(await store.list()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByRole("region", { name: es.resumeTitle })).toBeNull());
  });

  it("con `?scan=<id>` se restaura sola; un id que ya no existe lo dice y limpia la direccion", async () => {
    await store.save({ id: "scan-prev-3", createdAt: "", updatedAt: new Date().toISOString(), name: "", settings: DEFAULT_SCAN_SETTINGS, pages: [makeBarePage("p1"), makeBarePage("p2")] });
    window.history.replaceState(null, "", "/scan-to-pdf?scan=scan-prev-3");
    const first = mount();
    await waitFor(() => expect(tiles()).toHaveLength(2));
    first.unmount();
    window.history.replaceState(null, "", "/scan-to-pdf?scan=scan-no-existe");
    mount();
    expect(await screen.findByText(es.resumeGone)).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("si el almacen no puede guardar, lo dice (no guardado) y la hoja de salida avisa de que se perderia", async () => {
    store.controls.unavailable = true;
    mount();
    await importFiles(["a.jpg", "b.jpg"]);
    await waitFor(() => expect(document.querySelector("[data-save-status]")?.textContent).toBe(es.statusUnavailable), { timeout: 5000 });
    expect(document.querySelector('[data-banner="storage"]')).not.toBeNull();
    act(() => {
      interceptNavigation("/merge-pdf", () => {});
    });
    const dialog = await screen.findByRole("dialog", { name: es.leaveTitle });
    expect(dialog.textContent).toContain(es.leaveBodyUnsaved(2));
  });

  it("salir con un cambio pendiente del autoguardado: la hoja dice que las paginas quedan guardadas (no «se perderan»)", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Girar la página 1" }));
    // El cambio aun no llego al disco (autoguardado en 500 ms) pero `stage` lo apunta y se escribe al salir.
    expect(document.querySelector("[data-save-status]")?.getAttribute("data-save-status")).toBe("unsaved");
    act(() => {
      interceptNavigation("/merge-pdf", () => {});
    });
    const dialog = await screen.findByRole("dialog", { name: es.leaveTitle });
    expect(dialog.textContent).toContain(es.leaveBodySaved(2));
    expect(dialog.textContent).not.toMatch(/perder/);
  });

  it("al salir con todo guardado, la hoja lo dice y la opcion segura (seguir) es la primaria", async () => {
    mount();
    await importFiles(["a.jpg"]);
    await waitFor(() => expect(document.querySelector("[data-save-status]")?.textContent).toBe(es.statusSaved), { timeout: 5000 });
    act(() => {
      interceptNavigation("/merge-pdf", () => {});
    });
    const dialog = await screen.findByRole("dialog", { name: es.leaveTitle });
    expect(dialog.textContent).toContain(es.leaveBodySaved(1));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: es.leaveStay })).toBe(document.activeElement));
  });

  it("cuota llena: «No guardado: no hay espacio»", async () => {
    store.controls.quotaBytes = 1;
    mount();
    await importFiles(["a.jpg"]);
    await waitFor(() => expect(document.querySelector("[data-save-status]")?.textContent).toBe(es.statusQuota), { timeout: 5000 });
  });
});

describe("camara y guardar", () => {
  it("sin camara (jsdom no tiene getUserMedia): pantalla clara y «Elegir fotos» como camino principal que importa", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: es.startButton }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.cameraErrorTitle);
    const layer = alert.closest("[data-scan-layer]") as HTMLElement;
    expect(within(layer).getByRole("button", { name: es.pickPhotos })).toBeTruthy();
    expect(within(layer).getByRole("button", { name: es.retryCamera })).toBeTruthy();
  });

  it("guardar: nombre propuesto «Escaneo fecha hora», calidad con «≈», PDF con una pagina por hoja y «Antes → Despues»", async () => {
    mount();
    await importFiles(["a.jpg", "title-Contrato_de_servicio.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(2) }));
    const nameInput = await screen.findByLabelText(es.nameLabel);
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toMatch(/^Contrato de servicio · \d{4}-\d{2}-\d{2}$/));
    expect(document.querySelector("[data-image-quality-estimate]")?.textContent).toContain("≈");
    expect(screen.getByRole("tab", { name: "Equilibrada" }).getAttribute("aria-selected")).toBe("true");
    // El nombre editado manda.
    fireEvent.change(nameInput, { target: { value: "Siniestro 123" } });
    fireEvent.click(screen.getByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    expect(document.querySelector("[data-download-summary]")?.textContent).toMatch(/Tus fotos: .* → PDF: /);
    expect(screen.getByText("Siniestro 123.pdf")).toBeTruthy();
    expect(engine.controls.calls.buildPdf).toBe(1);
  });

  it("guardar con el texto buscable activado lo pasa al motor; la estimacion lo tiene en cuenta", async () => {
    const spy = vi.spyOn(engine, "estimateSize");
    mount();
    await importFiles(["a.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(1) }));
    fireEvent.click(await screen.findByRole("checkbox", { name: es.searchable }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ searchable: true })));
  });

  async function toSaveWithSearchable(names = ["a.jpg"]) {
    await importFiles(names);
    fireEvent.click(screen.getByRole("button", { name: es.save(names.length) }));
    fireEvent.click(await screen.findByRole("checkbox", { name: es.searchable }));
  }
  const downloadButton = () => document.querySelector<HTMLButtonElement>('[data-save-action="download-model"]');

  it("texto buscable: el texto NO promete «sin internet»; sin el modelo ofrece descargarlo (accion explicita), no descarga nada solo y crea un PDF normal con AVISO", async () => {
    mount();
    expect(es.searchableHint).not.toMatch(/sin internet/i);
    expect(en.searchableHint).not.toMatch(/without internet|offline/i);
    await importFiles(["a.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(1) }));
    const box = await screen.findByRole("checkbox", { name: es.searchable });
    expect(document.querySelector("[data-ocr-download]")).toBeNull();
    fireEvent.click(box);
    const note = await waitFor(() => {
      const found = document.querySelector("[data-ocr-download]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(note.textContent).toContain(es.searchableDownloadNote(OCR_MODEL_MB));
    expect(downloadButton()?.textContent).toBe(es.downloadModel(OCR_MODEL_MB));
    expect(document.querySelector("[data-create-meta]")?.textContent).toBe(es.createMetaNoModel);
    // Crear NO depende de la descarga: el PDF sale normal y el aviso del motor aparece en el resultado (no es un error).
    const create = screen.getByRole("button", { name: es.create }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    expect(document.querySelector("[data-download-notices]")?.textContent).toContain(es.searchableWarning({ code: "searchable-unavailable", reason: "model-missing", pagesWithText: 0, total: 1 }));
    expect(document.querySelector("[data-save-error]")).toBeNull();
    expect(engine.controls.calls.prepareOcrModel ?? 0).toBe(0);
    expect(engine.controls.calls.ocrUsed ?? 0).toBe(0);
  });

  it("«Descargar el modelo de texto»: llama a prepareOcrModel UNA vez, la nota desaparece y el PDF ya lleva texto (sin aviso)", async () => {
    mount();
    await toSaveWithSearchable();
    await waitFor(() => expect(downloadButton()).not.toBeNull());
    fireEvent.click(downloadButton()!);
    await waitFor(() => expect(document.querySelector("[data-ocr-download]")).toBeNull());
    expect(engine.controls.calls.prepareOcrModel).toBe(1);
    expect(document.querySelector("[data-create-meta]")?.textContent).not.toBe(es.createMetaNoModel);
    fireEvent.click(screen.getByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    expect(engine.controls.calls.ocrUsed).toBe(1);
    expect(document.querySelector("[data-download-notices]")).toBeNull();
  });

  it("la descarga del modelo falla sin conexion: lo dice (aviso, no error de pagina), se puede reintentar y crear sin texto", async () => {
    engine.controls.ocrPrepare = "offline";
    mount();
    await toSaveWithSearchable();
    await waitFor(() => expect(downloadButton()).not.toBeNull());
    fireEvent.click(downloadButton()!);
    await waitFor(() => expect(document.querySelector("[data-ocr-download-error]")?.textContent).toBe(es.modelFailed.offline));
    expect(downloadButton()?.disabled).toBe(false);
    expect(document.querySelector("[data-save-error]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    expect(document.querySelector("[data-download-notices]")?.textContent).toContain("falta el modelo de texto");
  });

  it("con el modelo ya en el dispositivo no se ofrece descargar nada y el PDF lleva texto", async () => {
    engine.controls.ocrAvailable = true;
    mount();
    await toSaveWithSearchable();
    await waitFor(() => expect(document.querySelector("[data-save-screen]")).not.toBeNull());
    expect(document.querySelector("[data-ocr-download]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    expect(engine.controls.calls.ocrUsed).toBe(1);
    expect(engine.controls.calls.prepareOcrModel ?? 0).toBe(0);
  });

  it("no se pregunta por el modelo (ni se hace nada de OCR) mientras el texto buscable esta desactivado", async () => {
    const spy = vi.spyOn(globalThis.__optimusScanOcr!, "ocrModelAvailable");
    mount();
    await importFiles(["a.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(1) }));
    await screen.findByRole("checkbox", { name: es.searchable });
    expect(spy).not.toHaveBeenCalled();
    expect(engine.controls.calls.prepareOcrModel ?? 0).toBe(0);
  });

  it("texto buscable que falla en el motor: dice por que, deja las paginas y ofrece crear el PDF sin texto", async () => {
    engine.controls.buildError = "ocr";
    mount();
    await toSaveWithSearchable();
    fireEvent.click(screen.getByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-save-error]")?.textContent).toBe(es.searchableFailed));
    engine.controls.buildError = null;
    fireEvent.click(screen.getByRole("button", { name: es.createWithoutText }));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
  });

  it("crear el PDF: la estimacion no se recalcula con cada cuadro del progreso y el foco va a «Cancelar»", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg", "c.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: es.save(3) }));
    const create = await screen.findByRole("button", { name: es.create });
    engine.controls.buildDelayMs = 60;
    const before = engine.controls.calls.estimateSize ?? 0;
    fireEvent.click(create);
    const cancel = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-processing-overlay] button");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await waitFor(() => expect(document.querySelector("[data-result]")).not.toBeNull(), { timeout: 15000 });
    // Tres hojas = tres cuadros de progreso: sin memoizar, la estimacion se repetia en cada uno.
    expect((engine.controls.calls.estimateSize ?? 0) - before).toBe(0);
  });

  it("un fallo del motor al crear el PDF deja las paginas y lo dice", async () => {
    mount();
    await importFiles(["a.jpg"]);
    engine.controls.buildError = "boom";
    fireEvent.click(screen.getByRole("button", { name: es.save(1) }));
    fireEvent.click(await screen.findByRole("button", { name: es.create }));
    await waitFor(() => expect(document.querySelector("[data-save-error]")?.textContent).toBe(es.buildFailed));
    fireEvent.click(screen.getByRole("button", { name: es.saveBack }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
  });

  it("cancelar la creacion vuelve al formulario con las paginas intactas", async () => {
    mount();
    await importFiles(["a.jpg", "b.jpg"]);
    engine.controls.buildDelayMs = 400;
    fireEvent.click(screen.getByRole("button", { name: es.save(2) }));
    fireEvent.click(await screen.findByRole("button", { name: es.create }));
    const cancel = await screen.findByRole("button", { name: /cancelar|cancel/i });
    fireEvent.click(cancel);
    await waitFor(() => expect(document.querySelector("[data-save-error]")?.textContent).toBe(es.buildCancelled));
    await waitFor(() => expect(document.querySelector("[data-scan-live]")?.textContent).toContain(es.buildCancelled));
  });
});

describe("regresion: acciones seguidas en el mismo turno", () => {
  it("dos importaciones consecutivas no se pisan (el estado se aplica al instante)", async () => {
    mount();
    const a = [tinyJpegFile("a1.jpg", 64, 80, 1), tinyJpegFile("a2.jpg", 64, 80, 2)];
    const b = [tinyJpegFile("b1.jpg", 64, 80, 3)];
    fireEvent.change(libraryInput(), { target: { files: a } });
    fireEvent.change(libraryInput(), { target: { files: b } });
    await waitFor(() => expect(tiles()).toHaveLength(3));
    await waitFor(() => expect(document.querySelectorAll("[data-tile-processing]")).toHaveLength(0));
    expect(engine.controls.createLog).toEqual(["a1.jpg", "a2.jpg", "b1.jpg"]);
  });

  it("la cola arranca aunque la importacion ocurra en cuanto monta la pagina (sin esperar a ningun efecto)", async () => {
    mount();
    fireEvent.change(libraryInput(), { target: { files: [tinyJpegFile("a.jpg")] } });
    await waitFor(() => expect(engine.controls.calls.createPage).toBe(1));
    void tinyJpegBytes;
  });
});
