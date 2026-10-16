import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignatureComposer } from "@/app/sign-pdf/SignatureComposer";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { exportVaultEntry } from "@/app/sign-pdf/signVaultFile";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { decodeImageFile, encodePng, extractInkAsync } from "@/lib/image/inkExtract";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Los puntos de entrada de la subida y del respaldo: los tres botones nuevos de «Firmas guardadas» y el modo
 * «Subir» del compositor (que ahora pasa por el motor de tinta en vez de solo recortar por alfa).
 */

vi.mock("@/lib/image/inkExtract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image/inkExtract")>();
  return { ...actual, decodeImageFile: vi.fn(), extractInkAsync: vi.fn(), encodePng: vi.fn() };
});

const strings = SIGN_STRINGS.es;
const ink = strings.inkImport;
const backup = strings.vaultBackup;

beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(decodeImageFile).mockReset().mockResolvedValue({
    width: 120,
    height: 50,
    data: new Uint8ClampedArray(120 * 50 * 4),
    format: "jpeg",
    originalWidth: 120,
    originalHeight: 50,
    downscaled: false,
  });
  vi.mocked(extractInkAsync).mockReset().mockResolvedValue({
    image: { width: 60, height: 30, data: new Uint8ClampedArray(60 * 30 * 4) },
    threshold: 140,
    auto: true,
    inkBounds: { x: 10, y: 10, width: 100, height: 30 },
    outputRect: { x: 0, y: 0, width: 120, height: 50 },
    inkPixels: 120,
    removedSpecks: 0,
    scale: 1,
    evenLighting: true,
  });
  vi.mocked(encodePng).mockReset().mockImplementation(
    async () => new Blob([makePng({ width: 60, height: 30, seed: 7 }) as unknown as BlobPart], { type: "image/png" }),
  );
  await clearVault();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jpg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])], "firma.jpg", { type: "image/jpeg" });
const previewReady = () =>
  waitFor(() => expect((document.querySelector("[data-ink-accept]") as HTMLButtonElement).disabled).toBe(false));

function renderVault() {
  return render(
    <LanguageProvider>
      <SignatureVaultSheet open onClose={() => {}} strings={strings} />
    </LanguageProvider>,
  );
}

describe("«Firmas guardadas»: subir y respaldar", () => {
  it("muestra «Subir firma o iniciales», «Exportar todas mis firmas» e «Importar firmas»; exportar espera a que haya firmas", async () => {
    renderVault();
    expect(await screen.findByRole("button", { name: ink.entryButton })).toBeTruthy();
    expect(screen.getByRole("button", { name: backup.importButton })).toBeTruthy();
    const exportButton = screen.getByRole("button", { name: backup.exportButton }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(screen.getByText(backup.sectionHint)).toBeTruthy();
  });

  it("subir una imagen desde aqui la guarda y aparece en la lista, con el aviso en la region de estado", async () => {
    renderVault();
    const uploadButton = (await screen.findByRole("button", { name: ink.entryButton })) as HTMLButtonElement;
    await waitFor(() => expect(uploadButton.disabled).toBe(false));
    fireEvent.click(uploadButton);
    const dialog = await screen.findByRole("dialog", { name: ink.title });
    fireEvent.change(dialog.querySelector("[data-ink-file-input]") as HTMLInputElement, { target: { files: [jpg()] } });
    await screen.findByRole("heading", { name: ink.adjustTitle });
    await previewReady();
    fireEvent.click(document.querySelector("[data-ink-accept]") as HTMLButtonElement);
    fireEvent.change(await screen.findByLabelText(ink.nameLabel), { target: { value: "Ana Pérez" } });
    fireEvent.click(screen.getByRole("button", { name: ink.save }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: ink.title })).toBeNull());
    expect(await screen.findByText(ink.saved("Ana Pérez", "signature"))).toBeTruthy();
    expect(await screen.findByAltText(strings.vaultSignatureAlt("Ana Pérez"))).toBeTruthy();
    expect((await listVault()).entries[0].origin).toBe("uploaded");
  });

  it("«Exportar todas mis firmas» abre su hoja con el numero de firmas", async () => {
    await saveVaultEntry(vaultInput("Ana Pérez"));
    await saveVaultEntry(vaultInput("Luis Gómez", { signature: vaultInput("x", { }).signature }));
    renderVault();
    await screen.findByText("Ana Pérez");
    const button = screen.getByRole("button", { name: backup.exportButton }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: backup.exportTitle });
    expect(within(dialog).getByText(backup.exportBody(2))).toBeTruthy();
  });

  it("«Importar firmas» recibe tambien el archivo de UNA firma del formato anterior y lo importa como siempre", async () => {
    const saved = await saveVaultEntry(vaultInput("Ana Pérez"));
    if (!saved.ok) throw new Error("seed");
    const sameRealm = <T extends { png: Uint8Array } | null>(image: T): T =>
      image ? ({ ...image, png: new Uint8Array(image.png) } as T) : image;
    const exported = await exportVaultEntry(
      { ...saved.entry, signature: sameRealm(saved.entry.signature), initials: sameRealm(saved.entry.initials) },
      {},
    );
    if (!exported.ok) throw new Error("export");
    await clearVault();
    renderVault();
    const importButton = (await screen.findByRole("button", { name: backup.importButton })) as HTMLButtonElement;
    await waitFor(() => expect(importButton.disabled).toBe(false));
    fireEvent.click(importButton);
    const dialog = await screen.findByRole("dialog", { name: backup.importTitle });
    const input = dialog.querySelector("[data-backup-file-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([exported.blob], "Firma-ana.zip", { type: "application/zip" })] } });
    expect(await screen.findByText(strings.vaultImported("Ana Pérez"))).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("el icono discreto de importar de siempre sigue ahi", async () => {
    renderVault();
    expect(await screen.findByRole("button", { name: strings.vaultImport })).toBeTruthy();
  });
});

describe("compositor: modo «Subir» con el motor de tinta", () => {
  function renderComposer(onSave = vi.fn(), variant: "signature" | "initials" = "signature") {
    render(
      <LanguageProvider>
        <SignatureComposer open onClose={() => {}} onSave={onSave} strings={strings} variant={variant} />
      </LanguageProvider>,
    );
    return onSave;
  }

  it("elegir imagen abre la hoja de subida; «Usar esta imagen» devuelve el PNG limpio y se guarda con «Usar esta firma»", async () => {
    const onSave = renderComposer();
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeUpload }));
    expect(screen.getByText(strings.uploadHint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.uploadPick }));
    const dialog = await screen.findByRole("dialog", { name: ink.composeTitle });
    fireEvent.change(dialog.querySelector("[data-ink-file-input]") as HTMLInputElement, { target: { files: [jpg()] } });
    await screen.findByRole("heading", { name: ink.adjustTitle });
    await previewReady();
    // en este modo no hay nombre ni tipo ni guardado en el baul
    expect(screen.queryByLabelText(ink.nameLabel)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ink.useDraft }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: ink.composeTitle })).toBeNull());
    const preview = document.querySelector("[data-composer-upload-preview] img") as HTMLImageElement;
    expect(preview.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(screen.getByRole("button", { name: ink.changeImage })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ dataUrl: preview.src });
    expect(onSave.mock.calls[0][0].ratio).toBeCloseTo(0.5, 5);
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("sin imagen elegida, guardar avisa (no guarda nada)", async () => {
    const onSave = renderComposer();
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeUpload }));
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
