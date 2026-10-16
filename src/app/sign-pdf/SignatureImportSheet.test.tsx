import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignatureImportSheet, type SignatureImportSheetProps } from "@/app/sign-pdf/SignatureImportSheet";
import { clearVault, listVault, saveVaultEntry, MAX_VAULT_ENTRIES } from "@/app/sign-pdf/signVault";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { InkError } from "@/lib/image/inkCore";
import { decodeImageFile, encodePng, extractInkAsync } from "@/lib/image/inkExtract";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Hoja «Subir firma o iniciales» (U6.2) en jsdom: el motor de tinta (`inkExtract`) se sustituye por dobles (jsdom no
 * decodifica imagenes; el motor real tiene sus propias pruebas y su E2E en navegador). Aqui se prueba la INTERFAZ:
 * pasos, errores, ajustes -> opciones del motor, cancelacion, privacidad y guardado con `origin`.
 */

vi.mock("@/lib/image/inkExtract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image/inkExtract")>();
  return { ...actual, decodeImageFile: vi.fn(), extractInkAsync: vi.fn(), encodePng: vi.fn() };
});

const strings = SIGN_STRINGS.es;
const copy = strings.inkImport;

function fakeDecoded(width = 120, height = 50) {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    format: "jpeg" as const,
    originalWidth: width,
    originalHeight: height,
    downscaled: false,
  };
}

function fakeResult(threshold = 140) {
  return {
    image: { width: 60, height: 30, data: new Uint8ClampedArray(60 * 30 * 4) },
    threshold,
    auto: true,
    inkBounds: { x: 10, y: 10, width: 100, height: 30 },
    outputRect: { x: 0, y: 0, width: 120, height: 50 },
    inkPixels: 120,
    removedSpecks: 0,
    scale: 1,
    evenLighting: true,
  };
}

let pngSeed = 0;
beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  // jsdom no dibuja: sin contexto 2D la vista previa no pinta (la logica es la misma) y no ensucia la consola.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  pngSeed = 0;
  vi.mocked(decodeImageFile).mockReset().mockImplementation(async () => fakeDecoded());
  vi.mocked(extractInkAsync).mockReset().mockImplementation(async () => fakeResult());
  vi.mocked(encodePng).mockReset().mockImplementation(async () => {
    pngSeed += 1;
    return new Blob([makePng({ width: 60, height: 30, seed: pngSeed }) as unknown as BlobPart], { type: "image/png" });
  });
  await clearVault();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function renderSheet(props: Partial<SignatureImportSheetProps> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <LanguageProvider>
      <SignatureImportSheet
        open
        onClose={onClose}
        strings={strings}
        target={{ kind: "vault" }}
        onSaved={onSaved}
        {...props}
      />
    </LanguageProvider>,
  );
  return { ...view, onClose, onSaved };
}

const fileInput = () => document.querySelector("[data-ink-file-input]") as HTMLInputElement;
const status = () => document.querySelector("[data-ink-status]") as HTMLElement;
const jpg = (name = "firma.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])], name, { type: "image/jpeg" });

async function pickFile(file: File = jpg()) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
  await screen.findByRole("heading", { name: copy.adjustTitle });
}

/** Espera a que la vista previa del ajuste vigente este lista (el boton de aceptar se habilita). */
async function previewReady() {
  await waitFor(() => expect((document.querySelector("[data-ink-accept]") as HTMLButtonElement).disabled).toBe(false));
}

const acceptButton = () => document.querySelector("[data-ink-accept]") as HTMLButtonElement;

