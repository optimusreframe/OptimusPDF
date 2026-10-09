import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import {
  clearVault,
  deleteVaultEntry,
  listVault,
  saveVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { exportVaultEntry } from "@/app/sign-pdf/signVaultFile";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { makeImage, vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { downloadBlob } from "@/lib/pdf/core";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/** La descarga real crea un <a> y una URL de objeto: aqui solo importa que se pida. */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

/**
 * Envuelve el export real para poder retrasarlo (estado «procesando»). Ademas
 * copia los PNG al reino de jsdom: fake-indexeddb devuelve `Uint8Array` del
 * reino de Node y JSZip (que usa `instanceof`) los rechazaria; en un
 * navegador real no hay dos reinos.
 */
vi.mock("@/app/sign-pdf/signVaultFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signVaultFile")>();
  const sameRealm = <T extends { png: Uint8Array } | null>(image: T): T =>
    image ? ({ ...image, png: new Uint8Array(image.png) } as T) : image;
  return {
    ...actual,
    exportVaultEntry: vi.fn((entry: Parameters<typeof actual.exportVaultEntry>[0], opts) =>
      actual.exportVaultEntry(
        {
          ...entry,
          signature: sameRealm(entry.signature),
          initials: sameRealm(entry.initials),
        },
        opts,
      ),
    ),
  };
});

const strings = SIGN_STRINGS.es;

/* IndexedDB (fake) y las hojas animadas van mas lentas con toda la suite en paralelo. */
configure({ asyncUtilTimeout: 5000 });

beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  vi.mocked(downloadBlob).mockClear();
  vi.mocked(exportVaultEntry).mockClear();
  await clearVault();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSheet(
  props: Partial<React.ComponentProps<typeof SignatureVaultSheet>> = {},
) {
  return render(
    <LanguageProvider>
      <SignatureVaultSheet open onClose={() => {}} strings={strings} {...props} />
    </LanguageProvider>,
  );
}

async function seed(
  name: string,
  overrides: Parameters<typeof vaultInput>[1] = {},
): Promise<VaultEntry> {
  const result = await saveVaultEntry(vaultInput(name, overrides));
  if (!result.ok) throw new Error("no se pudo sembrar el baul");
  return result.entry;
}

const fileInput = () =>
  document.querySelector('input[type="file"]') as HTMLInputElement;

async function importFile(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

describe("SignatureVaultSheet — lista", () => {
  it("estado vacio amable y 'Borrar todas' deshabilitado", async () => {
    renderSheet();
    expect(await screen.findByText(strings.vaultEmpty)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: strings.vaultDeleteAll }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("muestra miniatura de firma e iniciales, nombre, cargo, documento y fecha", async () => {
    await seed("Ana Pérez");
    renderSheet();
    expect(await screen.findByText("Ana Pérez")).toBeTruthy();
    expect(screen.getByText("Directora")).toBeTruthy();
    const detail = screen.getByText(new RegExp(strings.vaultUsedIn("contrato.pdf")));
    expect(detail.textContent).toContain(strings.vaultLastUsed("").trim().slice(0, 9));
    const signature = screen.getByAltText(strings.vaultSignatureAlt("Ana Pérez"));
    expect((signature as HTMLImageElement).src.startsWith("data:image/png;base64,")).toBe(true);
    expect(screen.getByAltText(strings.vaultInitialsAlt("Ana Pérez"))).toBeTruthy();
  });

  it("las entradas del firmante pedido salen primero y se marcan", async () => {
    await seed("Ana Pérez");
    await seed("Luis Gómez", { signature: makeImage({ seed: 5 }) });
    renderSheet({ preferSignerName: "ana perez" });
    await screen.findByText("Luis Gómez");
    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent);
    expect(names).toEqual(["Ana Pérez", "Luis Gómez"]);
    expect(screen.getAllByText(strings.vaultMatchesSigner)).toHaveLength(1);
  });

  it("'Usar' entrega la entrada elegida", async () => {
    const entry = await seed("Ana Pérez");
    const onUse = vi.fn();
    renderSheet({ onUse, need: "signature" });
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }),
    );
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0][0].id).toBe(entry.id);
  });

  it("una entrada sin la imagen necesaria se lista, pero sin 'Usar' y con la explicacion", async () => {
    await seed("Solo Firma", { initials: null });
    renderSheet({ onUse: vi.fn(), need: "initials" });
    await screen.findByText("Solo Firma");
    expect(screen.queryByRole("button", { name: strings.vaultUseFor("Solo Firma") })).toBeNull();
    expect(screen.getByText(strings.vaultLacksInitials)).toBeTruthy();
  });

  it("sin onUse (solo gestion) no hay botones 'Usar'", async () => {
    await seed("Ana Pérez");
    renderSheet();
    await screen.findByText("Ana Pérez");
    expect(screen.queryByRole("button", { name: strings.vaultUseFor("Ana Pérez") })).toBeNull();
  });

  it("'Crear una firma nueva' aparece solo si hay onCreateNew", async () => {
    const onCreateNew = vi.fn();
    const { unmount } = renderSheet({ onCreateNew });
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultCreateNew }));
    expect(onCreateNew).toHaveBeenCalled();
    unmount();
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    expect(screen.queryByRole("button", { name: strings.vaultCreateNew })).toBeNull();
  });

  it("se refresca cuando el baul cambia desde fuera (otra pestaña)", async () => {
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await seed("Ana Pérez");
    expect(await screen.findByText("Ana Pérez")).toBeTruthy();
    const [entry] = (await listVault()).entries;
    await deleteVaultEntry(entry.id);
    expect(await screen.findByText(strings.vaultEmpty)).toBeTruthy();
  });
});

