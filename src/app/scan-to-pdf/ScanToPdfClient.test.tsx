import "fake-indexeddb/auto";
import { useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { __resetNavigationGuardForTests, interceptNavigation } from "@/lib/navigationGuard";
import { createFakeEngine, makeBarePage, newControls, type FakeEngine } from "@/lib/scan/testing/fakeEngine";
import { createFakeStore, type FakeStore } from "@/lib/scan/testing/fakeStore";
import { tinyJpegBytes, tinyJpegFile } from "@/lib/scan/testing/testImages";
import { DEFAULT_SCAN_SETTINGS, type ScanSession } from "@/lib/scan/types";
import { ScanToPdfClient } from "@/app/scan-to-pdf/ScanToPdfClient";
import { STRINGS } from "@/app/scan-to-pdf/strings";

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
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  engine = createFakeEngine(newControls());
  store = createFakeStore({ backend: "memory" });
  globalThis.__optimusScanEngine = engine;
  globalThis.__optimusScanStore = store;
});

afterEach(() => {
  delete globalThis.__optimusScanEngine;
  delete globalThis.__optimusScanStore;
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
    await waitFor(() => expect(document.querySelector("[data-scan-live]")?.textContent).toContain(es.notImage));
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
    expect(screen.getByRole("button", { name: "Página 4: Sin documento. Recortar" })).toBeTruthy();
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
