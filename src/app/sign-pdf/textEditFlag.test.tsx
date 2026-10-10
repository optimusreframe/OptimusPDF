import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { SoloFlow, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import {
  __resetEditPdfFeatureFlagsCacheForTests,
  setEditPdfFeatureFlag,
} from "@/app/edit-pdf/editFeatureFlags";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/**
 * Ajuste `editExistingText` (Ajustes > Editar PDF): apagado, la herramienta
 * «Editar texto» no aparece en Firmar (W6-A). Si el documento YA trae ediciones
 * sigue disponible, para poder verlas, deshacerlas y quitarlas.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 1, getPage: async () => ({ cleanup: () => {} }) }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", { type: "application/pdf" });

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetValueHistoryCacheForTests();
});

function options(patch: Partial<SignToolOptions> = {}): SignToolOptions {
  return {
    mode: "single",
    signaturePng: "",
    ratio: 0,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    signature: "",
    step: "signers",
    signers: [],
    fields: [],
    captures: {},
    activeSignerId: null,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: null,
    ...patch,
  };
}

function Harness({ initial, withStrings = true }: { initial: SignToolOptions; withStrings?: boolean }) {
  const [state, setState] = useState(initial);
  const patch = useCallback((next: Partial<SignToolOptions>) => setState((previous) => ({ ...previous, ...next })), []);
  return (
    <SoloFlow
      file={FILE}
      options={state}
      setOptions={patch}
      onCreateSignature={() => {}}
      strings={strings}
      editStrings={withStrings ? EDIT_STRINGS.es.inline : undefined}
    />
  );
}

const toolButton = () =>
  within(screen.getByRole("toolbar", { name: strings.paletteLabel })).queryByRole("button", { name: strings.toolEditText });
const palette = () => screen.findByRole("toolbar", { name: strings.paletteLabel });

describe("ajuste editExistingText y herramienta «Editar texto»", () => {
  it("activo (por defecto): la herramienta aparece", async () => {
    render(<Harness initial={options()} />);
    await palette();
    expect(toolButton()).toBeTruthy();
  });

  it("apagado: la herramienta NO aparece", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    render(<Harness initial={options()} />);
    await palette();
    expect(toolButton()).toBeNull();
  });

  it("apagado pero con ediciones ya hechas: sigue disponible (para quitarlas)", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    render(<Harness initial={options({ textEdits: [makeEdit({ id: "e1", blockId: "p0-b0", text: "Hecho" })] })} />);
    await palette();
    expect(toolButton()).toBeTruthy();
  });

  it("sin la copia del editor (quien monta el flujo no la pasa) no hay herramienta, con el ajuste que sea", async () => {
    render(<Harness initial={options()} withStrings={false} />);
    await palette();
    expect(toolButton()).toBeNull();
  });

  it("encender el ajuste con la pagina abierta la hace aparecer sin recargar", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    render(<Harness initial={options()} />);
    await palette();
    expect(toolButton()).toBeNull();
    setEditPdfFeatureFlag("editExistingText", true);
    await waitFor(() => expect(toolButton()).toBeTruthy());
  });
});
