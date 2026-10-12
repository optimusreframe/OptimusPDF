import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { ProSuite } from "@/app/pdf-pro/ProSuite";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff, setHandoff } from "@/app/pdf-pro/proHandoff";
import { __resetProFeatureFlagsCacheForTests, setProFeatureFlag } from "@/app/pdf-pro/proFeatureFlags";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
  saveProDraft,
} from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { fakeDoc, fakeFile, makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { __clearRegisteredCommandsForTests } from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests } from "@/app/pdf-pro/shell/proActions";
import { __clearDraftThumbnailCacheForTests } from "@/app/pdf-pro/session/useDraftThumbnails";
import { clearRecentEntries } from "@/lib/recent";
import { es } from "@/lib/locales/es";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { installLayoutEnv, pdfMocks, resetViewerGlobals, settle, type LayoutEnv } from "@/app/pdf-pro/viewer/viewerTestUtils";

/**
 * Sesion de PDF Pro (U8): estado vacio con acciones y recientes, nuevo en blanco, menus de guardar y crear,
 * atajos Ctrl+S / Ctrl+Mayus+S, aviso al cerrar la pestaña SOLO con cambios que el borrador no cubre, cambiar de
 * documento con confirmacion, errores de «Abrir otro» y avisos de tamaño/memoria. pdf.js se simula.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
    openPdfDocument: utils.pdfMocks.open,
    closePdfDocument: utils.pdfMocks.close,
    renderPageToDataUrl: utils.pdfMocks.thumb,
  };
});
vi.mock("@/lib/pdf/pageRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/pageRaster")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, renderPageRaster: utils.pdfMocks.render };
});
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => "data:image/png;base64,AAAA") }));

const S = PRO_STRINGS.es;
let env: LayoutEnv;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 1100, height: 700 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  __clearDraftThumbnailCacheForTests();
  await clearAllProDrafts();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
});

afterEach(() => {
  cleanup();
  env.restore();
  vi.unstubAllGlobals();
  resetReducedMotionPrefCache();
  document.documentElement.removeAttribute("data-pro-suite");
});

function renderPro() {
  return render(
    <LanguageProvider>
      <ProToolClient />
    </LanguageProvider>,
  );
}
const dropzoneInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

async function openPro(pages = 3, name = "informe.pdf") {
  pdfMocks.state.defaultPages = pages;
  const utils = renderPro();
  fireEvent.change(dropzoneInput(utils.container), { target: { files: [pdfFile(await makePdfBytes(pages), name)] } });
  await screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });
  await settle();
  return utils;
}

const rotate = async () => {
  fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
  await screen.findByText(S.suite.unsaved);
};

const idOf = (n: number) => n.toString(16).padStart(64, "0");
async function seedDraft(n: number, patch: { fileName?: string; savedStepCount?: number } = {}) {
  const result = await saveProDraft({
    id: idOf(n),
    fileName: patch.fileName ?? `reciente-${n}.pdf`,
    bytes: await makePdfBytes(2),
    snapshotId: `snap-${n}`,
    history: [
      { label: "Original", createdAt: 1, source: "open" },
      { label: "Rotar", createdAt: 2, source: "operation" },
    ],
    pageCount: 2,
    currentPage: 0,
  });
  expect(result.ok).toBe(true);
}

describe("estado vacio: crear y retomar", () => {
  it("ofrece «Nuevo desde imágenes» y «Nuevo en blanco»", () => {
    renderPro();
    const start = document.querySelector("[data-pro-start]")!;
    expect(within(start as HTMLElement).getByRole("button", { name: S.session.newFromImages })).toBeTruthy();
    expect(within(start as HTMLElement).getByRole("button", { name: S.session.newBlank })).toBeTruthy();
    expect(within(start as HTMLElement).queryByRole("button", { name: S.session.openLast })).toBeNull();
  });

  it("«Nuevo en blanco» crea el documento y abre la suite con su nombre y una pagina", async () => {
    pdfMocks.state.defaultPages = 1;
    renderPro();
    fireEvent.click(screen.getByRole("button", { name: S.session.newBlank }));
    fireEvent.click(await screen.findByRole("button", { name: S.create.blank.create }));
    expect(await screen.findByRole("heading", { level: 1, name: new RegExp(S.create.blank.fileName.replace(".", "\\.")) })).toBeTruthy();
    expect(screen.getAllByText("1 página").length).toBeGreaterThan(0);
    expect(screen.getByRole("tablist")).toBeTruthy();
    // Un documento nuevo no viene de ninguna herramienta ni tiene cambios sin guardar.
    expect(screen.queryByText(/Abierto desde/)).toBeNull();
    expect(screen.getByText(S.suite.saved)).toBeTruthy();
  });

  it("«Nuevo desde imágenes» abre el selector de imágenes", () => {
    renderPro();
    const picker = document.querySelector<HTMLInputElement>("[data-pro-create-input]")!;
    const click = vi.spyOn(picker, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: S.session.newFromImages }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("con borradores guardados: «Reabrir el último» y la lista con nombre, fecha, cambios y peso", async () => {
    await seedDraft(1, { fileName: "antiguo.pdf" });
    await seedDraft(2, { fileName: "ultimo.pdf" });
    renderPro();
    const reopen = await screen.findByRole("button", { name: S.session.openLast });
    expect(reopen.getAttribute("title")).toContain("ultimo.pdf");
    const list = document.querySelector("[data-recent-list]") as HTMLElement;
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("ultimo.pdf");
    expect(items[0].textContent).toContain("2 páginas");
    expect(items[0].textContent).toContain(S.empty.recentDraftNote(1, "").split("·")[0].trim().slice(0, 4));
  });

  it("«Reabrir el último» abre el borrador mas reciente", async () => {
    await seedDraft(1, { fileName: "antiguo.pdf" });
    await seedDraft(2, { fileName: "ultimo.pdf" });
    pdfMocks.state.defaultPages = 2;
    renderPro();
    fireEvent.click(await screen.findByRole("button", { name: S.session.openLast }));
    expect(await screen.findByRole("heading", { level: 1, name: /ultimo\.pdf/ })).toBeTruthy();
  });

  it("cada reciente muestra una miniatura de su primera pagina cuando se puede dibujar", async () => {
    await seedDraft(3);
    renderPro();
    await waitFor(() => expect(document.querySelector("[data-recent-thumb]")).not.toBeNull());
    expect((document.querySelector("[data-recent-thumb]") as HTMLImageElement).alt).toBe("");
  });

  it("abrir un reciente concreto por su boton", async () => {
    await seedDraft(4, { fileName: "elegido.pdf" });
    pdfMocks.state.defaultPages = 2;
    renderPro();
    fireEvent.click(await screen.findByRole("button", { name: S.empty.recentOpen("elegido.pdf") }));
    expect(await screen.findByRole("heading", { level: 1, name: /elegido\.pdf/ })).toBeTruthy();
  });
});

describe("menus y atajos de la suite", () => {
  it("el menu «Guardar y exportar» ofrece descargar, guardar como, con contraseña y exportar", async () => {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.save.menuLabel }));
    const items = within(screen.getByRole("menu", { name: S.save.menuLabel })).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining(S.save.downloadPdf),
      expect.stringContaining(S.save.saveAs),
      expect.stringContaining(S.save.saveWithPassword),
      expect.stringContaining(S.save.exportAs),
    ]);
    expect(items[0].textContent).toContain("Ctrl/⌘ S");
  });

  it("«Exportar como…» lleva a la pestaña Convertir", async () => {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.save.menuLabel }));
    fireEvent.click(screen.getByRole("menuitem", { name: S.save.exportAs }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Convertir" }).getAttribute("aria-selected")).toBe("true"));
    expect(document.querySelector("[data-doc-tab='convert']")).not.toBeNull();
  });

  it("el menu «Más» agrega abrir otro, nuevo desde imagenes, nuevo en blanco, insertar, unir y recientes", async () => {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    const labels = within(screen.getByRole("menu", { name: S.shell.more })).getAllByRole("menuitem").map((item) => item.textContent ?? "");
    for (const label of [
      S.create.menu.openAnother,
      S.create.menu.newFromImages,
      S.create.menu.newBlank,
      S.create.menu.insertConvert,
      S.create.menu.mergePdfs,
      S.create.menu.recents,
      S.shell.exportItem,
    ]) {
      expect(labels.some((text) => text.includes(label)), label).toBe(true);
    }
  });

  it("«Unir PDFs…» enlaza con la pestaña Páginas", async () => {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: S.create.menu.mergePdfs }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Páginas" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("Ctrl+S descarga el PDF sin pasar por ningun menu", async () => {
    await openPro(2, "contrato.pdf");
    await rotate();
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
    expect(downloaded.blobs[0].name).toBe("contrato-pro.pdf");
    expect(screen.getByText(S.suite.saved)).toBeTruthy();
  });

  it("Cmd+S (macOS) tambien descarga y se cancela el «Guardar página» del navegador", async () => {
    await openPro();
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
  });

  it("Ctrl+S funciona tambien con el foco en un campo de texto", async () => {
    await openPro();
    fireEvent.keyDown(screen.getByRole("textbox", { name: S.viewer.pageInputLabel }), { key: "s", ctrlKey: true });
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
  });

  it("Ctrl+Mayus+S abre el menu «Guardar y exportar» con el foco en su primera opcion", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "S", ctrlKey: true, shiftKey: true });
    const menu = await screen.findByRole("menu", { name: S.save.menuLabel });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]));
    expect(downloaded.blobs).toHaveLength(0);
  });

  it("con una hoja modal abierta Ctrl+S no actua", async () => {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: S.shell.shortcutsItem }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    expect(downloaded.blobs).toHaveLength(0);
  });

  it("la paleta ofrece Descargar PDF, Guardar como, con contraseña, Exportar como y las acciones de crear", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "" } });
    const labels = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
    for (const [query, expected] of [
      ["descargar", S.palette.download],
      ["exportar", S.palette.exportDoc],
      ["guardar como", S.save.saveAs],
      ["contraseña", S.save.saveWithPassword],
      ["imagenes", S.create.menu.newFromImages],
      ["blanco", S.create.menu.newBlank],
      ["word", S.create.menu.insertConvert],
      ["unir", S.create.menu.mergePdfs],
    ] as const) {
      fireEvent.change(input, { target: { value: query } });
      await waitFor(() => expect(labels().some((text) => text.includes(expected)), `${query} -> ${expected}`).toBe(true));
    }
  });

  it("«Descargar PDF» desde la paleta descarga", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "descargar pdf" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
  });
});

describe("cerrar la pestaña: beforeunload solo con cambios que el borrador no cubre", () => {
  function unloadEvent(): BeforeUnloadEvent {
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  it("sin cambios no avisa", async () => {
    await openPro();
    expect(unloadEvent().defaultPrevented).toBe(false);
  });

  it("con cambios y el autoguardado ENCENDIDO, justo tras aplicar (la escritura aun pendiente) SI avisa", async () => {
    await openPro();
    await rotate();
    // El borrador espera su debounce: todavia no cubre lo ultimo que se hizo.
    expect(unloadEvent().defaultPrevented).toBe(true);
  });

  it("con cambios y el autoguardado ENCENDIDO, una vez guardado el borrador, ya no avisa (los conserva)", async () => {
    await openPro();
    await rotate();
    await waitFor(() => expect(unloadEvent().defaultPrevented).toBe(false), { timeout: 5000 });
    // Y se mantiene asi: no vuelve a avisar sin un cambio nuevo.
    expect(unloadEvent().defaultPrevented).toBe(false);
  });

  it("un cambio nuevo tras guardarse vuelve a avisar hasta que ese tambien se guarda", async () => {
    await openPro();
    await rotate();
    await waitFor(() => expect(unloadEvent().defaultPrevented).toBe(false), { timeout: 5000 });
    await rotate();
    expect(unloadEvent().defaultPrevented).toBe(true);
    await waitFor(() => expect(unloadEvent().defaultPrevented).toBe(false), { timeout: 5000 });
  });

  it("con cambios y el autoguardado APAGADO avisa", async () => {
    setProFeatureFlag("proAutosave", false);
    await openPro();
    await rotate();
    expect(unloadEvent().defaultPrevented).toBe(true);
  });

  it("tras descargar (sin cambios pendientes) deja de avisar aunque el autoguardado este apagado", async () => {
    setProFeatureFlag("proAutosave", false);
    await openPro();
    await rotate();
    expect(unloadEvent().defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    await waitFor(() => expect(screen.getByText(S.suite.saved)).toBeTruthy());
    expect(unloadEvent().defaultPrevented).toBe(false);
  });

  it("deshacer hasta el original (sin cambios) deja de avisar", async () => {
    setProFeatureFlag("proAutosave", false);
    await openPro();
    await rotate();
    fireEvent.click(screen.getByRole("button", { name: S.suite.undo }));
    await waitFor(() => expect(screen.getByText(S.suite.saved)).toBeTruthy());
    expect(unloadEvent().defaultPrevented).toBe(false);
  });

  it("si el borrador automatico falla, avisa Y lo dice en el panel", async () => {
    const saved = await import("@/app/pdf-pro/proDrafts");
    const spy = vi.spyOn(saved, "saveProDraft").mockResolvedValue({ ok: false, reason: "quota" });
    try {
      await openPro();
      await rotate();
      await waitFor(() => expect(unloadEvent().defaultPrevented).toBe(true), { timeout: 3000 });
      expect(await screen.findByText(S.drafts.saveQuota)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("al cerrar el documento ya no queda ningun manejador que avise", async () => {
    setProFeatureFlag("proAutosave", false);
    await openPro();
    await rotate();
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.suite.close }));
    await screen.findByText(es.tool.dropTitle);
    expect(unloadEvent().defaultPrevented).toBe(false);
  });
});

describe("cambiar de documento", () => {
  it("«Abrir otro PDF…» sin cambios abre el nuevo al instante", async () => {
    await openPro(2, "uno.pdf");
    pdfMocks.state.defaultPages = 4;
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [pdfFile(await makePdfBytes(4), "dos.pdf")] } });
    expect(await screen.findByRole("heading", { level: 1, name: /dos\.pdf/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("con cambios sin descargar pide confirmacion y «Cancelar» conserva el documento", async () => {
    await openPro(2, "uno.pdf");
    await rotate();
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [pdfFile(await makePdfBytes(2), "dos.pdf")] } });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(S.session.replaceBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { level: 1, name: /uno\.pdf/ })).toBeTruthy();
  });

  it("confirmar cambia al documento nuevo", async () => {
    await openPro(2, "uno.pdf");
    await rotate();
    pdfMocks.state.defaultPages = 3;
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [pdfFile(await makePdfBytes(3), "dos.pdf")] } });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.session.replaceConfirm }));
    expect(await screen.findByRole("heading", { level: 1, name: /dos\.pdf/ })).toBeTruthy();
  });

  it("un archivo que no es PDF se explica DENTRO de la suite y el documento sigue abierto", async () => {
    await openPro(2, "uno.pdf");
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [new File(["hola"], "nota.pdf", { type: "application/pdf" })] } });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("nota.pdf");
    expect(banner.textContent).toContain(es.tool.errors.corrupt);
    expect(screen.getByRole("heading", { level: 1, name: /uno\.pdf/ })).toBeTruthy();
  });

  it("un archivo vacio se explica con su mensaje", async () => {
    await openPro(2, "uno.pdf");
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [new File([], "vacio.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText(es.tool.errors.emptyFile)).toBeTruthy();
  });

  it("«Documentos recientes» abre la hoja y permite pasar a uno", async () => {
    await seedDraft(7, { fileName: "guardado.pdf" });
    await openPro(2, "uno.pdf");
    pdfMocks.state.defaultPages = 2;
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: S.create.menu.recents }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: S.empty.recentOpen("guardado.pdf") }));
    expect(await screen.findByRole("heading", { level: 1, name: /guardado\.pdf/ })).toBeTruthy();
  });
});

describe("la oferta de borrador: el foco nunca cae a <body>", () => {
  async function openWithOffer() {
    const bytes = await makePdfBytes(2);
    const { fingerprintProBytes } = await import("@/app/pdf-pro/proWorkingDoc");
    const id = (await fingerprintProBytes(bytes))!;
    await saveProDraft({
      id,
      fileName: "informe.pdf",
      bytes: await makePdfBytes(3),
      snapshotId: "snap-offer",
      history: [
        { label: "Original", createdAt: 1, source: "open" },
        { label: "Rotar", createdAt: 2, source: "operation" },
      ],
      pageCount: 3,
      currentPage: 0,
    });
    pdfMocks.state.defaultPages = 2;
    const utils = renderPro();
    fireEvent.change(dropzoneInput(utils.container), { target: { files: [pdfFile(bytes, "informe.pdf")] } });
    await screen.findByRole("heading", { level: 1, name: /informe\.pdf/ });
    await settle();
    return screen.findByRole("group", { name: S.drafts.foundTitle });
  }

  it("«Retomar borrador» deja el foco en el titulo del documento", async () => {
    const offer = await openWithOffer();
    const restore = within(offer).getByRole("button", { name: S.drafts.restore });
    restore.focus();
    pdfMocks.state.defaultPages = 3;
    fireEvent.click(restore);
    await waitFor(() => expect(screen.queryByRole("group", { name: S.drafts.foundTitle })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  });

  it("«Descartar borrador» tambien", async () => {
    const offer = await openWithOffer();
    const discard = within(offer).getByRole("button", { name: S.drafts.discard });
    discard.focus();
    fireEvent.click(discard);
    await waitFor(() => expect(screen.queryByRole("group", { name: S.drafts.foundTitle })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });
});

describe("traspaso desde otra herramienta", () => {
  it("de un solo PDF: «Abierto desde …»", async () => {
    setHandoff(pdfFile(await makePdfBytes(2), "uno.pdf"), "compress-pdf");
    pdfMocks.state.defaultPages = 2;
    renderPro();
    expect(await screen.findByText(S.suite.openedFrom(es.tools["compress-pdf"].name))).toBeTruthy();
  });

  it("de varios PDF: avisa VISIBLEMENTE de que solo se abrio el primero y como unirlos", async () => {
    setHandoff(pdfFile(await makePdfBytes(2), "uno.pdf"), "merge-pdf", 3);
    pdfMocks.state.defaultPages = 2;
    renderPro();
    expect(await screen.findByText(S.suite.openedFromMany(es.tools["merge-pdf"].name, 3))).toBeTruthy();
    expect(screen.queryByText(S.suite.openedFrom(es.tools["merge-pdf"].name))).toBeNull();
  });
});

describe("tamaño y memoria", () => {
  function renderSuite(doc: ReturnType<typeof fakeDoc>) {
    return render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <ProSuite openedFrom={null} draftOffer={null} draftBusy={false} onRestoreDraft={() => {}} onDiscardDraft={() => {}} onClose={() => {}} />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
  }
  const MB = 1024 * 1024;

  it("un documento pequeno no muestra el bloque de limites", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(2 * MB), { pageCount: 3 });
    renderSuite(doc);
    await settle();
    expect(document.querySelector("[data-pro-limits]")).toBeNull();
  });

  it("de 100 MB o mas avisa de que es grande", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(101 * MB), { pageCount: 3 });
    renderSuite(doc);
    await settle();
    const block = document.querySelector("[data-pro-limits]") as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.textContent).toContain("101 MB");
    expect(block.textContent).not.toContain("borrador automático");
  });

  it("de mas de 150 MB avisa ademas de que NO se guarda borrador", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(151 * MB), { pageCount: 3 });
    renderSuite(doc);
    await settle();
    const block = document.querySelector("[data-pro-limits]") as HTMLElement;
    expect(block.textContent).toContain("151 MB");
    expect(block.textContent).toContain("no se guardará un borrador automático");
  });
});
