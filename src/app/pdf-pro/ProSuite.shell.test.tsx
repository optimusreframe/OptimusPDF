import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff } from "@/app/pdf-pro/proHandoff";
import { __resetProFeatureFlagsCacheForTests } from "@/app/pdf-pro/proFeatureFlags";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
} from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { PRO_LAYOUT_STORAGE_KEY } from "@/app/pdf-pro/shell/proLayout";
import {
  __clearRegisteredCommandsForTests,
  registerCommand,
} from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests, registerProAction } from "@/app/pdf-pro/shell/proActions";
import { clearRecentEntries } from "@/lib/recent";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import {
  SetLanguage,
  installLayoutEnv,
  pdfMocks,
  resetViewerGlobals,
  settle,
  type LayoutEnv,
} from "@/app/pdf-pro/viewer/viewerTestUtils";

/**
 * El shell de la suite (Wave 7 · U3): paneles responsive, redimensionado y plegado con persistencia, regiones y
 * saltos de foco, menu «Mas», paleta Cmd/Ctrl+K y deshacer/rehacer conservando pagina y zoom. pdf.js se simula
 * (jsdom no dibuja); el documento de trabajo y los motores de operaciones son los reales.
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

const S = PRO_STRINGS.es;
let env: LayoutEnv;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 800, height: 600 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  window.localStorage.removeItem(PRO_LAYOUT_STORAGE_KEY);
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
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

/** Emula un telefono: `min-width: 768px` no se cumple y `max-width: 767px` si. */
function stubMobile() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 767px") || query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })),
  );
}

async function openPro(pages = 5, name = "informe.pdf") {
  pdfMocks.state.defaultPages = pages;
  const utils = render(
    <LanguageProvider>
      <ProToolClient />
    </LanguageProvider>,
  );
  const bytes = await makePdfBytes(pages);
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdfFile(bytes, name)] } });
  await screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });
  await settle();
  return utils;
}

const sleep = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const suite = () => document.querySelector("section[data-pro-suite]") as HTMLElement;
const menuItems = () => {
  const menu = within(screen.getByRole("menu"));
  return [...menu.queryAllByRole("menuitem"), ...menu.queryAllByRole("menuitemcheckbox")].map((el) => el.textContent ?? "");
};
const separators = () => screen.queryAllByRole("separator");
const pageInput = () => screen.getByRole("textbox", { name: S.viewer.pageInputLabel }) as HTMLInputElement;

/* ------------------------------------------------------------------ *
 * Escritorio
 * ------------------------------------------------------------------ */

