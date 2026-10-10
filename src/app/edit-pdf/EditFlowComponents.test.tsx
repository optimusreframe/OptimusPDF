import "fake-indexeddb/auto";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { EditDraftsSheet } from "@/app/edit-pdf/EditDraftsSheet";
import { EditNotices, type EditNotice } from "@/app/edit-pdf/EditNotices";
import { EDIT_PRIVACY_NOTICE_SEEN_KEY, EditPrivacyNotice } from "@/app/edit-pdf/EditPrivacyNotice";
import { PasswordSheet } from "@/app/edit-pdf/PasswordSheet";
import {
  __resetEditDraftsMemoryForTests,
  clearAllEditDrafts,
  listEditDrafts,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { applyOp, createEditSession, newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import type { PrepareResult } from "@/app/edit-pdf/editPrepare";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { useEditPrepare } from "@/app/edit-pdf/useEditPrepare";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

const flow = EDIT_FLOW_STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(async () => {
  window.localStorage.removeItem(EDIT_PRIVACY_NOTICE_SEEN_KEY);
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
});
afterEach(cleanup);

/* ------------------------------------------------------------------ *
 * PasswordSheet
 * ------------------------------------------------------------------ */

function PasswordHarness(props: Partial<React.ComponentProps<typeof PasswordSheet>> = {}) {
  return (
    <PasswordSheet
      open
      onClose={vi.fn()}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      busy={false}
      wrong={false}
      failed={false}
      attempt={0}
      flow={flow}
      {...props}
    />
  );
}

describe("PasswordSheet", () => {
  it("pide la contrasena en un campo de contrasena y enfoca el campo", async () => {
    render(<PasswordHarness />);
    const input = await screen.findByLabelText("Contraseña");
    expect(input.getAttribute("type")).toBe("password");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("«Abrir documento» esta deshabilitado sin texto y envia la contrasena escrita", async () => {
    const onSubmit = vi.fn();
    render(<PasswordHarness onSubmit={onSubmit} />);
    const input = await screen.findByLabelText("Contraseña");
    const submit = screen.getByRole("button", { name: flow.passwordSubmit }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "secreto" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("secreto");
  });

  it("Intro envia el formulario", async () => {
    const onSubmit = vi.fn();
    render(<PasswordHarness onSubmit={onSubmit} />);
    const input = await screen.findByLabelText("Contraseña");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("abc");
  });

  it("contrasena incorrecta: mensaje claro en la region de estado y el foco vuelve al campo con el texto seleccionado", async () => {
    const { rerender } = render(<PasswordHarness />);
    const input = (await screen.findByLabelText("Contraseña")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mala" } });
    input.blur();
    rerender(<PasswordHarness wrong attempt={1} />);
    const message = document.querySelector("[data-password-message]") as HTMLElement;
    expect(message.getAttribute("role")).toBe("status");
    expect(message.textContent).toBe(flow.passwordWrong);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("un fallo distinto de contrasena incorrecta tiene su propio texto", async () => {
    render(<PasswordHarness failed attempt={1} />);
    await screen.findByLabelText("Contraseña");
    expect(document.querySelector("[data-password-message]")!.textContent).toBe(flow.passwordFailed);
  });

  it("mientras abre, el campo y el boton se deshabilitan y se anuncia «Abriendo…»", async () => {
    render(<PasswordHarness busy />);
    const input = (await screen.findByLabelText("Contraseña")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(document.querySelector("[data-password-message]")!.textContent).toContain(flow.passwordOpening);
    expect((screen.getByRole("button", { name: flow.passwordSubmit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("mostrar/ocultar la contrasena alterna el tipo del campo y el nombre del boton", async () => {
    render(<PasswordHarness />);
    const input = await screen.findByLabelText("Contraseña");
    fireEvent.click(screen.getByRole("button", { name: flow.passwordShow }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: flow.passwordHide }));
    expect(input.getAttribute("type")).toBe("password");
  });

  it("Cancelar avisa de que se renuncia al documento", async () => {
    const onCancel = vi.fn();
    render(<PasswordHarness onCancel={onCancel} />);
    fireEvent.click(await screen.findByRole("button", { name: flow.passwordCancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("el boton de mostrar la contrasena mide 44 px de ancho (clase w-11) y no usa outline-none", async () => {
    render(<PasswordHarness />);
    const toggle = await screen.findByRole("button", { name: flow.passwordShow });
    expect(toggle.className).toContain("w-11");
    expect(toggle.className).not.toContain("outline-none");
  });
});

/* ------------------------------------------------------------------ *
 * EditNotices
 * ------------------------------------------------------------------ */

describe("EditNotices", () => {
  const notices: EditNotice[] = [
    { id: "a", tone: "warning", text: "Aviso uno" },
    {
      id: "b",
      tone: "info",
      text: "Aviso dos",
      action: { label: "Hacer algo", onClick: vi.fn() },
      onDismiss: vi.fn(),
    },
    { id: "c", tone: "info", text: "Aviso tres", action: { label: "Ir", href: "/sign-pdf" } },
  ];

  it("la region de estado esta SIEMPRE montada, incluso sin avisos", () => {
    const { container } = render(<EditNotices notices={[]} dismissLabel="Ocultar" />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe("");
    expect(container.querySelector("ul")).toBeNull();
  });

  it("repite los textos en la region viva y los pinta como filas (no modales)", () => {
    const { container } = render(<EditNotices notices={notices} dismissLabel="Ocultar" />);
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Aviso uno Aviso dos Aviso tres");
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
  });

  it("la accion con enlace es un <a> y la de boton llama a su manejador; descartar solo donde se puede", () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <EditNotices
        dismissLabel="Ocultar"
        notices={[
          { id: "b", tone: "info", text: "Dos", action: { label: "Hacer algo", onClick }, onDismiss },
          { id: "c", tone: "info", text: "Tres", action: { label: "Ir", href: "/sign-pdf" } },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hacer algo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Ir" }).getAttribute("href")).toBe("/sign-pdf");
    expect(screen.getAllByRole("button", { name: "Ocultar" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("el boton de cerrar mide 44 px (size-11)", () => {
    render(<EditNotices dismissLabel="Ocultar" notices={[{ id: "x", tone: "info", text: "t", onDismiss: vi.fn() }]} />);
    expect(screen.getByRole("button", { name: "Ocultar" }).className).toContain("size-11");
  });
});

/* ------------------------------------------------------------------ *
 * EditPrivacyNotice
 * ------------------------------------------------------------------ */

describe("EditPrivacyNotice", () => {
  const ID = "cd".repeat(32);
  async function saveOne() {
    const session = applyOp(
      createEditSession(),
      {
        type: "add",
        item: textItem(newTextEdit({ id: "t", pageIndex: 0, box: { x: 1, y: 1, width: 50, height: 10 }, fontKey: "helvetica", text: "Hola" })),
      },
      0,
    );
    const saved = await saveEditDraft({ id: ID, fileName: "a.pdf", fileBytes: new Uint8Array([37, 80, 68, 70]), session });
    expect(saved.ok).toBe(true);
  }

  it("la primera vez el texto esta abierto; al cerrarlo no vuelve a abrirse solo", () => {
    const first = render(<EditPrivacyNotice flow={flow} />);
    expect(screen.getByText(flow.privacyBody)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: flow.confirmClose }));
    expect(screen.queryByText(flow.privacyBody)).toBeNull();
    first.unmount();
    render(<EditPrivacyNotice flow={flow} />);
    expect(screen.queryByText(flow.privacyBody)).toBeNull();
    expect(screen.getByRole("button", { name: flow.privacyToggle }).getAttribute("aria-expanded")).toBe("false");
  });

  it("«Borrar datos» pide confirmacion y vacia los borradores; solo entonces dice «Datos borrados»", async () => {
    await saveOne();
    const onCleared = vi.fn();
    render(<EditPrivacyNotice flow={flow} onCleared={onCleared} />);
    const status = document.querySelector("[data-privacy-status]") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: flow.privacyClear }));
    // La hoja de confirmacion ofrece su propia accion con el mismo nombre.
    const confirm = (await screen.findAllByRole("button", { name: flow.privacyClear })).at(-1)!;
    expect(status.textContent).toBe("");
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(status.textContent).toBe(flow.privacyCleared));
    expect(await listEditDrafts()).toEqual([]);
    expect(onCleared).toHaveBeenCalled();
  });

  it("si no se pudieron vaciar los borradores NO afirma que se borraron y lo dice", async () => {
    const mod = await import("@/app/edit-pdf/clearLocalEditData");
    const spy = vi.spyOn(mod, "clearLocalEditData").mockResolvedValue(["drafts"]);
    render(<EditPrivacyNotice flow={flow} />);
    fireEvent.click(screen.getByRole("button", { name: flow.privacyClear }));
    const confirm = (await screen.findAllByRole("button", { name: flow.privacyClear })).at(-1)!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    const status = document.querySelector("[data-privacy-status]") as HTMLElement;
    await waitFor(() => expect(status.textContent).toBe(flow.privacyClearFailed));
    expect(screen.queryByText(flow.privacyCleared)).toBeNull();
    spy.mockRestore();
  });

  it("los controles tactiles miden 44 px bajo puntero grueso", () => {
    render(<EditPrivacyNotice flow={flow} />);
    expect(screen.getByRole("button", { name: flow.privacyClear }).className).toContain("pointer-coarse:h-11");
    expect(screen.getByRole("button", { name: flow.confirmClose }).className).toContain("pointer-coarse:size-11");
  });
});

/* ------------------------------------------------------------------ *
 * EditDraftsSheet
 * ------------------------------------------------------------------ */

describe("EditDraftsSheet", () => {
  const A = "aa".repeat(32);
  const B = "bb".repeat(32);

  async function save(id: string, name: string, texts: number) {
    let session = createEditSession();
    for (let i = 0; i < texts; i += 1) {
      session = applyOp(
        session,
        {
          type: "add",
          item: textItem(
            newTextEdit({ id: `${id.slice(0, 2)}-${i}`, pageIndex: 0, box: { x: 1, y: 1, width: 50, height: 10 }, fontKey: "helvetica", text: "Hola" }),
          ),
        },
        i,
      );
    }
    const result = await saveEditDraft({ id, fileName: name, fileBytes: new Uint8Array([37, 80, 68, 70, 1]), session, pageCount: 3 });
    expect(result.ok).toBe(true);
  }

  function Harness({ onResume }: { onResume: (id: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <LanguageProvider>
        <EditDraftsSheet open={open} onClose={() => setOpen(false)} onResume={(d) => onResume(d.id)} flow={flow} />
      </LanguageProvider>
    );
  }

  it("sin borradores dice que no hay", async () => {
    render(<Harness onResume={vi.fn()} />);
    expect(await screen.findByText(flow.draftsEmpty)).toBeTruthy();
  });

  it("lista nombre, numero de cambios y paginas, del mas reciente al mas antiguo", async () => {
    await save(A, "primero.pdf", 1);
    await new Promise((r) => setTimeout(r, 5));
    await save(B, "segundo.pdf", 2);
    render(<Harness onResume={vi.fn()} />);
    const rows = await waitFor(() => {
      const found = document.querySelectorAll("[data-draft-id]");
      expect(found.length).toBe(2);
      return Array.from(found) as HTMLElement[];
    });
    expect(rows[0].textContent).toContain("segundo.pdf");
    expect(rows[0].textContent).toContain("2 cambios");
    expect(rows[1].textContent).toContain("primero.pdf");
    expect(rows[1].textContent).toContain("1 cambio");
    expect(rows[0].textContent).toContain("3 páginas");
  });

  it("«Retomar» entrega el borrador elegido", async () => {
    await save(A, "primero.pdf", 1);
    const onResume = vi.fn();
    render(<Harness onResume={onResume} />);
    const row = await waitFor(() => {
      const el = document.querySelector("[data-draft-id]") as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    fireEvent.click(within(row).getByRole("button", { name: flow.draftsResume }));
    expect(onResume).toHaveBeenCalledWith(A);
  });

  it("eliminar pide confirmacion, borra de verdad y el foco no cae a <body>", async () => {
    await save(A, "primero.pdf", 1);
    await save(B, "segundo.pdf", 1);
    render(<Harness onResume={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll("[data-draft-id]").length).toBe(2));
    const del = screen.getByRole("button", { name: flow.draftsDelete("primero.pdf") });
    expect(del.className).toContain("size-11");
    fireEvent.click(del);
    const confirm = (await screen.findAllByRole("button", { name: flow.draftsDelete("primero.pdf") })).at(-1)!;
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(async () => expect((await listEditDrafts()).map((d) => d.id)).toEqual([B]));
    await waitFor(() => expect(document.querySelectorAll("[data-draft-id]").length).toBe(1));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("cancelar la confirmacion no borra nada", async () => {
    await save(A, "primero.pdf", 1);
    render(<Harness onResume={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll("[data-draft-id]").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: flow.draftsDelete("primero.pdf") }));
    fireEvent.click(await screen.findByRole("button", { name: flow.confirmCancel }));
    expect((await listEditDrafts()).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * useEditPrepare
 * ------------------------------------------------------------------ */

describe("useEditPrepare", () => {
  // `File` nuevos en cada prueba: el estado preparado se recuerda por objeto `File`.
  let fileA = new File(["a"], "a.pdf");
  let fileB = new File(["b"], "b.pdf");
  beforeEach(() => {
    fileA = new File(["a"], "a.pdf");
    fileB = new File(["b"], "b.pdf");
  });
  const ready = (file: File): PrepareResult => ({
    status: "ready",
    document: { file, wasEncrypted: false, signatures: "none", formFields: 0, flattenLoss: null },
  });

  it("empieza comprobando y pasa a listo", async () => {
    const prepare = vi.fn(async (file: File) => ready(file));
    const { result } = renderHook(() => useEditPrepare(fileA, prepare));
    expect(result.current.state.phase).toBe("checking");
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
  });

  it("contrasena: password -> equivocada (cuenta intentos) -> correcta", async () => {
    const prepare = vi.fn(async (file: File, password?: string): Promise<PrepareResult> => {
      if (password === undefined) return { status: "password" };
      return password === "ok" ? ready(file) : { status: "wrongPassword" };
    });
    const { result } = renderHook(() => useEditPrepare(fileA, prepare));
    await waitFor(() => expect(result.current.state.phase).toBe("password"));
    act(() => result.current.submitPassword("mala"));
    await waitFor(() => {
      const state = result.current.state;
      expect(state.phase === "password" && state.wrong && state.attempt === 1 && !state.busy).toBe(true);
    });
    act(() => result.current.submitPassword("ok"));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(prepare).toHaveBeenLastCalledWith(fileA, "ok");
  });

  it("un cifrado no soportado bloquea y publica el codigo", async () => {
    const onBlocked = vi.fn();
    const prepare = vi.fn(async (): Promise<PrepareResult> => ({ status: "unsupported", code: "certificateEncryption" }));
    const { result } = renderHook(() => useEditPrepare(fileA, prepare, onBlocked));
    await waitFor(() => expect(result.current.state.phase).toBe("blocked"));
    expect(onBlocked).toHaveBeenCalledWith("certificateEncryption");
  });

  it("si cambia el archivo, el resultado tardio del anterior se descarta", async () => {
    let resolveA: (value: PrepareResult) => void = () => {};
    const prepare = vi.fn((file: File) =>
      file === fileA ? new Promise<PrepareResult>((resolve) => (resolveA = resolve)) : Promise.resolve(ready(file)),
    );
    const { result, rerender } = renderHook(({ file }) => useEditPrepare(file, prepare), { initialProps: { file: fileA } });
    rerender({ file: fileB });
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    await act(async () => resolveA(ready(fileA)));
    const state = result.current.state;
    expect(state.phase === "ready" && state.document.file === fileB).toBe(true);
  });

  it("si la preparacion lanza, queda bloqueado con un error generico (no se cuelga comprobando)", async () => {
    const onBlocked = vi.fn();
    const prepare = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useEditPrepare(fileA, prepare, onBlocked));
    await waitFor(() => expect(result.current.state.phase).toBe("blocked"));
    expect(onBlocked).toHaveBeenCalledWith("unknown");
  });
});
