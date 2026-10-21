import "fake-indexeddb/auto";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { Square } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { TrayHistoryPortal, TrayPortal, useTray } from "@/components/tool/trayRouting";
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
import { __clearRegisteredCommandsForTests } from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests } from "@/app/pdf-pro/shell/proActions";
import { clearRecentEntries } from "@/lib/recent";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { SetLanguage, installLayoutEnv, pdfMocks, resetViewerGlobals, settle, type LayoutEnv } from "@/app/pdf-pro/viewer/viewerTestUtils";
import { ProModeApplyError, useProModeControls, useProModeHost } from "@/app/pdf-pro/modes/modeContext";
import type { ProModeDefinition, ProModeProps } from "@/app/pdf-pro/modes/modeTypes";
import { getProMode, registerProMode } from "@/app/pdf-pro/modes/proModes";
import { MODE_STRINGS } from "@/app/pdf-pro/modes/modeStrings";
import "@/app/pdf-pro/tabs/proTabContent";

/**
 * El host de modos de PDF Pro (Wave 7 · U6) con un modo FALSO registrado en la pestaña «Anotar»: entrar, salir,
 * aplicar, descartar, confirmar, foco, Ctrl+Z, un solo snapshot, firmas, errores y que el visor suelte su PDF.
 * pdf.js se simula (jsdom no dibuja); el documento de trabajo y los motores de operaciones son los reales.
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
const unlockMock = vi.hoisted(() => ({ signatures: "none" as "none" | "active" | "unknown" }));
vi.mock("@/lib/pdf/unlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/unlock")>();
  return {
    ...actual,
    inspectProtection: async (file: File) => {
      if (unlockMock.signatures === "unknown") throw new Error("no se pudo comprobar");
      const real = await actual.inspectProtection(file);
      if (real.kind !== "ready") return real;
      return { ...real, profile: { ...real.profile, hasActiveSignatures: unlockMock.signatures === "active" } };
    },
  };
});

const S = PRO_STRINGS.es;
const M = MODE_STRINGS.es;
let env: LayoutEnv;
let originals: Record<string, ProModeDefinition | undefined> = {};

/* ------------------------------ modo falso ------------------------------ */

type Behavior = {
  /** Resultado de `controls.apply`: aplica (por defecto) o lanza. */
  applyError?: Error;
  /** Hace que `onApply` reciba estos bytes. */
  bytes?: Uint8Array;
  /** Sin controles propios: el modo trae su propio boton «Aplicar». */
  ownButtons?: boolean;
  discard?: () => void;
  /** El modo espera a esta puerta antes de entregar los bytes (para probar «ocupado»). */
  gate?: Promise<void>;
  /** (M5) El modo lleva una «paleta» y una fila de privacidad a la bandeja del movil (como el editor de verdad). */
  tray?: boolean;
};
const behavior: Behavior = {};
const spies = {
  discard: vi.fn(),
  apply: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
  props: null as ProModeProps | null,
  host: null as ReturnType<typeof useProModeHost>,
};

function FakeMode(props: ProModeProps) {
  const { onApply, onDirtyChange } = props;
  const [dirty, setDirty] = useState(false);
  const host = useProModeHost();
  const tray = useTray();
  useEffect(() => {
    spies.props = props;
    spies.host = host;
  });
  useProModeControls(
    behavior.ownButtons
      ? null
      : {
          apply: async () => {
            spies.apply();
            if (behavior.applyError) throw behavior.applyError;
            if (behavior.gate) await behavior.gate;
            await onApply(behavior.bytes ?? props.bytes, "Anotaciones (2)", { notices: ["Un aviso del modo"] });
            return true;
          },
          discard: () => {
            spies.discard();
            behavior.discard?.();
          },
        },
  );
  return (
    <div data-testid="fake-mode" data-initial-page={host?.initialPage}>
      <button
        type="button"
        onClick={() => {
          setDirty(true);
          onDirtyChange(true);
        }}
      >
        Hacer un cambio
      </button>
      {behavior.ownButtons ? (
        <button type="button" onClick={() => void onApply(behavior.bytes ?? props.bytes, "Firma", { notices: [] })}>
          Aplicar propio
        </button>
      ) : null}
      <input aria-label="Campo de texto del modo" />
      {behavior.tray ? (
        <>
          <TrayHistoryPortal>
            <button type="button" data-testid="fake-undo" aria-label="Deshacer">
              ↶
            </button>
          </TrayHistoryPortal>
          <TrayPortal slot="palette">
            <div data-testid="fake-palette" role="toolbar" aria-label="Paleta falsa">
              <button
                type="button"
                data-palette-item="rect"
                onClick={() => {
                  tray?.reportTool({ id: "rect", label: "Rectángulo", icon: Square });
                  tray?.onToolPicked();
                }}
              >
                Rectángulo
              </button>
              <button type="button" data-palette-item="select" onClick={() => tray?.reportTool(null)}>
                Seleccionar
              </button>
            </div>
          </TrayPortal>
          <TrayPortal slot="privacy">
            <p data-testid="fake-privacy">Privacidad</p>
          </TrayPortal>
        </>
      ) : null}
      <span>{dirty ? "sucio" : "limpio"}</span>
      {/* Region de estado propia del modo: dentro de PDF Pro NO debe ser una region viva mas (A11Y-3). */}
      <StatusRegion text={dirty ? "Estado propio del modo" : ""} data-fake-status="">
        {dirty ? "Estado propio del modo" : ""}
      </StatusRegion>
    </div>
  );
}

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 800, height: 600 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  unlockMock.signatures = "none";
  for (const key of Object.keys(behavior)) delete (behavior as Record<string, unknown>)[key];
  spies.discard.mockReset();
  spies.apply.mockReset();
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  window.localStorage.removeItem("optimuspdf.pro.panHintSeen");
  window.localStorage.removeItem(PRO_LAYOUT_STORAGE_KEY);
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
  originals = { annotate: getProMode("annotate"), edit: getProMode("edit"), sign: getProMode("sign") };
  registerProMode({ id: "annotate", tab: "annotate", labelKey: "annotate", Component: FakeMode });
});

afterEach(() => {
  cleanup();
  env.restore();
  vi.unstubAllGlobals();
  resetReducedMotionPrefCache();
  document.documentElement.removeAttribute("data-pro-suite");
  for (const original of Object.values(originals)) if (original) registerProMode(original);
});

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

async function openPro(pages = 4, name = "informe.pdf", language: "es" | "en" = "es") {
  pdfMocks.state.defaultPages = pages;
  const utils = render(
    <LanguageProvider>
      {language === "en" ? <SetLanguage language="en" /> : null}
      <ProToolClient />
    </LanguageProvider>,
  );
  const bytes = await makePdfBytes(pages);
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdfFile(bytes, name)] } });
  await screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });
  await settle();
  return { ...utils, bytes };
}

