import "fake-indexeddb/auto";
import { useCallback, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within, configure } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  SignToolClient,
  SoloFlow,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import {
  SigningCeremony,
  captureStamp,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  useSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import {
  MAX_VAULT_ENTRIES,
  clearVault,
  listVault,
  saveVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import {
  installCanvasStubs,
  makeImage,
  pngDataUrl,
  vaultInput,
} from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Baul de firmas (W3) integrado en los flujos: «Solo yo» (SignToolClient,
 * lienzo) y «Varios firmantes» (SigningCeremony). Los de la hoja en si estan en
 * SignatureVaultSheet.test.tsx y los de la casilla en
 * SignatureComposerRemember.test.tsx.
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

/* IndexedDB (fake) y las hojas animadas van mas lentas con toda la suite en paralelo. */
configure({ asyncUtilTimeout: 5000 });

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

let restoreCanvas = () => {};

beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs();
  await clearVault();
});

afterEach(() => restoreCanvas());

function disableVaultFlag() {
  window.localStorage.setItem(
    SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
    JSON.stringify({ signatureVault: false }),
  );
  __resetSignPdfFeatureFlagsCacheForTests();
}

async function seed(
  name: string,
  overrides: Parameters<typeof vaultInput>[1] = {},
): Promise<VaultEntry> {
  const result = await saveVaultEntry(vaultInput(name, overrides));
  if (!result.ok) throw new Error("no se pudo sembrar el baul");
  return result.entry;
}

/* ------------------------------------------------------------------ *
 * «Solo yo»
 * ------------------------------------------------------------------ */