describe("distribucion de escritorio", () => {
  it("pinta la barra, las pestañas, las miniaturas, el visor y el panel como regiones con nombre", async () => {
    await openPro(5);
    expect(suite().dataset.layout).toBe("desktop");
    expect(screen.getByRole("group", { name: S.suite.topBarLabel })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: S.suite.tabsLabel })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: S.suite.thumbsTitle })).toBeTruthy();
    expect(screen.getByRole("region", { name: S.suite.viewerTitle })).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    expect(screen.getByRole("feed", { name: S.viewer.feedLabel })).toBeTruthy();
  });

  it("no hay barra inferior de movil", async () => {
    await openPro(5);
    expect(document.querySelector("[data-pro-dock]")).toBeNull();
  });

  it("las miniaturas, el visor y la barra del visor hablan del mismo documento (5 paginas)", async () => {
    await openPro(5);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText(S.viewer.pageTotal(5))).toBeTruthy();
    expect(pageInput().value).toBe("1");
  });

  it("hay dos tiradores (separadores) con los anchos por defecto", async () => {
    await openPro(5);
    const [thumbs, context] = separators();
    expect(thumbs.getAttribute("aria-label")).toBe(S.shell.resizeThumbs);
    expect(thumbs.getAttribute("aria-valuenow")).toBe("176");
    expect(context.getAttribute("aria-label")).toBe(S.shell.resizeContext);
    expect(context.getAttribute("aria-valuenow")).toBe("340");
    expect(thumbs.getAttribute("aria-controls")).toBe(screen.getByRole("complementary").id);
    expect(context.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
  });

  it("cada pestaña apunta a un panel que existe", async () => {
    await openPro(3);
    const panelId = screen.getByRole("tabpanel").id;
    for (const tab of screen.getAllByRole("tab")) expect(tab.getAttribute("aria-controls")).toBe(panelId);
    expect(document.getElementById(panelId)).toBeTruthy();
  });

  it("el ancho de las miniaturas se cambia con el teclado y se guarda", async () => {
    await openPro(3);
    const [thumbs] = separators();
    fireEvent.keyDown(thumbs, { key: "ArrowRight" });
    expect(thumbs.getAttribute("aria-valuenow")).toBe("192");
    expect(screen.getByRole("complementary").style.width).toBe("192px");
    fireEvent.keyDown(thumbs, { key: "ArrowRight", shiftKey: true });
    expect(thumbs.getAttribute("aria-valuenow")).toBe("256");
    expect(JSON.parse(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)!).thumbsWidth).toBe(256);
  });

  it("el ancho del panel de herramienta se cambia (la flecha izquierda lo agranda) y se acota", async () => {
    await openPro(3);
    const context = separators()[1];
    fireEvent.keyDown(context, { key: "ArrowLeft" });
    expect(context.getAttribute("aria-valuenow")).toBe("356");
    fireEvent.keyDown(context, { key: "End" });
    expect(context.getAttribute("aria-valuenow")).toBe("560");
    fireEvent.keyDown(context, { key: "Home" });
    expect(context.getAttribute("aria-valuenow")).toBe("280");
    expect(screen.getByRole("tabpanel").style.width).toBe("280px");
  });

  it("Intro en un tirador restablece su ancho", async () => {
    await openPro(3);
    const [thumbs] = separators();
    fireEvent.keyDown(thumbs, { key: "End" });
    expect(thumbs.getAttribute("aria-valuenow")).toBe("280");
    fireEvent.keyDown(thumbs, { key: "Enter" });
    expect(thumbs.getAttribute("aria-valuenow")).toBe("176");
  });

  it("arrastrar un tirador con el raton cambia el ancho y guarda al soltar", async () => {
    await openPro(3);
    const [thumbs] = separators();
    fireEvent.pointerDown(thumbs, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(thumbs, { pointerId: 1, clientX: 340 });
    expect(screen.getByRole("complementary").style.width).toBe("216px");
    expect(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)).toBeNull();
    fireEvent.pointerUp(thumbs, { pointerId: 1 });
    expect(JSON.parse(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)!).thumbsWidth).toBe(216);
  });

  it("la distribucion guardada se recupera al abrir otro documento", async () => {
    window.localStorage.setItem(
      PRO_LAYOUT_STORAGE_KEY,
      JSON.stringify({ thumbsWidth: 240, contextWidth: 400, thumbsOpen: true, contextOpen: true }),
    );
    await openPro(3);
    expect(screen.getByRole("complementary").style.width).toBe("240px");
    expect(screen.getByRole("tabpanel").style.width).toBe("400px");
  });

  it("una distribucion guardada rota se ignora", async () => {
    window.localStorage.setItem(PRO_LAYOUT_STORAGE_KEY, "{roto");
    await openPro(3);
    expect(screen.getByRole("complementary").style.width).toBe("176px");
  });

  it("«Ocultar miniaturas» pliega el panel, lo recuerda y deja el boton para volver a abrirlo", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.hideThumbs }));
    expect(screen.queryByRole("complementary")).toBeNull();
    const show = screen.getByRole("button", { name: S.viewer.showThumbs });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.getAttribute("aria-controls")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)!).thumbsOpen).toBe(false);
    fireEvent.click(show);
    expect(screen.getByRole("complementary")).toBeTruthy();
  });

  it("el visor sigue funcionando con las miniaturas plegadas", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.hideThumbs }));
    expect(screen.getByRole("feed")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("«Ocultar el panel de herramienta» lo pliega sin dejar pestañas apuntando a un id inexistente", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.hidePanel }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    for (const tab of screen.getAllByRole("tab")) expect(tab.getAttribute("aria-controls")).toBeNull();
    expect(screen.getByRole("button", { name: S.viewer.showPanel }).getAttribute("aria-expanded")).toBe("false");
  });

  it("elegir una pestaña con el panel plegado lo vuelve a abrir", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.hidePanel }));
    fireEvent.click(screen.getByRole("tab", { name: "Firmar" }));
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Firmar" }).getAttribute("aria-selected")).toBe("true");
  });

  it("si no cabe, el panel de herramienta se pliega solo y las miniaturas se conservan", async () => {
    await openPro(3);
    env.resizeRow(700);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByRole("complementary")).toBeTruthy();
    // El boton sigue ahi para volver a abrirlo (a costa de las miniaturas).
    fireEvent.click(screen.getByRole("button", { name: S.viewer.showPanel }));
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("con el ancho muy justo los paneles se estrechan antes de plegarse", async () => {
    await openPro(3);
    env.resizeRow(1000);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    const panel = Number.parseInt(screen.getByRole("tabpanel").style.width, 10);
    const thumbs = Number.parseInt(screen.getByRole("complementary").style.width, 10);
    expect(1000 - panel - thumbs).toBeGreaterThanOrEqual(320);
  });

  it("la region del visor no se queda sin ancho minimo en ninguna anchura", async () => {
    await openPro(3);
    for (const width of [900, 800, 760, 640, 560, 480]) {
      env.resizeRow(width);
      const used =
        (screen.queryByRole("complementary") ? Number.parseInt(screen.getByRole("complementary").style.width, 10) : 0) +
        (screen.queryByRole("tabpanel") ? Number.parseInt(screen.getByRole("tabpanel").style.width, 10) : 0);
      expect(width - used, `ancho ${width}`).toBeGreaterThanOrEqual(Math.min(width, 320));
    }
  });

  it("el menu «Mas» permite restablecer la distribucion", async () => {
    window.localStorage.setItem(
      PRO_LAYOUT_STORAGE_KEY,
      JSON.stringify({ thumbsWidth: 260, contextWidth: 500, thumbsOpen: true, contextOpen: true }),
    );
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.resetLayout) }));
    expect(screen.getByRole("complementary").style.width).toBe("176px");
    expect(screen.getByRole("tabpanel").style.width).toBe("340px");
  });
});

