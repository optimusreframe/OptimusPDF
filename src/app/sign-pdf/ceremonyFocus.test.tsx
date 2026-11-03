import "fake-indexeddb/auto";
import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MultiFlow, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { SigningCeremony, captureStamp, type CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { QUICK_SIGN_STRINGS } from "@/app/sign-pdf/fillMode/fillStrings";
import { useCeremonyFocus } from "@/app/sign-pdf/useCeremonyFocus";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import type { CeremonyState } from "@/app/sign-pdf/blockModel";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";

/*
 * Foco de la ceremonia de UN documento (arreglo pre-existente de la W4) y de
 * los botones «Atrás» / «Continuar» de `MultiFlow`. Antes, cada boton pulsado
 * se desmontaba y el foco caia a <body>. Cada test lo comprueba contra el
 * elemento real y falla si se quita `useCeremonyFocus` (o el efecto de paso).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const DOC = "contrato.pdf:2048:1700000000000";
const DRAFT: SignatureDraft = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

function field(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}
const FIELDS = [field("f1", ANA.id), field("f2", LUIS.id)];

function signedAll(): CaptureMap {
  return {
    [ANA.id]: { signature: DRAFT, initials: null, stamp: captureStamp(DOC, FIELDS, ANA.id) },
    [LUIS.id]: { signature: DRAFT, initials: null, stamp: captureStamp(DOC, FIELDS, LUIS.id) },
  };
}

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 600,
      height: 800,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
});

/**
 * El turno se DERIVA del primer firmante pendiente al montar (Fase 0 · U0.2): con todos ya firmados no hay
 * turno que mostrar. Las pruebas que recorren el turno con los trazos precargados lo declaran guardado.
 */
const ANA_TURN: CeremonyState = { signerId: ANA.id, stage: "handoff" };
const LUIS_TURN: CeremonyState = { signerId: LUIS.id, stage: "handoff" };

function Ceremony({
  captures = signedAll(),
  ceremony,
}: {
  captures?: CaptureMap;
  /** Turno guardado inicial; con valor, la ceremonia va CONTROLADA (como en la sesion real). */
  ceremony?: CeremonyState | null;
}) {
  const [current, setCurrent] = useState<CaptureMap>(captures);
  const [turn, setTurn] = useState<CeremonyState | null>(ceremony ?? null);
  return (
    <LanguageProvider>
      <SigningCeremony
        {...(ceremony !== undefined ? { ceremony: turn, onCeremonyChange: setTurn } : {})}
        signers={[ANA, LUIS]}
        fields={FIELDS}
        captures={current}
        onCapturesChange={setCurrent}
        documentKey={DOC}
        onFinish={() => {}}
        strings={strings}
      />
    </LanguageProvider>
  );
}

const heading = (name: string) => screen.getByRole("heading", { name });
const readyButtons = () => screen.getAllByRole("button", { name: strings.handoffReady });

describe("SigningCeremony — el foco no cae a <body> al cambiar de etapa o de turno", () => {
  it("al montar no roba el foco", () => {
    render(<Ceremony />);
    expect(document.activeElement).toBe(document.body);
  });

  it("«Estoy listo» -> encabezado de la captura", () => {
    render(<Ceremony ceremony={ANA_TURN} />);
    fireEvent.click(readyButtons()[0]);
    const h = heading(strings.captureTitle("Ana"));
    expect(h.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(h);
  });

  it("«Continuar» -> encabezado de la revision", () => {
    // Luis aun no ha firmado: la revision de Ana es su propia tarjeta (con todos firmados seria la pantalla unica, ver abajo).
    render(<Ceremony ceremony={ANA_TURN} captures={{ [ANA.id]: signedAll()[ANA.id] }} />);
    fireEvent.click(readyButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(document.activeElement).toBe(heading(strings.reviewTitle("Ana")));
  });

  it("«Rehacer» -> vuelve al encabezado de la captura", () => {
    render(<Ceremony ceremony={ANA_TURN} captures={{ [ANA.id]: signedAll()[ANA.id] }} />);
    fireEvent.click(readyButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewRedo }));
    expect(document.activeElement).toBe(heading(strings.captureTitle("Ana")));
  });

  it("«Siguiente» -> traspaso del siguiente firmante", () => {
    // Luis aun no ha firmado: es el siguiente turno (a quien ya firmo no se le pasa el dispositivo).
    render(<Ceremony ceremony={ANA_TURN} captures={{ [ANA.id]: signedAll()[ANA.id] }} />);
    fireEvent.click(readyButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(document.activeElement).toBe(heading(strings.handoffTitle("Luis")));
  });

  it("al pasar el ultimo turno -> titulo de «Revisa y descarga» (una sola pantalla, sin «He terminado»)", () => {
    // El ultimo turno (Luis) con todo ya recogido: al «Continuar» no queda nadie y la revision y la descarga son UNA pantalla
    // (W3-B2). La tarjeta de revision del turno no se pinta y el foco va al titulo de la tarjeta final (el balance de la ronda).
    render(<Ceremony ceremony={LUIS_TURN} />);
    fireEvent.click(readyButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(screen.queryByRole("button", { name: strings.reviewFinish })).toBeNull();
    expect(document.activeElement).toBe(heading(QUICK_SIGN_STRINGS.es.finalTitle));
  });

  it("«Cambiar mi firma» de «Revisa y descarga» -> vuelve al encabezado de la captura", () => {
    render(<Ceremony ceremony={LUIS_TURN} />);
    fireEvent.click(readyButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: QUICK_SIGN_STRINGS.es.finalRedo }));
    expect(document.activeElement).toBe(heading(strings.captureTitle("Luis")));
  });

  it("goToTurn desde la lista de la ronda -> traspaso de ese firmante", () => {
    render(<Ceremony captures={{}} />);
    // [0] traspaso de Ana; [1] y [2] los de la lista (Ana, Luis).
    fireEvent.click(readyButtons()[2]);
    expect(document.activeElement).toBe(heading(strings.handoffTitle("Luis")));
  });

  it("si la etapa y el turno no cambian, no se mueve el foco", () => {
    render(<Ceremony captures={{}} />);
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    fireEvent.click(readyButtons()[1]);
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe("useCeremonyFocus — contrato del gancho", () => {
  function Probe({ stage, position }: { stage: string; position: number }) {
    const ref = useCeremonyFocus(stage, position);
    return (
      <h4 ref={ref} tabIndex={-1}>
        {stage}
        {position}
      </h4>
    );
  }

  it("no enfoca al montar ni al repetir el mismo par; enfoca al cambiar la etapa o el turno", () => {
    const { rerender } = render(<Probe stage="a" position={0} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Probe stage="a" position={0} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Probe stage="b" position={0} />);
    expect(document.activeElement).toBe(screen.getByRole("heading"));
    (document.activeElement as HTMLElement).blur();
    rerender(<Probe stage="b" position={1} />);
    expect(document.activeElement).toBe(screen.getByRole("heading"));
  });
});

/* ------------------------------------------------------------------ *
 * MultiFlow: «Atras» y «Continuar»
 * ------------------------------------------------------------------ */

const PRIMERO = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_000_000,
});
let CLAVE = "";
beforeAll(async () => {
  CLAVE = await documentContentKey(PRIMERO);
});

function flowOptions(step: SignToolOptions["step"]): SignToolOptions {
  return {
    mode: "multi",
    signaturePng: "",
    ratio: 0,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    signature: CLAVE,
    step,
    signers: [ANA],
    fields: [field("f1", ANA.id)],
    captures: {},
    activeSignerId: ANA.id,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: CLAVE,
  };
}

function Flow({ step }: { step: SignToolOptions["step"] }) {
  const [options, setOptions] = useState<SignToolOptions>(() => flowOptions(step));
  const patch = useCallback(
    (next: Partial<SignToolOptions>) => setOptions((previous) => ({ ...previous, ...next })),
    [],
  );
  return (
    <MultiFlow
      file={PRIMERO}
      options={options}
      setOptions={patch}
      onFinish={() => {}}
      strings={strings}
    />
  );
}

const stepButton = (index: number, label: string) =>
  screen.getByRole("button", { name: `${index}. ${label}` });
const nextButton = () => screen.queryByRole("button", { name: strings.next });
const backButton = () => screen.queryByRole("button", { name: strings.back });

async function settled() {
  await waitFor(() => expect(screen.queryByText(strings.checkingDocument)).toBeNull());
}

describe("MultiFlow — el foco no se pierde al llegar al ultimo / primer paso", () => {
  it("al montar en cualquier paso no se roba el foco", async () => {
    render(
      <LanguageProvider>
        <Flow step="document" />
      </LanguageProvider>,
    );
    await settled();
    expect(document.activeElement).toBe(document.body);
  });

  it("«Continuar» del paso Documento: en el ultimo paso ya no hay «Continuar» y el foco va al paso actual de la barra", async () => {
    render(
      <LanguageProvider>
        <Flow step="document" />
      </LanguageProvider>,
    );
    await settled();
    const next = nextButton()!;
    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    await waitFor(() => expect(nextButton()).toBeNull());
    const current = stepButton(3, strings.stepSign);
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(document.activeElement).toBe(current);
  });

  it("«Atrás» hasta el primer paso: ya no hay «Atrás» y el foco va a «1. Firmantes»", async () => {
    render(
      <LanguageProvider>
        <Flow step="document" />
      </LanguageProvider>,
    );
    await settled();
    const back = backButton()!;
    back.focus();
    fireEvent.click(back);
    await waitFor(() => expect(backButton()).toBeNull());
    expect(document.activeElement).toBe(stepButton(1, strings.stepSigners));
  });

  it("aunque «Continuar» siga en pantalla (de Firmantes a Documento), el foco va al paso nuevo de la barra: la vista empieza arriba del paso (SC-01)", async () => {
    render(
      <LanguageProvider>
        <Flow step="signers" />
      </LanguageProvider>,
    );
    await settled();
    const next = nextButton()!;
    next.focus();
    fireEvent.click(next);
    await waitFor(() =>
      expect(stepButton(2, strings.stepDocument).getAttribute("aria-current")).toBe("step"),
    );
    // Antes el foco se quedaba en «Continuar», al final de un paso largo y fuera de la vista tras el cambio de paso.
    expect(document.activeElement).toBe(stepButton(2, strings.stepDocument));
    // El cambio de paso se anuncia en una region viva (sin `role`, para no duplicar los `status` de la pagina).
    expect(document.querySelector("[data-step-announce]")?.textContent).toBe(
      strings.stepAnnounce(2, 3, strings.stepDocument),
    );
  });

  it("pulsar un paso de la barra deja el foco en ese paso", async () => {
    render(
      <LanguageProvider>
        <Flow step="signers" />
      </LanguageProvider>,
    );
    await settled();
    const target = stepButton(3, strings.stepSign);
    target.focus();
    fireEvent.click(target);
    await waitFor(() => expect(target.getAttribute("aria-current")).toBe("step"));
    expect(document.activeElement).toBe(target);
    expect(within(document.body).getByRole("navigation", { name: strings.ceremonyTitle })).toBeTruthy();
  });
});