describe("«Solo yo» con firmas guardadas — SignToolClient", () => {
  async function pdfFile(name: string): Promise<File> {
    const doc = await PDFDocument.create();
    doc.addPage([307, 307]);
    const bytes = await doc.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
  }
  const pdfInput = (container: HTMLElement) =>
    container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
  const soloGroup = () =>
    screen.queryByRole("group", {
      name: `${strings.soloSignatureLabel}, ${strings.soloSignatureA11y}`,
    });

  async function openTool(name = "contrato.pdf") {
    const file = await pdfFile(name);
    const view = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(pdfInput(view.container), { target: { files: [file] } });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    return view;
  }

  it("hay un boton «Firmas guardadas» en el lienzo y otro en las opciones", async () => {
    await openTool();
    expect(screen.getAllByRole("button", { name: strings.vaultButton })).toHaveLength(2);
  });

  it("elegir una guardada la coloca en el lienzo (como el onSave del compositor) y la marca como usada", async () => {
    const entry = await seed("Ana Pérez");
    await openTool();
    expect(soloGroup()).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: strings.vaultButton })[0]);
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }),
    );

    await waitFor(() => expect(soloGroup()).toBeTruthy());
    const expected = vaultImageToDataUrl(entry.signature!);
    const shown = screen.getAllByAltText(strings.createTitle) as HTMLImageElement[];
    expect(shown.some((image) => image.src === expected)).toBe(true);
    expect(await screen.findByText(strings.vaultApplied("Ana Pérez"))).toBeTruthy();
    // La hoja se cerro y la entrada se marco como usada.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: strings.vaultTitle })).toBeNull());
    await waitFor(async () => {
      const [stored] = (await listVault()).entries;
      expect(stored.lastUsedAt > entry.lastUsedAt).toBe(true);
    });
  });

  it("la hoja de «Solo yo» solo deja usar entradas que tienen firma", async () => {
    await seed("Solo Iniciales", { signature: null });
    await openTool();
    fireEvent.click(screen.getAllByRole("button", { name: strings.vaultButton })[1]);
    await screen.findByText("Solo Iniciales");
    expect(screen.queryByRole("button", { name: strings.vaultUseFor("Solo Iniciales") })).toBeNull();
    expect(screen.getByText(strings.vaultLacksSignature)).toBeTruthy();
  });

  it("recordar: marca la casilla, escribe el nombre y se guarda con el nombre del documento", async () => {
    await openTool("contrato-marco.pdf");
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));

    expect(await screen.findByText(strings.vaultSaved)).toBeTruthy();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signerName).toBe("Ana Pérez");
    expect(entries[0].sourceDocument).toBe("contrato-marco.pdf");
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].initials).toBeNull();
    // Y la firma se uso igualmente en el documento.
    await waitFor(() => expect(soloGroup()).toBeTruthy());
  });

  it("recordar sin marcar la casilla no guarda nada", async () => {
    await openTool();
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    await waitFor(() => expect(soloGroup()).toBeTruthy());
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("recordar sin nombre: no guarda, no cierra el compositor y se explica", async () => {
    await openTool();
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    // Llega precargado con lo escrito en «Escribir»; se borra a proposito.
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    expect(await screen.findByText(strings.vaultRememberNeedsName)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: strings.createTitle })).toBeTruthy();
    expect(soloGroup()).toBeNull();
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("si el baul esta lleno el motivo se ve (role=status) y la firma se usa igual", async () => {
    for (let index = 0; index < MAX_VAULT_ENTRIES; index += 1) {
      const result = await saveVaultEntry(
        vaultInput(`Firmante ${index}`, {
          signature: makeImage({ seed: index + 20 }),
          initials: null,
        }),
      );
      expect(result.ok).toBe(true);
    }
    await openTool();
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    fireEvent.change(screen.getByLabelText(strings.vaultRememberNameLabel), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));

    const message = await screen.findByText(strings.vaultSaveLimit);
    expect(message.getAttribute("role")).toBe("status");
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
    await waitFor(() => expect(soloGroup()).toBeTruthy());
  }, 30000);

  it("con el flag apagado desaparece todo: ni botones ni casilla", async () => {
    disableVaultFlag();
    await seed("Ana Pérez");
    await openTool();
    expect(screen.queryByRole("button", { name: strings.vaultButton })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    await screen.findByRole("dialog", { name: strings.createTitle });
    expect(screen.queryByRole("checkbox", { name: strings.vaultRemember })).toBeNull();
  });

  const VAULT_DB = "optimuspdf-signature-vault";
  async function deleteVaultDb() {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(VAULT_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
  const databaseNames = async () => (await indexedDB.databases()).map((db) => db.name);

  it("con el flag apagado NO se abre ni se crea la base del baul (aunque el primer render use el valor por defecto)", async () => {
    await deleteVaultDb();
    disableVaultFlag();
    await openTool();
    // Margen para que cualquier lectura asincrona indebida hubiera llegado.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await databaseNames()).not.toContain(VAULT_DB);
  });

  it("(control) con el flag encendido la base del baul si se abre", async () => {
    await deleteVaultDb();
    await openTool();
    await waitFor(async () => expect(await databaseNames()).toContain(VAULT_DB));
  });

  it("con el flag apagado la herramienta Firma sigue abriendo el compositor aunque haya guardadas", async () => {
    disableVaultFlag();
    await seed("Ana Pérez");
    await openTool();
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
        name: strings.fieldSignature,
      }),
    );
    expect(await screen.findByRole("dialog", { name: strings.createTitle })).toBeTruthy();
  });
});

