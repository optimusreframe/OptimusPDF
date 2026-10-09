import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MAX_SIGNERS, SignerManager } from "@/app/sign-pdf/SignerManager";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGNER_COLORS, type Signer } from "@/lib/pdf/sign";

const strings = SIGN_STRINGS.es;

/** Envoltura controlada: el componente no guarda la lista, la publica. */
function Harness({
  onChange,
  initial = [],
}: {
  onChange: (signers: Signer[]) => void;
  /** Lista heredada (borrador, configuracion): se muestra tal cual, sin pasar por el alta. */
  initial?: Signer[];
}) {
  const [signers, setSigners] = useState<Signer[]>(initial);
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
    expect(last[0].name).toBe("");
    expect(
      (screen.getByLabelText(strings.signerNameLabel(1)) as HTMLInputElement)
        .placeholder,
    ).toBe(strings.defaultSignerName(1));
    expect(SIGNER_COLORS as readonly string[]).toContain(last[0].color);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cada alta suma un firmante con id propio y color distinto", () => {
    let last: Signer[] = [];
    render(<Harness onChange={(signers) => (last = signers)} />);

    addSigner();
    addSigner();

    expect(last).toHaveLength(MAX_SIGNERS);
    expect(new Set(last.map((signer) => signer.id)).size).toBe(MAX_SIGNERS);
    expect(new Set(last.map((signer) => signer.color)).size).toBe(MAX_SIGNERS);
    expect(screen.getAllByRole("radio")).toHaveLength(MAX_SIGNERS);
  });

  it("borrar un firmante lo saca de la lista y recoloca los colores", () => {
    // Con el limite de altas en 2, la lista de tres llega como dato heredado.
    const legacy: Signer[] = [0, 1, 2].map((index) => ({
      id: `sg-${index + 1}`,
      name: "",
      color: SIGNER_COLORS[index],
    }));
    let last: Signer[] = legacy;
    render(<Harness initial={legacy} onChange={(signers) => (last = signers)} />);

    const second = last[1];
    const third = last[2];

    fireEvent.click(
      screen.getByRole("button", {
        name: strings.removeSigner(strings.defaultSignerName(2)),
      }),
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
    expect(last[1].name).toBe("");
  });

  it("no deja pasar del maximo de firmantes", () => {
    render(<Harness onChange={() => {}} />);

    for (let index = 0; index < MAX_SIGNERS; index += 1) addSigner();

    const button = screen.getByRole("button", {
      name: strings.addSigner,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(strings.signerLimit)).toBeTruthy();
  });

  it("una lista heredada con mas firmantes que el maximo se conserva intacta", () => {
    const legacy: Signer[] = [0, 1, 2, 3].map((index) => ({
      id: `sg-${index + 1}`,
      name: `Persona ${index + 1}`,
      color: SIGNER_COLORS[index],
    }));
    render(<Harness initial={legacy} onChange={() => {}} />);

    expect(screen.getAllByRole("radio")).toHaveLength(4);
    const button = screen.getByRole("button", {
      name: strings.addSigner,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(strings.signerLimit)).toBeTruthy();
  });

  it("MAX_SIGNERS es 2 y la paleta conserva sus colores (SOLO_COLOR usa el indice 4)", () => {
    expect(MAX_SIGNERS).toBe(2);
    expect(SIGNER_COLORS.length).toBeGreaterThanOrEqual(5);
  });

  it("el aviso del limite nombra el numero y existe en espanol e ingles", () => {
    expect(SIGN_STRINGS.es.signerLimit).toContain("2");
    expect(SIGN_STRINGS.en.signerLimit).toContain("2");
  });

  it("quitar uno de dos reabre el alta", () => {
    render(<Harness onChange={() => {}} />);
    addSigner();
    addSigner();
    const button = () =>
      screen.getByRole("button", { name: strings.addSigner }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: strings.removeSigner(strings.defaultSignerName(1)),
      }),
    );
    expect(button().disabled).toBe(false);
  });
});
