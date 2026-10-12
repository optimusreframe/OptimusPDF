import "fake-indexeddb/auto";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import type { ProTabId } from "@/app/pdf-pro/ProTabs";
import { ProModeApplyError, type ProModeControls } from "@/app/pdf-pro/modes/modeContext";
import { getProMode, registerProMode } from "@/app/pdf-pro/modes/proModes";
import { ProModeStaleError, useProModeSession, type ProModeSession } from "@/app/pdf-pro/modes/useProModeSession";
import { MODE_STRINGS } from "@/app/pdf-pro/modes/modeStrings";
import type { ProModeDefinition } from "@/app/pdf-pro/modes/modeTypes";

/** La maquina de estados del host de modos (Wave 7 · U6), sin pintar nada: solo el gancho y un documento falso. */

const Stub = (() => null) as unknown as ProModeDefinition["Component"];
let original: ProModeDefinition | undefined;
let originalEdit: ProModeDefinition | undefined;

beforeEach(() => {
  original = getProMode("annotate");
  originalEdit = getProMode("edit");
  registerProMode({ id: "annotate", tab: "annotate", labelKey: "annotate", Component: Stub });
  registerProMode({ id: "edit", tab: "edit", labelKey: "edit", Component: Stub });
});
afterEach(() => {
  cleanup();
  if (original) registerProMode(original);
  if (originalEdit) registerProMode(originalEdit);
});

type Setup = {
  session: () => ProModeSession;
  doc: ProWorkingDoc;
  setTab: ReturnType<typeof vi.fn>;
  focusTab: ReturnType<typeof vi.fn>;
  restoreViewerPage: ReturnType<typeof vi.fn>;
  setTabProp: (tab: ProTabId) => void;
  controls: ProModeControls;
  applySpy: ReturnType<typeof vi.fn>;
  discardSpy: ReturnType<typeof vi.fn>;
};

async function setup(options: { tab?: ProTabId; signatures?: "none" | "active" | "unknown"; viewerPage?: number } = {}): Promise<Setup> {
  const doc = fakeDoc({ inspectSignatures: async () => options.signatures ?? "none" });
  await doc.open(fakeFile(64));
  const setTab = vi.fn();
  const focusTab = vi.fn();
  const restoreViewerPage = vi.fn();
  let currentTab: ProTabId = options.tab ?? "home";
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc} shortcuts={false}>
        {children}
      </ProWorkingDocProvider>
    </LanguageProvider>
  );
  const hook = renderHook(
    ({ tab }: { tab: ProTabId }) =>
      useProModeSession({
        tab,
        setTab,
        language: "es",
        focusTab,
        getViewerPage: () => options.viewerPage ?? 0,
        restoreViewerPage,
      }),
    { wrapper, initialProps: { tab: currentTab } },
  );
  const applySpy = vi.fn();
  const discardSpy = vi.fn();
  const controls: ProModeControls = {
    apply: async () => {
      applySpy();
      await hook.result.current.onApply(fakeBytes(80, 9), "Anotaciones (1)", { notices: ["aviso"] });
      return true;
    },
    discard: () => discardSpy(),
  };
  return {
    session: () => hook.result.current,
    doc,
    setTab,
    focusTab,
    restoreViewerPage,
    setTabProp: (tab) => {
      currentTab = tab;
      hook.rerender({ tab });
    },
    controls,
    applySpy,
    discardSpy,
  };
}

function enter(s: Setup, from: ProTabId = "home") {
  act(() => s.setTabProp("annotate"));
  void from;
  act(() => s.session().registerControls(s.controls));
}

