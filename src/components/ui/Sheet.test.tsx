import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});

describe("Sheet: contrato ARIA", () => {
  it("expone role dialog con el titulo como nombre, aria-modal y mueve el foco dentro", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Opciones" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
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
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 3000,
    });
  });

  it("el boton de cierre (44px) y el scrim cierran", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const close = screen.getByRole("button", { name: "Cerrar" });
    expect(close.className).toMatch(/size-11/);
    fireEvent.click(close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  it("el scrim no es un control accesible (aria-hidden) pero cierra al tocarlo", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(scrim().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(1);
    fireEvent.click(scrim());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
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
    expect(document.activeElement).toBe(dialog);

    // El padre cierra sin gesto: el dialog sigue montado mientras sale...
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 3000,
    });
    expect(document.activeElement).toBe(opener);
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
    waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), { timeout: 3000 });

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
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), {
      timeout: 3000,
    });
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
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
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
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), {
      timeout: 3000,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("agarrarlo mientras se cierra lo detiene donde esta, sin salto, y onClose no se dispara", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    // El primer render ya esta fuera de pantalla; espera a que termine de entrar.
    expect(translateY(dialog)).toBe(768);
    await settled(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    // Deja avanzar el cierre unos frames.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const midway = translateY(dialog)!;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(768);

    // Agarra: motion sincroniza el valor con el instante del pointerdown
    // (como mucho un frame de recorrido por delante del DOM pintado) y
    // desde ahi queda congelado: dos lecturas separadas por frames coinciden.
    pointer("pointerDown", header(), { pointerId: 9, pointerType: "touch", button: 0, clientY: 300 }, 5000);
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
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), {
      timeout: 3000,
    });
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
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(translateY(dialog) ?? 0).toBe(0);
  });
});

describe("Sheet: pointercancel", () => {
  it("si el navegador reclama el gesto a mitad de un arrastre, el panel vuelve a 0 en vez de decidir por posicion", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), { timeout: 3000 });
    const target = screen.getByRole("heading", { name: "Opciones" }).parentElement!;
    pointer("pointerDown", target, { pointerId: 5, pointerType: "touch", button: 0, clientY: 100 }, 1000);
    pointer("pointerMove", dialog, { pointerId: 5, pointerType: "touch", clientY: 110 }, 1016);
    pointer("pointerMove", dialog, { pointerId: 5, pointerType: "touch", clientY: 600 }, 1032); // 490 px: mas de la mitad
    const cancel = createEvent.pointerCancel(dialog, { pointerId: 5, pointerType: "touch", clientY: 600 });
    Object.defineProperty(cancel, "timeStamp", { value: 1048 });
    fireEvent(dialog, cancel);
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0), { timeout: 3000 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