describe("SignatureVaultSheet — editar y borrar", () => {
  it("editar nombre y cargo se guarda, se ve en la lista y el foco vuelve al boton de editar", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultEditLabel("Ana Pérez") }),
    );
    const name = screen.getByLabelText(strings.vaultEditNameLabel) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(name));
    fireEvent.change(name, { target: { value: "Ana Ruiz" } });
    fireEvent.change(screen.getByLabelText(strings.vaultEditRoleLabel), {
      target: { value: "Gerente" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.vaultEditSave }));

    expect(await screen.findByText("Ana Ruiz")).toBeTruthy();
    expect(screen.getByText("Gerente")).toBeTruthy();
    expect(screen.getByText(strings.vaultEdited)).toBeTruthy();
    const [stored] = (await listVault()).entries;
    expect(stored.signerName).toBe("Ana Ruiz");
    expect(stored.role).toBe("Gerente");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: strings.vaultEditLabel("Ana Ruiz") }),
      ),
    );
  });

  it("un nombre vacio no se guarda y se explica; Cancelar deja todo igual", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultEditLabel("Ana Pérez") }),
    );
    fireEvent.change(screen.getByLabelText(strings.vaultEditNameLabel), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.vaultEditSave }));
    expect(await screen.findByText(strings.vaultEditInvalid)).toBeTruthy();
    expect((await listVault()).entries[0].signerName).toBe("Ana Pérez");

    fireEvent.click(screen.getByRole("button", { name: strings.vaultEditCancel }));
    expect(screen.queryByLabelText(strings.vaultEditNameLabel)).toBeNull();
    expect(screen.getByText("Ana Pérez")).toBeTruthy();
  });

  it("borrar una firma la quita del baul, lo avisa y el foco no cae en <body>", async () => {
    await seed("Ana Pérez");
    await seed("Luis Gómez", { signature: makeImage({ seed: 5 }) });
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultDeleteLabel("Ana Pérez") }),
    );
    await waitFor(async () => expect((await listVault()).entries).toHaveLength(1));
    expect(await screen.findByText(strings.vaultDeleted)).toBeTruthy();
    // La lista se refresca con el aviso del baul: espera a que salga.
    await waitFor(() => expect(screen.queryByText("Ana Pérez")).toBeNull());
    expect(screen.getByText("Luis Gómez")).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.getAttribute("role")).toBe("region");
    });
  });

  it("'Borrar todas' pide confirmacion y vacia el baul", async () => {
    await seed("Ana Pérez");
    await seed("Luis Gómez", { signature: makeImage({ seed: 5 }) });
    renderSheet();
    await screen.findByText("Luis Gómez");
    fireEvent.click(screen.getByRole("button", { name: strings.vaultDeleteAll }));
    // Sin confirmar nada se borra.
    const confirm = await screen.findByRole("dialog", {
      name: strings.vaultDeleteAllTitle,
    });
    expect((await listVault()).entries).toHaveLength(2);
    fireEvent.click(within(confirm).getByRole("button", { name: strings.vaultDeleteAll }));
    await waitFor(async () => expect((await listVault()).entries).toHaveLength(0));
    expect(await screen.findByText(strings.vaultDeletedAll)).toBeTruthy();
    expect(await screen.findByText(strings.vaultEmpty)).toBeTruthy();
  });

  it("cancelar la confirmacion de 'Borrar todas' no borra nada", async () => {
    await seed("Ana Pérez");
    renderSheet();
    await screen.findByText("Ana Pérez");
    fireEvent.click(screen.getByRole("button", { name: strings.vaultDeleteAll }));
    const confirm = await screen.findByRole("dialog", {
      name: strings.vaultDeleteAllTitle,
    });
    fireEvent.click(within(confirm).getByRole("button", { name: strings.confirmCancel }));
    expect((await listVault()).entries).toHaveLength(1);
  });
});

