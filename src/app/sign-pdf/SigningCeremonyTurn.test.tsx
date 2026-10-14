import "fake-indexeddb/auto";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  SigningCeremony,
  captureStamp,
  type CaptureMap,
  type SignerCapture,
} from "@/app/sign-pdf/SigningCeremony";
import type { CeremonyState } from "@/app/sign-pdf/blockModel";
import { clearVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { installCanvasStubs, pngDataUrl, vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * Ceremonia de UN documento (`SigningCeremony`) · Fase 0 «Firma agil», U0.2: el turno se deriva de lo que falta,
 * se guarda en la sesion (sobrevive a remontar la ceremonia: «Atras» -> «Continuar»), «Ver como queda» dice QUE
 * falta y hay una lista de progreso. Los de `BlockCeremony` (varios documentos) estan en su propio archivo.
 */

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const DOC = "contrato.pdf:2048:1700000000000";
const DRAFT: SignatureDraft = { dataUrl: pngDataUrl({ seed: 5 }), ratio: 0.5 };

function field(id: string, signerId: string, type: SignatureField["type"] = "signature"): SignatureField {
  return { id, signerId, pageIndex: 0, type, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } };
}

/** Ana firma e inicia; Luis firma. */
const FIELDS = [field("f1", ANA.id), field("f2", ANA.id, "initials"), field("f3", LUIS.id)];

function captured(signerId: string, parts: Pick<SignerCapture, "signature" | "initials">): SignerCapture {
  return { ...parts, stamp: captureStamp(DOC, FIELDS, signerId) };
}
const ANA_DONE = captured(ANA.id, { signature: DRAFT, initials: DRAFT });
const ANA_HALF = captured(ANA.id, { signature: DRAFT, initials: null });
const LUIS_DONE = captured(LUIS.id, { signature: DRAFT, initials: null });

const ANA_TURN: CeremonyState = { signerId: ANA.id, stage: "handoff" };
const LUIS_TURN: CeremonyState = { signerId: LUIS.id, stage: "handoff" };

/**
 * La sesion de verdad: capturas y turno viven FUERA de la ceremonia, que se desmonta y se vuelve a montar.
 * `remontar` simula «Atras» -> «Continuar» (o tocar otra pestana de documento).
 */
function SessionHost({
  captures = {},
  ceremony = null,
  onFinish = () => {},
  controlled = true,
  strs = strings,
}: {
  captures?: CaptureMap;
  ceremony?: CeremonyState | null;
  onFinish?: () => void;
  controlled?: boolean;
  strs?: typeof strings;
}) {
  const [current, setCurrent] = useState<CaptureMap>(captures);
  const [turn, setTurn] = useState<CeremonyState | null>(ceremony);
  const [generation, setGeneration] = useState(0);
  return (
    <LanguageProvider>
      <button type="button" onClick={() => setGeneration((count) => count + 1)}>
        remontar
      </button>
      <output data-testid="stored">{turn ? `${turn.signerId}:${turn.stage}` : "none"}</output>
      <SigningCeremony
        key={generation}
        signers={[ANA, LUIS]}
        fields={FIELDS}
        captures={current}
        onCapturesChange={setCurrent}
        documentKey={DOC}
        onFinish={onFinish}
        strings={strs}
        {...(controlled ? { ceremony: turn, onCeremonyChange: setTurn } : {})}
      />
    </LanguageProvider>
  );
}

const remount = () => fireEvent.click(screen.getByRole("button", { name: "remontar" }));
const stored = () => screen.getByTestId("stored").textContent;
const heading = (name: string) => screen.getByRole("heading", { name });
const ready = () => screen.getAllByRole("button", { name: strings.handoffReady })[0];
const continueButton = () => screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement;

let restoreCanvas = () => {};
beforeEach(async () => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
  restoreCanvas = installCanvasStubs();
  await clearVault();
});
afterEach(() => restoreCanvas());

describe("SigningCeremony — el turno se deriva de lo que falta al montar", () => {
  it("con Ana ya firmada arranca en Luis (Turno 2 de 2), no en Ana", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} controlled={false} />);
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();
  });

  it("sin nadie firmado arranca en el primero; con todos firmados no hay turno (balance)", () => {
    const first = render(<SessionHost controlled={false} />);
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    first.unmount();
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE, [LUIS.id]: LUIS_DONE }} controlled={false} />);
    expect(screen.queryByText(/^Turno \d+ de \d+$/)).toBeNull();
    expect(heading(strings.allSignedTitle)).toBeTruthy();
  });
});