/* ------------------------------------------------------------------ *
 * Regiones, saltos y foco
 * ------------------------------------------------------------------ */

describe("regiones, enlaces de salto y foco", () => {
  it("hay enlaces de salto al documento, a las miniaturas y al panel", async () => {
    await openPro(3);
    const nav = screen.getByRole("navigation", { name: S.shell.skipLabel });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      S.shell.skipViewer,
      S.shell.skipThumbs,
      S.shell.skipPanel,
    ]);
  });

  it("estan ocultos hasta recibir el foco (sr-only) y son enfocables", async () => {
    await openPro(3);
    const link = screen.getByRole("button", { name: S.shell.skipViewer });
    expect(link.className).toContain("sr-only");
    expect(link.className).toContain("focus:not-sr-only");
  });

  it("«Ir al documento» lleva el foco a la pagina actual del visor", async () => {
    await openPro(5);
    fireEvent.click(screen.getByRole("button", { name: S.shell.skipViewer }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(S.viewer.pageOf(1, 5));
  });

  it("«Ir a las miniaturas» lleva el foco a la miniatura que es parada de tabulador", async () => {
    await openPro(5);
    fireEvent.click(screen.getByRole("button", { name: S.shell.skipThumbs }));
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  });

  it("«Ir al panel» lleva el foco dentro del panel de herramienta", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.shell.skipPanel }));
    expect(screen.getByRole("tabpanel").contains(document.activeElement)).toBe(true);
  });

  it("con un panel plegado ya no se ofrece su enlace de salto", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.hideThumbs }));
    expect(screen.queryByRole("button", { name: S.shell.skipThumbs })).toBeNull();
  });

  it("F6 recorre las regiones y Mayus+F6 las recorre al reves", async () => {
    await openPro(5);
    const regionOf = () => (document.activeElement as HTMLElement | null)?.closest("[data-pro-region]")?.getAttribute("data-pro-region");
    screen.getByRole("button", { name: S.suite.undo }).focus();
    expect(regionOf()).toBe("top");
    const seen: (string | null | undefined)[] = [];
    for (let i = 0; i < 5; i += 1) {
      fireEvent.keyDown(window, { key: "F6" });
      seen.push(regionOf());
    }
    expect(seen).toEqual(["tabs", "thumbs", "viewer", "context", "top"]);
    fireEvent.keyDown(window, { key: "F6", shiftKey: true });
    expect(regionOf()).toBe("context");
  });

  it("al abrir el documento el foco esta en el titulo, nunca en <body>", async () => {
    await openPro(3);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  });

  it("solo hay una region viva (role=status) aunque se abran la paleta y el menu", async () => {
    await openPro(3);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("combobox");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Menu «Mas»
 * ------------------------------------------------------------------ */

describe("menu «Mas»", () => {
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: S.shell.more }));

  it("lista paleta, exportar, miniaturas, panel, atajos y cerrar", async () => {
    await openPro(3);
    openMenu();
    const labels = menuItems().join("|");
    for (const label of [S.shell.paletteItem, S.shell.exportItem, S.shell.thumbsItem, S.shell.panelItem, S.shell.shortcutsItem, S.shell.closeItem]) {
      expect(labels).toContain(label);
    }
  });

  it("«Paleta de comandos» abre la paleta", async () => {
    await openPro(3);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.paletteItem) }));
    expect(await screen.findByRole("combobox", { name: S.palette.label })).toBeTruthy();
  });

  it("«Atajos de teclado» abre la hoja con los atajos en tres grupos", async () => {
    await openPro(3);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.shortcutsItem) }));
    const dialog = await screen.findByRole("dialog");
    for (const title of Object.values(S.shell.shortcutGroups)) expect(within(dialog).getByRole("heading", { name: title })).toBeTruthy();
    expect(within(dialog).getByText(S.shell.shortcutActions.palette)).toBeTruthy();
    expect(within(dialog).getAllByText("Ctrl/⌘ K").length).toBeGreaterThan(0);
  });

  it("«Exportar…» lleva a la pestaña Convertir por defecto", async () => {
    await openPro(3);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.exportItem) }));
    expect(screen.getByRole("tab", { name: "Convertir" }).getAttribute("aria-selected")).toBe("true");
  });

  it("una accion «exportar» registrada por otra unidad sustituye al valor por defecto", async () => {
    const handler = vi.fn();
    registerProAction("export", handler);
    await openPro(3);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.exportItem) }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "Inicio" }).getAttribute("aria-selected")).toBe("true");
  });

  it("una accion «guardar» registrada sustituye a «Descargar»", async () => {
    const handler = vi.fn();
    registerProAction("save", handler);
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(downloaded.blobs).toHaveLength(0);
  });

  it("sin accion registrada «Descargar» sigue descargando el PDF", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    expect(downloaded.blobs).toHaveLength(1);
  });

  it("Esc cierra el menu y devuelve el foco a su boton", async () => {
    await openPro(3);
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: S.shell.more }));
  });
});

