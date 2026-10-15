import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LeaveSheet } from "@/app/sign-pdf/LeaveSheet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { LeaveSheetState } from "@/app/sign-pdf/useLeaveGuard";

/** La hoja «¿Salir de la firma?» (U0.3): nombre del dialogo, lo que dice, foco y la opcion segura como valor por defecto. */

const es = SIGN_STRINGS.es.resume;
const en = SIGN_STRINGS.en.resume;

afterEach(cleanup);

function state(over: Partial<LeaveSheetState> = {}): LeaveSheetState {
  return { open: true, saved: true, onStay: vi.fn(), onLeave: vi.fn(), ...over };
}

describe("LeaveSheet", () => {
  it("es un dialogo modal con nombre «¿Salir de la firma?» y dice que todo esta guardado en este dispositivo", async () => {
    render(<LeaveSheet state={state()} strings={es} closeLabel="Cerrar" />);
    const dialog = await screen.findByRole("dialog", { name: "¿Salir de la firma?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Todo está guardado en este dispositivo");
    expect(within(dialog).getByRole("button", { name: "Seguir firmando" }).className).toContain("h-11");
    expect(within(dialog).getByRole("button", { name: "Salir" }).className).toContain("h-11");
  });

  it("si el trabajo NO cupo en el borrador, no promete que esta guardado: dice que se perdera", async () => {
    render(<LeaveSheet state={state({ saved: false })} strings={es} closeLabel="Cerrar" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("Todo está guardado");
    expect(dialog.textContent).toContain("se perderá");
  });

  it("el foco entra por «Seguir firmando» (la opcion segura), no por «Salir»", async () => {
    render(<LeaveSheet state={state()} strings={es} closeLabel="Cerrar" />);
    const stay = await screen.findByRole("button", { name: "Seguir firmando" });
    await waitFor(() => expect(document.activeElement).toBe(stay));
  });

  it("«Seguir firmando» y «Salir» llaman a SU manejador, y no al otro", async () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    render(<LeaveSheet state={state({ onStay, onLeave })} strings={es} closeLabel="Cerrar" />);
    fireEvent.click(await screen.findByRole("button", { name: "Salir" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Seguir firmando" }));
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("Escape y el boton de cerrar equivalen a quedarse (nunca a salir)", async () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    render(<LeaveSheet state={state({ onStay, onLeave })} strings={es} closeLabel="Cerrar" />);
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onStay).toHaveBeenCalled());
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("cerrada no pinta nada", () => {
    render(<LeaveSheet state={state({ open: false })} strings={es} closeLabel="Cerrar" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("en ingles", async () => {
    render(<LeaveSheet state={state()} strings={en} closeLabel="Close" />);
    const dialog = await screen.findByRole("dialog", { name: "Leave signing?" });
    expect(dialog.textContent).toContain("Everything is saved on this device");
    expect(within(dialog).getByRole("button", { name: "Keep signing" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Leave" })).toBeTruthy();
  });
});

describe("LeaveSheet · dice la razon verdadera (F0-fix, D2)", () => {
  it("el navegador no pudo guardar: «No se pudo guardar tu trabajo en este dispositivo: si sales se perderá», sin «guardado»", async () => {
    render(<LeaveSheet state={state({ saved: false, reason: "failed" })} strings={es} closeLabel="Cerrar" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("No se pudo guardar tu trabajo en este dispositivo: si sales se perderá");
    expect(dialog.textContent).not.toContain("Todo está guardado");
    expect(dialog.textContent).not.toContain("demasiado grande");
    // «Seguir firmando» es la accion primaria y recibe el foco.
    const stay = within(dialog).getByRole("button", { name: "Seguir firmando" });
    await waitFor(() => expect(document.activeElement).toBe(stay));
  });

  it("«Solo yo»: «Este modo no guarda borrador», sin «guardado»", async () => {
    render(<LeaveSheet state={state({ saved: false, reason: "solo" })} strings={es} closeLabel="Cerrar" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Este modo no guarda borrador");
    expect(dialog.textContent).not.toContain("Todo está guardado");
  });

  it("no cabe (o sin razon dada) sigue diciendo que es demasiado grande", async () => {
    render(<LeaveSheet state={state({ saved: false, reason: "tooBig" })} strings={es} closeLabel="Cerrar" />);
    expect((await screen.findByRole("dialog")).textContent).toContain("demasiado grande");
  });

  it("en ingles cada razon sale en ingles", async () => {
    const { unmount } = render(<LeaveSheet state={state({ saved: false, reason: "failed" })} strings={en} closeLabel="Close" />);
    expect((await screen.findByRole("dialog")).textContent).toContain(en.leaveBodyFailed);
    unmount();
    render(<LeaveSheet state={state({ saved: false, reason: "solo" })} strings={en} closeLabel="Close" />);
    expect((await screen.findByRole("dialog")).textContent).toContain("This mode does not save a draft");
  });

  it("con la hoja abierta, si el guardado falla DESPUES, el texto pasa de «guardado» a «se perdera» (no se queda mintiendo)", async () => {
    const view = render(<LeaveSheet state={state({ saved: true, reason: null })} strings={es} closeLabel="Cerrar" />);
    expect((await screen.findByRole("dialog")).textContent).toContain("Todo está guardado");
    view.rerender(<LeaveSheet state={state({ saved: false, reason: "failed" })} strings={es} closeLabel="Cerrar" />);
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("No se pudo guardar"));
    expect(screen.getByRole("dialog").textContent).not.toContain("Todo está guardado");
  });
});
