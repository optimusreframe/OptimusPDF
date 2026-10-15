import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __resetDraftActivityForTests, beginDraftWrite } from "@/app/sign-pdf/draftActivity";
import { currentSessionParam, hideSessionFromUrl } from "@/app/sign-pdf/sessionUrl";
import {
  LEAVE_GIVE_UP_MS,
  shouldWarnBeforeUnload,
  useLeaveGuard,
  type SignWork,
} from "@/app/sign-pdf/useLeaveGuard";
import { __resetNavigationGuardForTests, interceptNavigation } from "@/lib/navigationGuard";

/*
 * Las tres redes de seguridad de Firmar al salir (U0.3): `beforeunload` condicionado, la entrada `?s=` del historial con su
 * «Atras», y los enlaces internos. Cada caso prueba UNA decision; ninguno depende del navegador real.
 */

const SESSION = "s-mgl1abc-1k3v9x2a";
const OTHER = "s-mgl1abd-2k3v9x2b";
const WORK: SignWork = { progress: true, draftId: SESSION, saved: true, roundOpen: false };

function render(initial: SignWork | null) {
  return renderHook(({ work }: { work: SignWork | null }) => useLeaveGuard(work), { initialProps: { work: initial } });
}

/** El «Atras» del navegador: se espera al `popstate` que jsdom emite de forma asincrona. */
async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function beforeUnloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/sign-pdf");
});
afterEach(() => {
  __resetDraftActivityForTests();
  __resetNavigationGuardForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shouldWarnBeforeUnload (la decision pura)", () => {
  const base: SignWork = { progress: true, draftId: SESSION, saved: true, roundOpen: false };
  it("sin espacio de trabajo o sin progreso nunca avisa", () => {
    expect(shouldWarnBeforeUnload(null, true)).toBe(false);
    expect(shouldWarnBeforeUnload({ ...base, progress: false, roundOpen: true, saved: false }, true)).toBe(false);
  });
  it("con todo guardado y la ronda en reposo no avisa", () => {
    expect(shouldWarnBeforeUnload(base, false)).toBe(false);
  });
  it("avisa con un cambio sin volcar, con un borrador que no cabe o con la ronda a medias", () => {
    expect(shouldWarnBeforeUnload(base, true)).toBe(true);
    expect(shouldWarnBeforeUnload({ ...base, saved: false }, false)).toBe(true);
    expect(shouldWarnBeforeUnload({ ...base, roundOpen: true }, false)).toBe(true);
  });
});

describe("la entrada ?s= del historial", () => {
  it("con progreso y borrador conocido añade ?s=<id> UNA vez, por mucho que se repinte", () => {
    const before = window.history.length;
    const view = render(WORK);
    expect(currentSessionParam()).toBe(SESSION);
    expect(window.history.length).toBe(before + 1);
    view.rerender({ work: { ...WORK } });
    view.rerender({ work: { ...WORK, roundOpen: true } });
    view.rerender({ work: { ...WORK, saved: false } });
    expect(window.history.length).toBe(before + 1);
  });

  it("sin progreso no escribe nada; sin id de borrador todavia, tampoco", () => {
    const before = window.history.length;
    render({ ...WORK, progress: false });
    render({ ...WORK, draftId: null });
    render(null);
    expect(currentSessionParam()).toBeNull();
    expect(window.history.length).toBe(before);
  });

  it("al perder el progreso se retira ?s= sin añadir entradas; al recuperarlo se reutiliza la entrada", () => {
    const before = window.history.length;
    const view = render(WORK);
    view.rerender({ work: { ...WORK, progress: false } });
    expect(currentSessionParam()).toBeNull();
    expect(window.history.length).toBe(before + 1);
    view.rerender({ work: WORK });
    expect(currentSessionParam()).toBe(SESSION);
    expect(window.history.length).toBe(before + 1);
  });

  it("si el borrador cambia (del documento suelto a la sesion) la entrada se reescribe, no se apila", () => {
    const before = window.history.length;
    const view = render({ ...WORK, draftId: "ab".repeat(32) });
    view.rerender({ work: { ...WORK, draftId: OTHER } });
    expect(currentSessionParam()).toBe(OTHER);
    expect(window.history.length).toBe(before + 1);
  });
});