describe("modo de la pestaña", () => {
  it("una pestaña sin modo no esta activa", async () => {
    const s = await setup();
    expect(s.session().def).toBeUndefined();
    expect(s.session().active).toBe(false);
  });

  it("una pestaña con modo registrado lo activa", async () => {
    const s = await setup({ tab: "annotate" });
    expect(s.session().def?.id).toBe("annotate");
    expect(s.session().active).toBe(true);
  });

  it("la pagina de entrada es la del visor en el instante de entrar", async () => {
    const s = await setup({ viewerPage: 5 });
    act(() => s.setTabProp("edit"));
    expect(s.session().entryPage).toBe(5);
  });

  it("fuera de un modo la pagina de entrada es 0", async () => {
    const s = await setup({ viewerPage: 5 });
    expect(s.session().entryPage).toBe(0);
  });

  it("parte limpio: ni cambios, ni ocupado, ni error, ni resultado", async () => {
    const s = await setup({ tab: "annotate" });
    expect(s.session().dirty).toBe(false);
    expect(s.session().busy).toBe(false);
    expect(s.session().error).toBeNull();
    expect(s.session().result).toBeNull();
    expect(s.session().hasControls).toBe(false);
  });

  it("registerControls y onDirtyChange actualizan el estado", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().registerControls(s.controls));
    act(() => s.session().onDirtyChange(true));
    expect(s.session().hasControls).toBe(true);
    expect(s.session().dirty).toBe(true);
    act(() => s.session().registerControls(null));
    expect(s.session().hasControls).toBe(false);
  });

  it("cambiar de un modo a otro reinicia el estado sucio", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().onDirtyChange(true));
    act(() => s.setTabProp("edit"));
    expect(s.session().dirty).toBe(false);
  });
});

describe("guarda de salida", () => {
  it("sin modo o sin cambios ejecuta al momento", async () => {
    const s = await setup();
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    enter(s);
    const again = vi.fn();
    act(() => s.session().guard(again));
    expect(again).toHaveBeenCalledTimes(1);
    expect(s.session().sheets.leave.open).toBe(false);
  });

  it("con cambios abre la hoja y NO ejecuta", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(s.session().sheets.leave.open).toBe(true);
  });

  it("«Seguir» cierra la hoja sin ejecutar y anuncia que se sigue", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    act(() => s.session().actions.leaveStay());
    expect(proceed).not.toHaveBeenCalled();
    expect(s.session().sheets.leave.open).toBe(false);
    expect(s.doc.getState().announcement?.text).toBe(MODE_STRINGS.es.host.kept);
  });

  it("«Descartar y salir» limpia el modo y ejecuta lo pedido", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    await act(async () => s.session().actions.leaveDiscard());
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(s.discardSpy).toHaveBeenCalledTimes(1);
    expect(s.session().dirty).toBe(false);
  });

  it("«Aplicar y salir» aplica primero y solo despues ejecuta lo pedido", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    const order: string[] = [];
    s.applySpy.mockImplementation(() => order.push("apply"));
    const proceed = vi.fn(() => order.push("proceed"));
    act(() => s.session().guard(proceed));
    await act(async () => s.session().actions.leaveApply());
    await waitFor(() => expect(proceed).toHaveBeenCalled());
    expect(order).toEqual(["apply", "proceed"]);
  });

  it("si aplicar falla, «Aplicar y salir» NO ejecuta lo pedido", async () => {
    const s = await setup();
    s.controls.apply = async () => {
      throw new ProModeApplyError("No se pudo aplicar. X");
    };
    enter(s);
    act(() => s.session().onDirtyChange(true));
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    await act(async () => s.session().actions.leaveApply());
    expect(proceed).not.toHaveBeenCalled();
    expect(s.session().error).toBe("No se pudo aplicar. X");
  });

  it("mientras se aplica, la guarda ignora cualquier salida", async () => {
    const s = await setup();
    let release: () => void = () => undefined;
    s.controls.apply = () => new Promise<boolean>((resolve) => (release = () => resolve(true)));
    enter(s);
    act(() => s.session().onDirtyChange(true));
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().busy).toBe(true));
    const proceed = vi.fn();
    act(() => s.session().guard(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(s.session().sheets.leave.open).toBe(false);
    await act(async () => {
      release();
    });
    expect(s.session().busy).toBe(false);
  });
});

