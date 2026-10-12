import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ViewerToolbar, type ViewerToolbarProps } from "@/app/pdf-pro/viewer/ViewerToolbar";
import { createViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import {
  SetLanguage,
  ViewerHarness,
  installLayoutEnv,
  makeSnapshot,
  resetViewerGlobals,
  settle,
  type LayoutEnv,
} from "@/app/pdf-pro/viewer/viewerTestUtils";

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, openPdfDocument: utils.pdfMocks.open, closePdfDocument: utils.pdfMocks.close };
});

const V = PRO_STRINGS.es.viewer;
let env: LayoutEnv;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  env = installLayoutEnv();
  resetViewerGlobals();
});
afterEach(() => {
  cleanup();
  env.restore();
});

const baseProps: ViewerToolbarProps = {
  thumbsOpen: true,
  thumbsControls: "thumbs-panel",
  onToggleThumbs: () => undefined,
  thumbsAsSheet: false,
};

async function mount(pages: number | null, props: Partial<ViewerToolbarProps> = {}) {
  const store = createViewerStore();
  render(
    <ViewerHarness snapshot={pages === null ? null : makeSnapshot(pages)} store={store} pageCountHint={pages ?? 0}>
      <ViewerToolbar {...baseProps} {...props} />
    </ViewerHarness>,
  );
  await settle();
  return store;
}

const input = () => screen.getByRole("textbox", { name: V.pageInputLabel }) as HTMLInputElement;
const zoomValue = () => document.querySelector("[data-pro-zoom-value]")!.textContent;