const tab = (name: string) => screen.getByRole("tab", { name });
const host = () => document.querySelector<HTMLElement>("[data-pro-mode-host]");
const bar = () => document.querySelector<HTMLElement>("[data-pro-mode-bar]");
const applyButton = () => document.querySelector<HTMLElement>("[data-pro-mode-apply]");
const discardButton = () => document.querySelector<HTMLElement>("[data-pro-mode-discard]");
const viewerScroller = () => document.querySelector("[data-pro-viewer-scroller]");
const history = () =>
  within(screen.getByRole("list", { name: S.suite.historyTitle }))
    .getAllByRole("listitem")
    .map((li) => li.textContent?.replace(S.suite.historyCurrent, "").trim());
const topBar = () => within(document.querySelector<HTMLElement>('[data-pro-region="top"]')!);
const topUndo = () => topBar().getByRole("button", { name: S.suite.undo });
const topRedo = () => topBar().getByRole("button", { name: S.suite.redo });
/** El documento sigue como se abrio: sin pasos de historial (deshacer no esta disponible y no hay cambios sin guardar). */
const expectNoSnapshots = () => {
  expect(topUndo().getAttribute("aria-disabled")).toBe("true");
  expect(topBar().getByText(S.suite.saved)).toBeTruthy();
};

async function enterAnnotate() {
  fireEvent.click(tab("Anotar"));
  await screen.findByTestId("fake-mode");
  await settle();
}
async function makeDirty() {
  fireEvent.click(screen.getByRole("button", { name: "Hacer un cambio" }));
  await settle();
}
async function applyNow() {
  await act(async () => {
    fireEvent.click(applyButton()!);
  });
  await settle(8);
}

/* ------------------------------------------------------------------ *
 * Una region viva por suceso (A11Y-3)
 * ------------------------------------------------------------------ */

describe("avisos del modo", () => {
  const liveRegions = () => Array.from(document.querySelectorAll('[role="status"],[aria-live]:not([aria-live="off"])'));

  it("el modo NO suma regiones vivas: sus avisos salen por la unica region de PDF Pro", async () => {
    await openPro();
    await enterAnnotate();
    const own = document.querySelector("[data-fake-status]")!;
    expect(own.hasAttribute("role")).toBe(false);
    expect(own.hasAttribute("aria-live")).toBe(false);
    const regions = liveRegions().filter((region) => !region.closest("[role=dialog]"));
    expect(regions.map((region) => region.className)).toEqual(["sr-only"]);
  });

  it("lo que el modo dice (un cambio de su estado) se anuncia por la region unica, tras lo de entrar al modo", async () => {
    await openPro();
    await enterAnnotate();
    const unique = () => document.querySelector<HTMLElement>('p[role="status"][aria-atomic="true"]')!;
    expect(unique().textContent).toContain(M.host.entered("Anotar"));
    await makeDirty();
    await waitFor(() => expect(unique().textContent).toContain("Estado propio del modo"));
    expect(document.querySelector("[data-fake-status]")!.textContent).toBe("Estado propio del modo");
  });

  it("si lo dicho llega pegado a lo de entrar al modo, se lee junto (no se pisa)", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    const text = document.querySelector<HTMLElement>('p[role="status"][aria-atomic="true"]')!.textContent ?? "";
    expect(text).toContain(M.host.entered("Anotar"));
    expect(text).toContain("Estado propio del modo");
    expect(text.indexOf(M.host.entered("Anotar"))).toBeLessThan(text.indexOf("Estado propio del modo"));
  });
});

/* ------------------------------------------------------------------ *
 * Entrar
 * ------------------------------------------------------------------ */