describe("SignatureVaultSheet — detalles de la r2", () => {
  it("«Borrar todas» usa la variante destructiva del sistema (visible como accion destructiva)", async () => {
    await seed("Ana Pérez");
    renderSheet();
    await screen.findByText("Ana Pérez");
    const button = screen.getByRole("button", { name: strings.vaultDeleteAll });
    expect(button.className).toContain("text-destructive-text");
    expect(button.className).toContain("bg-destructive/12");
    expect(button.className).not.toContain("text-foreground");
  });

  it("al pedir la contraseña de un archivo cifrado el foco va al campo de contraseña", async () => {
    const result = await exportVaultEntry(vaultInput("Ana Pérez"), { password: "secreto-123" });
    if (!result.ok) throw new Error("export de prueba fallido");
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    fireEvent.change(fileInput(), {
      target: { files: [new File([result.blob], result.filename, { type: "application/zip" })] },
    });
    const dialog = await screen.findByRole("dialog", { name: strings.vaultImportPasswordTitle });
    const input = within(dialog).getByLabelText(strings.vaultImportPasswordLabel);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.id).toBe("vault-import-password");
  });

  it("un archivo exportado SIN documento se importa y se puede volver a exportar", async () => {
    const result = await exportVaultEntry(
      { ...vaultInput("Ana Pérez"), sourceDocument: "" },
      {},
    );
    if (!result.ok) throw new Error("export de prueba fallido");
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    fireEvent.change(fileInput(), {
      target: { files: [new File([result.blob], result.filename, { type: "application/zip" })] },
    });
    await screen.findByText(strings.vaultImported("Ana Pérez"));
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("Firma-ana-perez.zip");
  });
});

describe("SignatureVaultSheet — no disponible", () => {
  it("sin IndexedDB explica que se puede seguir firmando y no ofrece borrar ni importar", async () => {
    vi.stubGlobal("indexedDB", undefined);
    renderSheet();
    expect(await screen.findByText(strings.vaultUnavailable)).toBeTruthy();
    expect(strings.vaultUnavailable).toMatch(/seguir firmando/);
    expect(strings.vaultUnavailable).toMatch(/exportar e importar sirve de respaldo/);
    expect(screen.queryByRole("button", { name: strings.vaultImport })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.vaultDeleteAll })).toBeNull();
  });
});

describe("SignatureVaultSheet — controles discretos de exportar e importar", () => {
  it("son solo icono: sin texto visible, con aria-label y title neutros", async () => {
    await seed("Ana Pérez");
    renderSheet();
    const importButton = await screen.findByRole("button", { name: strings.vaultImport });
    expect(importButton.getAttribute("title")).toBe(strings.vaultImport);
    expect(importButton.textContent).toBe("");
    expect(importButton.querySelector("svg")).toBeTruthy();

    const exportButton = await screen.findByRole("button", {
      name: strings.vaultExportFor("Ana Pérez"),
    });
    expect(exportButton.getAttribute("title")).toBe(strings.vaultExport);
    expect(exportButton.textContent).toBe("");
    // Nada visible habla de «guardar firmas» en el control.
    expect(`${importButton.outerHTML}${exportButton.outerHTML}`).not.toMatch(/guardar/i);
  });
});

