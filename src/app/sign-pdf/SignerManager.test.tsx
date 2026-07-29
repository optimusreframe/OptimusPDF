import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SignerManager } from "@/app/sign-pdf/SignerManager";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGNER_COLORS, type Signer } from "@/lib/pdf/sign";

const strings = SIGN_STRINGS.es;

/** Envoltura controlada: el componente no guarda la lista, la publica. */
function Harness({ onChange }: { onChange: (signers: Signer[]) => void }) {
  const [signers, setSigners] = useState<Signer[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <SignerManager
      signers={signers}
      onSignersChange={(next) => {
        setSigners(next);
        onChange(next);
      }}
      activeSignerId={activeId}
      onActiveSignerIdChange={setActiveId}
      strings={strings}
    />
  );
}

function addSigner() {
  fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
}

describe("SignerManager — src/app/sign-pdf/SignerManager.tsx", () => {
  it("dar de alta un firmante lo añade a la lista con un color de la paleta", () => {
    let last: Signer[] = [];
    render(<Harness onChange={(signers) => (last = signers)} />);

    expect(screen.getByRole("alert").textContent).toBe(strings.noSigners);

    addSigner();

    expect(last).toHaveLength(1);
    expect(last[0].name).toBe(strings.defaultSignerName(1));
    expect(SIGNER_COLORS as readonly string[]).toContain(last[0].color);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cada alta suma un firmante con id propio y color distinto", () => {
    let last: Signer[] = [];
    render(<Harness onChange={(signers) => (last = signers)} />);

    addSigner();
    addSigner();
    addSigner();

    expect(last).toHaveLength(3);
    expect(new Set(last.map((signer) => signer.id)).size).toBe(3);
    expect(new Set(last.map((signer) => signer.color)).size).toBe(3);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("borrar un firmante lo saca de la lista y recoloca los colores", () => {
    let last: Signer[] = [];
    render(<Harness onChange={(signers) => (last = signers)} />);

    addSigner();
    addSigner();
    addSigner();
    const second = last[1];
    const third = last[2];

    fireEvent.click(
      screen.getByRole("button", { name: strings.removeSigner(second.name) }),
    );

    expect(last).toHaveLength(2);
    expect(last.map((signer) => signer.id)).not.toContain(second.id);
    expect(last.map((signer) => signer.id)).toContain(third.id);
    // El tercero hereda el color del hueco que ha quedado libre.
    expect(last[1].color).toBe(SIGNER_COLORS[1]);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("renombrar publica el nombre nuevo sin tocar al resto", () => {
    let last: Signer[] = [];
    render(<Harness onChange={(signers) => (last = signers)} />);

    addSigner();
    addSigner();

    fireEvent.change(
      screen.getByLabelText(strings.signerNameLabel(1)) as HTMLInputElement,
      { target: { value: "Ana" } },
    );

    expect(last[0].name).toBe("Ana");
    expect(last[1].name).toBe(strings.defaultSignerName(2));
  });

  it("no deja pasar del tamaño de la paleta", () => {
    render(<Harness onChange={() => {}} />);

    for (let index = 0; index < SIGNER_COLORS.length; index += 1) addSigner();

    const button = screen.getByRole("button", {
      name: strings.addSigner,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(strings.signerLimit)).toBeTruthy();
  });
});