describe("beforeunload", () => {
  it("con todo guardado y la ronda en reposo cerrar o recargar no molesta", () => {
    render(WORK);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("molesta mientras un cambio no ha llegado al disco, y deja de molestar al llegar", () => {
    render(WORK);
    const end = beginDraftWrite();
    expect(beforeUnloadPrevented()).toBe(true);
    end();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("molesta con un borrador demasiado grande (salir lo pierde) y con la ronda de firmas a medias", () => {
    const view = render({ ...WORK, saved: false });
    expect(beforeUnloadPrevented()).toBe(true);
    view.rerender({ work: { ...WORK, roundOpen: true } });
    expect(beforeUnloadPrevented()).toBe(true);
    view.rerender({ work: WORK });
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("sin progreso no hay manejador: ni con una escritura pendiente se molesta", () => {
    render({ ...WORK, progress: false });
    beginDraftWrite();
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("al desmontar se retira el manejador", () => {
    const view = render({ ...WORK, roundOpen: true });
    expect(beforeUnloadPrevented()).toBe(true);
    view.unmount();
    expect(beforeUnloadPrevented()).toBe(false);
  });
});

describe("«Atras» del navegador", () => {
  it("con progreso, volver a la entrada sin `s` abre la hoja; «Seguir firmando» la cierra y vuelve a poner ?s=", async () => {
    const view = render(WORK);
    expect(view.result.current.open).toBe(false);
    await pressBack();
    expect(currentSessionParam()).toBeNull();
    expect(view.result.current.open).toBe(true);
    expect(view.result.current.saved).toBe(true);

    act(() => view.result.current.onStay());
    expect(view.result.current.open).toBe(false);
    expect(currentSessionParam()).toBe(SESSION);

    // El SIGUIENTE «Atras» tambien pregunta (por eso se vuelve a empujar la entrada).
    await pressBack();
    expect(view.result.current.open).toBe(true);
  });

  it("sin progreso el «Atras» no pregunta nada", async () => {
    window.history.pushState(null, "", "/sign-pdf?x=1");
    const view = render({ ...WORK, progress: false });
    await pressBack();
    expect(view.result.current.open).toBe(false);
  });

  it("sin espacio de trabajo (null) el «Atras» tampoco pregunta", async () => {
    window.history.pushState(null, "", "/sign-pdf?x=1");
    const view = render(null);
    await pressBack();
    expect(view.result.current.open).toBe(false);
  });

  it("volver ADELANTE a la entrada con `s` cierra la hoja: ya no hay nada que preguntar", async () => {
    const view = render(WORK);
    await pressBack();
    expect(view.result.current.open).toBe(true);
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(currentSessionParam()).toBe(SESSION);
    expect(view.result.current.open).toBe(false);
  });

  it("«Salir» sigue el camino del navegador (un paso atras) y NO vuelve a preguntar ni a avisar al cerrar", async () => {
    const view = render({ ...WORK, roundOpen: true });
    await pressBack();
    expect(view.result.current.open).toBe(true);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => view.result.current.onLeave());
    expect(back).toHaveBeenCalledTimes(1);
    expect(view.result.current.open).toBe(false);
    // Mientras sale, ni la hoja ni el aviso del navegador se interponen.
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("si «Salir» no saca de la pagina (no habia a donde volver), pasado un rato vuelve la proteccion y ?s=", async () => {
    const view = render({ ...WORK, roundOpen: true });
    await pressBack();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view.result.current.onLeave());
    expect(currentSessionParam()).toBeNull();
    expect(beforeUnloadPrevented()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(LEAVE_GIVE_UP_MS + 1);
    });
    expect(currentSessionParam()).toBe(SESSION);
    expect(beforeUnloadPrevented()).toBe(true);
  });

  it("si la pagina SI se va (desmontaje), el temporizador no escribe `?s=` en la pagina nueva", async () => {
    const view = render(WORK);
    await pressBack();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view.result.current.onLeave());
    view.unmount();
    window.history.replaceState(null, "", "/");
    act(() => {
      vi.advanceTimersByTime(LEAVE_GIVE_UP_MS * 3);
    });
    expect(window.location.search).toBe("");
  });

  it("el texto de la hoja depende de si lo guardado cabe: `saved` sigue al estado del trabajo", async () => {
    const view = render({ ...WORK, saved: false });
    await pressBack();
    expect(view.result.current.open).toBe(true);
    expect(view.result.current.saved).toBe(false);
  });
});

describe("enlaces internos (guarda de navegacion)", () => {
  it("con progreso cancelan la navegacion y abren la hoja; «Salir» repite el enlace; «Seguir» lo olvida", () => {
    const view = render(WORK);
    const proceed = vi.fn();
    let blocked = false;
    act(() => {
      blocked = interceptNavigation("/merge-pdf", proceed);
    });
    expect(blocked).toBe(true);
    expect(view.result.current.open).toBe(true);

    act(() => view.result.current.onStay());
    expect(view.result.current.open).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    // Seguir tras un enlace no toca la direccion (la entrada `?s=` nunca se quito).
    expect(currentSessionParam()).toBe(SESSION);

    act(() => {
      interceptNavigation("/merge-pdf", proceed);
    });
    act(() => view.result.current.onLeave());
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(view.result.current.open).toBe(false);
  });

  it("sin progreso (o sin espacio de trabajo) los enlaces pasan sin preguntar", () => {
    const view = render({ ...WORK, progress: false });
    expect(interceptNavigation("/merge-pdf", () => {})).toBe(false);
    expect(view.result.current.open).toBe(false);
    view.rerender({ work: null });
    expect(interceptNavigation("/merge-pdf", () => {})).toBe(false);
  });

  it("al desmontar la guarda se retira: otras herramientas no quedan afectadas", () => {
    const view = render(WORK);
    view.unmount();
    expect(interceptNavigation("/merge-pdf", () => {})).toBe(false);
  });

  it("la guarda sigue al estado MAS reciente del trabajo (no al del primer pintado)", () => {
    const view = render({ ...WORK, progress: false });
    expect(interceptNavigation("/a", () => {})).toBe(false);
    view.rerender({ work: WORK });
    expect(interceptNavigation("/a", () => {})).toBe(true);
    view.rerender({ work: { ...WORK, progress: false } });
    expect(interceptNavigation("/a", () => {})).toBe(false);
  });
});

describe("la sesion terminada deja una entrada base que se salta", () => {
  it("al terminar (sin progreso) un solo «Atras» sale: la entrada base que dejo la sesion se salta", async () => {
    window.history.replaceState(null, "", "/inicio");
    window.history.pushState(null, "", "/sign-pdf");
    const view = render(WORK);
    expect(currentSessionParam()).toBe(SESSION);
    // Se descarga: no hay espacio de trabajo y la URL se limpia (lo hace `WorkDone`).
    view.rerender({ work: null });
    hideSessionFromUrl();
    expect(window.location.pathname).toBe("/sign-pdf");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    // Un unico «Atras» del usuario llevo hasta la pagina anterior; la hoja no aparecio.
    expect(window.location.pathname).toBe("/inicio");
    expect(view.result.current.open).toBe(false);
  });

  it("en una pagina que nunca puso la entrada (llegada nueva a la base) NO se salta: se puede volver a ella", async () => {
    window.history.replaceState({ optimusSignBase: true }, "", "/sign-pdf");
    window.history.pushState(null, "", "/sign-pdf?x=1");
    const view = render(null);
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(window.location.pathname).toBe("/sign-pdf");
    expect(window.location.search).toBe("");
    expect(view.result.current.open).toBe(false);
  });

  it("con progreso el «Atras» a la base pregunta (no se salta)", async () => {
    window.history.replaceState(null, "", "/inicio");
    window.history.pushState(null, "", "/sign-pdf");
    const view = render(WORK);
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(window.location.pathname).toBe("/sign-pdf");
    expect(view.result.current.open).toBe(true);
  });
});

describe("volver desde la cache de atras/adelante (bfcache)", () => {
  it("la guarda recupera su estado normal: el permiso de salida de «Salir» no se queda puesto", async () => {
    const view = render({ ...WORK, roundOpen: true });
    await pressBack();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => view.result.current.onLeave());
    expect(beforeUnloadPrevented()).toBe(false);
    // La pagina vuelve de la cache tal y como estaba al irse.
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(beforeUnloadPrevented()).toBe(true);
    expect(view.result.current.open).toBe(false);
  });

  it("una carga normal (no persistida) no toca nada", async () => {
    const view = render({ ...WORK, roundOpen: true });
    await pressBack();
    expect(view.result.current.open).toBe(true);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    });
    expect(view.result.current.open).toBe(true);
  });
});

describe("la razon por la que lo de pantalla NO esta a salvo (F0-fix, D2)", () => {
  it("con todo guardado la hoja dice «guardado» y no hay razon", () => {
    const view = render(WORK);
    expect(view.result.current.saved).toBe(true);
    expect(view.result.current.reason).toBeNull();
  });

  it("cada razon llega a la hoja tal cual: no cabe, el navegador no deja guardar y «Solo yo» no guarda", () => {
    const view = render({ ...WORK, saved: false, unsaved: "failed" });
    expect(view.result.current).toMatchObject({ saved: false, reason: "failed" });
    view.rerender({ work: { ...WORK, saved: false, unsaved: "tooBig" } });
    expect(view.result.current).toMatchObject({ saved: false, reason: "tooBig" });
    view.rerender({ work: { ...WORK, saved: false, unsaved: "solo" } });
    expect(view.result.current).toMatchObject({ saved: false, reason: "solo" });
  });

  it("sin razon dada, no guardado sigue significando «no cabe» (como antes de F0-fix)", () => {
    expect(render({ ...WORK, saved: false }).result.current.reason).toBe("tooBig");
  });

  it("«Solo yo» con trabajo: pregunta al cerrar, pone una entrada ?s= (reservada, no restaurable) y el «Atras» abre la hoja con su razon", async () => {
    const solo: SignWork = { progress: true, draftId: "solo", saved: false, unsaved: "solo", roundOpen: false };
    const view = render(solo);
    expect(currentSessionParam()).toBe("solo");
    expect(beforeUnloadPrevented()).toBe(true);
    await pressBack();
    expect(view.result.current.open).toBe(true);
    expect(view.result.current.reason).toBe("solo");
    // «Seguir firmando» la cierra y vuelve a poner la entrada.
    act(() => view.result.current.onStay());
    expect(currentSessionParam()).toBe("solo");
  });

  it("un fallo de escritura hace que cerrar pregunte aunque todo lo demas este en reposo", () => {
    render({ ...WORK, saved: false, unsaved: "failed", roundOpen: false });
    expect(beforeUnloadPrevented()).toBe(true);
  });
});