describe("entrar a un modo", () => {
  it("la pestaña con un modo registrado monta el modo EN LUGAR DEL VISOR", async () => {
    await openPro();
    expect(viewerScroller()).not.toBeNull();
    await enterAnnotate();
    expect(screen.getByTestId("fake-mode")).toBeTruthy();
    expect(viewerScroller()).toBeNull();
    expect(screen.queryByRole("textbox", { name: S.viewer.pageInputLabel })).toBeNull();
  });

  it("el visor SUELTA su documento de pdf.js al entrar y lo recupera al volver (nunca dos a la vez)", async () => {
    await openPro();
    const openedBefore = pdfMocks.open.mock.calls.length;
    const closedBefore = pdfMocks.close.mock.calls.length;
    await enterAnnotate();
    expect(pdfMocks.close.mock.calls.length).toBeGreaterThan(closedBefore);
    expect(pdfMocks.open.mock.calls.length).toBe(openedBefore); // el modo falso no abre ninguno
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(viewerScroller()).not.toBeNull();
    expect(pdfMocks.open.mock.calls.length).toBeGreaterThan(openedBefore);
  });

  it("las miniaturas laterales y el panel contextual se retiran mientras dura el modo", async () => {
    await openPro();
    expect(screen.getByRole("complementary", { name: S.suite.thumbsTitle })).toBeTruthy();
    await enterAnnotate();
    expect(screen.queryByRole("complementary", { name: S.suite.thumbsTitle })).toBeNull();
    expect(document.querySelector('[data-pro-region="context"]')).toBeNull();
  });

  it("la region del modo es el tabpanel de su pestaña (aria-labelledby) y la pestaña lo controla", async () => {
    await openPro();
    await enterAnnotate();
    const panel = screen.getByRole("tabpanel");
    expect(panel.hasAttribute("data-pro-mode-host")).toBe(true);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Anotar").id);
    expect(tab("Anotar").getAttribute("aria-controls")).toBe(panel.id);
  });

  it("la barra del modo dice «Anotando», el estado y ofrece Descartar y Aplicar", async () => {
    await openPro();
    await enterAnnotate();
    const group = within(bar()!);
    expect(group.getByText(M.host.annotating)).toBeTruthy();
    expect(group.getByText(M.host.clean)).toBeTruthy();
    expect(group.getByRole("button", { name: M.host.discard })).toBeTruthy();
    expect(group.getByRole("button", { name: M.host.apply })).toBeTruthy();
    expect(screen.getByRole("group", { name: M.host.barLabel })).toBeTruthy();
  });

  it("«Aplicar» esta desactivado (aria-disabled) hasta que el modo avisa de cambios", async () => {
    await openPro();
    await enterAnnotate();
    expect(applyButton()!.getAttribute("aria-disabled")).toBe("true");
    await makeDirty();
    expect(applyButton()!.getAttribute("aria-disabled")).toBeNull();
    expect(within(bar()!).getByText(M.host.dirty)).toBeTruthy();
  });

  it("pulsar «Aplicar» sin cambios no hace nada", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(applyButton()!);
    await settle();
    expect(spies.apply).not.toHaveBeenCalled();
  });

  it("registra el modo con deshacer propio: el documento lo sabe (ownUndoActive) y lo retira al salir", async () => {
    await openPro();
    await enterAnnotate();
    // Un snapshot nuevo no se puede deshacer desde fuera mientras el modo esta abierto: se comprueba con el teclado.
    expect(topUndo().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(host()).toBeNull();
  });

  it("el modo recibe el archivo vigente, sus bytes, el idioma y la pagina con la que se entra", async () => {
    await openPro();
    await enterAnnotate();
    expect(spies.props!.file.name).toBe("informe.pdf");
    expect(spies.props!.bytes.byteLength).toBeGreaterThan(100);
    expect(spies.props!.lang).toBe("es");
    expect(spies.host!.tab).toBe("annotate");
    expect(spies.host!.initialPage).toBe(0);
  });

  it("entra con la pagina que se miraba en el visor", async () => {
    await openPro(6);
    const input = screen.getByRole("textbox", { name: S.viewer.pageInputLabel }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle(6);
    await enterAnnotate();
    expect(screen.getByTestId("fake-mode").getAttribute("data-initial-page")).toBe("3");
  });

  it("anuncia la entrada en la region viva unica", async () => {
    await openPro();
    await enterAnnotate();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain(M.host.entered(M.annotate.name));
  });

  it("una pestaña sin modo (Páginas) NO monta el host", async () => {
    await openPro();
    fireEvent.click(tab("Páginas"));
    await settle();
    expect(host()).toBeNull();
    expect(viewerScroller()).not.toBeNull();
  });

  it("de un modo a otro (Anotar → Editar) cambia el host sin pasar por el visor", async () => {
    await openPro();
    registerProMode({ id: "edit", tab: "edit", labelKey: "edit", Component: FakeMode });
    await enterAnnotate();
    fireEvent.click(tab("Editar"));
    await settle();
    expect(host()!.dataset.mode).toBe("edit");
    expect(within(bar()!).getByText(M.host.editing)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

describe("aplicar", () => {
  it("«Aplicar» crea UN snapshot «mode-apply» con la etiqueta del modo y vuelve al visor", async () => {
    await openPro();
    const bytes2 = await makePdfBytes(4);
    behavior.bytes = bytes2;
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(host()).toBeNull();
    expect(viewerScroller()).not.toBeNull();
    expect(history()).toEqual(["Original", "Anotaciones (2)"]);
  });

  it("un solo «Aplicar» = un solo paso de historial (aunque se pulse dos veces seguidas)", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
      fireEvent.click(applyButton()!);
    });
    await settle(8);
    expect(history()).toHaveLength(2);
    expect(spies.apply).toHaveBeenCalledTimes(1);
  });

  it("el snapshot queda marcado como cambio sin guardar y el documento como modificado", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.getByText(S.suite.unsaved)).toBeTruthy();
  });

  it("vuelve a la pestaña de la que se vino, con el foco en ella (nunca en <body>)", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    fireEvent.click(tab("Páginas"));
    await settle();
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    await waitFor(() => expect(document.activeElement).toBe(tab("Páginas")));
    expect(tab("Páginas").getAttribute("aria-selected")).toBe("true");
  });

  it("muestra lo aplicado y los avisos del modo bajo la barra hasta cerrarlo", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    const result = document.querySelector("[data-pro-mode-result]")!;
    expect(result.textContent).toContain(M.host.appliedTitle("Anotaciones (2)"));
    expect(result.textContent).toContain("Un aviso del modo");
    fireEvent.click(within(result as HTMLElement).getByRole("button", { name: M.host.appliedDismiss }));
    expect(document.querySelector("[data-pro-mode-result]")).toBeNull();
  });

  it("anuncia «Aplicado: …» en la region viva unica", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.getByRole("status").textContent).toContain(S.announce.applied("Anotaciones (2)"));
  });

  it("Ctrl+Z global deshace UNA aplicacion por vez (y rehacer la repone)", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(history()).toEqual(["Original", "Anotaciones (2)"]);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(topRedo().getAttribute("aria-disabled")).toBeNull();
    expect(topUndo().getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    await settle();
    expect(topUndo().getAttribute("aria-disabled")).toBeNull();
  });

  it("dos aplicaciones seguidas son dos pasos y Ctrl+Z las deshace de una en una", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(history()).toHaveLength(3);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(screen.getByText(/2 cambios|1 cambio/)).toBeTruthy();
    expect(topUndo().getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(topUndo().getAttribute("aria-disabled")).toBe("true");
  });

  it("el resultado de aplicar no sobrevive a cerrar el documento", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(document.querySelector("[data-pro-mode-result]")).not.toBeNull();
  });

  it("un modo con su propio boton «Aplicar» tambien crea un unico snapshot por el contrato (onApply)", async () => {
    await openPro();
    behavior.ownButtons = true;
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    expect(applyButton()).toBeNull();
    expect(discardButton()).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Aplicar propio" }));
    });
    await settle(8);
    expect(history()).toEqual(["Original", "Firma"]);
    expect(host()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Descartar
 * ------------------------------------------------------------------ */

describe("descartar", () => {
  it("sin cambios descarta al momento: ni hoja ni snapshot", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(host()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expectNoSnapshots();
    expect(spies.discard).toHaveBeenCalledTimes(1);
  });

  it("con cambios pide confirmacion y «Descartar cambios» sale sin snapshot", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(discardButton()!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(M.host.discardTitle);
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.discardConfirm }));
    await settle(8);
    expect(host()).toBeNull();
    expect(spies.discard).toHaveBeenCalledTimes(1);
    expectNoSnapshots();
  });

  it("«Seguir editando» en la confirmacion de descartar conserva el modo y los cambios", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(discardButton()!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveStay }));
    await settle(8);
    expect(host()).not.toBeNull();
    expect(screen.getByText("sucio")).toBeTruthy();
    expect(spies.discard).not.toHaveBeenCalled();
  });

  it("descartar devuelve a la pestaña de origen, con el foco en ella", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(discardButton()!);
    await settle(8);
    await waitFor(() => expect(document.activeElement).toBe(tab("Inicio")));
  });

  it("descartar anuncia que los cambios se descartaron", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(screen.getByRole("status").textContent).toContain(M.host.discarded(M.annotate.name));
  });

  it("si el modo falla al limpiar su borrador, igualmente se sale", async () => {
    await openPro();
    behavior.discard = () => {
      throw new Error("IndexedDB bloqueada");
    };
    await enterAnnotate();
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(host()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Salir con cambios sin aplicar
 * ------------------------------------------------------------------ */

describe("salir con cambios sin aplicar", () => {
  it("cambiar de pestaña con cambios pregunta: aplicar y salir, descartar y salir o seguir", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(M.host.leaveTitle);
    expect(within(dialog).getByRole("button", { name: M.host.leaveApply })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: M.host.leaveDiscard })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: M.host.leaveStay })).toBeTruthy();
    expect(host()).not.toBeNull();
  });

  it("«Seguir editando» se queda en el modo y en la pestaña", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveStay }));
    await settle(8);
    expect(host()).not.toBeNull();
    expect(tab("Anotar").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("sucio")).toBeTruthy();
  });

  it("«Descartar y salir» limpia el modo y cambia a la pestaña pedida sin crear snapshots", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveDiscard }));
    await settle(8);
    expect(host()).toBeNull();
    expect(tab("Páginas").getAttribute("aria-selected")).toBe("true");
    expect(spies.discard).toHaveBeenCalledTimes(1);
    expectNoSnapshots();
  });

  it("«Aplicar y salir» crea UN snapshot y llega a la pestaña pedida", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveApply }));
    });
    await settle(10);
    expect(host()).toBeNull();
    expect(tab("Páginas").getAttribute("aria-selected")).toBe("true");
    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(topUndo().getAttribute("aria-disabled")).toBeNull();
  });

  it("sin cambios cambiar de pestaña NO pregunta", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(tab("Páginas"));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(host()).toBeNull();
  });

  it("cerrar el documento con cambios pregunta antes de nada", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(M.host.leaveTitle);
  });

  it("descargar con cambios sin aplicar pregunta; «Descartar y salir» descarga el documento tal cual", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    const dialog = await screen.findByRole("dialog");
    expect(downloaded.blobs).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveDiscard }));
    await settle(8);
    expect(downloaded.blobs).toHaveLength(1);
  });

  it("descargar con el modo abierto pero SIN cambios no pregunta ni sale del modo", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.click(screen.getByRole("button", { name: S.suite.download }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(downloaded.blobs).toHaveLength(1);
    expect(host()).not.toBeNull();
  });

  it("Escape cierra la hoja de salida como «Seguir editando»", async () => {
    await openPro();
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(host()).not.toBeNull();
  });

  it("un modo sin controles propios no ofrece «Aplicar y salir» (solo descartar o seguir)", async () => {
    await openPro();
    behavior.ownButtons = true;
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: M.host.leaveApply })).toBeNull();
    expect(within(dialog).getByRole("button", { name: M.host.leaveDiscard })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Ctrl+Z dentro del modo
 * ------------------------------------------------------------------ */

describe("deshacer global dentro del modo", () => {
  async function openWithOneStep() {
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await waitFor(() => expect(history()).toEqual(["Original", S.operations.rotateAll90]));
    await settle();
  }

  it("Ctrl+Z NO deshace el documento mientras el modo esta abierto", async () => {
    await openWithOneStep();
    await enterAnnotate();
    const cancelled = !fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(cancelled).toBe(false);
    fireEvent.click(discardButton()!);
    await settle(8);
    expect(history()).toEqual(["Original", S.operations.rotateAll90]);
  });

  it("Ctrl+Shift+Z y Ctrl+Y tampoco actuan dentro del modo", async () => {
    await openWithOneStep();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    await enterAnnotate();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await settle();
    fireEvent.click(discardButton()!);
    await settle(8);
    // Seguimos en «Original»: nada se rehizo.
    expect(topRedo().getAttribute("aria-disabled")).toBeNull();
  });

  it("los botones Deshacer/Rehacer de la barra estan desactivados dentro del modo", async () => {
    await openWithOneStep();
    await enterAnnotate();
    expect(topUndo().getAttribute("aria-disabled")).toBe("true");
    expect(topRedo().getAttribute("aria-disabled")).toBe("true");
  });

  it("al salir del modo Ctrl+Z vuelve a funcionar", async () => {
    await openWithOneStep();
    await enterAnnotate();
    fireEvent.click(discardButton()!);
    await settle(8);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(topUndo().getAttribute("aria-disabled")).toBe("true");
  });
});

/* ------------------------------------------------------------------ *
 * Firmas digitales
 * ------------------------------------------------------------------ */

describe("firmas digitales antes de aplicar", () => {
  it("un PDF con firmas activas pide confirmacion ANTES de aplicar; seguir sin aplicar no crea snapshot", async () => {
    unlockMock.signatures = "active";
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(M.host.signaturesTitle);
    expect(dialog.textContent).toContain(S.warnings.signaturesInvalidated);
    expect(spies.apply).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.signaturesCancel }));
    });
    await settle(8);
    expect(host()).not.toBeNull();
    expect(spies.apply).not.toHaveBeenCalled();
    expectNoSnapshots();
  });

  it("«Aplicar de todos modos» aplica y crea UN snapshot", async () => {
    unlockMock.signatures = "active";
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.signaturesConfirm }));
    });
    await settle(10);
    expect(spies.apply).toHaveBeenCalledTimes(1);
    expect(history()).toEqual(["Original", "Anotaciones (2)"]);
  });

  it("la confirmacion se pide UNA sola vez (no otra dentro de onApply)", async () => {
    unlockMock.signatures = "active";
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.signaturesConfirm }));
    });
    await settle(10);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("si no se pudo comprobar si hay firmas, el texto lo dice (nunca «sin firmas»)", async () => {
    unlockMock.signatures = "unknown";
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(S.warnings.signaturesUnknown);
  });

  it("un PDF sin firmas aplica directo, sin hoja", async () => {
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(history()).toHaveLength(2);
  });

  it("un modo con su propio boton tambien pasa por la confirmacion de firmas", async () => {
    unlockMock.signatures = "active";
    await openPro();
    behavior.ownButtons = true;
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Aplicar propio" }));
    });
    const dialog = await screen.findByRole("dialog");
    expectNoSnapshots();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.signaturesConfirm }));
    });
    await settle(10);
    expect(history()).toEqual(["Original", "Firma"]);
  });

  it("«Aplicar y salir» con firmas tambien pregunta una vez", async () => {
    unlockMock.signatures = "active";
    await openPro();
    behavior.bytes = await makePdfBytes(4);
    await enterAnnotate();
    await makeDirty();
    fireEvent.click(tab("Páginas"));
    const leave = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(leave).getByRole("button", { name: M.host.leaveApply }));
    });
    const sig = await waitFor(() => {
      const dialogs = screen.getAllByRole("dialog");
      const found = dialogs.find((d) => d.textContent?.includes(M.host.signaturesTitle));
      if (!found) throw new Error("aun no");
      return found;
    });
    await act(async () => {
      fireEvent.click(within(sig).getByRole("button", { name: M.host.signaturesConfirm }));
    });
    await settle(12);
    expect(topUndo().getAttribute("aria-disabled")).toBeNull();
    expect(topBar().getByText(S.suite.unsaved)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Errores
 * ------------------------------------------------------------------ */

describe("errores al aplicar", () => {
  it("un error del modo con texto propio se muestra como alerta y se SIGUE en el modo sin perder nada", async () => {
    await openPro();
    behavior.applyError = new ProModeApplyError("No se pudo aplicar. El archivo no es valido.");
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.getByRole("alert").textContent).toContain("El archivo no es valido");
    expect(host()).not.toBeNull();
    expect(screen.getByText("sucio")).toBeTruthy();
    expectNoSnapshots();
  });

  it("un error inesperado muestra el mensaje generico amable", async () => {
    await openPro();
    behavior.applyError = new Error("fallo interno");
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.getByRole("alert").textContent).toContain(M.host.applyFailed);
    expect(screen.getByRole("alert").textContent).not.toContain("fallo interno");
  });

  it("tras un error se puede volver a aplicar y entonces funciona", async () => {
    await openPro();
    behavior.applyError = new ProModeApplyError("No se pudo aplicar. Prueba de nuevo.");
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    expect(screen.getByRole("alert")).toBeTruthy();
    delete behavior.applyError;
    behavior.bytes = await makePdfBytes(4);
    await applyNow();
    expect(history()).toHaveLength(2);
    expect(host()).toBeNull();
  });

  it("al volver a entrar tras un error el aviso anterior ya no esta", async () => {
    await openPro();
    behavior.applyError = new ProModeApplyError("No se pudo aplicar. X.");
    await enterAnnotate();
    await makeDirty();
    await applyNow();
    fireEvent.click(discardButton()!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.discardConfirm }));
    await settle(8);
    delete behavior.applyError;
    await enterAnnotate();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Atajos E y A, comandos y movil
 * ------------------------------------------------------------------ */

describe("atajos y comandos", () => {
  beforeEach(() => {
    registerProMode({ id: "edit", tab: "edit", labelKey: "edit", Component: FakeMode });
  });

  it("«E» abre Editar y «A» abre Anotar cuando el foco no esta en un campo de texto", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "e" });
    await settle();
    expect(host()!.dataset.mode).toBe("edit");
    fireEvent.click(discardButton() ?? tab("Inicio"));
    fireEvent.click(tab("Inicio"));
    await settle(8);
    fireEvent.keyDown(document.body, { key: "a" });
    await settle();
    expect(host()!.dataset.mode).toBe("annotate");
  });

  it("«A» y «E» NO actuan si el foco esta en un campo de texto", async () => {
    await openPro();
    const input = screen.getByRole("textbox", { name: S.viewer.pageInputLabel });
    input.focus();
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.keyDown(input, { key: "e" });
    await settle();
    expect(host()).toBeNull();
  });

  it("«S» abre Firmar y «F» abre Rellenar (Firmar con la intencion «fill») fuera de campos de texto", async () => {
    registerProMode({ id: "sign", tab: "sign", labelKey: "sign", Component: FakeMode });
    await openPro();
    fireEvent.keyDown(document.body, { key: "s" });
    await settle();
    expect(host()!.dataset.mode).toBe("sign");
    expect(spies.host!.intent?.tool).toBe("sign");
    fireEvent.click(tab("Inicio"));
    await settle(8);
    fireEvent.keyDown(document.body, { key: "f" });
    await settle();
    expect(host()!.dataset.mode).toBe("sign");
    expect(spies.host!.intent?.tool).toBe("fill");
    expect(within(bar()!).getByText(M.names.sign.bar)).toBeTruthy();
  });

  it("«S» y «F» NO actuan en un campo de texto, dentro de un modo ni con modificadores", async () => {
    registerProMode({ id: "sign", tab: "sign", labelKey: "sign", Component: FakeMode });
    await openPro();
    const input = screen.getByRole("textbox", { name: S.viewer.pageInputLabel });
    input.focus();
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(input, { key: "f" });
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    await settle();
    expect(host()).toBeNull();
    await enterAnnotate();
    fireEvent.keyDown(document.body, { key: "s" });
    fireEvent.keyDown(screen.getByLabelText("Campo de texto del modo"), { key: "f" });
    await settle();
    expect(host()!.dataset.mode).toBe("annotate");
  });

  it("E y A siguen activos junto a S y F", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "a" });
    await settle();
    expect(host()!.dataset.mode).toBe("annotate");
  });

  it("la paleta ofrece «Firmar documento» y «Rellenar formulario» y arma la intencion", async () => {
    registerProMode({ id: "sign", tab: "sign", labelKey: "sign", Component: FakeMode });
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.fillForm } });
    const option = await waitFor(() => {
      const found = within(dialog).getAllByRole("option").find((o) => o.textContent?.includes(M.commands.fillForm));
      if (!found) throw new Error("aun no");
      return found;
    });
    fireEvent.click(option);
    await settle(8);
    expect(host()!.dataset.mode).toBe("sign");
    expect(spies.host!.intent?.tool).toBe("fill");
  });

  it("la paleta tiene «Firmar documento»", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.signDocument } });
    await waitFor(() => expect(within(dialog).getAllByRole("option").some((o) => o.textContent?.includes(M.commands.signDocument))).toBe(true));
  });

  it("la hoja de atajos lista S y F", async () => {
    await openPro();
    fireEvent.click(topBar().getByRole("button", { name: S.shell.more }));
    fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(S.shell.shortcutsItem) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(S.shell.shortcutActions.openSign);
    expect(dialog.textContent).toContain(S.shell.shortcutActions.openFill);
  });

  it("con Ctrl/Alt/Mayús no se abre nada", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "e", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "e", altKey: true });
    fireEvent.keyDown(document.body, { key: "A", shiftKey: true });
    await settle();
    expect(host()).toBeNull();
  });

  it("dentro de un modo «E» y «A» NO cambian de modo (son sus propias herramientas)", async () => {
    await openPro();
    await enterAnnotate();
    fireEvent.keyDown(document.body, { key: "e" });
    await settle();
    expect(host()!.dataset.mode).toBe("annotate");
  });

  it("con una hoja abierta los atajos no actuan", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.body, { key: "e" });
    await settle();
    expect(host()).toBeNull();
  });

  it("la paleta de comandos ofrece «Editar texto», «Anotar», «Añadir imagen», «Resaltar texto», «Añadir nota»", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    for (const label of [M.commands.editText, M.commands.annotate, M.commands.addImage, M.commands.highlight, M.commands.addNote]) {
      fireEvent.change(input, { target: { value: label } });
      await waitFor(() => expect(within(dialog).getAllByRole("option").some((o) => o.textContent?.includes(label))).toBe(true));
    }
  });

  it("«Editar texto» de la paleta abre Editar", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.editText } });
    const option = await waitFor(() => {
      const found = within(dialog).getAllByRole("option").find((o) => o.textContent?.includes(M.commands.editText));
      if (!found) throw new Error("aun no");
      return found;
    });
    fireEvent.click(option);
    await settle(8);
    expect(host()!.dataset.mode).toBe("edit");
  });

  it("«Añadir imagen» abre Editar y le pide la herramienta de imagen (intent)", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.addImage } });
    const option = await waitFor(() => {
      const found = within(dialog).getAllByRole("option").find((o) => o.textContent?.includes(M.commands.addImage));
      if (!found) throw new Error("aun no");
      return found;
    });
    fireEvent.click(option);
    await settle(8);
    expect(host()!.dataset.mode).toBe("edit");
    expect(spies.host!.intent?.tool).toBe("image");
  });

  it("la intencion no sobrevive a salir del modo", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.highlight } });
    const option = await waitFor(() => {
      const found = within(dialog).getAllByRole("option").find((o) => o.textContent?.includes(M.commands.highlight));
      if (!found) throw new Error("aun no");
      return found;
    });
    fireEvent.click(option);
    await settle(8);
    expect(spies.host!.intent?.tool).toBe("highlight");
    fireEvent.click(discardButton()!);
    await settle(8);
    await enterAnnotate();
    expect(spies.host!.intent).toBeNull();
  });

  it("la hoja de atajos lista E y A", async () => {
    await openPro();
    fireEvent.click(topBar().getByRole("button", { name: S.shell.more }));
    fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(S.shell.shortcutsItem) }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(S.shell.shortcutActions.openEdit);
    expect(dialog.textContent).toContain(S.shell.shortcutActions.openAnnotate);
  });
});

