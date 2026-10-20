import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { SignerManager } from "@/app/sign-pdf/SignerManager";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider } from "@/lib/i18n";
import type { Signer } from "@/lib/pdf/sign";

/*
 * Objetivos tactiles de 44 px con puntero grueso (caja real, no solo un
 * pseudo-elemento) en los controles pequenos de Firmantes y del aviso de
 * privacidad. Con raton el aspecto no cambia.
 */

const strings = SIGN_STRINGS.es;
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };

function manager() {
  return render(
    <LanguageProvider>
      <SignerManager
        signers={[ANA]}
        onSignersChange={() => {}}
        activeSignerId={ANA.id}
        onActiveSignerIdChange={() => {}}
        strings={strings}
      />
    </LanguageProvider>,
  );
}

describe("objetivos tactiles de 44 px", () => {
  it("el radio de color del firmante mide 44 px con puntero grueso y su aspecto (circulo de 24 px con color) vive en el interior", () => {
    manager();
    const radio = screen.getByRole("radio", { name: "Ana" });
    expect(radio.className).toContain("pointer-coarse:size-11");
    const dot = radio.querySelector("span") as HTMLElement;
    expect(dot.className).toContain("size-6");
    expect(dot.style.backgroundColor).toBe("rgb(13, 75, 255)");
  });

  it("la caja de nombre del firmante mide 44 px con puntero grueso y 36 px con raton", () => {
    manager();
    const input = screen.getByLabelText(strings.signerNameLabel(1));
    expect(input.className).toContain("h-9");
    expect(input.className).toContain("pointer-coarse:h-11");
  });

  it("«Quitar a Ana» mide 44 px con puntero grueso", () => {
    manager();
    expect(screen.getByRole("button", { name: strings.removeSigner("Ana") }).className).toContain(
      "pointer-coarse:size-11",
    );
  });

  it("«Cómo usamos tus datos» y «Cerrar» del aviso de privacidad miden 44 px con puntero grueso", () => {
    render(
      <LanguageProvider>
        <PrivacyNotice strings={strings} />
      </LanguageProvider>,
    );
    // La primera vez se ve el resumen; «Leer completo» abre el texto con su «Cerrar» (ER-03).
    expect(screen.getByRole("button", { name: strings.privacyReadFull }).className).toMatch(/h-11/);
    expect(screen.getByRole("button", { name: strings.privacyUnderstood }).className).toMatch(/h-11/);
    fireEvent.click(screen.getByRole("button", { name: strings.privacyReadFull }));
    expect(screen.getByRole("button", { name: strings.privacyNoticeToggle }).className).toContain(
      "pointer-coarse:min-h-11",
    );
    expect(screen.getByRole("button", { name: "Cerrar" }).className).toContain("pointer-coarse:size-11");
    expect(screen.getByRole("button", { name: strings.privacyClearData }).className).toContain(
      "pointer-coarse:h-11",
    );
  });
});
