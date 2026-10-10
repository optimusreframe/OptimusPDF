import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { blockedRunText } from "@/components/tool/errorCopy";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import {
  ToolShell,
  type CanRunResult,
  type InputPolicy,
  type ProcessResult,
} from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { PdfError, loadPdf } from "@/lib/pdf/core";
import {
  createInputGuard,
  isDecryptedCopy,
  type InputCheck,
  type InputGuard,
} from "@/lib/pdf/inputGuard";
import {
  BAD_FILE_KINDS,
  EXPECTED_CODE,
  buildBadFile,
  buildEncryptedPdf,
  buildGoodPdf,
  pdfFile,
  type BadFileKind,
} from "@/lib/pdf/testing/inputFixtures";
import { getTool } from "@/lib/tools-registry";

/**
 * Wave 6 · U1/U2/U3 sobre `ToolShell`: los 7 archivos malos con archivos reales,
 * las acciones del banner, la hoja de contrasena, `canRun` con motivo y un solo
 * «Procesar». La comprobacion de entrada se inyecta con `InputGuardContext`
 * (pdf.js no corre en jsdom): abre con pdf-lib como los motores.
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const SINGLE = getTool("rotate-pdf");
const MULTI = getTool("merge-pdf");
type Options = { note: string };
const DEFAULTS: Options = { note: "" };
const tool = es.tool;

async function strictOpen(file: File): Promise<void> {
  (await loadPdf(file)).getPageCount();
}
const realGuard = createInputGuard({ open: strictOpen });

type ShellProps = {
  tool?: typeof SINGLE;
  guard?: InputGuard | null;
  policy?: InputPolicy | "off";
  canRun?: (files: File[], options: Options) => boolean | CanRunResult;
  withOptions?: boolean;
  minFiles?: number;
  process?: (files: File[]) => Promise<ProcessResult>;
};

function renderShell(props: ShellProps = {}) {
  const process = vi.fn(
    props.process ??
      (async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "salida.pdf" })),
  );
  const utils = render(
    <LanguageProvider>
      <InputGuardContext.Provider value={props.guard === undefined ? realGuard : props.guard}>
        <ToolShell<Options>
          tool={props.tool ?? SINGLE}
          defaultOptions={DEFAULTS}
          process={process}
          minFiles={props.minFiles}
          inputPolicy={props.policy}
          canRun={props.canRun}
          renderOptions={props.withOptions ? () => <p>panel de opciones</p> : undefined}
        />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
  return { ...utils, process };
}

async function findBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = document.querySelector<HTMLElement>("[data-error-banner]");
    expect(banner).toBeTruthy();
    return banner as HTMLElement;
  });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

async function upload(container: HTMLElement, ...files: File[]) {
  fireEvent.change(fileInput(container), { target: { files } });
}

/** Los «Procesar» que se pintan en escritorio (el de la barra movil es `md:hidden`). */
function desktopRunButtons(): HTMLElement[] {
  return screen
    .queryAllByRole("button", { name: "Procesar" })
    .filter((button) => !button.closest(".md\\:hidden"));
}

function runButton(): HTMLButtonElement {
  return screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement;
}

async function goodPdf(name = "bueno.pdf", pages = 2): Promise<File> {
  return pdfFile(await buildGoodPdf(pages), name);
}

const MESSAGE: Record<string, string> = {
  corrupt: es.tool.errors.corrupt,
  emptyFile: es.tool.errors.emptyFile,
  notPdf: es.tool.errors.notPdf,
  encrypted: es.tool.encryptedSheetMessage,
  tooLarge: es.tool.errors.tooLarge,
};