describe("aplicar", () => {
  it("onApply crea UN snapshot «mode-apply» con la etiqueta, la pestaña de origen y el aviso", async () => {
    const s = await setup();
    enter(s);
    await act(async () => s.session().requestApply());
    const document = s.doc.getState().document!;
    expect(document.snapshots).toHaveLength(2);
    const snapshot = document.snapshots[1];
    expect(snapshot.source).toBe("mode-apply");
    expect(snapshot.label).toBe("Anotaciones (1)");
    expect(snapshot.opId).toBe("mode:annotate");
    expect(s.session().result).toMatchObject({ label: "Anotaciones (1)", notices: ["aviso"] });
  });

  it("al aplicar vuelve a la pestaña de la que se vino y devuelve el foco", async () => {
    const s = await setup();
    act(() => s.setTabProp("pages"));
    act(() => s.setTabProp("annotate"));
    act(() => s.session().registerControls(s.controls));
    await act(async () => s.session().requestApply());
    expect(s.setTab).toHaveBeenLastCalledWith("pages");
    expect(s.focusTab).toHaveBeenLastCalledWith("pages");
  });

  it("por defecto vuelve a Inicio", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().registerControls(s.controls));
    await act(async () => s.session().requestApply());
    expect(s.setTab).toHaveBeenLastCalledWith("home");
  });

  it("pide al visor volver a la pagina en la que se trabajaba (la que informo el modo)", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().reportPage(7));
    await act(async () => s.session().requestApply());
    expect(s.restoreViewerPage).toHaveBeenCalledWith(7);
  });

  it("sin pagina informada no toca la del visor", async () => {
    const s = await setup();
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.restoreViewerPage).not.toHaveBeenCalled();
  });

  it("dos «Aplicar» seguidos lanzan UNA sola aplicacion (cerrojo sincrono)", async () => {
    const s = await setup({ signatures: "active" });
    enter(s);
    act(() => {
      s.session().requestApply();
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
    await act(async () => s.session().actions.signaturesConfirm());
    await waitFor(() => expect(s.doc.getState().document!.snapshots).toHaveLength(2));
    expect(s.applySpy).toHaveBeenCalledTimes(1);
  });

  it("si el documento se cerro mientras se aplicaba, onApply lanza ProModeStaleError y NO guarda", async () => {
    const s = await setup({ tab: "annotate" });
    const onApply = s.session().onApply;
    s.doc.close();
    await expect(onApply(fakeBytes(70, 3), "X")).rejects.toBeInstanceOf(ProModeStaleError);
  });

  it("un ProModeStaleError se muestra como aviso amable", async () => {
    const s = await setup();
    s.controls.apply = async () => {
      s.doc.close();
      await s.session().onApply(fakeBytes(70, 3), "X");
      return true;
    };
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.session().error).toBe(MODE_STRINGS.es.host.applyStale);
  });

  it("un error con texto propio (ProModeApplyError) se conserva tal cual", async () => {
    const s = await setup();
    s.controls.apply = async () => {
      throw new ProModeApplyError("Texto propio");
    };
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.session().error).toBe("Texto propio");
  });

  it("un error cualquiera cae en el aviso generico", async () => {
    const s = await setup();
    s.controls.apply = async () => {
      throw new Error("interno");
    };
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.session().error).toBe(MODE_STRINGS.es.host.applyFailed);
  });

  it("sin controles registrados, requestApply no hace nada", async () => {
    const s = await setup({ tab: "annotate" });
    await act(async () => s.session().requestApply());
    expect(s.doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("dismissResult retira el resultado", async () => {
    const s = await setup();
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.session().result).not.toBeNull();
    act(() => s.session().dismissResult());
    expect(s.session().result).toBeNull();
  });
});

