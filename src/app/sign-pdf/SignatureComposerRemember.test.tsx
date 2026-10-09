import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { installCanvasStubs } from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/**
 * Casilla «Recordar en este dispositivo» del compositor (W3). Es un callback
 * APARTE (`onRemember`): el contrato de `onSave` no cambia (ver
 * SignatureComposer.test.tsx).
 */

const strings = SIGN_STRINGS.es;
let restoreCanvas = () => {};

beforeEach(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs();
});
afterEach(() => restoreCanvas());

type Props = Partial<React.ComponentProps<typeof SignatureComposer>>;

function ui(props: Props = {}) {
  return (
    <LanguageProvider>
      <SignatureComposer
        open
        onClose={() => {}}
        onSave={() => {}}
        strings={strings}
        {...props}
      />
    </LanguageProvider>
  );
}

/** Pasa a «Escribir» y teclea algo: el unico modo con salida en jsdom. */
function typeSignature(text = "Ana") {
  fireEvent.click(screen.getByRole("tab", { name: strings.modeType }));
  fireEvent.change(screen.getByLabelText(strings.typeLabel), {
    target: { value: text },
  });
}

const remember = () =>
  screen.getByRole("checkbox", { name: strings.vaultRemember }) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: strings.save });

describe("SignatureComposer — casilla «Recordar en este dispositivo»", () => {
  it("sin onRemember no hay casilla ni region de estado extra", () => {
    render(ui());
    expect(screen.queryByRole("checkbox", { name: strings.vaultRemember })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("con onRemember la casilla sale DESMARCADA, con su aviso de privacidad, y sin campo de nombre", () => {
    render(ui({ onRemember: vi.fn() }));
    expect(remember().checked).toBe(false);
    expect(screen.getByText(strings.vaultRememberHint)).toBeTruthy();
    expect(screen.queryByLabelText(strings.vaultRememberNameLabel)).toBeNull();
    // La region de estado esta montada desde el principio, vacia.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("sin marcar la casilla, guardar llama a onSave y NO a onRemember", () => {
    const onSave = vi.fn();
    const onRemember = vi.fn();
    const onClose = vi.fn();
    render(ui({ onSave, onRemember, onClose }));
    typeSignature();
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRemember).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("marcada y con nombre: onSave primero y luego onRemember con ese nombre", () => {
    const calls: string[] = [];
    const onSave = vi.fn((draft: SignatureDraft) => {
      void draft;
      calls.push("save");
    });
    const onRemember = vi.fn(
      (draft: SignatureDraft, who: { signerName: string }) => {
        void draft;
        void who;
        calls.push("remember");
      },
    );
    render(ui({ onSave, onRemember }));
    typeSignature();
    fireEvent.click(remember());
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "  Ana Pérez  " },
    });
    fireEvent.click(save());
    expect(calls).toEqual(["save", "remember"]);
    const [draft, who] = onRemember.mock.calls[0];
    expect(who).toEqual({ signerName: "Ana Pérez" });
    expect(draft).toEqual(onSave.mock.calls[0][0]);
  });

  it("marcada y SIN nombre: no guarda nada, no cierra, lo explica y enfoca el campo", () => {
    const onSave = vi.fn();
    const onRemember = vi.fn();
    const onClose = vi.fn();
    render(ui({ onSave, onRemember, onClose }));
    typeSignature();
    fireEvent.click(remember());
    // El campo llega precargado con lo escrito en «Escribir»: aqui se borra a proposito.
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "" },
    });
    fireEvent.click(save());
    expect(onSave).not.toHaveBeenCalled();
    expect(onRemember).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(strings.vaultRememberNeedsName);
    const name = screen.getByLabelText(strings.vaultRememberNameLabel);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");

    // Desmarcar la casilla permite guardar la firma sin recordarla.
    fireEvent.click(remember());
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRemember).not.toHaveBeenCalled();
  });

  it("un nombre en blanco (solo espacios) cuenta como sin nombre", () => {
    const onRemember = vi.fn();
    render(ui({ onRemember }));
    typeSignature();
    fireEvent.click(remember());
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "    " },
    });
    fireEvent.click(save());
    expect(onRemember).not.toHaveBeenCalled();
  });

  it("con signerName conocido no pide el nombre: lo usa y lo dice", () => {
    const onRemember = vi.fn();
    render(ui({ onRemember, signerName: "Luis Gómez" }));
    typeSignature();
    fireEvent.click(remember());
    expect(screen.queryByLabelText(strings.vaultRememberNameLabel)).toBeNull();
    expect(screen.getByText(strings.vaultRememberFor("Luis Gómez"))).toBeTruthy();
    fireEvent.click(save());
    expect(onRemember.mock.calls[0][1]).toEqual({ signerName: "Luis Gómez" });
  });

  it("al cerrar y volver a abrir la casilla vuelve a estar desmarcada y sin nombre", () => {
    const { rerender } = render(ui({ onRemember: vi.fn() }));
    fireEvent.click(remember());
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "Ana" },
    });
    rerender(ui({ onRemember: vi.fn(), open: false }));
    rerender(ui({ onRemember: vi.fn(), open: true }));
    expect(remember().checked).toBe(false);
    fireEvent.click(remember());
    expect((screen.getByLabelText(strings.vaultRememberNameLabel) as HTMLInputElement).value).toBe("");
  });

  it("la casilla es un checkbox nativo (enfocable y operable con teclado)", () => {
    render(ui({ onRemember: vi.fn() }));
    const box = remember();
    expect(box.type).toBe("checkbox");
    box.focus();
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it("el nombre NO se pide dos veces: el campo de «Recordar» llega precargado con lo escrito en «Escribir»", () => {
    const onRemember = vi.fn();
    render(ui({ onRemember }));
    typeSignature("Ana Pérez");
    fireEvent.click(remember());
    const name = screen.getByLabelText(strings.vaultRememberNameLabel) as HTMLInputElement;
    expect(name.value).toBe("Ana Pérez");
    // Se puede guardar tal cual, sin escribir nada mas.
    fireEvent.click(save());
    expect(onRemember.mock.calls[0][1]).toEqual({ signerName: "Ana Pérez" });
  });

  it("lo precargado sigue lo que se teclea hasta que se edita el campo; despues manda lo editado", () => {
    render(ui({ onRemember: vi.fn() }));
    typeSignature("Ana");
    fireEvent.click(remember());
    const name = () =>
      screen.getByLabelText(strings.vaultRememberNameLabel) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana P" } });
    expect(name().value).toBe("Ana P");
    fireEvent.change(name(), { target: { value: "Ana Pérez Ruiz" } });
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Otra cosa" } });
    expect(name().value).toBe("Ana Pérez Ruiz");
  });

  it("las iniciales NO se precargan como nombre (no son un nombre)", () => {
    render(ui({ onRemember: vi.fn(), variant: "initials" }));
    typeSignature("AP");
    fireEvent.click(remember());
    expect(
      (screen.getByLabelText(strings.vaultRememberNameLabel) as HTMLInputElement).value,
    ).toBe("");
  });

  it("al reabrir, la precarga vuelve a seguir lo escrito (no queda un nombre editado de antes)", () => {
    const { rerender } = render(ui({ onRemember: vi.fn() }));
    typeSignature("Ana");
    fireEvent.click(remember());
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "Editado" },
    });
    rerender(ui({ onRemember: vi.fn(), open: false }));
    rerender(ui({ onRemember: vi.fn(), open: true }));
    typeSignature("Luis");
    fireEvent.click(remember());
    expect(
      (screen.getByLabelText(strings.vaultRememberNameLabel) as HTMLInputElement).value,
    ).toBe("Luis");
  });
});