describe("movil", () => {
  it("el boton del dock de un modo no abre hoja: monta el modo y se marca como actual", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    await screen.findByTestId("fake-mode");
    expect(screen.queryByRole("dialog")).toBeNull();
    const dock = document.querySelector('[data-dock="annotate"]')!;
    expect(dock.getAttribute("aria-current")).toBe("page");
    expect(dock.getAttribute("aria-haspopup")).toBeNull();
    expect(dock.getAttribute("aria-expanded")).toBeNull();
  });

  it("los demas botones del dock conservan aria-haspopup=dialog", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    await screen.findByTestId("fake-mode");
    expect(document.querySelector('[data-dock="protect"]')!.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("la region del modo es un grupo con nombre propio (no hay pestañas en movil)", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    await screen.findByTestId("fake-mode");
    const region = host()!;
    expect(region.getAttribute("role")).toBe("group");
    expect(region.getAttribute("aria-label")).toBe(M.host.regionLabel(M.annotate.name));
    expect(region.getAttribute("aria-labelledby")).toBeNull();
  });

  it("descartar en movil devuelve el foco al boton del dock de origen", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    await screen.findByTestId("fake-mode");
    fireEvent.click(discardButton()!);
    await settle(8);
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-dock="home"]')));
  });

  it("cambiar de dock con cambios sin aplicar tambien pregunta", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Anotar" }));
    await screen.findByTestId("fake-mode");
    await makeDirty();
    fireEvent.click(screen.getByRole("button", { name: "Proteger" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(M.host.leaveTitle);
  });
});