/* ------------------------------------------------------------------ *
 * Paleta Cmd/Ctrl+K
 * ------------------------------------------------------------------ */

describe("paleta de comandos (Cmd/Ctrl+K)", () => {
  async function openPalette(init: KeyboardEventInit = { key: "k", ctrlKey: true }) {
    fireEvent.keyDown(document.body, init);
    return screen.findByRole("combobox", { name: S.palette.label });
  }

  it("Ctrl+K la abre", async () => {
    await openPro(3);
    await openPalette();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Cmd+K tambien", async () => {
    await openPro(3);
    await openPalette({ key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("cancela la accion del navegador (Ctrl+K enfoca su buscador)", async () => {
    await openPro(3);
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(false);
  });

  it("con Alt o Mayus no se abre", async () => {
    await openPro(3);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, shiftKey: true });
    await sleep(20);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("la tecla K sola no hace nada", async () => {
    await openPro(3);
    fireEvent.keyDown(document.body, { key: "k" });
    await sleep(20);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("escribiendo en un campo (el de «Ir a la pagina») el atajo NO se secuestra", async () => {
    await openPro(3);
    pageInput().focus();
    fireEvent.keyDown(pageInput(), { key: "k", ctrlKey: true });
    await sleep(20);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("con el foco en un boton o en una pagina SI se abre", async () => {
    await openPro(3);
    screen.getByRole("button", { name: S.suite.undo }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox")).toBeTruthy();
  });

  it("no se apila sobre otra hoja modal abierta", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(S.shell.shortcutsItem) }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    await sleep(30);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lista operaciones, pestañas, vista, documento y herramientas sueltas", async () => {
    await openPro(3);
    await openPalette();
    const ids = screen.getAllByRole("option").map((el) => el.getAttribute("data-command-id"));
    expect(ids).toEqual(expect.arrayContaining(["doc:undo", "op:rotate-all", "op:compress", "tab:pages", "view:zoom-in", "tool:merge-pdf"]));
  });

  it("«Abrir herramienta suelta: …» navega a la herramienta", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await openPro(3);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "suelta unir" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/merge-pdf"));
  });

  it("«Ir a la pagina N»: escribir un numero salta a esa pagina y lleva el foco", async () => {
    await openPro(40);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "25" } });
    const results = within(screen.getByRole("listbox", { name: S.palette.resultsLabel }));
    expect(results.getAllByRole("option")[0].textContent).toContain(S.palette.goToPage(25));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(pageInput().value).toBe("25"));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(S.viewer.pageOf(25, 40)));
  });

  it("un numero fuera del documento no ofrece saltar", async () => {
    await openPro(10);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "99" } });
    expect(screen.queryByText(S.palette.goToPage(99))).toBeNull();
  });

  it("«Acercar» desde la paleta cambia el zoom del visor", async () => {
    await openPro(3);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "acercar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-pro-zoom-value]")!.textContent).toBe("125 %"));
  });

  it("«Rotar todas las paginas» desde la paleta aplica la operacion y se puede deshacer con Ctrl+Z", async () => {
    await openPro(3);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "rotar 90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    expect(screen.getByText(S.suite.unsaved)).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.undone(S.operations.rotateAll90)));
  });

  it("Ctrl+Z justo despues de ejecutar un comando (con la hoja aun saliendo) deshace igualmente", async () => {
    await openPro(3);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "rotar 90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    // Sin esperar a que la hoja termine de cerrarse.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.undone(S.operations.rotateAll90)));
  });

  it("«rotar 90» en un documento largo NO salta a la pagina 90: aplica la rotacion (regresion)", async () => {
    await openPro(120);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "rotar 90" } });
    expect(screen.queryByText(S.palette.goToPage(90))).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    expect(pageInput().value).toBe("1");
  });

  it("«Deshacer» sin nada que deshacer aparece desactivado", async () => {
    await openPro(3);
    await openPalette();
    const undo = document.querySelector('[data-command-id="doc:undo"]') as HTMLElement;
    expect(undo.getAttribute("aria-disabled")).toBe("true");
  });

  it("los comandos de otras unidades (registerCommand) aparecen y se ejecutan", async () => {
    const run = vi.fn();
    registerCommand("modo-firma:nueva", { label: "Firmar: anadir mi firma", keywords: ["signature"], run });
    await openPro(3);
    const input = await openPalette();
    // (W7-U6) «firma» ya casa tambien con el comando «Firmar documento» de los modos: se busca por lo propio del comando.
    fireEvent.change(input, { target: { value: "anadir mi firma" } });
    expect(screen.getByText("Firmar: anadir mi firma")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("un comando registrado despues de abrir el documento tambien se encuentra", async () => {
    await openPro(3);
    act(() => {
      registerCommand("tarde", { label: "Comando tardio", run: () => undefined });
    });
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "tardio" } });
    expect(screen.getByText("Comando tardio")).toBeTruthy();
  });

  it("Esc la cierra y el foco vuelve a donde estaba", async () => {
    await openPro(3);
    const undo = screen.getByRole("button", { name: S.suite.undo });
    undo.focus();
    fireEvent.keyDown(undo, { key: "k", ctrlKey: true });
    await screen.findByRole("combobox");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(undo);
  });

  it("los textos salen en ingles con el idioma en", async () => {
    pdfMocks.state.defaultPages = 3;
    const utils = render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <ProToolClient />
      </LanguageProvider>,
    );
    const bytes = await makePdfBytes(3);
    fireEvent.change(utils.container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [pdfFile(bytes, "report.pdf")] },
    });
    await screen.findByRole("heading", { level: 1, name: /report\.pdf/ });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const E = PRO_STRINGS.en.palette;
    expect(await screen.findByRole("combobox", { name: E.label })).toBeTruthy();
    expect(document.querySelector('[data-command-id="doc:undo"]')!.textContent).toContain(E.undo);
  });
});