describe("herramienta Firma del lienzo en «Solo yo» — SoloFlow", () => {
  const A = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
    type: "application/pdf",
    lastModified: 1_700_000_000_000,
  });

  function options(): SignToolOptions {
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
    };
  }

  function Harness(props: { onCreate: () => void; onOpenSaved?: () => void; hasSaved?: boolean }) {
    const [state, setState] = useState(options);
    const patch = useCallback(
      (next: Partial<SignToolOptions>) => setState((previous) => ({ ...previous, ...next })),
      [],
    );
    return (
      <LanguageProvider>
        <SoloFlow
          file={A}
          options={state}
          setOptions={patch}
          onCreateSignature={props.onCreate}
          onOpenSaved={props.onOpenSaved}
          hasSaved={props.hasSaved}
          strings={strings}
        />
      </LanguageProvider>
    );
  }

  const signatureTool = () =>
    within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
      name: strings.fieldSignature,
    });

  it("sin firma creada y CON guardadas, ofrece las guardadas en vez de abrir el compositor", async () => {
    const onCreate = vi.fn();
    const onOpenSaved = vi.fn();
    render(<Harness onCreate={onCreate} onOpenSaved={onOpenSaved} hasSaved />);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(signatureTool());
    expect(onOpenSaved).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("sin guardadas el comportamiento es el de siempre: abre el compositor", async () => {
    const onCreate = vi.fn();
    const onOpenSaved = vi.fn();
    render(<Harness onCreate={onCreate} onOpenSaved={onOpenSaved} hasSaved={false} />);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(signatureTool());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onOpenSaved).not.toHaveBeenCalled();
  });

  it("sin la prop del baul (apagado) no hay boton «Firmas guardadas» en el lienzo", async () => {
    render(<Harness onCreate={() => {}} />);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.queryByRole("button", { name: strings.vaultButton })).toBeNull();
  });

  it("el boton del lienzo abre las guardadas aunque no haya ninguna (la hoja muestra el estado vacio)", async () => {
    const onOpenSaved = vi.fn();
    render(<Harness onCreate={() => {}} onOpenSaved={onOpenSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultButton }));
    expect(onOpenSaved).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * «Varios firmantes»
 * ------------------------------------------------------------------ */

const ANA: Signer = { id: "sg-1", name: "Ana Pérez", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const DOC = "contrato.pdf:2048:1700000000000";
const OTRO_DOC = "contrato-v2.pdf:2600:1700000999999";

function slot(
  id: string,
  signerId: string,
  type: SignatureField["type"] = "signature",
  x = 0.1,
): SignatureField {
  return { id, signerId, pageIndex: 0, type, rect: { x, y: 0.1, width: 0.3, height: 0.1 } };
}

const FIELDS = [slot("f1", ANA.id), slot("f2", ANA.id, "initials"), slot("f3", LUIS.id)];
const MOVED = [slot("f1", ANA.id, "signature", 0.62), slot("f2", ANA.id, "initials"), slot("f3", LUIS.id)];

type CeremonyProps = {
  fields?: SignatureField[];
  documentKey?: string | null;
  captures?: CaptureMap;
  signers?: Signer[];
  documentName?: string;
};

function Ceremony({
  fields = FIELDS,
  documentKey = DOC,
  captures = {},
  signers = [ANA, LUIS],
  documentName = "contrato.pdf",
  onCaptures,
}: CeremonyProps & { onCaptures?: (value: CaptureMap) => void }) {
  const [current, setCurrent] = useState<CaptureMap>(captures);
  return (
    <LanguageProvider>
      <SigningCeremony
        signers={signers}
        fields={fields}
        captures={current}
        onCapturesChange={(next) => {
          setCurrent(next);
          onCaptures?.(next);
        }}
        documentKey={documentKey}
        documentName={documentName}
        onFinish={() => {}}
        strings={strings}
      />
    </LanguageProvider>
  );
}

/** Lleva a Ana (primer turno) a la etapa de captura. */
function toCapture() {
  fireEvent.click(screen.getAllByRole("button", { name: strings.handoffReady })[0]);
}
const savedButtonFor = (type: "signature" | "initials") =>
  screen.getByRole("button", {
    name: strings.vaultUseSavedFor(
      type === "signature" ? strings.fieldSignature : strings.fieldInitials,
    ),
  });

describe("«Varios firmantes» con firmas guardadas — SigningCeremony", () => {
  it("cada fila de trazo requerido tiene «Usar una guardada»", () => {
    render(<Ceremony />);
    toCapture();
    expect(savedButtonFor("signature")).toBeTruthy();
    expect(savedButtonFor("initials")).toBeTruthy();
  });

  it("«Usar una guardada» mide 44 px con puntero grueso y no se tocan los botones vecinos", () => {
    render(<Ceremony />);
    toCapture();
    for (const type of ["signature", "initials"] as const) {
      const button = savedButtonFor(type);
      expect(button.className).toContain("pointer-coarse:h-11");
      expect(button.className).toContain("pointer-coarse:before:hidden");
    }
    // El boton pre-existente de la misma fila queda como estaba.
    expect(
      screen.getByRole("button", { name: strings.captureSignature }).className,
    ).not.toContain("pointer-coarse:h-11");
  });

  it("las entradas del firmante salen primero", async () => {
    // Por fecha (lo ultimo guardado primero) saldria Zoe > Ana > Luis.
    await seed("Luis");
    await seed("Ana Pérez");
    await seed("Zoe");
    render(<Ceremony />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    await screen.findByText("Zoe");
    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent)
      .filter((name): name is string => ["Luis", "Ana Pérez", "Zoe"].includes(name ?? ""));
    expect(names[0]).toBe("Ana Pérez");
  });

  it("aplicar una guardada genera una captura VALIDA (firma e iniciales) para los huecos de ahora", async () => {
    const entry = await seed("Ana Pérez");
    let last: CaptureMap = {};
    render(<Ceremony onCaptures={(value) => (last = value)} />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));

    const capture = validCapture(last, FIELDS, ANA.id, DOC);
    expect(capture.signature?.dataUrl).toBe(vaultImageToDataUrl(entry.signature!));
    expect(capture.signature?.ratio).toBe(entry.signature!.ratio);
    expect(capture.initials?.dataUrl).toBe(vaultImageToDataUrl(entry.initials!));
    expect(last[ANA.id].stamp).toBe(captureStamp(DOC, FIELDS, ANA.id));
    expect(pendingSigners([ANA, LUIS], FIELDS, last, DOC).map((s) => s.id)).toEqual([LUIS.id]);
    expect(await screen.findByText(strings.vaultApplied("Ana Pérez"))).toBeTruthy();
    // La hoja se cierra y la ceremonia sigue (Continuar habilitado).
    await waitFor(() => expect(screen.queryByRole("dialog", { name: strings.vaultTitle })).toBeNull());
    expect(
      (screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("si la entrada no trae iniciales y el firmante las necesita, queda captura PARCIAL (no se inventan)", async () => {
    await seed("Ana Pérez", { initials: null });
    let last: CaptureMap = {};
    render(<Ceremony onCaptures={(value) => (last = value)} />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));

    const capture = validCapture(last, FIELDS, ANA.id, DOC);
    expect(capture.signature).not.toBeNull();
    expect(capture.initials).toBeNull();
    expect(pendingSigners([ANA, LUIS], FIELDS, last, DOC).map((s) => s.id)).toContain(ANA.id);
    expect(
      await screen.findByText(
        strings.vaultAppliedPartial("Ana Pérez", ["initials"]),
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("la captura parcial se explica con tono informativo (no de error) y concordancia correcta", async () => {
    await seed("Ana Pérez", { initials: null });
    render(<Ceremony />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    const message = await screen.findByText(strings.vaultAppliedPartial("Ana Pérez", ["initials"]));
    expect(message.textContent).toMatch(/No incluye las iniciales: créalas aparte\./);
    expect(message.className).not.toContain("text-destructive-text");
    expect(message.className).toContain("text-foreground");
    expect(message.getAttribute("role")).toBe("status");
  });

  it("el aviso de «aplicada» desaparece al pasar a otra pantalla o a otro firmante (no se queda en el traspaso a Luis)", async () => {
    await seed("Ana Pérez");
    render(<Ceremony />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    const applied = strings.vaultApplied("Ana Pérez");
    expect(await screen.findByText(applied)).toBeTruthy();
    // Continuar -> revision de Ana: el aviso ya no aplica.
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    await screen.findByText(strings.reviewTitle("Ana Pérez"));
    expect(screen.queryByText(applied)).toBeNull();
    // Siguiente -> traspaso a Luis: tampoco.
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    await screen.findByText(strings.handoffTitle("Luis"));
    expect(screen.queryByText(applied)).toBeNull();
    // La region de estado sigue montada, vacia.
    expect(screen.getAllByRole("status").some((node) => node.textContent === "")).toBe(true);
  });

  it("guardar las iniciales tras la firma FUNDE la entrada (no hay una segunda) y el aviso habla de iniciales", async () => {
    const signature = { dataUrl: pngDataUrl({ seed: 1 }), ratio: 0.5 };
    // Primera pasada: la firma sola ya quedo recordada.
    await saveVaultEntry(
      vaultInput("Ana Pérez", {
        signature: makeImage({ seed: 1 }),
        initials: null,
        sourceDocument: "acuerdo.pdf",
      }),
    );
    const captures: CaptureMap = {
      [ANA.id]: { signature, initials: null, stamp: captureStamp(DOC, FIELDS, ANA.id) },
    };
    render(<Ceremony captures={captures} documentName="acuerdo.pdf" />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureInitials }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "AP" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    fireEvent.click(screen.getByRole("button", { name: strings.save }));

    expect(await screen.findByText(strings.vaultSavedInitials)).toBeTruthy();
    expect(screen.queryByText(strings.vaultSaved)).toBeNull();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].initials).not.toBeNull();
  });

  it("la hoja de iniciales no ofrece «Usar» en una entrada sin iniciales", async () => {
    await seed("Ana Pérez", { initials: null });
    render(<Ceremony />);
    toCapture();
    fireEvent.click(savedButtonFor("initials"));
    await screen.findByText("Ana Pérez");
    expect(screen.queryByRole("button", { name: strings.vaultUseFor("Ana Pérez") })).toBeNull();
  });

  it("el sello se calcula EN EL CLIC, no al abrir la hoja: si los huecos cambian con ella abierta, vale para los nuevos", async () => {
    await seed("Ana Pérez");
    let last: CaptureMap = {};
    const view = render(<Ceremony onCaptures={(value) => (last = value)} />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") });
    view.rerender(<Ceremony onCaptures={(value) => (last = value)} fields={MOVED} />);
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }),
    );
    expect(last[ANA.id].stamp).toBe(captureStamp(DOC, MOVED, ANA.id));
    expect(validCapture(last, MOVED, ANA.id, DOC).signature).not.toBeNull();
    // Con los huecos de antes ya no valdria.
    expect(validCapture(last, FIELDS, ANA.id, DOC).signature).toBeNull();
  });

  it("lo aplicado deja de valer si luego se mueven los huecos", async () => {
    await seed("Ana Pérez");
    let last: CaptureMap = {};
    render(<Ceremony onCaptures={(value) => (last = value)} />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    await screen.findByText(strings.vaultApplied("Ana Pérez"));
    expect(pendingSigners([ANA, LUIS], FIELDS, last, DOC).map((s) => s.id)).not.toContain(ANA.id);
    // Con los huecos de Ana en otro sitio la captura ya no la respalda.
    expect(validCapture(last, MOVED, ANA.id, DOC).signature).toBeNull();
    expect(pendingSigners([ANA, LUIS], MOVED, last, DOC).map((s) => s.id)).toContain(ANA.id);
    // Ni vale para otro documento.
    expect(validCapture(last, FIELDS, ANA.id, OTRO_DOC).signature).toBeNull();
  });

  it("si cambia el documento con la hoja abierta, la hoja se cierra", async () => {
    await seed("Ana Pérez");
    const view = render(<Ceremony />);
    toCapture();
    fireEvent.click(savedButtonFor("signature"));
    await screen.findByRole("dialog", { name: strings.vaultTitle });
    view.rerender(<Ceremony documentKey={OTRO_DOC} />);
    // La salida animada del Sheet tarda mas de 1 s en jsdom.
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: strings.vaultTitle })).toBeNull(),
      { timeout: 4000 },
    );
  });

  it("mientras no hay huella del documento no hay forma de aplicar una guardada", () => {
    render(<Ceremony documentKey={null} />);
    expect(screen.queryByRole("button", { name: strings.vaultUseSaved })).toBeNull();
    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();
  });

  it("con el flag apagado no hay botones «Usar una guardada» ni casilla", () => {
    disableVaultFlag();
    render(<Ceremony />);
    toCapture();
    expect(screen.queryByRole("button", { name: /Usar una guardada/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.captureSignature }));
    expect(screen.queryByRole("checkbox", { name: strings.vaultRemember })).toBeNull();
  });

  it("recordar en el turno de Ana usa su nombre sin pedirlo y junta firma e iniciales en UNA entrada", async () => {
    const initials = { dataUrl: pngDataUrl({ width: 20, height: 20, seed: 4 }), ratio: 1 };
    const captures: CaptureMap = {
      [ANA.id]: {
        signature: null,
        initials,
        stamp: captureStamp(DOC, FIELDS, ANA.id),
      },
    };
    render(<Ceremony captures={captures} documentName="acuerdo.pdf" />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureSignature }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    expect(screen.queryByLabelText(strings.vaultRememberNameLabel)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.save }));

    expect(await screen.findByText(strings.vaultSaved)).toBeTruthy();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signerName).toBe("Ana Pérez");
    expect(entries[0].sourceDocument).toBe("acuerdo.pdf");
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].initials).not.toBeNull();
  });

  it("un firmante sin nombre pide el nombre en la casilla", async () => {
    const anonimo: Signer = { id: "sg-9", name: "", color: "#0d4bff" };
    const fields = [slot("g1", anonimo.id)];
    render(<Ceremony signers={[anonimo]} fields={fields} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureSignature }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    expect(screen.getByLabelText(strings.vaultRememberNameLabel)).toBeTruthy();
    await act(async () => {});
  });
});