describe("ToolShell — los 7 archivos malos al subirlos", () => {
  for (const kind of BAD_FILE_KINDS) {
    const code = EXPECTED_CODE[kind];
    it(`${kind}: banner «${code}» con sus acciones y el foco en el banner`, async () => {
      const { container, process } = renderShell();
      await upload(container, await buildBadFile(kind));

      // `tooLarge` es un aviso (role=status) con titulo propio; el resto, una alerta de archivo inservible.
      const alert = await findBanner();
      expect(alert.getAttribute("role")).toBe(code === "tooLarge" ? "status" : "alert");
      expect(alert.textContent).toContain(MESSAGE[code]);
      expect(alert.textContent).toContain(code === "tooLarge" ? tool.largeFileTitle : tool.fileProblemTitle);
      expect(within(alert).getByRole("button", { name: "Elegir otro archivo" })).toBeTruthy();
      expect(within(alert).getByRole("button", { name: "Quitar archivo" })).toBeTruthy();
      if (code === "encrypted") {
        expect(within(alert).getByRole("button", { name: "Escribir la contraseña" })).toBeTruthy();
      }
      expect(process).not.toHaveBeenCalled();
    });
  }

  for (const kind of BAD_FILE_KINDS.filter((item) => item !== "tooLarge")) {
    it(`${kind}: «Procesar» queda desactivado con su motivo y no se puede ejecutar`, async () => {
      const { container, process } = renderShell();
      await upload(container, await buildBadFile(kind));
      await screen.findByRole("alert");

      await waitFor(() => expect(runButton().disabled).toBe(true));
      const reasonId = runButton().getAttribute("aria-describedby");
      expect(reasonId).toBeTruthy();
      expect(document.getElementById(reasonId as string)?.textContent).toBe(blockedRunText(es, "Procesar"));
      fireEvent.click(runButton());
      expect(process).not.toHaveBeenCalled();
    });
  }

  it("el foco va al banner (nunca a <body>) al detectar un archivo vacio", async () => {
    const { container } = renderShell();
    await upload(container, await buildBadFile("empty"));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("un archivo grande (>100 MB) avisa pero NO bloquea: se puede procesar bajo responsabilidad propia", async () => {
    const { container, process } = renderShell();
    await upload(container, await buildBadFile("tooLarge"));
    const alert = await findBanner();
    // Aviso, no fallo: titulo propio, region de estado, «Procesar» activo y foco en el aviso (nunca <body>).
    expect(alert.getAttribute("role")).toBe("status");
    expect(alert.textContent).toContain(es.tool.largeFileTitle);
    expect(alert.textContent).not.toContain(es.tool.errors.title);
    // Rotar PDF propone Dividir PDF; el propio Dividir PDF no (ver mas abajo).
    expect(alert.textContent).toContain(es.tool.errorHints.tooLargeSplit);
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    expect(runButton().disabled).toBe(false);
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
  });

  it("mientras el archivo marcado siga ahi no se pinta el contenido de la herramienta (ni el panel de opciones)", async () => {
    const { container } = renderShell({ withOptions: true });
    await upload(container, await buildBadFile("garbage"));
    await screen.findByRole("alert");
    expect(screen.queryByText("panel de opciones")).toBeNull();
    // Sin panel, «Procesar» vive en la columna principal (un solo boton visible).
    expect(desktopRunButtons()).toHaveLength(1);
    expect((desktopRunButtons()[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("un PDF bueno no muestra ningun banner y se procesa", async () => {
    const { container, process } = renderShell();
    await upload(container, await goodPdf());
    await screen.findByText("bueno.pdf");
    // Dejar que termine la comprobacion antes de mirar.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
  });

  it("con VARIOS archivos, el banner nombra el que falla y el resto sigue en la lista", async () => {
    const { container } = renderShell({ tool: MULTI });
    await upload(container, await goodPdf("a.pdf"), await buildBadFile("truncated"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Archivo: truncado.pdf");
    expect(screen.getByText("a.pdf")).toBeTruthy();
  });
});

describe("ToolShell — acciones del banner", () => {
  it("«Quitar archivo» saca el archivo y el foco va a la zona de carga", async () => {
    const { container } = renderShell();
    await upload(container, await buildBadFile("notPdf"));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));

    const pick = await screen.findByRole("button", { name: "Seleccionar archivo" });
    await waitFor(() => expect(document.activeElement).toBe(pick));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("«Quitar archivo» con otros archivos buenos deja el foco en un control, no en <body>", async () => {
    const { container } = renderShell({ tool: MULTI });
    await upload(container, await goodPdf("a.pdf"), await goodPdf("b.pdf"), await buildBadFile("empty"));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(runButton().disabled).toBe(false);
  });

  it("«Elegir otro archivo» abre el selector y el archivo elegido sustituye al malo", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { container, process } = renderShell();
    await upload(container, await buildBadFile("garbage"));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Elegir otro archivo" }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();

    const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [await goodPdf("nuevo.pdf")] } });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("basura.pdf")).toBeNull();
    expect(screen.getByText("nuevo.pdf")).toBeTruthy();
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect((process.mock.calls[0][0] as File[])[0].name).toBe("nuevo.pdf");
  });

  it("elegir otro archivo que tampoco vale vuelve a marcarlo (sigue bloqueado)", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { container } = renderShell();
    await upload(container, await buildBadFile("garbage"));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Elegir otro archivo" }));
    click.mockRestore();
    const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [await buildBadFile("empty")] } });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(es.tool.errors.emptyFile),
    );
    expect(runButton().disabled).toBe(true);
  });

  it("un archivo de otro formato elegido en el selector avisa de formato y no sustituye al malo", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { container } = renderShell();
    await upload(container, await buildBadFile("garbage"));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Elegir otro archivo" }));
    click.mockRestore();
    const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["x"], "nota.txt", { type: "text/plain" })] } });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(es.tool.fileProblemTitle),
    );
    expect(screen.getByText("basura.pdf")).toBeTruthy();
  });

  it("el banner de un error general (no de archivo) tambien ofrece «Elegir otro archivo» y «Quitar archivo» con un solo archivo", async () => {
    const { container } = renderShell({
      guard: null,
      process: async () => {
        throw new Error("boom");
      },
    });
    await upload(container, await goodPdf());
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.unknown);
    expect(within(alert).getByRole("button", { name: "Elegir otro archivo" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Quitar archivo" })).toBeTruthy();
    // Procesar sigue activo (el fallo no fue del archivo) y recibe el foco para reintentar.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Procesar"));
  });

  it("con varios archivos, un error general NO ofrece quitar «el» archivo (no se sabe cual)", async () => {
    const { container } = renderShell({
      tool: MULTI,
      guard: null,
      process: async () => {
        throw new Error("boom");
      },
    });
    await upload(container, await goodPdf("a.pdf"), await goodPdf("b.pdf"));
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Quitar archivo" })).toBeNull();
  });
});

