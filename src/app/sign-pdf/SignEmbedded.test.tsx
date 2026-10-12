import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignEmbedded, type SignEmbeddedProps } from "@/app/sign-pdf/SignEmbedded";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS } from "@/app/sign-pdf/signEmbeddedStrings";
import { installCanvasStubs } from "@/app/sign-pdf/vaultTestUtils";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { clearVault, saveVaultEntry, dataUrlToVaultImage } from "@/app/sign-pdf/signVault";
import { listDrafts } from "@/app/sign-pdf/signDrafts";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { ProModeHostContext, ProModeApplyError, type ProModeControls, type ProModeHostValue } from "@/app/pdf-pro/modes/modeContext";
import { setSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import { contractFile, pageCountOf, pageImageCount, realSignaturePng } from "@/app/pdf-pro/modes/modeTestUtils";
import { pdfjsPageText } from "@/lib/pdf/testing/formFixtures";

/** Sin pdf.js: una pagina simulada de 600 x 800 (como el resto de pruebas del lienzo de Firmar). */
const downloads: { blob: Blob; name: string }[] = [];
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => {
      downloads.push({ blob, name });
    },
    openPdfDocument: async () => ({
      numPages: 3,
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
const e = SIGN_EMBEDDED_STRINGS.es;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let restoreCanvas = () => {};
beforeEach(async () => {
  downloads.length = 0;
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs(realSignaturePng());
  await clearVault();
});
afterEach(() => restoreCanvas());

type Applied = { bytes: Uint8Array; label: string; warnings?: unknown };

function setup(overrides: Partial<SignEmbeddedProps> & { file: File }) {
  const applied: Applied[] = [];
  const onApply = vi.fn(async (bytes: Uint8Array, label: string, opts?: { warnings?: unknown }) => {
    applied.push({ bytes, label, warnings: opts?.warnings });
  });
  const onCancel = vi.fn();
  const onDirtyChange = vi.fn();
  const props: SignEmbeddedProps = { lang: "es", onApply, onCancel, onDirtyChange, ...overrides };
  const view = render(
    <LanguageProvider>
      <SignEmbedded {...props} />
    </LanguageProvider>,
  );
  return { ...view, applied, onApply, onCancel, onDirtyChange, props };
}

const tool = (name: string) =>
  within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", { name });

async function addTextField(value: string) {
  fireEvent.click(tool(strings.fieldTypeText));
  fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
  const input = await screen.findByRole("textbox", { name: strings.textFieldFallbackLabel(1) });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function createTypedSignature(text = "Ana") {
  fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
  fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: strings.save }));
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: `${strings.soloSignatureLabel}, ${strings.soloSignatureA11y}` }),
    ).toBeTruthy(),
  );
}

const applyButton = () => screen.getByRole("button", { name: e.apply }) as HTMLButtonElement;