describe("SigningCeremony — el turno guardado en la sesion sobrevive a remontar", () => {
  it("«Atras» -> «Continuar» tras el turno de Ana: sigue el turno de Luis", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} ceremony={ANA_TURN} />);
    fireEvent.click(ready());
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(stored()).toBe("sg-2:handoff");

    remount();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();
  });

  it("la etapa sobrevive: captura de Luis a medias -> remontar -> sigue en su captura", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} ceremony={LUIS_TURN} />);
    fireEvent.click(ready());
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    remount();
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    expect(stored()).toBe("sg-2:capture");
  });

  it("sin guardar nada (solo derivado) remontar no escribe ni inventa turnos", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} />);
    remount();
    expect(stored()).toBe("none");
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
  });

  it("al salto «He terminado» de la ultima persona la ronda se cierra y un remontaje no la reabre", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE, [LUIS.id]: LUIS_DONE }} ceremony={LUIS_TURN} />);
    fireEvent.click(ready());
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("button", { name: strings.reviewFinish }));
    expect(stored()).toBe("none");
    remount();
    expect(heading(strings.allSignedTitle)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();
  });

  it("a quien ya firmo no se le vuelve a pasar el dispositivo: tras Luis, con Ana pendiente, vuelve a Ana", () => {
    render(<SessionHost captures={{ [LUIS.id]: LUIS_DONE }} ceremony={LUIS_TURN} />);
    fireEvent.click(ready());
    fireEvent.click(continueButton());
    expect(screen.getByRole("button", { name: strings.reviewNext })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(heading(strings.handoffTitle("Ana"))).toBeTruthy();
    expect(stored()).toBe("sg-1:handoff");
  });

  it("«Empezar la ronda de nuevo» vacia los trazos y guarda el turno del primero", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE, [LUIS.id]: LUIS_DONE }} ceremony={LUIS_TURN} />);
    fireEvent.click(screen.getByRole("button", { name: strings.restartCeremony }));
    expect(stored()).toBe("sg-1:handoff");
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SigningCeremony — «Ver cómo queda» apagado dice QUE falta", () => {
  it("con firma pero sin iniciales dice «Falta: Iniciales» y enlaza el boton apagado con la frase", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_HALF }} ceremony={ANA_TURN} />);
    fireEvent.click(ready());
    const hint = screen.getByText(strings.ceremonyMissing(["Iniciales"]));
    expect(continueButton().disabled).toBe(true);
    expect(continueButton().getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
  });

  it("sin nada recogido nombra los dos trazos; con todo recogido la frase y el salto desaparecen", () => {
    const empty = render(<SessionHost ceremony={ANA_TURN} />);
    fireEvent.click(ready());
    expect(screen.getByText(strings.ceremonyMissing(["Firma", "Iniciales"]))).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    empty.unmount();

    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} ceremony={ANA_TURN} />);
    fireEvent.click(ready());
    expect(screen.queryByText(/^Falta:/)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.ceremonyGoToMissing })).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  it("«Ir a lo que falta» lleva el foco y la vista a «Crear mis iniciales»", () => {
    const original = Element.prototype.scrollIntoView;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      render(<SessionHost captures={{ [ANA.id]: ANA_HALF }} ceremony={ANA_TURN} />);
      fireEvent.click(ready());
      fireEvent.click(screen.getByRole("button", { name: strings.ceremonyGoToMissing }));
      const target = screen.getByRole("button", { name: strings.captureInitials });
      expect(document.activeElement).toBe(target);
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.instances[0]).toBe(target);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("la lista de progreso (firma + iniciales) marca hecho y falta con icono Y con texto", () => {
    render(<SessionHost captures={{ [ANA.id]: ANA_HALF }} ceremony={ANA_TURN} />);
    fireEvent.click(ready());
    const list = screen.getByRole("list", { name: strings.ceremonyProgressLabel("Ana") });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `Firma${strings.ceremonyItemDone}`,
      `Iniciales${strings.ceremonyItemMissing}`,
    ]);
    expect(items[0].querySelector("svg.lucide-check")).not.toBeNull();
    expect(items[1].querySelector("svg.lucide-circle")).not.toBeNull();
  });

  it("con un solo trazo (solo firma) no hay lista de progreso, pero si la frase", () => {
    // Luis solo firma: su captura es una sola fila.
    render(<SessionHost captures={{ [ANA.id]: ANA_DONE }} ceremony={LUIS_TURN} />);
    fireEvent.click(ready());
    expect(screen.queryByRole("list", { name: strings.ceremonyProgressLabel("Luis") })).toBeNull();
    expect(screen.getByText(strings.ceremonyMissing(["Firma"]))).toBeTruthy();
  });

  it("al aplicar una firma guardada se anuncia lo que falta en la region viva (siempre montada, una sola)", async () => {
    await saveVaultEntry(vaultInput("Ana", { initials: null }));
    render(<SessionHost ceremony={ANA_TURN} />);
    const announced = strings.ceremonyMissing(["Iniciales"]);
    const carrying = () => screen.getAllByRole("status").filter((node) => node.textContent === announced);
    const regionsBefore = screen.getAllByRole("status").length;
    fireEvent.click(ready());
    expect(carrying()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana") }));
    await waitFor(() => expect(carrying()).toHaveLength(1));
    expect(carrying()[0].getAttribute("aria-live")).toBe("polite");
    expect(screen.getAllByRole("status").length).toBe(regionsBefore);
  });

  it("en ingles: la frase, el salto y la lista salen en ingles", () => {
    const en = SIGN_STRINGS.en;
    render(<SessionHost captures={{ [ANA.id]: ANA_HALF }} ceremony={ANA_TURN} strs={en} />);
    fireEvent.click(screen.getAllByRole("button", { name: en.handoffReady })[0]);
    expect(screen.getByText(en.ceremonyMissing([en.fieldInitials]))).toBeTruthy();
    expect(screen.getByRole("button", { name: en.ceremonyGoToMissing })).toBeTruthy();
    expect(screen.getByRole("list", { name: en.ceremonyProgressLabel("Ana") })).toBeTruthy();
  });
});