describe("indicador «Pagina X de N»", () => {
  it("muestra la pagina actual (base 1) y el total", async () => {
    const store = await mount(500);
    expect(input().value).toBe("1");
    expect(screen.getByText(V.pageTotal(500))).toBeTruthy();
    act(() => store.setCurrentPage(41));
    expect(input().value).toBe("42");
  });

  it("escribir un numero y pulsar Intro salta a esa pagina", async () => {
    const store = await mount(500);
    fireEvent.change(input(), { target: { value: "250" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(249);
  });

  it("un numero mayor que el total salta a la ultima y 0 a la primera", async () => {
    const store = await mount(30);
    fireEvent.change(input(), { target: { value: "9999" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(29);
    fireEvent.change(input(), { target: { value: "0" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(0);
  });

  it("solo admite digitos", async () => {
    await mount(30);
    fireEvent.change(input(), { target: { value: "1a2-b" } });
    expect(input().value).toBe("12");
  });

  it("un campo vacio al pulsar Intro no hace nada", async () => {
    const store = await mount(30);
    act(() => store.setCurrentPage(5));
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(5);
  });

  it("Esc con un borrador lo descarta y vuelve a mostrar la pagina actual", async () => {
    const store = await mount(30);
    act(() => store.setCurrentPage(7));
    fireEvent.change(input(), { target: { value: "20" } });
    expect(input().value).toBe("20");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("8");
  });

  it("al salir del campo sin confirmar vuelve a la pagina real", async () => {
    await mount(30);
    fireEvent.change(input(), { target: { value: "20" } });
    fireEvent.blur(input());
    expect(input().value).toBe("1");
  });

  it("lo que el usuario esta escribiendo no se borra si el visor sigue desplazandose (inercia de la rueda)", async () => {
    const store = await mount(500);
    fireEvent.change(input(), { target: { value: "40" } });
    act(() => store.setCurrentPage(7));
    act(() => store.setCurrentPage(8));
    expect(input().value).toBe("40");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(39);
  });

  it("sin documento no hay numero y los controles estan desactivados", async () => {
    await mount(null);
    expect(input().value).toBe("");
    expect(input().readOnly).toBe(true);
    expect(screen.getByRole("button", { name: V.zoomIn }).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("zoom", () => {
  it("muestra el porcentaje y los botones recorren los pasos", async () => {
    await mount(10);
    expect(zoomValue()).toBe("100 %");
    fireEvent.click(screen.getByRole("button", { name: V.zoomIn }));
    expect(zoomValue()).toBe("125 %");
    fireEvent.click(screen.getByRole("button", { name: V.zoomOut }));
    fireEvent.click(screen.getByRole("button", { name: V.zoomOut }));
    expect(zoomValue()).toBe("75 %");
  });

  it("«Ajustar al ancho» vuelve a 100 % y se marca como pulsado solo entonces", async () => {
    const store = await mount(10);
    const fit = screen.getByRole("button", { name: V.fitWidth });
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    act(() => store.setZoom(2));
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fit);
    expect(store.getZoom()).toBe(1);
    expect(fit.getAttribute("aria-pressed")).toBe("true");
  });

  it("en los extremos el boton correspondiente queda desactivado (aria-disabled, sin perder el foco)", async () => {
    const store = await mount(10);
    act(() => store.setZoom(4));
    const zoomIn = screen.getByRole("button", { name: V.zoomIn });
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    expect((zoomIn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(zoomIn);
    expect(store.getZoom()).toBe(4);
    act(() => store.setZoom(0.5));
    expect(screen.getByRole("button", { name: V.zoomOut }).getAttribute("aria-disabled")).toBe("true");
  });

  it("cada boton mide al menos 44 px (clase del tamano)", async () => {
    await mount(10);
    for (const name of [V.zoomIn, V.zoomOut, V.fitWidth]) {
      expect(screen.getByRole("button", { name }).className).toContain("size-11");
    }
  });
});

describe("miniaturas y panel", () => {
  it("el boton de miniaturas cambia de nombre segun este abierto o cerrado y avisa con aria-expanded", async () => {
    const onToggleThumbs = vi.fn();
    await mount(10, { thumbsOpen: true, onToggleThumbs });
    const hide = screen.getByRole("button", { name: V.hideThumbs });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe("thumbs-panel");
    fireEvent.click(hide);
    expect(onToggleThumbs).toHaveBeenCalledTimes(1);
  });

  it("cerrado se llama «Mostrar miniaturas»", async () => {
    await mount(10, { thumbsOpen: false });
    const show = screen.getByRole("button", { name: V.showThumbs });
    expect(show.getAttribute("aria-expanded")).toBe("false");
  });

  it("en movil abre una hoja: aria-haspopup y sin aria-expanded", async () => {
    await mount(10, { thumbsAsSheet: true, thumbsOpen: false });
    const open = screen.getByRole("button", { name: V.openThumbs });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(open.getAttribute("aria-expanded")).toBeNull();
  });

  it("el boton del panel de herramienta solo existe si hay manejador", async () => {
    await mount(10);
    expect(screen.queryByRole("button", { name: V.hidePanel })).toBeNull();
  });

  it("con manejador alterna su nombre y su estado", async () => {
    const onToggleContext = vi.fn();
    await mount(10, { contextOpen: true, contextControls: "ctx", onToggleContext });
    const hide = screen.getByRole("button", { name: V.hidePanel });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe("ctx");
    fireEvent.click(hide);
    expect(onToggleContext).toHaveBeenCalled();
  });

  it("el boton del panel se oculta en movil (clase max-md:hidden)", async () => {
    await mount(10, { contextOpen: false, onToggleContext: () => undefined });
    expect(screen.getByRole("button", { name: V.showPanel }).className).toContain("max-md:hidden");
  });
});

describe("seleccion de paginas", () => {
  it("no hay chip sin seleccion", async () => {
    await mount(10);
    expect(document.querySelector("[data-pro-selection-count]")).toBeNull();
  });

  it("con seleccion muestra cuantas y permite quitarlas", async () => {
    const store = await mount(10);
    act(() => store.setSelectedPages([1, 2]));
    expect(document.querySelector("[data-pro-selection-count]")!.textContent).toBe(V.selectedCount(2));
    fireEvent.click(screen.getByRole("button", { name: V.clearSelection }));
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("singular para una sola pagina", async () => {
    const store = await mount(10);
    act(() => store.setSelectedPages([4]));
    expect(document.querySelector("[data-pro-selection-count]")!.textContent).toBe(V.selectedCount(1));
    expect(V.selectedCount(1)).toBe("1 página seleccionada");
  });
});

describe("accesibilidad e idioma", () => {
  it("es una barra de herramientas con nombre", async () => {
    await mount(10);
    expect(screen.getByRole("toolbar", { name: V.toolbarLabel })).toBeTruthy();
    expect(screen.getByRole("group", { name: V.zoomGroup })).toBeTruthy();
  });

  it("los textos salen en ingles con el idioma en", async () => {
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(10)} store={store} pageCountHint={10}>
        <SetLanguage language="en" />
        <ViewerToolbar {...baseProps} />
      </ViewerHarness>,
    );
    await settle();
    const E = PRO_STRINGS.en.viewer;
    expect(screen.getByRole("toolbar", { name: E.toolbarLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: E.zoomIn })).toBeTruthy();
    expect(screen.getByText(E.pageTotal(10))).toBeTruthy();
  });
});