/* ------------------------------------------------------------------ *
 * Hidratacion: el flag vale su valor por defecto (encendido) en el primer render
 * ------------------------------------------------------------------ */

describe("useSignatureVault — hidratacion con el flag apagado", () => {
  function Probe() {
    const enabled = useSignPdfFeatureFlag("signatureVault");
    const vault = useSignatureVault(enabled);
    return <span data-testid="probe">{`${enabled}:${vault.status}`}</span>;
  }

  async function hydrate() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    // HTML de servidor: el flag vale su valor por defecto (encendido).
    container.innerHTML = renderToString(<Probe />);
    await act(async () => {
      hydrateRoot(container, <Probe />);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return container;
  }

  it("con el flag apagado en localStorage no se llega a abrir la base del baul", async () => {
    disableVaultFlag();
    const open = vi.spyOn(indexedDB, "open");
    const container = await hydrate();
    expect(container.textContent).toBe("false:loading");
    expect(open.mock.calls.filter(([name]) => name === "optimuspdf-signature-vault")).toHaveLength(0);
    open.mockRestore();
    container.remove();
  });

  it("(control) con el flag encendido si se abre", async () => {
    const open = vi.spyOn(indexedDB, "open");
    const container = await hydrate();
    await waitFor(() => expect(container.textContent).toBe("true:ready"));
    expect(open.mock.calls.some(([name]) => name === "optimuspdf-signature-vault")).toBe(true);
    open.mockRestore();
    container.remove();
  });
});