describe("SignEmbedded: Solo yo (jsdom)", () => {
  it("monta el lienzo y la paleta de Firmar sin dropzone ni ToolShell, con 'Aplicar' deshabilitado", async () => {
    const { file } = await contractFile();
    const { container } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(applyButton().disabled).toBe(true);
    expect(screen.getByText(e.notReady)).toBeTruthy();
  });

  it("un campo de texto relleno habilita 'Aplicar' y el PDF resultante lleva el texto", async () => {
    const { file } = await contractFile();
    const { applied, onApply } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await addTextField("Ana Perez");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(applied[0].label).toBe(e.labelSigned);
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Ana Perez");
    expect(await pageCountOf(applied[0].bytes)).toBe(3);
  });

  it("crear una firma la coloca y al aplicar la imagen esta en la pagina 1", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await createTypedSignature();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(await pageImageCount(await file.arrayBuffer().then((b) => new Uint8Array(b)))).toBe(0);
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageImageCount(applied[0].bytes, 0)).toBe(1);
    expect(await pageImageCount(applied[0].bytes, 1)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Varios firmantes
 * ------------------------------------------------------------------ */

async function addSignerNamed(position: number, name: string) {
  fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
  const input = await screen.findByLabelText(strings.signerNameLabel(position));
  fireEvent.change(input, { target: { value: name } });
}

async function addSlotFor(signerName: string) {
  const radio = screen.queryByRole("radio", { name: signerName });
  if (radio) fireEvent.click(radio);
  fireEvent.click(tool(strings.fieldSignature));
  fireEvent.click(await screen.findByRole("button", { name: strings.addFieldHere }));
}

/** Cada firmante crea su firma tecleada (el compositor usa el canvas simulado). */
async function ceremonyFor(names: string[]) {
  for (const name of names) {
    fireEvent.click((await screen.findAllByRole("button", { name: strings.handoffReady }))[0]);
    fireEvent.click(screen.getAllByRole("button", { name: strings.captureSignature })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    fireEvent.click(await screen.findByRole("button", { name: strings.captureContinue }));
    fireEvent.click(await screen.findByRole("button", { name: names.indexOf(name) < names.length - 1 ? strings.reviewNext : strings.reviewFinish }));
  }
}

async function multiRoundReady(names: string[]) {
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
  for (let index = 0; index < names.length; index += 1) await addSignerNamed(index + 1, names[index]);
  fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  for (const name of names) await addSlotFor(name);
  fireEvent.click(screen.getByRole("button", { name: `3. ${strings.stepSign}` }));
  await ceremonyFor(names);
}

describe("SignEmbedded: Varios firmantes (jsdom)", () => {
  it("dos firmantes firman por turnos y el snapshot se llama «Firmado por Ana y Luis»", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana", "Luis"]);
    await waitFor(() => expect(screen.getByText(strings.allSignedTitle)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Firmado por Ana y Luis");
    expect(await pageImageCount(applied[0].bytes, 0)).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Aplicar, sesion y avisos
 * ------------------------------------------------------------------ */

async function filledText(value = "Texto") {
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  await addTextField(value);
  await screen.findByText(e.ready);
}

describe("SignEmbedded: aplicar, descartar y errores", () => {
  it("sin nada que aplicar, pulsar 'Aplicar' no llama a onApply", async () => {
    const { file } = await contractFile();
    const { onApply } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(applyButton());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("'Descartar' avisa al anfitrion con onCancel y no aplica nada", async () => {
    const { file } = await contractFile();
    const { onCancel, onApply } = setup({ file });
    await filledText();
    fireEvent.click(screen.getByRole("button", { name: e.discard }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("onDirtyChange sube con el primer trabajo y baja al desmontar", async () => {
    const { file } = await contractFile();
    const { onDirtyChange, unmount } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await addTextField("Algo");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("si onApply rechaza, la sesion sigue, se avisa con role=alert y se puede reintentar", async () => {
    const { file } = await contractFile();
    const calls: string[] = [];
    let attempt = 0;
    const onApply = vi.fn(async (_bytes: Uint8Array, label: string) => {
      attempt += 1;
      calls.push(label);
      if (attempt === 1) throw new Error("fallo");
    });
    setup({ file, onApply });
    await filledText("Ana");
    fireEvent.click(applyButton());
    expect((await screen.findByRole("alert")).textContent).toContain(e.applyFailed);
    // La sesion sigue: el campo escrito y el boton listos para reintentar.
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(applyButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([e.labelSigned, e.labelSigned]);
  });

  it("un PDF que no se puede firmar se explica con el mensaje claro del error (no se aplica nada)", async () => {
    const garbage = toFileOf(new Uint8Array([1, 2, 3, 4]));
    const { onApply } = setup({ file: garbage });
    await filledText("Ana");
    fireEvent.click(applyButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(e.applyFailed);
    expect(onApply).not.toHaveBeenCalled();
    expect(applyButton().disabled).toBe(false);
  });

  it("pulsar 'Aplicar' dos veces seguidas aplica una sola vez", async () => {
    const { file } = await contractFile();
    const { onApply } = setup({ file });
    await filledText("Ana");
    fireEvent.click(applyButton());
    fireEvent.click(applyButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("mientras se aplica el contenido queda inerte y la barra muestra el progreso", async () => {
    const { file } = await contractFile();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onApply = vi.fn(async () => {
      await gate;
    });
    const { container } = setup({ file, onApply });
    await filledText("Ana");
    fireEvent.click(applyButton());
    await waitFor(() => expect(container.querySelector("[data-phase='applying']")).toBeTruthy());
    expect(container.querySelector("[data-pro-mode-scroll]")?.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    release();
    await waitFor(() => expect(container.querySelector("[data-phase='editing']")).toBeTruthy());
    expect(container.querySelector("[data-pro-mode-scroll]")?.hasAttribute("inert")).toBe(false);
  });

  it("al aplicar, el foco que estaba en el contenido no cae a <body>", async () => {
    const { file } = await contractFile();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onApply = vi.fn(async () => {
      await gate;
    });
    setup({ file, onApply });
    await filledText("Ana");
    tool(strings.fieldTypeText).focus();
    fireEvent.click(applyButton());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    release();
  });

  it("onApply recibe bytes de PDF validos con las mismas paginas que el original", async () => {
    const { file } = await contractFile(3);
    const { applied } = setup({ file });
    await filledText("Ana");
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageCountOf(applied[0].bytes)).toBe(3);
    expect(new TextDecoder().decode(applied[0].bytes.subarray(0, 5))).toBe("%PDF-");
  });
});

function toFileOf(bytes: Uint8Array) {
  return new File([bytes as unknown as BlobPart], "roto.pdf", { type: "application/pdf", lastModified: 1_700_000_000_123 });
}

describe("SignEmbedded: documento que cambia (huella y snapshots)", () => {
  it("otro snapshot con trabajo sin aplicar descarta la sesion, la vacia y avisa", async () => {
    const first = await contractFile(3);
    const second = await contractFile(2, "contrato.pdf");
    const { rerender, onDirtyChange } = setup({ file: first.file, bytes: first.bytes });
    await filledText("Ana");
    expect(screen.getAllByRole("group", { name: /Ana|campo/i }).length).toBeGreaterThan(0);
    rerender(
      <LanguageProvider>
        <SignEmbedded
          file={second.file}
          bytes={second.bytes}
          lang="es"
          onApply={async () => {}}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />
      </LanguageProvider>,
    );
    expect((await screen.findByText(e.sessionReset)).closest("[role='status']")).toBeTruthy();
    // La sesion nueva esta vacia: nada que aplicar.
    await waitFor(() => expect(applyButton().disabled).toBe(true));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("otro snapshot SIN trabajo sin aplicar se acepta en silencio", async () => {
    const first = await contractFile(3);
    const second = await contractFile(3);
    const { rerender } = setup({ file: first.file, bytes: first.bytes });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    rerender(
      <LanguageProvider>
        <SignEmbedded file={second.file} bytes={second.bytes} lang="es" onApply={async () => {}} onCancel={() => {}} />
      </LanguageProvider>,
    );
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.queryByText(e.sessionReset)).toBeNull();
  });

  it("la huella se recalcula con el documento nuevo: lo firmado antes no se arrastra (capturas de otro snapshot)", async () => {
    const first = await contractFile(3);
    const second = await contractFile(3);
    const { rerender, applied } = setup({ file: first.file, bytes: first.bytes });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await createTypedSignature();
    rerender(
      <LanguageProvider>
        <SignEmbedded
          file={second.file}
          bytes={second.bytes}
          lang="es"
          onApply={async (bytes, label) => {
            applied.push({ bytes, label });
          }}
          onCancel={() => {}}
        />
      </LanguageProvider>,
    );
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    // La firma creada en el documento anterior no esta colocada en el nuevo.
    expect(
      screen.queryByRole("group", { name: `${strings.soloSignatureLabel}, ${strings.soloSignatureA11y}` }),
    ).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  it("Varios firmantes: lo firmado en un snapshot no vale para el siguiente (ronda vacia, aviso y 'Aplicar' bloqueado)", async () => {
    const first = await contractFile(3);
    const second = await contractFile(3);
    const { rerender } = setup({ file: first.file, bytes: first.bytes });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana"]);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    rerender(
      <LanguageProvider>
        <SignEmbedded file={second.file} bytes={second.bytes} lang="es" onApply={async () => {}} onCancel={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByText(e.sessionReset)).toBeTruthy();
    await screen.findByRole("tab", { name: strings.modeSingle });
    expect(applyButton().disabled).toBe(true);
    // Vuelta a «Solo yo» y sin firmantes ni trazos del snapshot anterior.
    expect(screen.queryByRole("radio", { name: "Ana" })).toBeNull();
  });

  it("carrera: si el documento cambia MIENTRAS se genera el PDF, el resultado se descarta (no se encadena)", async () => {
    const first = await contractFile(3);
    const second = await contractFile(3);
    const onApply = vi.fn(async () => {});
    const { rerender } = setup({ file: first.file, bytes: first.bytes, onApply });
    await filledText("Ana");
    fireEvent.click(applyButton());
    // El anfitrion cambia de snapshot justo despues de pulsar (antes de que acabe de firmar).
    rerender(
      <LanguageProvider>
        <SignEmbedded file={second.file} bytes={second.bytes} lang="es" onApply={onApply} onCancel={() => {}} />
      </LanguageProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("aplicar es la transicion esperada: el snapshot nuevo no se toma por un cambio externo (sin aviso)", async () => {
    const first = await contractFile(3);
    const second = await contractFile(3);
    const view = render(<div />);
    view.unmount();
    let rerenderWith: (bytes: Uint8Array, file: File) => void = () => {};
    function Host() {
      return null;
    }
    void Host;
    const onApply = vi.fn(async () => {
      rerenderWith(second.bytes, second.file);
    });
    const { rerender } = setup({ file: first.file, bytes: first.bytes, onApply });
    rerenderWith = (bytes, file) =>
      rerender(
        <LanguageProvider>
          <SignEmbedded file={file} bytes={bytes} lang="es" onApply={onApply} onCancel={() => {}} />
        </LanguageProvider>,
      );
    await filledText("Ana");
    fireEvent.click(applyButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.queryByText(e.sessionReset)).toBeNull();
  });

  it("los mismos bytes con un File nuevo no reinician la sesion", async () => {
    const { file, bytes } = await contractFile(3);
    const { rerender } = setup({ file, bytes });
    await filledText("Ana");
    const same = toFile2(bytes);
    rerender(
      <LanguageProvider>
        <SignEmbedded file={same} bytes={bytes} lang="es" onApply={async () => {}} onCancel={() => {}} />
      </LanguageProvider>,
    );
    expect(applyButton().disabled).toBe(false);
  });
});

function toFile2(bytes: Uint8Array) {
  return new File([bytes as unknown as BlobPart], "otro-nombre.pdf", { type: "application/pdf" });
}

describe("SignEmbedded: avisos del documento", () => {
  it("sin firmas digitales ni copia descifrada no hay grupo de avisos y onApply no lleva warnings", async () => {
    const { file } = await contractFile();
    const { container, applied } = setup({ file, facts: { signatures: "none", encrypted: false } });
    await filledText();
    expect(container.querySelector("[data-pro-mode-warnings]")).toBeNull();
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].warnings).toBeUndefined();
  });

  it("firmas digitales activas: avisa de que se invalidan y lo pasa en warnings", async () => {
    const { file } = await contractFile();
    const { container, applied } = setup({ file, facts: { signatures: "active" } });
    await filledText();
    const group = container.querySelector("[data-pro-mode-warnings]")!;
    expect(group.textContent).toContain("firmas digitales");
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].warnings).toEqual([{ code: "signaturesInvalidated" }]);
  });

  it("firmas que no se pudieron comprobar: aviso 'signaturesUnknown' (nunca se lee como «sin firmas»)", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file, facts: { signatures: "unknown" } });
    await filledText();
    expect(screen.getByText(/No pudimos comprobar/)).toBeTruthy();
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].warnings).toEqual([{ code: "signaturesUnknown" }]);
  });

  it("copia descifrada: avisa de la contrasena y lo pasa en warnings, junto al de firmas", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file, facts: { signatures: "active", encrypted: true } });
    await filledText();
    expect(screen.getByText(/copia sin contraseña/)).toBeTruthy();
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].warnings).toEqual([{ code: "signaturesInvalidated" }, { code: "decryptedCopy" }]);
  });

  it("dice siempre que NO es una firma digital criptografica y que la sesion no se guarda como borrador", async () => {
    const { file } = await contractFile();
    setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.getByText(e.notDigital)).toBeTruthy();
    expect(screen.getByText(e.sessionNote)).toBeTruthy();
  });
});

describe("SignEmbedded: borradores de Firmar", () => {
  it("el modo NO escribe borradores v1 aunque haya trabajo (la sesion se descarta al salir)", async () => {
    const { file } = await contractFile();
    setup({ file });
    await filledText("Ana");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await listDrafts()).toEqual([]);
  });

  it("tampoco en Varios firmantes con firmantes y huecos", async () => {
    const { file } = await contractFile();
    setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await addSignerNamed(1, "Ana");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await listDrafts()).toEqual([]);
  });

  it("control positivo: la herramienta suelta SI guarda su borrador con el mismo trabajo", async () => {
    const { file } = await contractFile();
    const view = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(view.container.querySelector('input[type="file"][accept*="pdf"]')!, { target: { files: [file] } });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await addSignerNamed(1, "Ana");
    await waitFor(async () => expect((await listDrafts()).length).toBe(1), { timeout: 4000 });
  });
});

describe("SignEmbedded: idioma", () => {
  it("en ingles: textos del modo y etiqueta del snapshot en ingles", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const { file } = await contractFile();
    const en = SIGN_EMBEDDED_STRINGS.en;
    const enStrings = SIGN_STRINGS.en;
    const { applied } = setup({ file, lang: "en" });
    await screen.findByRole("toolbar", { name: enStrings.paletteLabel });
    expect(screen.getByText(en.notReady)).toBeTruthy();
    expect(screen.getByText(en.notDigital)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("toolbar", { name: enStrings.paletteLabel })).getByRole("button", { name: enStrings.fieldTypeText }));
    fireEvent.click(await screen.findByRole("button", { name: enStrings.addTextFieldHere }));
    const input = await screen.findByRole("textbox", { name: enStrings.textFieldFallbackLabel(1) });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.blur(input);
    await waitFor(() => expect((screen.getByRole("button", { name: en.apply }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: en.apply }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe(en.labelSigned);
  });
});

/* ------------------------------------------------------------------ *
 * Anfitrion de modos (canal de controles)
 * ------------------------------------------------------------------ */

function hostValue(overrides: Partial<ProModeHostValue> = {}): ProModeHostValue & { controls: ProModeControls | null } {
  const value = {
    tab: "sign",
    initialPage: 0,
    reportPage: vi.fn(),
    registerControls: vi.fn((controls: ProModeControls | null) => {
      value.controls = controls;
    }),
    intent: null,
    busy: false,
    controls: null as ProModeControls | null,
    ...overrides,
  };
  return value;
}

function setupHosted(host: ReturnType<typeof hostValue>, props: Partial<SignEmbeddedProps> & { file: File }) {
  const applied: Applied[] = [];
  const onApply =
    props.onApply ??
    vi.fn(async (bytes: Uint8Array, label: string, opts?: { warnings?: unknown }) => {
      applied.push({ bytes, label, warnings: opts?.warnings });
    });
  const view = render(
    <LanguageProvider>
      <ProModeHostContext.Provider value={host}>
        <SignEmbedded lang="es" onCancel={() => {}} onDirtyChange={() => {}} {...props} onApply={onApply} />
      </ProModeHostContext.Provider>
    </LanguageProvider>,
  );
  return { ...view, applied, onApply };
}

describe("SignEmbedded: con el anfitrion de modos", () => {
  it("registra su 'aplicar' y no pinta 'Aplicar' ni 'Descartar' (los dibuja el anfitrion)", async () => {
    const host = hostValue();
    const { file } = await contractFile();
    const { container } = setupHosted(host, { file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(host.controls).not.toBeNull();
    expect(screen.queryByRole("button", { name: e.apply })).toBeNull();
    expect(screen.queryByRole("button", { name: e.discard })).toBeNull();
    expect(container.querySelector("[data-hosted]")).toBeTruthy();
    // El estado (listo / falta algo) si se conserva.
    expect(screen.getByText(e.notReady)).toBeTruthy();
  });

  it("'apply' del anfitrion sin nada que aplicar rechaza con un ProModeApplyError claro", async () => {
    const host = hostValue();
    const { file } = await contractFile();
    setupHosted(host, { file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await expect(host.controls!.apply()).rejects.toBeInstanceOf(ProModeApplyError);
    await expect(host.controls!.apply()).rejects.toMatchObject({ userMessage: e.notReady });
  });

  it("'apply' del anfitrion genera el PDF y llama a onApply; si el anfitrion no sustituye el modo, la sesion sigue", async () => {
    const host = hostValue();
    const { file } = await contractFile();
    const { applied, onApply } = setupHosted(host, { file });
    await filledText("Hola");
    let result: boolean | undefined;
    await act(async () => {
      result = await host.controls!.apply();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(applied[0].label).toBe(e.labelSigned);
    expect(result).toBe(true);
    // El anfitrion de prueba no desmonto el modo: pasado un instante la sesion vuelve a poder editarse.
    await waitFor(() => expect(document.querySelector("[data-phase='editing']")).toBeTruthy());
    expect(applyDisabledHostless()).toBe(true);
  });

  it("si onApply hace que llegue el snapshot nuevo (como el anfitrion real), 'apply' devuelve true", async () => {
    const host = hostValue();
    const first = await contractFile(3);
    const second = await contractFile(3);
    let swap: () => void = () => {};
    const onApply = vi.fn(async () => {
      swap();
    });
    const { rerender } = setupHosted(host, { file: first.file, bytes: first.bytes, onApply });
    swap = () =>
      rerender(
        <LanguageProvider>
          <ProModeHostContext.Provider value={host}>
            <SignEmbedded
              file={second.file}
              bytes={second.bytes}
              lang="es"
              onApply={onApply}
              onCancel={() => {}}
              onDirtyChange={() => {}}
            />
          </ProModeHostContext.Provider>
        </LanguageProvider>,
      );
    await filledText("Hola");
    let result: boolean | undefined;
    await act(async () => {
      result = await host.controls!.apply();
    });
    expect(result).toBe(true);
    // El cambio fue el resultado esperado de aplicar: sin aviso de sesion descartada.
    expect(screen.queryByText(e.sessionReset)).toBeNull();
  });

  it("un fallo al generar el PDF llega al anfitrion como ProModeApplyError con el texto ya redactado", async () => {
    const host = hostValue();
    const { onApply } = setupHosted(host, { file: toFileOf(new Uint8Array([1, 2, 3])) });
    await filledText("Hola");
    const failure = await act(async () => host.controls!.apply().then(() => null, (error: unknown) => error));
    expect(failure).toBeInstanceOf(ProModeApplyError);
    expect((failure as ProModeApplyError).userMessage).toContain(e.applyFailed);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("un rechazo de onApply (p. ej. documento obsoleto) se relanza tal cual al anfitrion", async () => {
    const host = hostValue();
    const stale = new Error("stale");
    const { file } = await contractFile();
    setupHosted(host, { file, onApply: vi.fn(async () => Promise.reject(stale)) });
    await filledText("Hola");
    const failure = await act(async () => host.controls!.apply().then(() => null, (error: unknown) => error));
    expect(failure).toBe(stale);
  });

  it("'Cancelar' del anfitrion mientras se aplica descarta el PDF generado: no se llama a onApply y 'apply' devuelve false", async () => {
    const host = hostValue();
    const { file } = await contractFile();
    const { onApply } = setupHosted(host, { file });
    await filledText("Hola");
    let result: boolean | undefined;
    await act(async () => {
      const pending = host.controls!.apply();
      host.controls!.cancel!();
      result = await pending;
    });
    expect(result).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    // La sesion sigue y se puede volver a aplicar.
    await act(async () => {
      expect(await host.controls!.apply()).toBe(true);
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("con el anfitrion ocupado el contenido queda inerte", async () => {
    const host = hostValue({ busy: true });
    const { file } = await contractFile();
    const { container } = setupHosted(host, { file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(container.querySelector("[data-pro-mode-scroll]")?.hasAttribute("inert")).toBe(true);
  });

  it("arranca en la pagina que se miraba en el visor y le informa de la que se trabaja", async () => {
    const host = hostValue({ initialPage: 1 });
    const { file } = await contractFile();
    setupHosted(host, { file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await waitFor(() => expect(screen.getAllByText(strings.pageOf(2, 3)).length).toBeGreaterThan(0));
    expect(host.reportPage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getAllByRole("button", { name: strings.nextPage })[0]);
    await waitFor(() => expect(host.reportPage).toHaveBeenLastCalledWith(2));
  });
});

function applyDisabledHostless(): boolean {
  return screen.queryByRole("button", { name: e.apply }) === null;
}

/* ------------------------------------------------------------------ *
 * Firma guardada, certificado y etiquetas
 * ------------------------------------------------------------------ */

async function seedRealSignature(name = "Ana Pérez") {
  const image = dataUrlToVaultImage(realSignaturePng(), 0.375)!;
  const result = await saveVaultEntry({
    signerName: name,
    sourceDocument: "contrato.pdf",
    signature: image,
    initials: image,
  });
  if (!result.ok) throw new Error("no se pudo sembrar el baul");
  return result.entry;
}

describe("SignEmbedded: baul de firmas", () => {
  it("elegir una firma guardada la coloca y, al aplicar, la imagen esta en el PDF", async () => {
    await seedRealSignature();
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(screen.getAllByRole("button", { name: strings.vaultButton })[0]);
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(await screen.findByText(strings.vaultApplied("Ana Pérez"))).toBeTruthy();
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageImageCount(applied[0].bytes, 0)).toBe(1);
  });

  it("con el ajuste del baul apagado no hay botones de firmas guardadas", async () => {
    setSignPdfFeatureFlag("signatureVault", false);
    const { file } = await contractFile();
    setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.queryByRole("button", { name: strings.vaultButton })).toBeNull();
  });

  it("'Crear firma' abre el compositor de Firmar (el mismo componente)", async () => {
    const { file } = await contractFile();
    setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    expect(await screen.findByRole("dialog", { name: strings.createTitle })).toBeTruthy();
  });
});

describe("SignEmbedded: etiquetas del snapshot y certificado", () => {
  it("un solo firmante con nombre: «Firmado por Ana»", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await addSignerNamed(1, "Ana");
    fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await addSlotFor("Ana");
    fireEvent.click(screen.getByRole("button", { name: `3. ${strings.stepSign}` }));
    await ceremonyFor(["Ana"]);
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Firmado por Ana");
  });

  it("un firmante sin hueco no figura en la etiqueta: solo quien firma el documento", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await addSignerNamed(1, "Ana");
    await addSignerNamed(2, "Luis");
    fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await addSlotFor("Luis");
    fireEvent.click(screen.getByRole("button", { name: `3. ${strings.stepSign}` }));
    await ceremonyFor(["Luis"]);
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Firmado por Luis");
  });

  it("con certificado de finalizacion (ajuste por defecto) el PDF lleva una pagina mas, con el aviso de que no es firma electronica cualificada", async () => {
    const { file } = await contractFile(3);
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana", "Luis"]);
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageCountOf(applied[0].bytes)).toBe(4);
    const text = await pdfjsPageText(applied[0].bytes, 4);
    expect(text).toContain(strings.certificateTitle);
    expect(text).toContain("Ana");
    expect(text).toContain("Luis");
    expect(text).toMatch(/no es una firma electr/i);
  });

  it("con el certificado apagado no se anade pagina", async () => {
    setSignPdfFeatureFlag("completionCertificate", false);
    const { file } = await contractFile(3);
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana"]);
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageCountOf(applied[0].bytes)).toBe(3);
  });

  it("«Solo yo» nunca lleva certificado ni nombres, aunque el ajuste este encendido", async () => {
    const { file } = await contractFile(3);
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await createTypedSignature();
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pageCountOf(applied[0].bytes)).toBe(3);
    expect(applied[0].label).toBe(e.labelSigned);
  });

  it("Varios firmantes: 'Aplicar' sigue bloqueado hasta que todos firman", async () => {
    const { file } = await contractFile();
    setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await addSignerNamed(1, "Ana");
    fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await addSlotFor("Ana");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `3. ${strings.stepSign}` }));
    await ceremonyFor(["Ana"]);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });
});

describe("SignEmbedded: cambiar entre Solo yo y Varios firmantes", () => {
  it("el campo escrito en Solo yo sigue ahi al volver (el estado es del documento)", async () => {
    const { file } = await contractFile();
    const { applied } = setup({ file });
    await filledText("Persiste");
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeSingle }));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Persiste");
  });
});

/* ------------------------------------------------------------------ *
 * Equivalencia con la herramienta suelta
 * ------------------------------------------------------------------ */

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Hace lo mismo en la herramienta suelta y devuelve el PDF que descargaria. */
async function standaloneResult(file: File, steps: () => Promise<void>): Promise<Uint8Array> {
  const view = render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"][accept*="pdf"]')!, { target: { files: [file] } });
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  await steps();
  const run = () => screen.getAllByRole("button", { name: "Procesar" }).find((button) => !(button as HTMLButtonElement).disabled);
  await waitFor(() => expect(run()).toBeTruthy());
  fireEvent.click(run()!);
  const download = await screen.findByRole("button", { name: "Descargar" });
  fireEvent.click(download);
  await waitFor(() => expect(downloads.length).toBe(1));
  const result = await bytesOf(downloads[0].blob);
  view.unmount();
  return result;
}

describe("SignEmbedded: equivalencia con la herramienta suelta (mismos bytes)", () => {
  it("Solo yo con un campo de texto: el PDF aplicado es IDENTICO byte a byte al que descarga Firmar", async () => {
    const { file } = await contractFile(3);
    const suelta = await standaloneResult(file, async () => {
      await addTextField("Ana Perez");
    });
    const { applied } = setup({ file });
    await filledText("Ana Perez");
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(Array.from(applied[0].bytes)).toEqual(Array.from(suelta));
  });

  it("Solo yo con firma creada: mismos bytes que la herramienta suelta", async () => {
    const { file } = await contractFile(3);
    const suelta = await standaloneResult(file, async () => {
      await createTypedSignature("Ana");
    });
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await createTypedSignature("Ana");
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(Array.from(applied[0].bytes)).toEqual(Array.from(suelta));
  });

  it("Solo yo con firma y texto a la vez: mismos bytes", async () => {
    const { file } = await contractFile(3);
    const both = async () => {
      await createTypedSignature("Ana");
      await addTextField("Madrid");
    };
    const suelta = await standaloneResult(file, both);
    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await both();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(Array.from(applied[0].bytes)).toEqual(Array.from(suelta));
  });
});

describe("SignEmbedded: equivalencia en Varios firmantes", () => {
  it("dos firmantes (sin certificado, que lleva la hora): mismos bytes que la herramienta suelta", async () => {
    setSignPdfFeatureFlag("completionCertificate", false);
    const { file } = await contractFile(3);
    // Herramienta suelta: la ronda se remata con «Firmar y descargar» y se elige no prefijar el nombre.
    const view = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(view.container.querySelector('input[type="file"][accept*="pdf"]')!, { target: { files: [file] } });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana", "Luis"]);
    fireEvent.click(await screen.findByRole("button", { name: strings.applyAndDownload }));
    fireEvent.click(await screen.findByRole("button", { name: strings.filenamePrefixNo }));
    fireEvent.click(await screen.findByRole("button", { name: "Descargar" }));
    await waitFor(() => expect(downloads.length).toBe(1));
    const suelta = await bytesOf(downloads[0].blob);
    view.unmount();

    const { applied } = setup({ file });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await multiRoundReady(["Ana", "Luis"]);
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar y aplicar" }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(Array.from(applied[0].bytes)).toEqual(Array.from(suelta));
  });
});