describe("paso 1: elegir la imagen", () => {
  it("muestra la ayuda de la foto, la privacidad y los formatos; el foco empieza en «Elegir imagen»", async () => {
    renderSheet();
    expect(await screen.findByText(copy.tip)).toBeTruthy();
    expect(screen.getByText(copy.privacy)).toBeTruthy();
    expect(screen.getByText(copy.formats)).toBeTruthy();
    const pick = screen.getByRole("button", { name: copy.pickFile });
    await waitFor(() => expect(document.activeElement).toBe(pick));
    expect(fileInput().accept).toContain("image/png");
    expect(fileInput().accept).toContain("image/svg+xml");
  });

  it("en un ordenador no hay «Tomar una foto»", async () => {
    renderSheet();
    await screen.findByText(copy.tip);
    expect(screen.queryByRole("button", { name: copy.takePhoto })).toBeNull();
  });

  it("con puntero tactil aparece «Tomar una foto» y usa la camara trasera (capture)", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderSheet();
    expect(await screen.findByRole("button", { name: copy.takePhoto })).toBeTruthy();
    const camera = document.querySelector("[data-ink-camera-input]") as HTMLInputElement;
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.accept).toBe("image/*");
    // elegir una foto de la camara sigue el mismo camino que un archivo
    fireEvent.change(camera, { target: { files: [jpg("foto.jpg")] } });
    await screen.findByRole("heading", { name: copy.adjustTitle });
    vi.unstubAllGlobals();
  });

  it("arrastrar y soltar una imagen la carga; pegarla del portapapeles tambien", async () => {
    renderSheet();
    const zone = document.querySelector("[data-ink-dropzone]") as HTMLElement;
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(await screen.findByText(copy.dropActive)).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { files: [jpg("soltada.jpg")] } });
    await screen.findByRole("heading", { name: copy.adjustTitle });
    expect(vi.mocked(decodeImageFile).mock.calls[0][0]).toMatchObject({ name: "soltada.jpg" });
  });

  it("pegar desde el portapapeles carga la imagen (y un pegado sin imagen se ignora)", async () => {
    renderSheet();
    await screen.findByText(copy.tip);
    const ignored = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ignored, "clipboardData", { value: { files: [] } });
    document.dispatchEvent(ignored);
    expect(decodeImageFile).not.toHaveBeenCalled();
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { files: [jpg("pegada.jpg")] } });
    document.dispatchEvent(event);
    await screen.findByRole("heading", { name: copy.adjustTitle });
    expect(vi.mocked(decodeImageFile).mock.calls[0][0]).toMatchObject({ name: "pegada.jpg" });
  });

  it("soltar un archivo que no es imagen dice que el formato no sirve y no llama al motor", async () => {
    renderSheet();
    const zone = document.querySelector("[data-ink-dropzone]") as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "nota.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(status().textContent).toBe(copy.errors.unsupported));
    expect(decodeImageFile).not.toHaveBeenCalled();
  });
});

describe("errores amigables sin salir de la hoja", () => {
  const cases: Array<[string, keyof typeof copy.errors]> = [
    ["no-ink", "noInk"],
    ["too-dark", "tooDark"],
    ["file-too-large", "tooLargeFile"],
    ["unsupported-format", "unsupported"],
    ["empty-file", "empty"],
    ["too-many-pixels", "tooManyPixels"],
    ["decode-failed", "decode"],
  ];
  for (const [code, key] of cases) {
    it(`al leer: ${code} -> mensaje claro y la hoja sigue en el paso de elegir`, async () => {
      vi.mocked(decodeImageFile).mockRejectedValueOnce(new InkError(code as never));
      const { onClose } = renderSheet();
      fireEvent.change(fileInput(), { target: { files: [jpg()] } });
      await waitFor(() => expect(status().textContent).toBe(copy.errors[key]));
      expect(screen.getByRole("button", { name: copy.pickFile })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: copy.adjustTitle })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });
  }

  it("una foto HEIC que el navegador no abre pide JPG o PNG", async () => {
    vi.mocked(decodeImageFile).mockRejectedValueOnce(new InkError("decode-failed"));
    renderSheet();
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])], "IMG_1.heic", { type: "image/heic" });
    fireEvent.change(fileInput(), { target: { files: [heic] } });
    await waitFor(() => expect(status().textContent).toBe(copy.errors.heic));
    expect(copy.errors.heic).toMatch(/JPG o PNG/);
  });

  it("un fallo inesperado (no InkError) tambien se explica", async () => {
    vi.mocked(decodeImageFile).mockRejectedValueOnce(new Error("boom"));
    renderSheet();
    fireEvent.change(fileInput(), { target: { files: [jpg()] } });
    await waitFor(() => expect(status().textContent).toBe(copy.errors.generic));
  });

  it("«No se encontró tinta» al ajustar: el mensaje sale en el ajuste, el boton de usar queda deshabilitado y se puede corregir", async () => {
    vi.mocked(extractInkAsync).mockRejectedValueOnce(new InkError("no-ink"));
    renderSheet();
    await pickFile();
    await waitFor(() => expect(status().textContent).toBe(copy.errors.noInk));
    expect(acceptButton().disabled).toBe(true);
    // mover «Limpiar fondo» vuelve a intentarlo y ahora si hay tinta
    fireEvent.change(screen.getByRole("slider", { name: /Limpiar fondo/ }), { target: { value: "40" } });
    await previewReady();
    expect(status().textContent).not.toBe(copy.errors.noInk);
  });
});