describe("ToolShell — el mismo mensaje al subir y al ejecutar", () => {
  it("el motor falla con un error de libreria: sale 'corrupt', no «Algo ha fallado»", async () => {
    const { container } = renderShell({
      guard: null,
      process: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'Pages')");
      },
    });
    await upload(container, await goodPdf());
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.corrupt);
    expect(alert.textContent).not.toContain(es.tool.errors.unknown);
  });

  it("la comprobacion de la subida fallo: al fallar el motor se vuelve a mirar el archivo y sale el mensaje de archivo vacio", async () => {
    let calls = 0;
    const flaky: InputGuard = async (file) => {
      calls += 1;
      if (calls === 1) throw new Error("la comprobacion no pudo con este archivo");
      return realGuard(file);
    };
    const { container } = renderShell({
      guard: flaky,
      process: async () => {
        throw new PdfError("corrupt");
      },
    });
    await upload(container, await buildBadFile("empty"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Al subirlo no se vio nada: «Procesar» sigue activo.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.emptyFile);
    expect(alert.textContent).toContain(es.tool.fileProblemTitle);
    expect(runButton().disabled).toBe(true);
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
  });

  it("pulsar «Procesar» antes de que termine la comprobacion espera a su resultado y no ejecuta", async () => {
    let finish: (check: InputCheck) => void = () => {};
    const slow: InputGuard = () =>
      new Promise<InputCheck>((resolve) => {
        finish = resolve;
      });
    const { container, process } = renderShell({ guard: slow });
    await upload(container, await goodPdf());
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    expect(process).not.toHaveBeenCalled();
    await act(async () => {
      finish({ status: "problem", code: "corrupt" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.corrupt);
    expect(process).not.toHaveBeenCalled();
  });

  it("sin comprobacion (guard = null, el modo de las pruebas) el comportamiento es el de siempre", async () => {
    const { container, process } = renderShell({ guard: null });
    await upload(container, await buildBadFile("garbage"));
    await screen.findByText("basura.pdf");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
  });

  it("«off» tampoco marca archivos malos (Reparar PDF abre justo los danados)", async () => {
    const { container, process } = renderShell({ policy: "off" });
    await upload(container, await buildBadFile("truncated"));
    await screen.findByText("truncado.pdf");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
  });
});

describe("ToolShell — PDF cifrado: hoja de contrasena", () => {
  async function uploadEncrypted(props: ShellProps = {}, password = "secreta") {
    const utils = renderShell(props);
    const file = pdfFile(await buildEncryptedPdf(password), "protegido.pdf");
    await upload(utils.container, file);
    return { ...utils, file };
  }

  it("abre la hoja sola, con el campo enfocado, y el banner ofrece reabrirla", async () => {
    await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(es.tool.password.title)).toBeTruthy();
    expect(within(dialog).getByText("protegido.pdf")).toBeTruthy();
    const field = within(dialog).getByLabelText(es.tool.password.label);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect((field as HTMLInputElement).type).toBe("password");
  });

  it("contrasena mala: mensaje claro (role=status), el foco vuelve al campo y nada cambia", async () => {
    const { process } = await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(es.tool.password.label) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "equivocada" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));

    await waitFor(() =>
      expect(within(dialog).getByText(es.tool.password.wrong)).toBeTruthy(),
    );
    expect(within(dialog).getByText(es.tool.password.wrong).getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(runButton().disabled).toBe(true);
    expect(process).not.toHaveBeenCalled();
  });

  it("contrasena buena: se trabaja con una COPIA sin contrasena, con aviso, y «Procesar» la recibe", async () => {
    const { process, file } = await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "secreta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // Aviso de privacidad en la unica region viva.
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("trabajas con una copia sin contraseña");
    expect(status.textContent).toContain("No se guardará la contraseña");
    expect(status.textContent).toContain("sin cifrar");

    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    const received = (process.mock.calls[0][0] as File[])[0];
    expect(received).not.toBe(file);
    expect(received.name).toBe("protegido.pdf");
    expect(isDecryptedCopy(received)).toBe(true);
    // La copia se abre sin contrasena; el original sigue cifrado.
    await expect(loadPdf(received)).resolves.toBeTruthy();
    await expect(loadPdf(file)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("privacidad: abrir con contrasena no escribe nada en localStorage ni sessionStorage", async () => {
    const before = JSON.stringify({ ...window.localStorage });
    await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "secreta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.stringify({ ...window.localStorage })).toBe(before);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("«Cancelar» renuncia al documento: lo quita y devuelve la zona de carga", async () => {
    await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("button", { name: "Seleccionar archivo" })).toBeTruthy();
    expect(screen.queryByText("protegido.pdf")).toBeNull();
  });

  it("Esc cierra la hoja SIN perder el archivo: el banner sigue y «Escribir la contraseña» la reabre", async () => {
    await uploadEncrypted();
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const alert = screen.getByRole("alert");
    expect(screen.getByText("protegido.pdf")).toBeTruthy();
    expect(dialog.isConnected).toBe(false);
    fireEvent.click(within(alert).getByRole("button", { name: "Escribir la contraseña" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("PDF que solo restringe permisos: se abre una copia sin restricciones SIN pedir contrasena", async () => {
    const { container, process } = renderShell({ guard: createInputGuard({ open: async () => {} }) });
    await upload(container, pdfFile(await buildEncryptedPdf(""), "permisos.pdf"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("tenía restricciones de edición o impresión"),
    );
    // No hubo contrasena: no se dice que «saldra sin cifrar» (seria falso en Proteger).
    expect(screen.getByRole("status").textContent).not.toContain("sin cifrar");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect(isDecryptedCopy((process.mock.calls[0][0] as File[])[0])).toBe(true);
  });

  it("el motor dice «cifrado» y la comprobacion no lo vio: se ofrece igualmente la hoja", async () => {
    const encrypted = pdfFile(await buildEncryptedPdf("secreta"), "protegido.pdf");
    const { container } = renderShell({
      guard: null,
      process: async () => {
        throw new PdfError("encrypted");
      },
    });
    await upload(container, encrypted);
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("política «link» (Proteger): bloquea y enlaza a Desbloquear PDF, sin hoja de contrasena", async () => {
    await uploadEncrypted({ policy: { encrypted: "link" } });
    const alert = await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).toBeNull();
    const link = within(alert).getByRole("link", { name: "Abrir Desbloquear PDF" });
    expect(link.getAttribute("href")).toBe("/unlock-pdf");
    expect(alert.textContent).toContain(es.tool.errors.encrypted);
    // UNA frase y UNA accion principal: sin pista repetida.
    expect(alert.querySelectorAll("p")).toHaveLength(3);
    expect(runButton().disabled).toBe(true);
  });

  it("política «allow» (Desbloquear, Editar): el PDF cifrado pasa tal cual", async () => {
    const { process } = await uploadEncrypted({ policy: { encrypted: "allow" } });
    await screen.findByText("protegido.pdf");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect(isDecryptedCopy((process.mock.calls[0][0] as File[])[0])).toBe(false);
  });

  it("con VARIOS PDF cifrados, la hoja los va pidiendo uno a uno", async () => {
    const { container } = renderShell({ tool: MULTI });
    await upload(
      container,
      pdfFile(await buildEncryptedPdf("uno"), "uno.pdf"),
      pdfFile(await buildEncryptedPdf("dos"), "dos.pdf"),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("uno.pdf")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "uno" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("dos.pdf")).toBeTruthy(),
    );
    // El campo de la segunda empieza vacio (no arrastra lo escrito para la primera).
    expect((within(screen.getByRole("dialog")).getByLabelText(es.tool.password.label) as HTMLInputElement).value).toBe("");
  });
});

describe("ToolShell — canRun con motivo y un solo «Procesar»", () => {
  it("canRun {ok:false, reason}: «Procesar» desactivado con el motivo descrito (aria-describedby)", async () => {
    const { container } = renderShell({
      guard: null,
      canRun: () => ({ ok: false, reason: "Marca al menos una página para quitar." }),
    });
    await upload(container, await goodPdf());
    await screen.findByText("bueno.pdf");
    expect(runButton().disabled).toBe(true);
    const id = runButton().getAttribute("aria-describedby");
    expect(document.getElementById(id as string)?.textContent).toBe("Marca al menos una página para quitar.");
  });

  it("el motivo NO es otra region viva: sigue habiendo un unico role=status", async () => {
    const { container } = renderShell({
      guard: null,
      canRun: () => ({ ok: false, reason: "Motivo cualquiera" }),
    });
    await upload(container, await goodPdf());
    await screen.findAllByText("Motivo cualquiera");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("al cumplirse la condicion el motivo desaparece y «Procesar» se activa", async () => {
    function Harness() {
      return (
        <LanguageProvider>
          <InputGuardContext.Provider value={null}>
            <ToolShell<Options>
              tool={SINGLE}
              defaultOptions={{ note: "" }}
              process={async () => ({ blob: new Blob(["x"]), filename: "s.pdf" })}
              canRun={(_files, options) =>
                options.note.length > 0 ? { ok: true } : { ok: false, reason: "Escribe una nota." }
              }
              renderOptions={({ setOptions }) => (
                <button type="button" onClick={() => setOptions({ note: "hola" })}>
                  escribir nota
                </button>
              )}
            />
          </InputGuardContext.Provider>
        </LanguageProvider>
      );
    }
    const { container } = render(<Harness />);
    fireEvent.change(fileInput(container), { target: { files: [await goodPdf()] } });
    await screen.findAllByText("Escribe una nota.");
    expect(runButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "escribir nota" }));
    await waitFor(() => expect(screen.queryAllByText("Escribe una nota.")).toHaveLength(0));
    expect(runButton().disabled).toBe(false);
    expect(runButton().hasAttribute("aria-describedby")).toBe(false);
  });

  it("canRun booleano (compatibilidad): desactiva sin motivo y sin elemento de motivo", async () => {
    const { container } = renderShell({ guard: null, canRun: () => false });
    await upload(container, await goodPdf());
    await screen.findByText("bueno.pdf");
    expect(runButton().disabled).toBe(true);
    expect(runButton().hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector("[data-run-reason]")).toBeNull();
  });

  it("minFiles=2 con un solo archivo: el motivo es «necesita al menos dos archivos»", async () => {
    const { container } = renderShell({ tool: MULTI, guard: null, minFiles: 2 });
    await upload(container, await goodPdf("a.pdf"));
    await screen.findByText("a.pdf");
    expect(runButton().disabled).toBe(true);
    expect(document.querySelector("[data-run-reason]")?.textContent).toBe(es.tool.errors.needTwo);
  });

  it("forzar la ejecucion con la condicion sin cumplir (runRef) no procesa: 'nothingSelected'", async () => {
    const runRef = { current: null as (() => void) | null };
    const process = vi.fn(async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "s.pdf" }));
    const { container } = render(
      <LanguageProvider>
        <InputGuardContext.Provider value={null}>
          <ToolShell<Options>
            tool={SINGLE}
            defaultOptions={DEFAULTS}
            process={process}
            runRef={runRef}
            canRun={() => ({ ok: false, reason: "no" })}
          />
        </InputGuardContext.Provider>
      </LanguageProvider>,
    );
    fireEvent.change(fileInput(container), { target: { files: [await goodPdf()] } });
    await screen.findByText("bueno.pdf");
    await act(async () => {
      runRef.current?.();
    });
    expect(process).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain(es.tool.errors.nothingSelected);
  });

  it("sin panel de opciones: UN solo «Procesar» visible en escritorio", async () => {
    const { container } = renderShell({ guard: null });
    await upload(container, await goodPdf());
    await screen.findByText("bueno.pdf");
    expect(desktopRunButtons()).toHaveLength(1);
  });

  it("con panel de opciones: UN solo «Procesar» visible en escritorio y vive en el pie del panel", async () => {
    const { container } = renderShell({ guard: null, withOptions: true });
    await upload(container, await goodPdf());
    await screen.findByText("panel de opciones");
    const visible = desktopRunButtons();
    expect(visible).toHaveLength(1);
    expect(visible[0].closest("aside")).toBeTruthy();
  });

  it("el «Procesar» del panel ejecuta el mismo procesado", async () => {
    const { container, process } = renderShell({ guard: null, withOptions: true });
    await upload(container, await goodPdf());
    await screen.findByText("panel de opciones");
    fireEvent.click(desktopRunButtons()[0]);
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
  });

  it("con panel, el motivo se lee dentro del panel, justo sobre su boton", async () => {
    const { container } = renderShell({
      guard: null,
      withOptions: true,
      canRun: () => ({ ok: false, reason: "Falta algo." }),
    });
    await upload(container, await goodPdf());
    const aside = (await screen.findByText("panel de opciones")).closest("aside") as HTMLElement;
    expect(within(aside).getByText("Falta algo.")).toBeTruthy();
    expect(desktopRunButtons()[0].getAttribute("aria-describedby")).toBe(
      within(aside).getByText("Falta algo.").id,
    );
  });
});

describe("ToolShell — foco por fase (sin cambios) con la comprobacion activa", () => {
  it("tras un error del motor con un archivo bueno, el foco vuelve a «Procesar»", async () => {
    const { container } = renderShell({
      process: async () => {
        throw new Error("boom");
      },
    });
    await upload(container, await goodPdf());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.click(runButton());
    await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Procesar"));
  });

  it("un buen PDF sigue pudiendo procesarse y descargarse con el foco en «Descargar»", async () => {
    const { container } = renderShell();
    await upload(container, await goodPdf());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.click(runButton());
    const download = await screen.findByRole("button", { name: "Descargar" });
    await waitFor(() => expect(document.activeElement).toBe(download));
  });
});

describe("es/en en paridad para los textos nuevos", () => {
  it("los dos idiomas tienen exactamente las mismas claves nuevas", async () => {
    const { en } = await import("@/lib/locales/en");
    const keys = (value: object): string[] => Object.keys(value).sort();
    expect(keys(en.tool.password)).toEqual(keys(es.tool.password));
    expect(keys(en.tool.errorHints)).toEqual(keys(es.tool.errorHints));
    for (const key of ["emptyFile", "notPdf"] as const) {
      expect(en.tool.errors[key]).toBeTruthy();
      expect(en.tool.errors[key]).not.toBe(es.tool.errors[key]);
    }
    for (const key of [
      "fileProblemTitle",
      "fileProblemFile",
      "chooseAnother",
      "removeFile",
      "enterPassword",
      "blockedRun",
      "encryptedSheetMessage",
      "decryptedNotice",
      "needPageSelected",
    ] as const) {
      expect(en.tool[key]).toBeTruthy();
      expect(en.tool[key]).not.toBe(es.tool[key]);
    }
  });

  it("el PDF bueno de las pruebas es de verdad un PDF (guarda de cordura de los fixtures)", async () => {
    const document = await PDFDocument.load(await buildGoodPdf(3));
    expect(document.getPageCount()).toBe(3);
    const kinds: BadFileKind[] = [...BAD_FILE_KINDS];
    expect(kinds).toHaveLength(7);
  });
});
