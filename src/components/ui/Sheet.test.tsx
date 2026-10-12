import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { ConfirmSheet } from "./ConfirmSheet";
import { Sheet } from "./Sheet";

/*
 * Contrato ARIA y de gestos del Sheet (W1-B). jsdom tiene rAF real, asi
 * que las animaciones de motion terminan solas; lo que depende de ellas
 * se espera con waitFor. La velocidad del gesto sale de performance.now(),
 * que aqui se controla a mano.
 */

const translateY = (element: HTMLElement): number | null => {
  const match = /translateY\((-?[\d.]+)px\)/.exec(element.style.transform);
  return match ? Number(match[1]) : null;
};

const scrim = () => document.querySelector<HTMLElement>("[data-sheet-scrim]")!;

function matchMediaStub(reduced: boolean) {
  return (query: string): MediaQueryList =>
    ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

function Harness({
  onClose = () => {},
  initialOpen = true,
}: {
  onClose?: () => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <Sheet
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Opciones"
        closeLabel="Cerrar"
      >
        <input aria-label="Nombre" />
        <button type="button">Aceptar</button>
      </Sheet>
    </div>
  );
}

/*
 * motion escribe el transform en el siguiente frame del frameloop, no en el
 * mismo `set`: tras cada gesto se esperan dos frames antes de leer el DOM.
 */
const frames = () =>
  act(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

type PointerKind = "pointerDown" | "pointerMove" | "pointerUp";

/** Evento de puntero con `timeStamp` propio (es la fuente de la velocidad). */
function pointer(
  kind: PointerKind,
  element: Element,
  init: { pointerId: number; pointerType: string; clientY: number; button?: number },
  timeStamp: number,
) {
  const event = createEvent[kind](element, init);
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(element, event);
}

beforeEach(() => {
  window.matchMedia = matchMediaStub(false);
  resetReducedMotionPrefCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetReducedMotionPrefCache();
  MotionGlobalConfig.skipAnimations = true;
});

describe("Sheet: contrato ARIA", () => {
  it("expone role dialog con el titulo como nombre, aria-modal y mueve el foco dentro", async () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Opciones" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByRole("heading", { name: "Opciones" })).toBeTruthy();
  });

  it("no hay rastro de la tipografia HUD (font-mono, uppercase, etiqueta HUD)", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.outerHTML).not.toMatch(new RegExp("font-mono|uppercase|hud" + "-label"));
    expect(dialog.outerHTML).toMatch(/material-thick/);
    expect(dialog.className).toMatch(/shadow-elevation-3/);
  });

  it("bloquea el scroll del fondo mientras esta abierto y lo restaura al cerrar", async () => {
    const { unmount } = render(<Harness />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("Escape anima la salida y luego llama a onClose; el contenido desaparece", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("el boton de cierre (44px) y el scrim cierran", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const close = screen.getByRole("button", { name: "Cerrar" });
    expect(close.className).toMatch(/size-11/);
    fireEvent.click(close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("el scrim no es un control accesible (aria-hidden) pero cierra al tocarlo", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(scrim().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(1);
    fireEvent.click(scrim());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("atrapa el foco con Tab en ambos sentidos", () => {
    render(<Harness />);
    const close = screen.getByRole("button", { name: "Cerrar" });
    const accept = screen.getByRole("button", { name: "Aceptar" });
    accept.focus();
    fireEvent.keyDown(accept, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(accept);
  });

  it("al cerrar desde el padre (open=false) la salida se anima y el foco vuelve al disparador", async () => {
    render(<Harness initialOpen={false} />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    // El foco lo mueven efectos de la hoja (al montarse y al desmontarse), que
    // React ejecuta DESPUES de que el DOM cambie: se espera a verlo en vez de
    // leerlo en el mismo instante en que aparece/desaparece el nodo.
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    // El padre cierra sin gesto: el dialog sigue montado mientras sale...
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("ConfirmSheet: confirmar llama a onConfirm y onClose; cancelar solo a onClose", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmSheet
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Borrar todo"
        body="No se puede deshacer."
        confirmLabel="Borrar"
        cancelLabel="Cancelar"
        closeLabel="Cerrar"
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Borrar todo" });
    expect(dialog.textContent).toContain("No se puede deshacer.");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Sheet: gestos", () => {
  const header = () =>
    screen.getByRole("heading", { name: "Opciones" }).parentElement!;

  /** Espera a que la entrada termine (el panel arranca fuera de pantalla). */
  const settled = (dialog: HTMLElement) =>
    waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));

  async function drag(steps: Array<{ y: number; dt: number }>, pointerType = "touch") {
    const dialog = screen.getByRole("dialog");
    await settled(dialog);
    let now = 1000;
    let clientY = 100;
    pointer("pointerDown", header(), { pointerId: 7, pointerType, button: 0, clientY }, now);
    for (const step of steps) {
      now += step.dt;
      clientY = step.y;
      pointer("pointerMove", dialog, { pointerId: 7, pointerType, clientY }, now);
    }
    return {
      dialog,
      release: (dt = 0) => {
        now += dt;
        pointer("pointerUp", dialog, { pointerId: 7, pointerType, clientY }, now);
      },
    };
  }

  it("sigue el dedo 1:1 desde la cabecera, respetando el punto de agarre", async () => {
    render(<Harness />);
    const { dialog } = await drag([
      { y: 110, dt: 16 }, // 10 px: supera la histeresis (8) y re-basa el origen
      { y: 160, dt: 16 }, // +50 desde el re-base
    ]);
    await frames();
    expect(translateY(dialog)).toBeCloseTo(50, 0);
  });

  it("rubber-band al tirar hacia arriba pasado el tope", async () => {
    render(<Harness />);
    const { dialog } = await drag([
      { y: 90, dt: 16 },
      { y: -200, dt: 16 }, // -290 px de exceso: se resiste
    ]);
    await frames();
    const offset = translateY(dialog)!;
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-290);
  });

  it("arrastre parcial y lento: vuelve a su sitio sin cerrar", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const { dialog, release } = await drag([
      { y: 110, dt: 16 },
      { y: 200, dt: 300 }, // 90 px en 300 ms = 300 px/s... y luego se queda quieto
      { y: 200, dt: 300 },
    ]);
    release(300); // el dedo lleva quieto: velocidad 0, manda la posicion (90/768 < 0.5)
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("flick rapido hacia abajo cierra aunque el desplazamiento sea corto", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const { release } = await drag([
      { y: 110, dt: 16 },
      { y: 140, dt: 16 },
      { y: 180, dt: 16 }, // ~2500 px/s
    ]);
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("con velocidad hacia arriba vuelve aunque este mas alla de la mitad", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const { dialog, release } = await drag([
      { y: 110, dt: 16 },
      { y: 600, dt: 200 }, // muy abajo (490 px de 768)
      { y: 560, dt: 16 }, // ...pero el dedo sube al soltar
    ]);
    release();
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("agarrarlo mientras se cierra lo detiene donde esta, sin salto, y onClose no se dispara", async () => {
    // Prueba una animacion A MEDIAS: necesita el muelle real, asi que se
    // apaga el `skipAnimations` global del setup (el afterEach lo restaura).
    MotionGlobalConfig.skipAnimations = false;
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    // El primer render ya esta fuera de pantalla; espera a que termine de entrar.
    expect(translateY(dialog)).toBe(768);
    await settled(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    // Agarra la hoja EN CUANTO el cierre lleve un buen tramo recorrido (100 px:
    // lo bastante para que `grabbed - 30` siga siendo positivo, es decir, sin
    // la resistencia elastica de pasar de 0). Se sondea y se agarra en el
    // MISMO callback, sin saltos de microtarea/`act` entre la lectura y el
    // `pointerdown`: motion fija el valor al "ahora" del agarre, asi que
    // cualquier retraso ahi (CPU cargada) deja la hoja mas cerca del final.
    // Antes se dormia un plazo fijo de 60 ms, con el mismo problema.
    const midway = await new Promise<number>((resolve) => {
      const check = () => {
        const current = translateY(dialog) ?? 0;
        if (current > 100) {
          pointer("pointerDown", header(), { pointerId: 9, pointerType: "touch", button: 0, clientY: 300 }, 5000);
          resolve(current);
        } else {
          setTimeout(check, 0);
        }
      };
      check();
    });
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(768);

    // Agarra: motion sincroniza el valor con el instante del pointerdown
    // (como mucho un frame de recorrido por delante del DOM pintado) y
    // desde ahi queda congelado: dos lecturas separadas por frames coinciden.
    await frames();
    const grabbed = translateY(dialog)!;
    expect(grabbed).toBeGreaterThanOrEqual(midway);
    // Sigue lejos del final: el cierre no continuo tras el agarre (el
    // margen es amplio porque con la suite completa los frames se retrasan).
    expect(grabbed).toBeLessThan(700);
    await frames();
    expect(translateY(dialog)).toBeCloseTo(grabbed, 1);
    pointer("pointerMove", dialog, { pointerId: 9, pointerType: "touch", clientY: 280 }, 5016);
    pointer("pointerMove", dialog, { pointerId: 9, pointerType: "touch", clientY: 250 }, 5032);
    await frames();
    // Sigue el dedo desde el valor interrumpido (grabbed - 30 tras el re-base).
    expect(translateY(dialog)!).toBeCloseTo(grabbed - 30, 0);
    pointer("pointerUp", dialog, { pointerId: 9, pointerType: "touch", clientY: 250 }, 5048);
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("con raton solo se arrastra desde la cabecera, no desde el contenido", async () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    const content = screen.getByRole("button", { name: "Aceptar" });
    await settled(dialog);
    pointer("pointerDown", content, { pointerId: 3, pointerType: "mouse", button: 0, clientY: 100 }, 100);
    pointer("pointerMove", dialog, { pointerId: 3, pointerType: "mouse", clientY: 200 }, 116);
    await frames();
    expect(translateY(dialog) ?? 0).toBeCloseTo(0, 0);
  });

  it("reduced motion: la salida es un fundido (opacity -> 0) y no un desplazamiento", async () => {
    window.matchMedia = matchMediaStub(true);
    resetReducedMotionPrefCache();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(translateY(dialog) ?? 0).toBe(0);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(translateY(dialog) ?? 0).toBe(0);
  });
});

describe("Sheet: zonas que gestionan su propio gesto (data-sheet-no-drag)", () => {
  function Drawing({ onClose }: { onClose: () => void }) {
    return (
      <Sheet open onClose={onClose} title="Opciones" closeLabel="Cerrar">
        <div data-sheet-no-drag="" data-testid="lienzo">
          <span data-testid="dentro">trazo</span>
        </div>
        <button type="button">Aceptar</button>
      </Sheet>
    );
  }

  async function touchDrag(target: Element, onClose = vi.fn()) {
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    let now = 2000;
    pointer("pointerDown", target, { pointerId: 5, pointerType: "touch", button: 0, clientY: 300 }, now);
    for (const y of [330, 380, 440, 520]) {
      now += 16;
      pointer("pointerMove", dialog, { pointerId: 5, pointerType: "touch", clientY: y }, now);
    }
    await frames();
    const during = translateY(dialog) ?? 0;
    now += 16;
    pointer("pointerUp", dialog, { pointerId: 5, pointerType: "touch", clientY: 520 }, now);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    return { during, onClose };
  }

  it("un gesto tactil con excursion vertical dentro de la zona NO arrastra la hoja ni la cierra", async () => {
    const onClose = vi.fn();
    render(<Drawing onClose={onClose} />);
    const { during } = await touchDrag(screen.getByTestId("dentro"));
    expect(during).toBeCloseTo(0, 0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("(control) el mismo gesto desde otro contenido de la hoja SI la arrastra", async () => {
    render(<Drawing onClose={() => {}} />);
    const { during } = await touchDrag(screen.getByRole("button", { name: "Aceptar" }));
    expect(during).toBeGreaterThan(50);
  });

  it("(control) desde la cabecera sigue siendo arrastrable", async () => {
    render(<Drawing onClose={() => {}} />);
    const { during } = await touchDrag(
      screen.getByRole("heading", { name: "Opciones" }).parentElement!,
    );
    expect(during).toBeGreaterThan(50);
  });
});

describe("Sheet: pointercancel", () => {
  it("si el navegador reclama el gesto a mitad de un arrastre, el panel vuelve a 0 en vez de decidir por posicion", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    const target = screen.getByRole("heading", { name: "Opciones" }).parentElement!;
    pointer("pointerDown", target, { pointerId: 5, pointerType: "touch", button: 0, clientY: 100 }, 1000);
    pointer("pointerMove", dialog, { pointerId: 5, pointerType: "touch", clientY: 110 }, 1016);
    pointer("pointerMove", dialog, { pointerId: 5, pointerType: "touch", clientY: 600 }, 1032); // 490 px: mas de la mitad
    const cancel = createEvent.pointerCancel(dialog, { pointerId: 5, pointerType: "touch", clientY: 600 });
    Object.defineProperty(cancel, "timeStamp", { value: 1048 });
    fireEvent(dialog, cancel);
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

/*
 * Hojas apiladas (W2-B): Opciones -> Plantillas -> confirmacion. Un solo
 * Escape cerraba TODAS porque cada hoja escuchaba Escape en `window` sin
 * saber de las demas. Debe cerrar solo la superior; el scrim de cada nivel
 * y el foco restaurado van por nivel.
 */
describe("Sheet: hojas apiladas y Escape", () => {
  function Stack({
    nested = false,
    onClose = {},
  }: {
    /** `true`: cada hoja hija es hijo React de la anterior (como una confirmacion dentro de Plantillas). */
    nested?: boolean;
    onClose?: Partial<Record<"a" | "b" | "c", () => void>>;
  }) {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    const [c, setC] = useState(false);
    const sheetC = (
      <Sheet
        open={c}
        onClose={() => {
          onClose.c?.();
          setC(false);
        }}
        title="Confirmar"
        closeLabel="Cerrar confirmar"
      >
        <button type="button">Dentro de C</button>
      </Sheet>
    );
    const sheetB = (
      <Sheet
        open={b}
        onClose={() => {
          onClose.b?.();
          setB(false);
        }}
        title="Plantillas"
        closeLabel="Cerrar plantillas"
      >
        <button type="button" onClick={() => setC(true)}>
          Abrir confirmar
        </button>
        {nested ? sheetC : null}
      </Sheet>
    );
    return (
      <div>
        <button type="button" onClick={() => setA(true)}>
          Abrir opciones
        </button>
        <Sheet
          open={a}
          onClose={() => {
            onClose.a?.();
            setA(false);
          }}
          title="Opciones"
          closeLabel="Cerrar opciones"
        >
          <button type="button" onClick={() => setB(true)}>
            Abrir plantillas
          </button>
          {nested ? sheetB : null}
        </Sheet>
        {nested ? null : sheetB}
        {nested ? null : sheetC}
      </div>
    );
  }

  const dialogNames = () =>
    screen.queryAllByRole("dialog").map((d) => d.getAttribute("aria-label"));

  /** Como un clic real: el boton recibe el foco (jsdom no lo hace solo) y luego el clic. */
  const press = (button: HTMLElement) => {
    button.focus();
    fireEvent.click(button);
  };

  /** Deja pasar mas que la salida de un spring: lo que sobreviva a esto de verdad sigue abierto. */
  const settleExit = () =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)));

  const dialogNamed = (name: string) =>
    screen.queryAllByRole("dialog").find((d) => d.getAttribute("aria-label") === name);

  /**
   * Espera a que la hoja recien abierta se haya llevado el foco al panel.
   * Que su contenido ya este en el DOM no basta: el foco inicial lo mueve
   * un efecto de la hoja, que con la maquina cargada puede ejecutarse
   * DESPUES de que el test pulse el boton siguiente y, al ejecutarse, le
   * quita el foco a ese boton y cambia a que elemento volvera el foco al
   * cerrar la hoja de encima.
   */
  const focusIsIn = (name: string) =>
    waitFor(() => expect(document.activeElement).toBe(dialogNamed(name)));

  async function openThree() {
    press(screen.getByRole("button", { name: "Abrir opciones" }));
    await focusIsIn("Opciones");
    press(await screen.findByRole("button", { name: "Abrir plantillas" }));
    await focusIsIn("Plantillas");
    press(await screen.findByRole("button", { name: "Abrir confirmar" }));
    await focusIsIn("Confirmar");
    await waitFor(() =>
      expect(dialogNames()).toEqual(["Opciones", "Plantillas", "Confirmar"]),
    );
  }

  for (const nested of [false, true]) {
    it(`un Escape cierra solo la hoja superior, tres veces para tres hojas (${nested ? "anidadas" : "hermanas"})`, async () => {
      const closed: string[] = [];
      render(
        <Stack
          nested={nested}
          onClose={{
            a: () => closed.push("a"),
            b: () => closed.push("b"),
            c: () => closed.push("c"),
          }}
        />,
      );
      await openThree();
      expect(scrimCount()).toBe(3);

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(dialogNames()).toEqual(["Opciones", "Plantillas"]));
      await settleExit();
      expect(dialogNames()).toEqual(["Opciones", "Plantillas"]);
      expect(closed).toEqual(["c"]);
      // El foco vuelve al disparador del nivel cerrado (dentro de la hoja de debajo).
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Abrir confirmar" })),
      );
      expect(scrimCount()).toBe(2);

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(dialogNames()).toEqual(["Opciones"]));
      await settleExit();
      expect(dialogNames()).toEqual(["Opciones"]);
      expect(closed).toEqual(["c", "b"]);
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Abrir plantillas" })),
      );
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(dialogNames()).toEqual([]));
      expect(closed).toEqual(["c", "b", "a"]);
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Abrir opciones" })),
      );
      expect(document.body.style.overflow).not.toBe("hidden");
    });
  }

  it("un segundo Escape mientras la superior aun sale ya cierra la siguiente (no se pierde ni se duplica)", async () => {
    const closed: string[] = [];
    render(
      <Stack
        onClose={{
          a: () => closed.push("a"),
          b: () => closed.push("b"),
          c: () => closed.push("c"),
        }}
      />,
    );
    await openThree();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(dialogNames()).toEqual(["Opciones"]));
    await settleExit();
    expect(dialogNames()).toEqual(["Opciones"]);
    expect(closed.sort()).toEqual(["b", "c"]);
  });

  it("arrastrar con el dedo la hoja superior (hija React de la de abajo) no arrastra tambien a la de debajo", async () => {
    render(<Stack nested />);
    await openThree();
    const dialogOf = (name: string) =>
      screen.getAllByRole("dialog").find((d) => d.getAttribute("aria-label") === name)!;
    const top = dialogOf("Confirmar");
    await waitFor(() => expect(translateY(top)).toBeCloseTo(0, 0));
    const header = within(top).getByRole("heading", { name: "Confirmar" }).parentElement!;
    pointer("pointerDown", header, { pointerId: 9, pointerType: "touch", button: 0, clientY: 100 }, 1000);
    pointer("pointerMove", top, { pointerId: 9, pointerType: "touch", clientY: 120 }, 1016);
    pointer("pointerMove", top, { pointerId: 9, pointerType: "touch", clientY: 180 }, 1032);
    await frames();
    expect(translateY(top) ?? 0).toBeGreaterThan(30);
    expect(translateY(dialogOf("Plantillas")) ?? 0).toBeCloseTo(0, 0);
    expect(translateY(dialogOf("Opciones")) ?? 0).toBeCloseTo(0, 0);
  });

  it("un arrastre largo de la hoja superior cierra SOLO la superior", async () => {
    const closed: string[] = [];
    render(
      <Stack
        nested
        onClose={{
          a: () => closed.push("a"),
          b: () => closed.push("b"),
          c: () => closed.push("c"),
        }}
      />,
    );
    await openThree();
    const top = screen.getAllByRole("dialog").find((d) => d.getAttribute("aria-label") === "Confirmar")!;
    await waitFor(() => expect(translateY(top)).toBeCloseTo(0, 0));
    const header = within(top).getByRole("heading", { name: "Confirmar" }).parentElement!;
    pointer("pointerDown", header, { pointerId: 9, pointerType: "touch", button: 0, clientY: 100 }, 1000);
    pointer("pointerMove", top, { pointerId: 9, pointerType: "touch", clientY: 300 }, 1016);
    pointer("pointerMove", top, { pointerId: 9, pointerType: "touch", clientY: 700 }, 1032);
    pointer("pointerUp", top, { pointerId: 9, pointerType: "touch", clientY: 700 }, 1048);
    await waitFor(() => expect(dialogNames()).toEqual(["Opciones", "Plantillas"]));
    await settleExit();
    expect(dialogNames()).toEqual(["Opciones", "Plantillas"]);
    expect(closed).toEqual(["c"]);
  });

  it("el scroll del fondo sigue bloqueado si se cierra la hoja de abajo antes que la de arriba", async () => {
    render(<Stack />);
    await openThree();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar opciones" }));
    await waitFor(() => expect(dialogNames()).toEqual(["Plantillas", "Confirmar"]));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("un Escape que ya atendio otro escuchador sin cerrar nada no rompe la pila: con una sola hoja sigue cerrandola", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

const scrimCount = () => document.querySelectorAll("[data-sheet-scrim]").length;

describe("Sheet: devolver el foco al cerrar (restoreFocusOnClose)", () => {
  function Focusing({ restore }: { restore?: () => boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Abrir
        </button>
        <button type="button">Destino</button>
        <Sheet open={open} onClose={() => setOpen(false)} title="Hoja" closeLabel="Cerrar" restoreFocusOnClose={restore}>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              // La accion que cierra la hoja mueve el foco ella misma.
              screen.getByRole("button", { name: "Destino" }).focus();
            }}
          >
            Hacer
          </button>
        </Sheet>
      </>
    );
  }

  it("por defecto devuelve el foco al disparador; con `restoreFocusOnClose` false respeta el foco que puso la accion", async () => {
    const first = render(<Focusing />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Hacer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    first.unmount();

    render(<Focusing restore={() => false} />);
    const opener2 = screen.getByRole("button", { name: "Abrir" });
    opener2.focus();
    fireEvent.click(opener2);
    fireEvent.click(await screen.findByRole("button", { name: "Hacer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Destino" }));
  });
});

describe("Sheet: foco inicial (initialFocus)", () => {
  function Form({ selector }: { selector?: string }) {
    return (
      <Sheet open onClose={() => {}} title="Formulario" closeLabel="Cerrar" initialFocus={selector}>
        <form data-form="">
          <input aria-label="Nombre" defaultValue="informe.pdf" />
          <button type="button">Aceptar</button>
        </form>
      </Sheet>
    );
  }

  it("sin selector el foco va al panel (comportamiento de siempre)", () => {
    render(<Form />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("con selector el foco va al primer campo y su texto queda seleccionado", () => {
    render(<Form selector="[data-form] input" />);
    const input = screen.getByLabelText("Nombre") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("informe.pdf".length);
  });

  it("un selector que no existe cae al panel (nunca deja el foco en <body>)", () => {
    render(<Form selector="[data-nada]" />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });
});
