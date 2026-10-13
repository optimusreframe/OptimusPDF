import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff, hasHandoff, setHandoff } from "@/app/pdf-pro/proHandoff";
import {
  __resetProFeatureFlagsCacheForTests,
  setProFeatureFlag,
} from "@/app/pdf-pro/proFeatureFlags";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
  listProDrafts,
} from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { getTool } from "@/lib/tools-registry";
import { getRecentEntries, clearRecentEntries } from "@/lib/recent";
import { es } from "@/lib/locales/es";
import type { InputCheck, InputGuard } from "@/lib/pdf/inputGuard";

/**
 * Pagina de PDF Pro de punta a punta en jsdom (motores reales, IndexedDB falso): estado vacio,
 * recepcion de archivos (arrastre, selector, traspaso), validacion, suite, operaciones, deshacer,
 * region viva unica, foco y borradores.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }) };
});

const S = PRO_STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  downloaded.blobs.length = 0;
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-pro-suite");
});

function renderPro(guard?: InputGuard | null) {
  const ui = (
    <LanguageProvider>
      <ProToolClient />
    </LanguageProvider>
  );
  return render(guard === undefined ? ui : <InputGuardContext.Provider value={guard}>{ui}</InputGuardContext.Provider>);
}

const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

async function openPdf(container: HTMLElement, pages = 3, name = "informe.pdf") {
  const bytes = await makePdfBytes(pages);
  fireEvent.change(fileInput(container), { target: { files: [pdfFile(bytes, name)] } });
  await screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });
  return bytes;
}

const history = () => screen.getByRole("list", { name: S.suite.historyTitle });
const historyLabels = () => within(history()).getAllByRole("listitem").map((li) => li.textContent?.replace(S.suite.historyCurrent, "").trim());

describe("estado vacio", () => {
  it("titulo, descripcion, zona de carga, recientes y herramientas sueltas", async () => {
    renderPro();
    expect(screen.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeTruthy();
    expect(screen.getByText(es.tools["pdf-pro"].description)).toBeTruthy();
    expect(screen.getByText(es.tool.dropTitle)).toBeTruthy();
    expect(screen.getByRole("heading", { name: S.empty.recentTitle })).toBeTruthy();
    expect(await screen.findByText(S.empty.recentEmpty)).toBeTruthy();
    const loose = screen.getByRole("heading", { name: S.empty.toolsTitle }).closest("section")!;
    for (const href of ["/merge-pdf", "/split-pdf", "/organize-pdf", "/compress-pdf", "/sign-pdf", "/protect-pdf"]) {
      expect(loose.querySelector(`a[href='${href}']`)).not.toBeNull();
    }
    expect(loose.querySelector("a[href='/']")).not.toBeNull();
  });

  it("en el estado vacio NO oculta el pie ni la barra movil (es la unica navegacion en un telefono)", () => {
    renderPro();
    expect(document.documentElement.hasAttribute("data-pro-suite")).toBe(false);
  });

  it("UNA sola region viva (role=status) en toda la pagina", () => {
    renderPro();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("el selector acepta solo PDF", () => {
    const { container } = renderPro();
    expect(fileInput(container).getAttribute("accept")).toContain("application/pdf");
    expect(fileInput(container).multiple).toBe(false);
  });

  it("sin documento no hay barra de documento ni pestañas", () => {
    renderPro();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("un archivo que no es PDF muestra un aviso claro y NO abre la suite", async () => {
    const { container } = renderPro();
    fireEvent.change(fileInput(container), { target: { files: [new File(["hola"], "nota.txt", { type: "text/plain" })] } });
    expect(await screen.findByText(es.tool.errors.invalidType)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("abrir un PDF", () => {
  it("abre la suite con el nombre, las paginas y las siete pestañas", async () => {
    const { container } = renderPro();
    await openPdf(container, 3, "contrato.pdf");
    expect(screen.getAllByText("3 páginas").length).toBeGreaterThan(0);
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Inicio", "Páginas", "Editar", "Anotar", "Firmar", "Proteger", "Convertir"]);
    expect(screen.getByRole("tab", { name: "Inicio" }).getAttribute("aria-selected")).toBe("true");
  });

  it("cuenta como uso de PDF Pro en «Recientes» / «Mas usadas»", async () => {
    const { container } = renderPro();
    await openPdf(container, 2, "uso.pdf");
    expect(getRecentEntries()[0]).toMatchObject({ slug: "pdf-pro", fileName: "uso.pdf" });
  });

  it("anuncia el documento abierto en la UNICA region viva y sigue habiendo una sola", async () => {
    const { container } = renderPro();
    await openPdf(container, 2, "anuncio.pdf");
    const status = screen.getAllByRole("status");
    expect(status).toHaveLength(1);
    await waitFor(() => expect(status[0].textContent).toBe(S.announce.opened("anuncio.pdf")));
  });

  it("el foco va al titulo del documento (nunca queda en <body>)", async () => {
    const { container } = renderPro();
    await openPdf(container);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  });

  it("muestra las miniaturas, el visor y el panel contextual como regiones con nombre", async () => {
    const { container } = renderPro();
    await openPdf(container, 4);
    expect(screen.getByRole("complementary", { name: S.suite.thumbsTitle })).toBeTruthy();
    expect(screen.getByRole("region", { name: S.suite.viewerTitle })).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    // U3: el marcador de las miniaturas ya es la lista real (una opcion por pagina, aunque pdf.js aun no las dibuje).
    const list = screen.getByRole("listbox", { name: S.viewer.thumbsListLabel(4) });
    expect(within(list).getAllByRole("option")).toHaveLength(4);
  });

  it("con un documento abierto marca <html data-pro-suite> (oculta pie y barra movil) y lo retira al cerrar o salir", async () => {
    const { container, unmount } = renderPro();
    await openPdf(container, 1);
    expect(document.documentElement.hasAttribute("data-pro-suite")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    await screen.findByText(es.tool.dropTitle);
    expect(document.documentElement.hasAttribute("data-pro-suite")).toBe(false);
    await openPdf(container, 1, "otra.pdf");
    expect(document.documentElement.hasAttribute("data-pro-suite")).toBe(true);
    unmount();
    expect(document.documentElement.hasAttribute("data-pro-suite")).toBe(false);
  });

  it("el historial arranca con «Original» como paso actual", async () => {
    const { container } = renderPro();
    await openPdf(container);
    expect(historyLabels()).toEqual(["Original"]);
    expect(screen.getByRole("button", { name: `Original (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
    expect(screen.getByText(S.suite.historyEmpty)).toBeTruthy();
    expect(screen.getByText(S.suite.saved)).toBeTruthy();
  });

  it("deshacer y rehacer estan deshabilitados (aria-disabled) sin cambios", async () => {
    const { container } = renderPro();
    await openPdf(container);
    expect(screen.getByRole("button", { name: S.suite.undo }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: S.suite.redo }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("pestañas", () => {
  it("las flechas, Inicio y Fin mueven la seleccion y el panel enlaza con su pestaña", async () => {
    const { container } = renderPro();
    await openPdf(container);
    const home = screen.getByRole("tab", { name: "Inicio" });
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowRight" });
    const pages = screen.getByRole("tab", { name: "Páginas" });
    expect(pages.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(pages);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(pages.id);
    fireEvent.keyDown(pages, { key: "End" });
    expect(screen.getByRole("tab", { name: "Convertir" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Convertir" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Inicio" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Inicio" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Convertir" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Convertir" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Inicio" }).getAttribute("aria-selected")).toBe("true");
  });

  it("solo la pestaña activa esta en el orden de tabulacion (roving tabindex)", async () => {
    const { container } = renderPro();
    await openPdf(container);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Firmar" }));
    expect(screen.getByRole("tab", { name: "Firmar" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Inicio" }).getAttribute("tabindex")).toBe("-1");
  });

  // «Proteger» y «Convertir» ya tienen contenido real (U5): sus pruebas estan en `tabs/proTabs.test.tsx`.
  // «Páginas» ya tiene su organizador real (U4): sus pruebas estan en `pages/PagesTab*.test.tsx`.
  it("«Páginas» muestra el organizador de paginas (no el marcador)", async () => {
    const { container } = renderPro();
    await openPdf(container, 3);
    fireEvent.click(screen.getByRole("tab", { name: "Páginas" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByText(/Próximamente en PDF Pro/)).toBeNull();
    expect(within(panel).getByRole("region", { name: S.pages.panelTitle })).toBeTruthy();
    await waitFor(() => expect(within(panel).getAllByRole("option")).toHaveLength(3));
    expect(within(panel).getByRole("button", { name: S.pages.status.apply })).toBeTruthy();
  });

  // «Editar» y «Anotar» ya son modos reales (U6) y «Firmar» tambien (U7): sus pruebas estan en `modes/*.test.tsx`.
  it("«Firmar» abre el modo real (con Rellenar formulario) y no el marcador", async () => {
    const { container } = renderPro();
    await openPdf(container);
    fireEvent.click(screen.getByRole("tab", { name: "Firmar" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByText(/Próximamente en PDF Pro/)).toBeNull();
    expect(within(panel).getByRole("region", { name: "Firmar el documento" })).toBeTruthy();
    expect(within(panel).getByRole("tab", { name: "Rellenar formulario" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: S.operations.rotateAll90 })).toBeNull();
  });
});

describe("operaciones y deshacer (motores reales)", () => {
  async function rotate(container: HTMLElement) {
    const bytes = await openPdf(container);
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(historyLabels()).toEqual(["Original", S.operations.rotateAll90]));
    return bytes;
  }

  it("«Rotar 90°» crea un snapshot, marca cambios sin guardar y habilita deshacer", async () => {
    const { container } = renderPro();
    await rotate(container);
    expect(screen.getByText(S.suite.unsaved)).toBeTruthy();
    expect(screen.getByRole("button", { name: S.suite.undo }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: `${S.operations.rotateAll90} (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
  });

  it("anuncia «Aplicado: …» en la region viva unica", async () => {
    const { container } = renderPro();
    await rotate(container);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.announce.applied(S.operations.rotateAll90)));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("el boton Deshacer vuelve al original y anuncia «Deshecho: …»", async () => {
    const { container } = renderPro();
    await rotate(container);
    fireEvent.click(screen.getByRole("button", { name: S.suite.undo }));
    expect(screen.getByRole("button", { name: `Original (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("status").textContent).toBe(S.announce.undone(S.operations.rotateAll90));
    expect(screen.getByText(S.suite.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: S.suite.redo }));
    expect(screen.getByRole("status").textContent).toBe(S.announce.redone(S.operations.rotateAll90));
  });

  it("Ctrl+Z deshace y Ctrl+Shift+Z rehace a nivel de documento", async () => {
    const { container } = renderPro();
    await rotate(container);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: `Original (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
    fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: `${S.operations.rotateAll90} (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
  });

  it("Ctrl+Z con el foco en un campo de texto NO deshace el documento", async () => {
    const { container } = renderPro();
    await rotate(container);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: `${S.operations.rotateAll90} (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
    field.remove();
  });

  it("el historial permite saltar a un paso concreto", async () => {
    const { container } = renderPro();
    await rotate(container);
    fireEvent.click(screen.getByRole("button", { name: S.suite.historyGoTo("Original") }));
    expect(screen.getByRole("button", { name: `Original (${S.suite.historyCurrent})` }).getAttribute("aria-current")).toBe("step");
  });

  it("dos rotaciones suman 180 grados en la descarga", async () => {
    const { container } = renderPro();
    await openPdf(container, 2);
    for (let i = 1; i <= 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
      await waitFor(() => expect(historyLabels()).toHaveLength(i + 1));
    }
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    const out = await PDFDocument.load(new Uint8Array(await downloaded.blobs[0].blob.arrayBuffer()));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([180, 180]);
  });

  it("confirmar otra operacion tras deshacer descarta la rama de rehacer", async () => {
    const { container } = renderPro();
    await rotate(container);
    fireEvent.click(screen.getByRole("button", { name: S.suite.undo }));
    expect(screen.getByRole("button", { name: S.suite.redo }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: S.operations.compress }));
    // Comprimir un PDF diminuto no cambia nada (unchanged): no hay snapshot nuevo y la rama sigue.
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/igual/));
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(historyLabels()).toEqual(["Original", S.operations.rotateAll90]));
    expect(screen.getByRole("button", { name: S.suite.redo }).getAttribute("aria-disabled")).toBe("true");
  });

  it("comprimir un PDF que ya es minimo no crea snapshot y lo dice", async () => {
    const { container } = renderPro();
    await openPdf(container, 1);
    fireEvent.click(screen.getByRole("button", { name: S.operations.compress }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(S.warnings.unchanged));
    expect(historyLabels()).toEqual(["Original"]);
  });

  it("descargar nombra el archivo con -pro cuando hay cambios y deja el documento limpio", async () => {
    const { container } = renderPro();
    await rotate(container);
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    expect(downloaded.blobs[0].name).toBe("informe-pro.pdf");
    expect(downloaded.blobs[0].blob.type).toBe("application/pdf");
    expect(screen.getByText(S.suite.saved)).toBeTruthy();
  });

  it("descargar sin cambios conserva el nombre original", async () => {
    const { container } = renderPro();
    await openPdf(container, 1, "tal-cual.pdf");
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    expect(downloaded.blobs[0].name).toBe("tal-cual.pdf");
  });

  it("mientras corre una operacion el boton NO se desactiva (conserva el foco) y no se lanza dos veces", async () => {
    const { container } = renderPro();
    await openPdf(container, 2);
    const button = screen.getByRole("button", { name: S.operations.rotateAll90 });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(historyLabels()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(historyLabels()).toHaveLength(2);
  });
});

describe("cerrar el documento", () => {
  it("sin cambios cierra al momento y vuelve al estado vacio", async () => {
    const { container } = renderPro();
    await openPdf(container, 1);
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    expect(await screen.findByText(es.tool.dropTitle)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("con cambios sin guardar pide confirmacion antes de cerrar", async () => {
    const { container } = renderPro();
    await openPdf(container, 2);
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(historyLabels()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(S.suite.closeConfirmBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: S.suite.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tablist")).toBeTruthy();
  });
});

describe("traspaso desde otras herramientas", () => {
  it("un archivo pendiente en el traspaso se abre solo al montar y se consume", async () => {
    const file = pdfFile(await makePdfBytes(2), "viene-de-unir.pdf");
    setHandoff(file, "merge-pdf");
    renderPro();
    await screen.findByRole("heading", { level: 1, name: /viene-de-unir\.pdf/ });
    expect(hasHandoff()).toBe(false);
    expect(screen.getByText(S.suite.openedFrom(es.tools["merge-pdf"].name))).toBeTruthy();
  });

  it("un traspaso con un archivo que no es PDF se rechaza con el aviso de siempre", async () => {
    setHandoff(new File(["texto"], "falso.pdf", { type: "application/pdf" }), "split-pdf");
    renderPro(async (): Promise<InputCheck> => ({ status: "problem", code: "notPdf" }));
    expect(await screen.findByText(es.tool.errors.notPdf)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("sin traspaso muestra el estado vacio", () => {
    renderPro();
    expect(screen.getByText(es.tool.dropTitle)).toBeTruthy();
  });

  it("de punta a punta con un <Link> real: «Abrir en PDF Pro» en una herramienta y la pagina recibe ESE archivo", async () => {
    const bytes = await makePdfBytes(3);
    const shell = render(
      <LanguageProvider>
        <ToolShell<Record<string, never>>
          tool={getTool("merge-pdf")}
          defaultOptions={{}}
          process={async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "x.pdf" })}
        />
      </LanguageProvider>,
    );
    fireEvent.change(fileInput(shell.container), { target: { files: [pdfFile(bytes, "desde-unir.pdf")] } });
    const link = await screen.findByRole("link", { name: es.tool.openInPro });
    expect(link.getAttribute("href")).toBe("/pdf-pro");
    link.addEventListener("click", (event) => event.preventDefault(), { once: true }); // jsdom no navega
    fireEvent.click(link);
    expect(hasHandoff()).toBe(true);
    // La navegacion de cliente no recarga el modulo: el almacen sobrevive y la pagina lo recoge.
    shell.unmount();
    renderPro();
    await screen.findByRole("heading", { level: 1, name: /desde-unir\.pdf/ });
    expect(screen.getAllByText("3 páginas").length).toBeGreaterThan(0);
    expect(screen.getByText(S.suite.openedFrom(es.tools["merge-pdf"].name))).toBeTruthy();
    expect(hasHandoff()).toBe(false);
  });
});

describe("validacion de la entrada (inputGuard)", () => {
  it.each([
    ["emptyFile", es.tool.errors.emptyFile],
    ["notPdf", es.tool.errors.notPdf],
    ["corrupt", es.tool.errors.corrupt],
  ] as const)("%s muestra su mensaje y el nombre del archivo, sin abrir la suite", async (code, message) => {
    const { container } = renderPro(async (): Promise<InputCheck> => ({ status: "problem", code }));
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(await makePdfBytes(1), "malo.pdf")] } });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText("malo.pdf")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("el aviso es una alerta enfocable por programa (el foco se le da al aparecer, no se pierde en <body>)", async () => {
    const { container } = renderPro(async (): Promise<InputCheck> => ({ status: "problem", code: "corrupt" }));
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(await makePdfBytes(1), "malo.pdf")] } });
    await screen.findByText(es.tool.errors.corrupt);
    const banner = document.querySelector("[data-error-banner]")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.getAttribute("tabindex")).toBe("-1");
  });

  it("un cifrado sin soporte (certificado) informa y no abre", async () => {
    const { container } = renderPro(async (): Promise<InputCheck> => ({ status: "unsupported", code: "certificateEncryption" }));
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(await makePdfBytes(1), "cert.pdf")] } });
    expect(await screen.findByText(es.tool.errors.certificateEncryption)).toBeTruthy();
  });

  it("el aviso se puede cerrar y vuelve a quedar la zona de carga", async () => {
    const { container } = renderPro(async (): Promise<InputCheck> => ({ status: "problem", code: "corrupt" }));
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(await makePdfBytes(1), "malo.pdf")] } });
    await screen.findByText(es.tool.errors.corrupt);
    fireEvent.click(screen.getByRole("button", { name: es.common.close }));
    await waitFor(() => expect(screen.queryByText(es.tool.errors.corrupt)).toBeNull());
    expect(screen.getByText(es.tool.dropTitle)).toBeTruthy();
  });
});

describe("PDF cifrado: hoja de contrasena", () => {
  it("pide la contrasena en la hoja de siempre; con una mala sigue pidiendola", async () => {
    const guard = async (): Promise<InputCheck> => ({ status: "encrypted", needsPassword: true });
    const { container } = renderPro(guard);
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(new Uint8Array([37, 80, 68, 70]), "secreto.pdf")] } });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(es.tool.password.body)).toBeTruthy();
    expect(within(dialog).getByText("secreto.pdf")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("cancelar la hoja descarta el archivo y deja el estado vacio", async () => {
    const guard = async (): Promise<InputCheck> => ({ status: "encrypted", needsPassword: true });
    const { container } = renderPro(guard);
    fireEvent.change(fileInput(container), { target: { files: [pdfFile(new Uint8Array([37, 80, 68, 70]), "secreto.pdf")] } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(es.tool.dropTitle)).toBeTruthy();
  });
});

describe("borradores en la pagina", () => {
  async function rotateAndWaitDraft(container: HTMLElement, name = "borrador.pdf") {
    const bytes = await openPdf(container, 2, name);
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(historyLabels()).toHaveLength(2));
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(1), { timeout: 5000 });
    return bytes;
  }

  it("un cambio aplicado deja un borrador en «Documentos recientes» al volver al estado vacio", async () => {
    const first = renderPro();
    await rotateAndWaitDraft(first.container);
    first.unmount();
    renderPro();
    const recent = await screen.findByRole("button", { name: S.empty.recentOpen("borrador.pdf") });
    expect(recent.textContent).toContain("1 cambio");
  });

  it("retomar desde «Documentos recientes» abre el PDF YA rotado, sucio y con la nota de borrador recuperado", async () => {
    const first = renderPro();
    await rotateAndWaitDraft(first.container);
    first.unmount();
    renderPro();
    fireEvent.click(await screen.findByRole("button", { name: S.empty.recentOpen("borrador.pdf") }));
    await screen.findByRole("heading", { level: 1, name: /borrador\.pdf/ });
    expect(screen.getByText(S.suite.unsaved)).toBeTruthy();
    expect(screen.getByText(/Borrador recuperado \(/)).toBeTruthy();
    expect(screen.getByText(S.suite.historyRestoredBody)).toBeTruthy();
    // Lo recuperado esta rotado: descargarlo sin mas lo demuestra.
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    const out = await PDFDocument.load(new Uint8Array(await downloaded.blobs[0].blob.arrayBuffer()));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90]);
  });

  it("reabrir el MISMO PDF original ofrece retomar el borrador; «Descartar» lo borra", async () => {
    const first = renderPro();
    const original = await rotateAndWaitDraft(first.container);
    first.unmount();
    const second = renderPro();
    fireEvent.change(fileInput(second.container), { target: { files: [pdfFile(original, "borrador.pdf")] } });
    await screen.findByRole("heading", { level: 1, name: /borrador\.pdf/ });
    const group = await screen.findByRole("group", { name: S.drafts.foundTitle });
    expect(within(group).getByText(/1 cambio/)).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: S.drafts.discard }));
    await waitFor(() => expect(screen.queryByRole("group", { name: S.drafts.foundTitle })).toBeNull());
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(0));
  });

  it("«Retomar borrador» desde la oferta sustituye el original por el borrador", async () => {
    const first = renderPro();
    const original = await rotateAndWaitDraft(first.container);
    first.unmount();
    const second = renderPro();
    fireEvent.change(fileInput(second.container), { target: { files: [pdfFile(original, "borrador.pdf")] } });
    const group = await screen.findByRole("group", { name: S.drafts.foundTitle });
    fireEvent.click(within(group).getByRole("button", { name: S.drafts.restore }));
    await waitFor(() => expect(screen.getByText(S.suite.unsaved)).toBeTruthy());
    // La oferta se retira un microtask despues de instalar el documento restaurado: se espera, no se supone.
    await waitFor(() => expect(screen.queryByRole("group", { name: S.drafts.foundTitle })).toBeNull());
  });

  it("con el autoguardado apagado en Ajustes NO se guarda borrador", async () => {
    setProFeatureFlag("proAutosave", false);
    const { container } = renderPro();
    await openPdf(container, 2, "sin-borrador.pdf");
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(historyLabels()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 1200));
    expect(await listProDrafts()).toEqual([]);
  });

  it("abrir sin tocar nada no deja borrador", async () => {
    const { container } = renderPro();
    await openPdf(container, 2, "intacto.pdf");
    await new Promise((r) => setTimeout(r, 1000));
    expect(await listProDrafts()).toEqual([]);
  });

  it("descargar deja el documento limpio y retira el borrador", async () => {
    const { container } = renderPro();
    await rotateAndWaitDraft(container, "descargado.pdf");
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(0), { timeout: 5000 });
  });
});

describe("avisos antes de guardar", () => {
  it("una copia descifrada avisa de que la contrasena no se guarda", async () => {
    const { markDecryptedCopy } = await import("@/lib/pdf/inputGuard");
    const { container } = renderPro();
    const file = pdfFile(await makePdfBytes(1), "descifrado.pdf");
    markDecryptedCopy(file);
    fireEvent.change(fileInput(container), { target: { files: [file] } });
    await screen.findByRole("heading", { level: 1, name: /descifrado\.pdf/ });
    expect(screen.getByText(S.warnings.decryptedCopy)).toBeTruthy();
    expect(screen.getByText(S.suite.warningsTitle)).toBeTruthy();
  });

  it("un PDF normal sin cambios no muestra avisos", async () => {
    const { container } = renderPro();
    await openPdf(container, 1);
    expect(screen.queryByText(S.suite.warningsTitle)).toBeNull();
  });

  /** Un PDF con un campo de firma digital ya firmado (`/FT /Sig` con `/V`): firmas «activas». */
  async function digitallySignedBytes(): Promise<Uint8Array> {
    const document = await PDFDocument.create();
    document.addPage([300, 400]).drawText("Firmado", { x: 40, y: 340, size: 18 });
    const context = document.context;
    const signature = PDFDict.withContext(context);
    signature.set(PDFName.of("Type"), PDFName.of("Sig"));
    const field = PDFDict.withContext(context);
    field.set(PDFName.of("FT"), PDFName.of("Sig"));
    field.set(PDFName.of("V"), context.register(signature));
    const fields = PDFArray.withContext(context);
    fields.push(context.register(field));
    const acroForm = PDFDict.withContext(context);
    acroForm.set(PDFName.of("Fields"), fields);
    document.catalog.set(PDFName.of("AcroForm"), context.register(acroForm));
    return document.save({ useObjectStreams: false });
  }

  it("B1 · UN aviso: titulo y texto en UNA linea, sin plegar", async () => {
    const { markDecryptedCopy } = await import("@/lib/pdf/inputGuard");
    const { container } = renderPro();
    const file = pdfFile(await makePdfBytes(1), "descifrado.pdf");
    markDecryptedCopy(file);
    fireEvent.change(fileInput(container), { target: { files: [file] } });
    await screen.findByRole("heading", { level: 1, name: /descifrado\.pdf/ });
    expect(document.querySelector("[data-pro-warnings-fold]")).toBeNull();
    const title = screen.getByText(S.suite.warningsTitle);
    const text = screen.getByText(S.warnings.decryptedCopy);
    // Mismo contenedor de una fila (`flex-wrap`): el texto no baja a otra linea en escritorio.
    expect(title.parentElement).toBe(text.closest("ul")!.parentElement);
    expect(title.parentElement!.className).toContain("flex-wrap");
    expect(text.closest("ul")!.className).not.toContain("list-disc");
  });

  it("B1 · DOS avisos (firma digital invalidada + copia sin contrasena): UNA linea «Antes de guardar · 2 avisos» expandible", async () => {
    const { markDecryptedCopy } = await import("@/lib/pdf/inputGuard");
    const { container } = renderPro();
    const file = pdfFile(await digitallySignedBytes(), "firmado.pdf");
    markDecryptedCopy(file);
    fireEvent.change(fileInput(container), { target: { files: [file] } });
    await screen.findByRole("heading", { level: 1, name: /firmado\.pdf/ });
    // Sin cambios todavia: la firma digital aun vale, solo avisa la copia sin contrasena (UN aviso, sin plegar).
    expect(document.querySelector("[data-pro-warnings-fold]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    const fold = await screen.findByRole("button", { name: new RegExp(`${S.suite.warningsTitle}.*${S.suite.warningsCount(2)}`) });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    const root = document.querySelector<HTMLElement>("[data-pro-warnings-fold]")!;
    const panel = root.querySelector<HTMLElement>("[data-notice-fold-panel]")!;
    // Plegado: el texto completo de los dos sigue ahi para lectores de pantalla, pero no se ve.
    expect(panel.className).toContain("sr-only");
    expect(panel.textContent).toContain(S.warnings.decryptedCopy);
    expect(panel.textContent).toContain(S.warnings.signaturesInvalidated);
    expect(panel.querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(panel.className).not.toContain("sr-only");
    // UNA sola region viva en la pagina (el pliegue no anade ninguna).
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