describe("paso 2: ajustes y vista previa en vivo", () => {
  it("al cargar corre con los valores por defecto: umbral automatico, iluminacion, motas, tinta original, recorte automatico", async () => {
    renderSheet();
    await pickFile();
    await previewReady();
    const [, options, run] = vi.mocked(extractInkAsync).mock.calls[0];
    expect(options).toEqual({ threshold: "auto", ink: "original", cleanSpecks: "auto", evenLighting: true, crop: "auto", margin: "auto" });
    expect(run?.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByRole("slider", { name: /Limpiar fondo \(automático\)/ })).toBeTruthy();
    expect(screen.getByText(copy.previewChecker)).toBeTruthy();
    expect(screen.getByText(copy.previewLine)).toBeTruthy();
  });

  it("la vista previa se pinta en los dos fondos (damero y linea de firma) con el resultado del motor", async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    renderSheet();
    await pickFile();
    await previewReady();
    await waitFor(() => expect(document.querySelector('[data-ink-preview="checker"]')).not.toBeNull());
    // original (copia para ver) + damero + linea
    await waitFor(() => expect(putImageData.mock.calls.length).toBeGreaterThanOrEqual(2));
    const painted = putImageData.mock.calls.map((call) => (call[0] as { width: number }).width);
    expect(painted).toContain(60);
    vi.unstubAllGlobals();
  });

  it("cada control cambia la opcion del motor: motas, iluminacion, color, umbral y vuelta a «Automático»", async () => {
    renderSheet();
    await pickFile();
    await previewReady();
    const last = () => vi.mocked(extractInkAsync).mock.calls.at(-1)![1]!;

    fireEvent.click(screen.getByRole("switch", { name: new RegExp(copy.removeSpecks) }));
    await waitFor(() => expect(last().cleanSpecks).toBe(0));
    fireEvent.click(screen.getByRole("switch", { name: new RegExp(copy.evenLighting.replace(/[()]/g, "\\$&")) }));
    await waitFor(() => expect(last().evenLighting).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: copy.inkBlack }));
    await waitFor(() => expect(last().ink).toBe("black"));
    fireEvent.click(screen.getByRole("radio", { name: copy.inkBlue }));
    await waitFor(() => expect(last().ink).toBe("blue"));

    fireEvent.change(screen.getByRole("slider", { name: /Limpiar fondo/ }), { target: { value: "100" } });
    await waitFor(() => expect(last().threshold).toBe(34));
    expect(screen.getByRole("slider", { name: "Limpiar fondo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.cleanAuto }));
    await waitFor(() => expect(last().threshold).toBe("auto"));
  });

  it("cada cambio cancela el calculo anterior con su AbortSignal", async () => {
    let first: AbortSignal | undefined;
    vi.mocked(extractInkAsync).mockImplementationOnce(
      (_image, _options, run) =>
        new Promise((_resolve, reject) => {
          first = run?.signal;
          run?.signal?.addEventListener("abort", () => reject(new InkError("aborted")));
        }),
    );
    renderSheet();
    await pickFile();
    await waitFor(() => expect(first).toBeDefined());
    expect(first!.aborted).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: copy.inkBlack }));
    await waitFor(() => expect(first!.aborted).toBe(true));
    await previewReady();
    // la cancelacion no se muestra como error
    expect(status().textContent).not.toBe(copy.errors.generic);
  });

  it("varios cambios seguidos no lanzan un calculo por cada uno (debounce)", async () => {
    renderSheet();
    await pickFile();
    await previewReady();
    const calls = vi.mocked(extractInkAsync).mock.calls.length;
    const slider = screen.getByRole("slider", { name: /Limpiar fondo/ });
    for (const value of ["10", "20", "30", "40", "50"]) fireEvent.change(slider, { target: { value } });
    await waitFor(() => expect(vi.mocked(extractInkAsync).mock.calls.length).toBe(calls + 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(vi.mocked(extractInkAsync).mock.calls.length).toBe(calls + 1);
    expect(vi.mocked(extractInkAsync).mock.calls.at(-1)![1]!.threshold).toBe(thresholdFor(50));
  });

  function thresholdFor(cleaning: number): number {
    return Math.round(254 - ((254 - 34) * cleaning) / 100);
  }

  it("recorte manual: las 4 asas tienen nombre, se mueven con el teclado y el motor recibe el rectangulo en pixeles", async () => {
    renderSheet();
    await pickFile();
    await previewReady();
    fireEvent.click(screen.getByRole("button", { name: copy.cropManual }));
    const handles = ["nw", "ne", "sw", "se"].map((corner) => screen.getByRole("button", { name: copy.cropHandle(corner as "nw") }));
    expect(handles).toHaveLength(4);
    const group = screen.getByRole("group", { name: copy.cropAreaLabel });
    const before = group.getAttribute("data-crop");
    fireEvent.keyDown(handles[3], { key: "ArrowLeft", shiftKey: true });
    await waitFor(() => expect(group.getAttribute("data-crop")).not.toBe(before));
    await waitFor(() => {
      const crop = vi.mocked(extractInkAsync).mock.calls.at(-1)![1]!.crop;
      expect(crop).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });
    });
    const crop = vi.mocked(extractInkAsync).mock.calls.at(-1)![1]!.crop as { x: number; y: number; width: number; height: number };
    expect(crop.x + crop.width).toBeLessThanOrEqual(120);
    expect(crop.y + crop.height).toBeLessThanOrEqual(50);
    // volver al recorte automatico
    fireEvent.click(screen.getByRole("button", { name: copy.cropReset }));
    await waitFor(() => expect(vi.mocked(extractInkAsync).mock.calls.at(-1)![1]!.crop).toBe("auto"));
    expect(screen.queryByRole("group", { name: copy.cropAreaLabel })).toBeNull();
  });
});