describe("SignatureVaultSheet — exportar", () => {
  it("sin contraseña: avisa de que la firma va en claro y descarga el .zip", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    const password = within(dialog).getByLabelText(
      strings.vaultExportPasswordLabel,
    ) as HTMLInputElement;
    expect(password.disabled).toBe(false);
    expect(within(dialog).getByText(strings.vaultExportPlainWarning)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    // Por defecto el nombre identifica al firmante Y al documento.
    expect(filename).toBe("Firma-ana-perez-contrato.zip");
    expect(
      await screen.findByText(strings.vaultExportDone("Firma-ana-perez-contrato.zip", false)),
    ).toBeTruthy();
  });

  it("la casilla del documento llega MARCADA (con el aviso de visibilidad) y desmarcarla quita el documento del nombre", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    expect(within(dialog).getByText(strings.vaultExportIncludeDocumentHint)).toBeTruthy();
    const box = within(dialog).getByRole("checkbox", {
      name: strings.vaultExportIncludeDocument,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("Firma-ana-perez.zip");
  });

  it("con contraseña la casilla sigue marcada y el aviso de que el nombre es visible sigue ahi", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    fireEvent.change(within(dialog).getByLabelText(strings.vaultExportPasswordLabel), {
      target: { value: "secreto-123" },
    });
    expect(
      (within(dialog).getByRole("checkbox", {
        name: strings.vaultExportIncludeDocument,
      }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(dialog).getByText(strings.vaultExportIncludeDocumentHint)).toBeTruthy();
  });

  it("una entrada SIN documento de origen no muestra la casilla y se exporta sin error como Firma-<firmante>.zip", async () => {
    await seed("Ana Pérez", { sourceDocument: "" });
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    expect(
      within(dialog).queryByRole("checkbox", { name: strings.vaultExportIncludeDocument }),
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("Firma-ana-perez.zip");
    expect(await screen.findByText(/Descargado/)).toBeTruthy();
  });

  it("con contraseña: pide repetirla, rechaza si no coinciden y cifra el archivo", async () => {
    await seed("Ana Pérez");
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    fireEvent.change(within(dialog).getByLabelText(strings.vaultExportPasswordLabel), {
      target: { value: "secreto-123" },
    });
    // Con contraseña ya no se avisa de «en claro» y se pide repetirla.
    expect(within(dialog).queryByText(strings.vaultExportPlainWarning)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(strings.vaultExportPasswordConfirmLabel), {
      target: { value: "otra-cosa" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    expect(await within(dialog).findByText(strings.vaultExportPasswordMismatch)).toBeTruthy();
    expect(downloadBlob).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(strings.vaultExportPasswordConfirmLabel), {
      target: { value: "secreto-123" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(
      await screen.findByText(strings.vaultExportDone("Firma-ana-perez-contrato.zip", true)),
    ).toBeTruthy();
  }, 30000);

  it("mientras cifra, el boton y los campos quedan deshabilitados y se avisa de que tarda", async () => {
    await seed("Ana Pérez");
    let finish: (value: Awaited<ReturnType<typeof exportVaultEntry>>) => void = () => {};
    vi.mocked(exportVaultEntry).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));

    const button = within(dialog).getByRole("button", {
      name: strings.vaultExportConfirm,
    }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(within(dialog).getByText(strings.vaultExportWorking)).toBeTruthy();
    expect(
      (within(dialog).getByLabelText(strings.vaultExportPasswordLabel) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    // Un segundo clic mientras procesa no lanza otro export.
    fireEvent.click(button);
    expect(vi.mocked(exportVaultEntry)).toHaveBeenCalledTimes(1);

    finish({
      ok: true,
      blob: new Blob(["x"]),
      filename: "Firma-ana-perez.zip",
      encrypted: false,
    });
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  });

  it("sin crypto.subtle la contraseña queda deshabilitada con la nota, y se puede exportar sin ella", async () => {
    await seed("Ana Pérez");
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    const password = within(dialog).getByLabelText(
      strings.vaultExportPasswordLabel,
    ) as HTMLInputElement;
    expect(password.disabled).toBe(true);
    expect(within(dialog).getByText(strings.vaultExportPasswordUnavailable)).toBeTruthy();
    expect(within(dialog).getByText(strings.vaultExportPlainWarning)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  });

  it("si el export falla lo dice y no descarga nada", async () => {
    await seed("Ana Pérez");
    vi.mocked(exportVaultEntry).mockResolvedValueOnce({ ok: false, reason: "failed" });
    renderSheet();
    fireEvent.click(
      await screen.findByRole("button", { name: strings.vaultExportFor("Ana Pérez") }),
    );
    const dialog = await screen.findByRole("dialog", { name: strings.vaultExportTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultExportConfirm }));
    expect(await within(dialog).findByText(strings.vaultExportFailed)).toBeTruthy();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe("SignatureVaultSheet — importar", () => {
  async function exported(name: string, password?: string): Promise<File> {
    const result = await exportVaultEntry(vaultInput(name), { password });
    if (!result.ok) throw new Error("export de prueba fallido");
    return new File([result.blob], result.filename, { type: "application/zip" });
  }

  it("un archivo valido entra en el baul y aparece en la lista", async () => {
    const file = await exported("Ana Pérez");
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await importFile(file);
    expect(await screen.findByText(strings.vaultImported("Ana Pérez"))).toBeTruthy();
    expect(await screen.findByText("Ana Pérez")).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("importar lo que ya estaba guardado lo dice y no duplica", async () => {
    const file = await exported("Ana Pérez");
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await importFile(file);
    await screen.findByText(strings.vaultImported("Ana Pérez"));
    await importFile(file);
    expect(
      await screen.findByText(strings.vaultImportedDuplicate("Ana Pérez")),
    ).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("un archivo cifrado pide la contraseña: la incorrecta se explica y la correcta importa", async () => {
    const file = await exported("Ana Pérez", "secreto-123");
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await importFile(file);
    const dialog = await screen.findByRole("dialog", {
      name: strings.vaultImportPasswordTitle,
    });
    const input = within(dialog).getByLabelText(strings.vaultImportPasswordLabel);
    fireEvent.change(input, { target: { value: "mal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultImportPasswordConfirm }));
    expect(
      await within(dialog).findByText(strings.vaultImportWrongPassword, {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(0);
    // Tras el error el foco sigue (o vuelve) en el campo, no cae en <body>.
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "secreto-123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.vaultImportPasswordConfirm }));
    expect(
      await screen.findByText(strings.vaultImported("Ana Pérez"), {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(1);
  }, 40000);

  it("un archivo que no es de firmas da un mensaje humano y no toca el baul", async () => {
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await importFile(new File(["no soy un zip"], "raro.zip", { type: "application/zip" }));
    expect(await screen.findByText(strings.vaultImportInvalid)).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("un archivo demasiado grande da su propio mensaje", async () => {
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    await importFile(
      new File([new Uint8Array(4 * 1024 * 1024 + 1)], "enorme.zip", { type: "application/zip" }),
    );
    expect(await screen.findByText(strings.vaultImportTooLarge)).toBeTruthy();
  });

  it("con el baul lleno dice el motivo (limite) en vez de fallar en silencio", async () => {
    for (let index = 0; index < 30; index += 1) {
      const result = await saveVaultEntry(
        vaultInput(`Firmante ${index}`, {
          signature: makeImage({ seed: index + 10 }),
          initials: null,
        }),
      );
      expect(result.ok).toBe(true);
    }
    const file = await exported("Una Mas");
    renderSheet();
    await screen.findByText("Firmante 0");
    await importFile(file);
    expect(await screen.findByText(strings.vaultSaveLimit)).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(30);
  }, 30000);
});

describe("SignatureVaultSheet — region de estado", () => {
  it("el role=status esta montado desde el principio (vacio) y sin aviso no ocupa sitio", async () => {
    renderSheet();
    await screen.findByText(strings.vaultEmpty);
    const dialog = screen.getByRole("dialog", { name: strings.vaultTitle });
    const status = within(dialog).getAllByRole("status")[0];
    expect(status.textContent).toBe("");
    expect(status.className).toContain("sr-only");
  });
});