describe("movil: foco al cerrarse una hoja", () => {
  it("si el foco no tenia adonde volver tras cerrar la hoja del panel, pasa al boton del dock de la pestaña (nunca <body>)", async () => {
    stubMobile();
    await openPro();
    // El elemento que tenia el foco al abrir la hoja (donde ella lo devolveria) desaparece antes de cerrarla.
    const transient = document.createElement("button");
    document.body.appendChild(transient);
    transient.focus();
    fireEvent.click(screen.getByRole("button", { name: "Proteger" }));
    await screen.findByRole("dialog");
    transient.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-dock="protect"]')), { timeout: 4000 });
  });
});

describe("idioma", () => {
  it("en ingles la barra y las hojas hablan en ingles", async () => {
    {
      await openPro(4, "informe.pdf", "en");
      fireEvent.click(screen.getByRole("tab", { name: "Annotate" }));
      await screen.findByTestId("fake-mode");
      const E = MODE_STRINGS.en;
      expect(within(bar()!).getByText(E.host.annotating)).toBeTruthy();
      expect(within(bar()!).getByRole("button", { name: E.host.apply })).toBeTruthy();
      await makeDirty();
      fireEvent.click(discardButton()!);
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain(E.host.discardTitle);
      expect(spies.props!.lang).toBe("en");
    }
  });
});