describe("paso 3: guardar en «Firmas guardadas»", () => {
  async function toSummary(kind: "signature" | "initials" = "signature") {
    await pickFile();
    await previewReady();
    if (kind === "initials") fireEvent.click(screen.getByRole("radio", { name: copy.kindInitials }));
    await previewReady();
    fireEvent.click(acceptButton());
    await screen.findByRole("heading", { name: copy.summaryTitle });
  }

  it("firma subida -> el nombre es obligatorio; con nombre queda guardada con origin «uploaded», sin documento de origen y con el PNG limpio", async () => {
    const { onClose, onSaved } = renderSheet();
    await toSummary();
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    const name = screen.getByLabelText(copy.nameLabel) as HTMLInputElement;
    expect(await screen.findByText(copy.nameNeeded)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    expect((await listVault()).entries).toHaveLength(0);

    fireEvent.change(name, { target: { value: "Ana Pérez" } });
    expect(screen.queryByText(copy.nameNeeded)).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.roleLabel), { target: { value: "Directora" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledWith(copy.saved("Ana Pérez", "signature"));

    const [saved] = (await listVault()).entries;
    expect(saved).toMatchObject({ signerName: "Ana Pérez", role: "Directora", origin: "uploaded", sourceDocument: "", initials: null });
    expect(saved.signature?.width).toBe(60);
    expect(Array.from(saved.signature!.png)).toEqual(Array.from(makePng({ width: 60, height: 30, seed: 1 })));
  });

  it("firma + iniciales desde dos imagenes en dos pasos, en UNA entrada", async () => {
    const { onSaved } = renderSheet();
    await toSummary("signature");
    fireEvent.click(screen.getByRole("button", { name: copy.addInitials }));
    await screen.findByText(copy.tip);
    await pickFile(jpg("iniciales.jpg"));
    await previewReady();
    // tras la primera imagen, el segundo paso propone lo que falta
    fireEvent.click(screen.getByRole("radio", { name: copy.kindInitials }));
    await previewReady();
    fireEvent.click(acceptButton());
    await screen.findByRole("heading", { name: copy.summaryTitle });
    expect(screen.getByAltText(copy.slotAlt("signature"))).toBeTruthy();
    expect(screen.getByAltText(copy.slotAlt("initials"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Luis" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(copy.saved("Luis", "both")));
    const entries = (await listVault()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].initials).not.toBeNull();
    expect(entries[0].origin).toBe("uploaded");
  });

  it("solo iniciales: se guarda como iniciales y el aviso lo dice", async () => {
    const { onSaved } = renderSheet();
    await toSummary("initials");
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Marta" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(copy.saved("Marta", "initials")));
    const [entry] = (await listVault()).entries;
    expect(entry.signature).toBeNull();
    expect(entry.initials).not.toBeNull();
  });

  it("quitar una imagen del resumen y cambiarla", async () => {
    renderSheet();
    await toSummary();
    fireEvent.click(screen.getByRole("button", { name: `${copy.removeImage}: ${copy.slotSignature}` }));
    // sin ninguna imagen se vuelve a elegir
    await screen.findByText(copy.tip);
    expect(screen.getByRole("button", { name: copy.pickFile })).toBeTruthy();
  });

  it("el nombre conocido del firmante precarga el campo", async () => {
    renderSheet({ preferSignerName: "Ana Pérez" });
    await toSummary();
    expect((screen.getByLabelText(copy.nameLabel) as HTMLInputElement).value).toBe("Ana Pérez");
  });

  it("baul lleno: lo avisa, y guardar una firma distinta se rechaza con el mensaje de limite (sin cerrar)", async () => {
    for (let i = 0; i < MAX_VAULT_ENTRIES; i += 1) {
      const saved = await saveVaultEntry(vaultInput(`Firmante ${i}`, { signature: { png: makePng({ width: 30, height: 10, seed: 200 + i }), ratio: 10 / 30, width: 30, height: 10 }, initials: null }));
      expect(saved.ok).toBe(true);
    }
    const { onClose, onSaved } = renderSheet();
    await screen.findByText(copy.vaultFull);
    await toSummary();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Nuevo Firmante" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(status().textContent).toBe(copy.saveLimit));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
  });

  it("sin IndexedDB: mensaje de que no se pudo guardar, sin cerrar", async () => {
    renderSheet();
    await toSummary();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Ana" } });
    vi.stubGlobal("indexedDB", undefined);
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(status().textContent).toBe(copy.saveUnavailable));
    vi.unstubAllGlobals();
  });

  it("guardar la misma imagen dos veces no duplica y lo dice", async () => {
    vi.mocked(encodePng).mockImplementation(async () => new Blob([makePng({ width: 60, height: 30, seed: 5 }) as unknown as BlobPart]));
    const first = renderSheet();
    await toSummary();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    first.unmount();
    const second = renderSheet();
    await toSummary();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledWith(copy.savedDuplicate("Ana")));
    expect((await listVault()).entries).toHaveLength(1);
  });
});

describe("privacidad", () => {
  it("la imagen original no se guarda: al aceptar se suelta y en el baul solo hay el PNG de tinta", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    renderSheet();
    await pickFile();
    await previewReady();
    fireEvent.click(acceptButton());
    await screen.findByRole("heading", { name: copy.summaryTitle });
    // sin recorte ni controles: la imagen original ya no esta en la hoja
    expect(screen.queryByRole("group", { name: copy.cropAreaLabel })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.nameLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await waitFor(async () => expect((await listVault()).entries).toHaveLength(1));
    const [entry] = (await listVault()).entries;
    expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "initials", "lastUsedAt", "origin", "schema", "signature", "signerKey", "signerName", "sourceDocument"].sort());
    expect(entry.sourceDocument).toBe("");
    // y nada se envio a ninguna parte
    expect(createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("desde el compositor (borrador, sin guardar en el baul)", () => {
  it("«Usar esta imagen» devuelve el PNG limpio como data URL con su proporcion y cierra; el baul sigue vacio", async () => {
    const onUse = vi.fn();
    const { onClose } = renderSheet({ target: { kind: "draft", variant: "signature", onUse } });
    expect(await screen.findByRole("dialog", { name: copy.composeTitle })).toBeTruthy();
    await pickFile();
    // en este modo no se pregunta si es firma o iniciales ni el nombre
    expect(screen.queryByText(copy.kindLabel)).toBeNull();
    await previewReady();
    fireEvent.click(screen.getByRole("button", { name: copy.useDraft }));
    await waitFor(() => expect(onUse).toHaveBeenCalled());
    expect(onUse.mock.calls[0][0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(onUse.mock.calls[0][0].ratio).toBeCloseTo(0.5, 5);
    expect(onClose).toHaveBeenCalled();
    expect((await listVault()).entries).toHaveLength(0);
  });
});

describe("accesibilidad", () => {
  it("una sola region de estado, hoja modal con titulo, y el foco pasa al titulo de cada paso", async () => {
    renderSheet();
    const dialog = await screen.findByRole("dialog", { name: copy.title });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    await pickFile();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: copy.adjustTitle })));
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    await previewReady();
    fireEvent.click(acceptButton());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: copy.summaryTitle })));
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
  });

  it("en ingles la hoja y sus mensajes salen en ingles", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const en = SIGN_STRINGS.en.inkImport;
    renderSheet({ strings: SIGN_STRINGS.en });
    expect(await screen.findByText(en.tip)).toBeTruthy();
    vi.mocked(decodeImageFile).mockRejectedValueOnce(new InkError("no-ink"));
    fireEvent.change(fileInput(), { target: { files: [jpg()] } });
    await waitFor(() => expect(status().textContent).toBe(en.errors.noInk));
  });
});