describe("firmas digitales", () => {
  it("con firmas activas, aplicar abre la hoja y NO llama al modo hasta confirmar", async () => {
    const s = await setup({ signatures: "active" });
    enter(s);
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
    expect(s.applySpy).not.toHaveBeenCalled();
  });

  it("cancelar la hoja de firmas no aplica y deja el cerrojo libre", async () => {
    const s = await setup({ signatures: "active" });
    enter(s);
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
    await act(async () => s.session().actions.signaturesCancel());
    expect(s.applySpy).not.toHaveBeenCalled();
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
  });

  it("firmas «unknown» tambien piden confirmacion (nunca se lee como «sin firmas»)", async () => {
    const s = await setup({ signatures: "unknown" });
    enter(s);
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
  });

  it("sin firmas no hay hoja", async () => {
    const s = await setup({ signatures: "none" });
    enter(s);
    await act(async () => s.session().requestApply());
    expect(s.session().sheets.signatures.open).toBe(false);
    expect(s.applySpy).toHaveBeenCalledTimes(1);
  });

  it("onApply directo (modo con boton propio) tambien confirma y, si se rechaza, no guarda nada", async () => {
    const s = await setup({ tab: "annotate", signatures: "active" });
    let done = false;
    act(() => {
      void s.session().onApply(fakeBytes(70, 4), "Firma").then(() => (done = true));
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
    await act(async () => s.session().actions.signaturesCancel());
    await waitFor(() => expect(done).toBe(true));
    expect(s.doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("onApply directo con confirmacion guarda el snapshot", async () => {
    const s = await setup({ tab: "annotate", signatures: "active" });
    act(() => {
      void s.session().onApply(fakeBytes(70, 4), "Firma");
    });
    await waitFor(() => expect(s.session().sheets.signatures.open).toBe(true));
    await act(async () => s.session().actions.signaturesConfirm());
    await waitFor(() => expect(s.doc.getState().document!.snapshots).toHaveLength(2));
  });
});

describe("descartar", () => {
  it("sin cambios descarta al momento: limpia el modo, anuncia y vuelve", async () => {
    const s = await setup();
    enter(s);
    await act(async () => s.session().requestDiscard());
    await waitFor(() => expect(s.setTab).toHaveBeenCalledWith("home"));
    expect(s.discardSpy).toHaveBeenCalledTimes(1);
    expect(s.doc.getState().announcement?.text).toBe(MODE_STRINGS.es.host.discarded("Anotar"));
    expect(s.doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("con cambios abre la confirmacion y no descarta todavia", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    act(() => s.session().requestDiscard());
    expect(s.session().sheets.discard.open).toBe(true);
    expect(s.discardSpy).not.toHaveBeenCalled();
  });

  it("confirmar descarta; cancelar cierra la hoja y deja todo como estaba", async () => {
    const s = await setup();
    enter(s);
    act(() => s.session().onDirtyChange(true));
    act(() => s.session().requestDiscard());
    act(() => s.session().actions.discardCancel());
    expect(s.session().sheets.discard.open).toBe(false);
    expect(s.discardSpy).not.toHaveBeenCalled();
    act(() => s.session().requestDiscard());
    await act(async () => s.session().actions.discardConfirm());
    await waitFor(() => expect(s.discardSpy).toHaveBeenCalledTimes(1));
  });

  it("descartar se ignora mientras se aplica", async () => {
    const s = await setup();
    s.controls.apply = () => new Promise<boolean>(() => undefined);
    enter(s);
    act(() => {
      s.session().requestApply();
    });
    await waitFor(() => expect(s.session().busy).toBe(true));
    act(() => s.session().requestDiscard());
    expect(s.discardSpy).not.toHaveBeenCalled();
  });
});

describe("intencion de herramienta", () => {
  it("setIntent crea una peticion con un nonce que crece", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().setIntent("image"));
    const first = s.session().intent!;
    act(() => s.session().setIntent("image"));
    const second = s.session().intent!;
    expect(first.tool).toBe("image");
    expect(second.nonce).toBeGreaterThan(first.nonce);
  });

  it("setIntent(null) la borra", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().setIntent("rect"));
    act(() => s.session().setIntent(null));
    expect(s.session().intent).toBeNull();
  });

  it("al salir del modo la peticion desaparece", async () => {
    const s = await setup({ tab: "annotate" });
    act(() => s.session().setIntent("note"));
    act(() => s.setTabProp("home"));
    expect(s.session().intent).toBeNull();
  });
});