/* ------------------------------------------------------------------ *
 * Deshacer / rehacer conserva pagina y zoom
 * ------------------------------------------------------------------ */

describe("deshacer y rehacer con el visor", () => {
  it("tras «Rotar 90°» y deshacer, la pagina visible y el zoom siguen igual", async () => {
    env.resize(800, 3000);
    await openPro(40);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.zoomIn }));
    fireEvent.change(pageInput(), { target: { value: "17" } });
    fireEvent.keyDown(pageInput(), { key: "Enter" });
    await settle();
    expect(pageInput().value).toBe("17");
    const zoomText = document.querySelector("[data-pro-zoom-value]")!.textContent;
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    await settle(10);
    expect(pageInput().value).toBe("17");
    expect(document.querySelector("[data-pro-zoom-value]")!.textContent).toBe(zoomText);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle(10);
    expect(pageInput().value).toBe("17");
    expect(document.querySelector("[data-pro-zoom-value]")!.textContent).toBe(zoomText);
    fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    await settle(10);
    expect(pageInput().value).toBe("17");
  });

  it("la seleccion de paginas sobrevive a un cambio de snapshot que no cambia el numero de paginas", async () => {
    env.resize(800, 3000);
    await openPro(10);
    fireEvent.click(screen.getAllByRole("option")[3], { ctrlKey: true });
    fireEvent.click(screen.getAllByRole("option")[5], { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    await settle(8);
    expect(screen.getAllByRole("option").filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(2);
  });

  it("abre un documento por snapshot de pdf.js (uno para el original y otro para el rotado)", async () => {
    await openPro(3);
    expect(pdfMocks.open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(pdfMocks.open).toHaveBeenCalledTimes(2));
    await settle(6);
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
  });

  it("al cerrar el documento se cierra tambien el de pdf.js y se liberan las miniaturas", async () => {
    await openPro(3);
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    await screen.findByText(PRO_STRINGS.es.empty.title);
    await settle(4);
    expect(pdfMocks.close).toHaveBeenCalled();
    expect(screen.queryByRole("feed")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Movil
 * ------------------------------------------------------------------ */

describe("distribucion de movil (375 px)", () => {
  beforeEach(() => stubMobile());

  it("el visor ocupa el ancho, no hay paneles laterales, tiradores ni pestañas superiores", async () => {
    await openPro(5);
    expect(suite().dataset.layout).toBe("mobile");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(separators()).toHaveLength(0);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByRole("feed")).toBeTruthy();
  });

  it("hay una barra inferior con las siete herramientas", async () => {
    await openPro(5);
    const dock = screen.getByRole("toolbar", { name: S.shell.dockLabel });
    expect(within(dock).getAllByRole("button")).toHaveLength(7);
  });

  it("la barra inferior es la ultima region de la suite (debajo del visor)", async () => {
    await openPro(5);
    const dock = document.querySelector("[data-pro-dock]")!;
    const viewer = document.querySelector('[data-pro-region="viewer"]')!;
    expect(viewer.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("una herramienta de la barra abre su panel en una hoja con su nombre", async () => {
    await openPro(5);
    fireEvent.click(screen.getByRole("button", { name: S.suite.tabs.protect }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(S.suite.tabs.protect);
    expect(screen.getByRole("button", { name: S.suite.tabs.protect }).getAttribute("aria-expanded")).toBe("true");
  });

  it("tocar otra vez la misma herramienta cierra la hoja", async () => {
    await openPro(5);
    // (W7-U6) «Editar» ya no abre una hoja sino un modo en la region central: se usa otra herramienta de hoja.
    fireEvent.click(screen.getByRole("button", { name: S.suite.tabs.convert }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: S.suite.tabs.convert }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("el boton de miniaturas abre una hoja con la rejilla de miniaturas", async () => {
    await openPro(5);
    const open = screen.getByRole("button", { name: S.viewer.openThumbs });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("option")).toHaveLength(5);
  });

  it("elegir una miniatura salta a esa pagina y cierra la hoja", async () => {
    await openPro(8);
    fireEvent.click(screen.getByRole("button", { name: S.viewer.openThumbs }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("option")[4]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageInput().value).toBe("5");
  });

  it("el boton del panel de herramienta no se pinta en movil (clase max-md:hidden)", async () => {
    await openPro(5);
    expect(screen.queryByRole("button", { name: S.viewer.hidePanel })).toBeNull();
    expect(screen.queryByRole("button", { name: S.viewer.showPanel })).toBeNull();
  });

  it("«Cerrar documento» vive en el menu «Mas» y el boton suelto lleva max-sm:hidden", async () => {
    await openPro(5);
    expect(screen.getByRole("button", { name: S.suite.close }).className).toContain("max-sm:hidden");
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    expect(screen.getByRole("menuitem", { name: new RegExp(S.shell.closeItem) })).toBeTruthy();
  });

  it("el menu «Mas» en movil no ofrece plegar paneles ni restablecer", async () => {
    await openPro(5);
    fireEvent.click(screen.getByRole("button", { name: S.shell.more }));
    const labels = menuItems();
    expect(labels.some((l) => l.includes(S.shell.resetLayout))).toBe(false);
    expect(labels.some((l) => l.includes(S.shell.panelItem))).toBe(false);
  });

  it("solo hay un enlace de salto (al documento)", async () => {
    await openPro(5);
    const nav = screen.getByRole("navigation", { name: S.shell.skipLabel });
    expect(within(nav).getAllByRole("button")).toHaveLength(1);
  });

  it("la paleta tambien funciona en movil", async () => {
    await openPro(5);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox")).toBeTruthy();
  });

  // Wave 10 · C-B1: las pestañas Editar, Anotar y Firmar son modos (ocupan la region central), no paneles. El comando
  // «Mostrar u ocultar el panel de herramienta» abria en movil una hoja con un aviso «Próximamente en PDF Pro» que ya
  // no es verdad: con un modo abierto no hay panel que mostrar.
  it.each(["edit", "annotate", "sign"] as const)(
    "con el modo «%s» abierto, «Mostrar u ocultar el panel» no abre una hoja ni dice «Próximamente»",
    async (tab) => {
      await openPro(5);
      fireEvent.click(screen.getByRole("button", { name: S.suite.tabs[tab] }));
      await settle();
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      await screen.findByRole("combobox", { name: S.palette.label });
      fireEvent.click(document.querySelector('[data-command-id="view:panel"]') as HTMLElement);
      await sleep(60);
      expect(screen.queryByText(/Próximamente|Coming soon/)).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
});
