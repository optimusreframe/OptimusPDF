import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PasswordSheet, type PasswordSheetStrings } from "@/components/tool/PasswordSheet";

/**
 * La hoja de contrasena generica (Wave 6 · U3), aislada: contrasena mala, buena,
 * cancelar, foco, mostrar/ocultar y estado ocupado. El flujo completo con un PDF
 * cifrado real esta en `ToolShell.errors.test.tsx`.
 */

const STRINGS: PasswordSheetStrings = {
  title: "Documento protegido",
  body: "Escribe la contraseña para abrirlo.",
  label: "Contraseña",
  show: "Mostrar la contraseña",
  hide: "Ocultar la contraseña",
  submit: "Abrir documento",
  opening: "Abriendo…",
  cancel: "Cancelar",
  wrong: "La contraseña no es correcta.",
  failed: "No se pudo abrir.",
  close: "Cerrar",
};

beforeAll(() => {
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
});

type Props = Partial<Parameters<typeof PasswordSheet>[0]>;

function renderSheet(props: Props = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <PasswordSheet
      open
      onClose={onClose}
      onSubmit={onSubmit}
      onCancel={onCancel}
      busy={false}
      wrong={false}
      failed={false}
      attempt={0}
      strings={STRINGS}
      fileName="contrato.pdf"
      {...props}
    />,
  );
  return { ...utils, onSubmit, onCancel, onClose };
}

function field(): HTMLInputElement {
  return screen.getByLabelText(STRINGS.label) as HTMLInputElement;
}

describe("PasswordSheet generica", () => {
  it("muestra titulo, nombre del archivo y el cuerpo, con el campo enfocado y oculto", async () => {
    renderSheet();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(STRINGS.title)).toBeTruthy();
    expect(within(dialog).getByText("contrato.pdf")).toBeTruthy();
    expect(within(dialog).getByText(STRINGS.body)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().type).toBe("password");
    expect(field().autocomplete).toBe("off");
  });

  it("sin nombre de archivo no pinta esa linea", async () => {
    renderSheet({ fileName: undefined });
    await screen.findByRole("dialog");
    expect(screen.queryByText("contrato.pdf")).toBeNull();
  });

  it("«Abrir documento» esta desactivado con el campo vacio y no envia nada", async () => {
    const { onSubmit } = renderSheet();
    await screen.findByRole("dialog");
    const submit = screen.getByRole("button", { name: STRINGS.submit }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(field().closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("contrasena escrita + «Abrir documento» envia exactamente lo escrito (sin recortar)", async () => {
    const { onSubmit } = renderSheet();
    await screen.findByRole("dialog");
    fireEvent.change(field(), { target: { value: " clave con espacios " } });
    fireEvent.click(screen.getByRole("button", { name: STRINGS.submit }));
    expect(onSubmit).toHaveBeenCalledWith(" clave con espacios ");
  });

  it("Enter en el campo tambien envia", async () => {
    const { onSubmit } = renderSheet();
    await screen.findByRole("dialog");
    fireEvent.change(field(), { target: { value: "abc" } });
    fireEvent.submit(field().closest("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledWith("abc");
  });

  it("contrasena mala: mensaje en una region role=status y aria-invalid en el campo", async () => {
    renderSheet({ wrong: true, attempt: 1 });
    await screen.findByRole("dialog");
    const message = screen.getByText(STRINGS.wrong);
    expect(message.getAttribute("role")).toBe("status");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe(message.id);
  });

  it("otro fallo: mensaje propio, distinto del de contrasena incorrecta", async () => {
    renderSheet({ failed: true, attempt: 1 });
    await screen.findByRole("dialog");
    expect(screen.getByText(STRINGS.failed)).toBeTruthy();
    expect(screen.queryByText(STRINGS.wrong)).toBeNull();
  });

  it("sin error la region de estado existe pero vacia para lectores (sr-only), sin aria-invalid", async () => {
    renderSheet();
    await screen.findByRole("dialog");
    expect(field().hasAttribute("aria-invalid")).toBe(false);
    const status = document.querySelector("[data-password-message]") as HTMLElement;
    expect(status.textContent).toBe("");
    expect(status.className).toContain("sr-only");
  });

  it("tras un intento fallido el foco vuelve al campo con el texto seleccionado", async () => {
    function Harness() {
      const [attempt, setAttempt] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            fallar
          </button>
          <PasswordSheet
            open
            onClose={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            busy={false}
            wrong={attempt > 0}
            failed={false}
            attempt={attempt}
            strings={STRINGS}
          />
        </>
      );
    }
    render(<Harness />);
    await screen.findByRole("dialog");
    fireEvent.change(field(), { target: { value: "equivocada" } });
    (screen.getByRole("button", { name: "fallar", hidden: true }) as HTMLButtonElement).focus();
    fireEvent.click(screen.getByRole("button", { name: "fallar", hidden: true }));
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("equivocada".length);
  });

  it("ocupado: campo y boton bloqueados y «Abriendo…» anunciado", async () => {
    renderSheet({ busy: true });
    await screen.findByRole("dialog");
    expect(field().disabled).toBe(true);
    expect(screen.getByText(STRINGS.opening)).toBeTruthy();
    const submit = screen.getByRole("button", { name: STRINGS.submit }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("el ojo muestra y oculta la contrasena, con aria-pressed", async () => {
    renderSheet();
    await screen.findByRole("dialog");
    const eye = screen.getByRole("button", { name: STRINGS.show });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eye);
    expect(field().type).toBe("text");
    const hide = screen.getByRole("button", { name: STRINGS.hide });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(field().type).toBe("password");
  });

  it("«Cancelar» renuncia al documento", async () => {
    const { onCancel, onClose } = renderSheet();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: STRINGS.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc cierra la hoja pero NO cancela (no pierde el documento)", async () => {
    const { onCancel, onClose } = renderSheet();
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("el objetivo del ojo y los botones mide al menos 44 px (clases h-11 / w-11)", async () => {
    renderSheet();
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: STRINGS.show }).className).toContain("w-11");
    expect(screen.getByRole("button", { name: STRINGS.submit }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: STRINGS.cancel }).className).toContain("h-11");
  });

  it("cerrada, no pinta nada", () => {
    renderSheet({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