describe("ocupado", () => {
  it("mientras se aplica no se puede cambiar de pestaña ni descartar", async () => {
    await openPro();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    behavior.bytes = await makePdfBytes(4);
    behavior.gate = gate;
    await enterAnnotate();
    await makeDirty();
    await act(async () => {
      fireEvent.click(applyButton()!);
    });
    expect(host()!.hasAttribute("data-busy")).toBe(true);
    fireEvent.click(tab("Páginas"));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tab("Anotar").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(discardButton()!);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spies.discard).not.toHaveBeenCalled();
    release();
    await settle(10);
    expect(host()).toBeNull();
    expect(history()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * (M2 · VP-01, ER-02, GE-01) Reparto del alto en movil
 * ------------------------------------------------------------------ */

/** `matchMedia` de un telefono: ancho de movil, puntero grueso y, si se pide, alto pequeño o de movil horizontal. */
function stubPhone(options: { compactHeight?: boolean; short?: boolean; coarse?: boolean; wide?: boolean } = {}) {
  const { compactHeight = false, short = false, coarse = true, wide = false } = options;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches:
        query.includes("max-width: 767px") ||
        (wide && query.includes("min-width: 768px")) ||
        (coarse && query.includes("pointer: coarse")) ||
        ((compactHeight || short) && query.includes("max-height: 719")) ||
        (short && query.includes("max-height: 479")),
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
const dockButton = (id: string) => document.querySelector<HTMLElement>(`[data-dock="${id}"]`)!;
const foldToggle = () => document.querySelector<HTMLElement>("[data-pro-fold-toggle]")!;
const panToggle = () => document.querySelector<HTMLElement>("[data-pro-pan-toggle]");

describe("movil: reparto del alto con un modo abierto", () => {
  async function enterOnPhone(options?: Parameters<typeof stubPhone>[0]) {
    stubPhone(options);
    await openPro();
    fireEvent.click(dockButton("annotate"));
    await screen.findByTestId("fake-mode");
    await settle();
  }

  it("la barra del modo va DEBAJO del contenido (al alcance del pulgar) y la cabecera es compacta", async () => {
    await enterOnPhone();
    expect(bar()!.getAttribute("data-placement")).toBe("bottom");
    expect(host()!.lastElementChild).toBe(bar());
    expect(within(bar()!).getByRole("button", { name: M.host.apply })).toBeTruthy();
    expect(within(bar()!).getByRole("button", { name: M.host.discard })).toBeTruthy();
    expect(document.querySelector('[data-pro-region="top"]')!.getAttribute("data-compact")).toBe("");
    // M5 · N1: el deshacer/rehacer GLOBAL esta apagado dentro de un modo (el modo trae el suyo): en el movil sus dos botones de 44 px
    // se retiran de la cabecera y dejan sitio a «Aplicar» y al titulo, en vez de quedar como dos botones muertos.
    expect(topBar().queryByRole("button", { name: S.suite.undo })).toBeNull();
    expect(topBar().queryByRole("button", { name: S.suite.redo })).toBeNull();
  });

  it("«Ocultar herramientas» pliega las barras del editor y «Mostrar» las devuelve; el dock siempre queda a la vista y el foco no se pierde", async () => {
    await enterOnPhone();
    expect(document.querySelector("[data-pro-dock]")).not.toBeNull();
    expect(foldToggle().getAttribute("aria-expanded")).toBe("true");
    expect(foldToggle().getAttribute("aria-label")).toBe(M.host.hideTools);
    expect(host()!.hasAttribute("data-chrome")).toBe(false);
    foldToggle().focus();
    fireEvent.click(foldToggle());
    await settle();
    expect(host()!.getAttribute("data-chrome")).toBe("collapsed");
    // Cambiar de herramienta es lo que mas se hace: el dock no se pliega.
    expect(document.querySelector("[data-pro-dock]")).not.toBeNull();
    expect(foldToggle().getAttribute("aria-expanded")).toBe("false");
    expect(foldToggle().getAttribute("aria-label")).toBe(M.host.showTools);
    expect(document.activeElement).toBe(foldToggle());
    fireEvent.click(foldToggle());
    await settle();
    expect(host()!.hasAttribute("data-chrome")).toBe(false);
  });

  it("en un alto pequeño (SE, horizontal) las barras del editor arrancan plegadas, el dock sigue y se pueden desplegar", async () => {
    stubPhone({ compactHeight: true });
    await openPro();
    fireEvent.click(dockButton("annotate"));
    await screen.findByTestId("fake-mode");
    await settle();
    expect(host()!.getAttribute("data-chrome")).toBe("collapsed");
    expect(document.querySelector("[data-pro-dock]")).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    // La persona puede desplegarlas aunque el alto sea pequeño.
    fireEvent.click(foldToggle());
    await settle();
    expect(host()!.hasAttribute("data-chrome")).toBe(false);
  });

  it("en un movil horizontal la barra del modo se pinta en la cabecera y el dock es un raíl lateral", async () => {
    await enterOnPhone({ short: true });
    const slot = document.querySelector('[data-pro-region="top"] [data-pro-mode-slot]');
    expect(slot).not.toBeNull();
    expect(slot!.contains(bar())).toBe(true);
    expect(bar()!.getAttribute("data-placement")).toBe("header");
    expect(document.querySelector("[data-pro-dock]")!.getAttribute("data-rail")).toBe("");
    expect(document.querySelector('[data-pro-suite][data-rail]')).not.toBeNull();
    // Aplicar y Descartar siguen siendo accesibles por nombre.
    expect(within(bar()!).getByRole("button", { name: M.host.apply })).toBeTruthy();
    expect(within(bar()!).getByRole("button", { name: M.host.discard })).toBeTruthy();
  });

  it("con el dedo hay un interruptor «Desplazar» de 44 px que activa el desplazamiento con un dedo sobre la hoja", async () => {
    await enterOnPhone();
    const toggle = panToggle()!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.className).toContain("min-h-11");
    expect(host()!.hasAttribute("data-pan")).toBe(false);
    // El texto de ayuda es una descripcion, no parte del nombre.
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    expect(toggle.textContent).toBe(M.host.panLabel);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(host()!.hasAttribute("data-pan")).toBe(true);
    fireEvent.click(toggle);
    expect(host()!.hasAttribute("data-pan")).toBe(false);
  });

  it("con un puntero fino (raton) no hay interruptor «Desplazar»", async () => {
    await enterOnPhone({ coarse: false });
    expect(panToggle()).toBeNull();
  });

  it("(M5 · N2) en el movil la paleta y la privacidad flotan en una bandeja sobre la hoja (no restan alto) y el boton la controla", async () => {
    behavior.tray = true;
    await enterOnPhone();
    const tray = document.querySelector<HTMLElement>("[data-pro-tray]")!;
    expect(tray).not.toBeNull();
    expect(tray.className).toContain("absolute");
    expect(tray.hasAttribute("data-open")).toBe(true);
    expect(tray.contains(screen.getByTestId("fake-palette"))).toBe(true);
    expect(tray.contains(screen.getByTestId("fake-privacy"))).toBe(true);
    // Esta dentro del cuerpo del modo, no en el flujo: el visor/hoja ocupa todo el alto.
    expect(document.querySelector("[data-pro-mode-body]")!.contains(tray)).toBe(true);
    expect(foldToggle().getAttribute("aria-controls")).toBe(tray.id);
  });

  it("(M5 · N2) elegir una herramienta cierra la bandeja y el boton nombra la herramienta armada", async () => {
    behavior.tray = true;
    await enterOnPhone();
    const tray = document.querySelector<HTMLElement>("[data-pro-tray]")!;
    fireEvent.click(within(tray).getByRole("button", { name: "Rectángulo" }));
    await settle();
    expect(host()!.getAttribute("data-chrome")).toBe("collapsed");
    expect(tray.hasAttribute("data-open")).toBe(false);
    expect(tray.className).toContain("hidden");
    expect(foldToggle().getAttribute("aria-expanded")).toBe("false");
    expect(foldToggle().getAttribute("aria-label")).toBe(M.host.showToolsActive("Rectángulo"));
    expect(foldToggle().getAttribute("data-tool-active")).toBe("rect");
    // Sin herramienta armada vuelve el icono y el nombre genericos.
    fireEvent.click(foldToggle());
    await settle();
    fireEvent.click(within(tray).getByRole("button", { name: "Seleccionar" }));
    await settle();
    expect(foldToggle().getAttribute("aria-label")).toBe(M.host.hideTools);
    fireEvent.click(foldToggle());
    await settle();
    expect(foldToggle().getAttribute("aria-label")).toBe(M.host.showTools);
    expect(foldToggle().hasAttribute("data-tool-active")).toBe(false);
  });

  it("(M5 · N2) Escape dentro de la bandeja la cierra y devuelve el foco al boton de herramientas", async () => {
    behavior.tray = true;
    await enterOnPhone();
    const piece = within(document.querySelector<HTMLElement>("[data-pro-tray]")!).getByRole("button", { name: "Rectángulo" });
    piece.focus();
    fireEvent.keyDown(piece, { key: "Escape" });
    await settle(4);
    expect(host()!.getAttribute("data-chrome")).toBe("collapsed");
    await waitFor(() => expect(document.activeElement).toBe(foldToggle()));
  });

  it("(M5 · GE-01) el aviso «Para mover la página, activa Desplazar o usa dos dedos» sale UNA sola vez, con la primera herramienta armada", async () => {
    behavior.tray = true;
    await enterOnPhone();
    expect(document.querySelector("[data-pro-pan-first-hint]")).toBeNull();
    const tray = document.querySelector<HTMLElement>("[data-pro-tray]")!;
    fireEvent.click(within(tray).getByRole("button", { name: "Rectángulo" }));
    await settle();
    const hint = document.querySelector<HTMLElement>("[data-pro-pan-first-hint]");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(M.host.panFirstHint);
    expect(hint!.className).toContain("pointer-events-none");
    expect(window.localStorage.getItem("optimuspdf.pro.panHintSeen")).toBe("1");
    // Activar «Desplazar» lo retira.
    fireEvent.click(panToggle()!);
    expect(document.querySelector("[data-pro-pan-first-hint]")).toBeNull();
  });

  it("(M5 · GE-01) con el aviso ya visto no vuelve a salir", async () => {
    window.localStorage.setItem("optimuspdf.pro.panHintSeen", "1");
    behavior.tray = true;
    await enterOnPhone();
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-pro-tray]")!).getByRole("button", { name: "Rectángulo" }));
    await settle();
    expect(document.querySelector("[data-pro-pan-first-hint]")).toBeNull();
  });

  it("(M5 · N2) en un movil horizontal ANCHO (≥ 768 px) la paleta sigue en su sitio (columna) y solo la privacidad va a la bandeja", async () => {
    behavior.tray = true;
    await enterOnPhone({ short: true, wide: true });
    const tray = document.querySelector<HTMLElement>("[data-pro-tray]")!;
    expect(tray.contains(screen.getByTestId("fake-privacy"))).toBe(true);
    expect(tray.contains(screen.getByTestId("fake-palette"))).toBe(false);
    expect(screen.getByTestId("fake-mode").contains(screen.getByTestId("fake-palette"))).toBe(true);
  });

  it("(M6) en un movil horizontal ESTRECHO (< 768 px: 667×375, 568×320) la paleta no cabe como columna: va en la bandeja, como en vertical", async () => {
    behavior.tray = true;
    await enterOnPhone({ short: true, wide: false });
    const tray = document.querySelector<HTMLElement>("[data-pro-tray]")!;
    expect(tray.contains(screen.getByTestId("fake-palette"))).toBe(true);
    expect(tray.contains(screen.getByTestId("fake-privacy"))).toBe(true);
  });

  it("(M6 · a) deshacer/rehacer del editor se pintan DENTRO de la barra del modo (no en la bandeja), en vertical y en horizontal", async () => {
    behavior.tray = true;
    await enterOnPhone();
    const history = document.querySelector<HTMLElement>("[data-pro-history]")!;
    expect(bar()!.contains(history)).toBe(true);
    expect(history.contains(screen.getByTestId("fake-undo"))).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-pro-tray]")!.contains(screen.getByTestId("fake-undo"))).toBe(false);
  });

  it("(M6 · c) en horizontal (sin cabecera de la web) el menu «Mas» trae «Inicio» e idioma; el idioma cambia la interfaz", async () => {
    behavior.tray = true;
    await enterOnPhone({ short: true, wide: true });
    fireEvent.click(topBar().getByRole("button", { name: S.shell.more }));
    const home = await screen.findByRole("menuitem", { name: S.shell.homeItem });
    expect(home).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: S.shell.languageItem }));
    await settle();
    // La interfaz pasa a ingles: la barra del modo habla ya en ingles.
    expect(within(bar()!).getByRole("button", { name: MODE_STRINGS.en.host.apply })).toBeTruthy();
    // El idioma vive en un almacen del modulo: se devuelve a español por la misma via para no contaminar el resto de pruebas.
    fireEvent.click(topBar().getByRole("button", { name: PRO_STRINGS.en.shell.more }));
    fireEvent.click(await screen.findByRole("menuitem", { name: PRO_STRINGS.en.shell.languageItem }));
    await settle();
    expect(within(bar()!).getByRole("button", { name: M.host.apply })).toBeTruthy();
  });

  it("(M6 · c) en vertical con la cabecera de la web a la vista el menu «Mas» NO repite «Inicio» ni idioma", async () => {
    await enterOnPhone();
    fireEvent.click(topBar().getByRole("button", { name: S.shell.more }));
    await screen.findByRole("menuitem", { name: S.shell.shortcutsItem });
    expect(screen.queryByRole("menuitem", { name: S.shell.homeItem })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: S.shell.languageItem })).toBeNull();
  });

  it("(M6 · H2) con la barra del modo dentro de la cabecera (horizontal) salen de ella «Guardar y exportar» y «Cerrar documento» (viven en «Mas»)", async () => {
    await enterOnPhone({ short: true, wide: true });
    expect(bar()!.getAttribute("data-placement")).toBe("header");
    const top = topBar();
    expect(top.queryByRole("button", { name: S.save.menuLabel })).toBeNull();
    // «Cerrar documento» no se pinta en la cabecera delgada (sin CSS en jsdom: se mira su clase `hidden`, no `max-sm:hidden`).
    const closeButton = top.getByRole("button", { name: S.suite.close, hidden: true });
    expect(closeButton.className.split(" ")).toContain("hidden");
    expect(closeButton.className).not.toContain("max-sm:hidden");
    fireEvent.click(top.getByRole("button", { name: S.shell.more }));
    // Sus opciones estan en «Mas» (sin `narrowOnly`: visibles en cualquier ancho).
    expect(await screen.findByRole("menuitem", { name: S.save.saveAs })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: S.shell.closeItem })).toBeTruthy();
  });

  it("(M6 · H1) «Aplicar» y «Descartar» llevan su nombre accesible completo aunque en movil estrecho solo se vea el icono", async () => {
    await enterOnPhone();
    expect(applyButton()!.textContent).toContain(M.host.apply);
    expect(discardButton()!.textContent).toContain(M.host.discard);
    // Sin texto visible por debajo de 390 px / 700 px: el rotulo queda para lectores (`sr-only`), no se quita.
    expect(applyButton()!.querySelector("span")!.className).toContain("max-[389px]:sr-only");
    expect(discardButton()!.querySelector("span")!.className).toContain("max-[699px]:sr-only");
  });

  it("en escritorio la barra sigue ARRIBA, sin boton de plegar ni interruptor", async () => {
    await openPro();
    await enterAnnotate();
    expect(bar()!.getAttribute("data-placement")).toBe("top");
    expect(host()!.firstElementChild).toBe(bar());
    expect(foldToggle()).toBeNull();
    expect(panToggle()).toBeNull();
    expect(topUndo()).toBeTruthy();
    // M5: sin bandeja en escritorio; la paleta se pinta donde siempre.
    expect(document.querySelector("[data-pro-tray]")).toBeNull();
  });
});
