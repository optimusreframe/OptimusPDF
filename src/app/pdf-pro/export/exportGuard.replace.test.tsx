import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProExport, ProExportResult } from "@/app/pdf-pro/ops/proExports";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { fakeBytes } from "@/app/pdf-pro/proTestUtils";
import { useReplaceGuard } from "@/app/pdf-pro/session/useReplaceGuard";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/** Abrir otro documento con una exportacion en curso (Wave 9): confirma, lo dice y la cancela ANTES de cambiar. */

const downloads = vi.hoisted(() => ({ items: [] as string[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (_blob: Blob, name: string) => downloads.items.push(name) };
});

const E = getExportStrings("es");
const S = PRO_STRINGS.es.session;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => {
  cleanup();
  downloads.items.length = 0;
});

function Harness({ action }: { action: () => void }) {
  const guard = useReplaceGuard();
  return (
    <div>
      <button onClick={() => guard.request(action)}>cambiar</button>
      {guard.node}
    </div>
  );
}

function exportRunning(id = "word") {
  let signal!: AbortSignal;
  let resolve!: (result: ProExportResult) => void;
  const entry: ProExport = {
    id,
    title: () => id,
    body: () => id,
    slug: "pdf-to-word",
    requiresNetwork: false,
    run: (_bytes, context) => {
      signal = context.signal;
      return new Promise<ProExportResult>((done, fail) => {
        resolve = done;
        context.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
      });
    },
  };
  return { entry, signal: () => signal, resolve: () => resolve({ blob: new Blob(["x"]), filename: "tarde.docx" }) };
}

describe("useReplaceGuard con una exportacion en curso", () => {
  it("pide confirmar aunque no haya cambios, con el texto de la exportacion, y NO ejecuta todavia", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    getExportStore(doc).start({ entry: exportRunning("word").entry, options: {}, selectedPages: [], language: "es" });
    expect(doc.getState().dirty).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(E.notices.replaceOnly("Word"))).toBeTruthy();
    expect(within(dialog).queryByText(S.replaceBody)).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(getExportStore(doc).running).toBe(true);
  });

  it("confirmar CANCELA la exportacion antes de ejecutar la accion, que corre UNA vez; un resultado tardio no descarga", async () => {
    const order: string[] = [];
    const control = exportRunning("word");
    const holder: { store?: ReturnType<typeof getExportStore> } = {};
    const { doc } = await mountTab(<Harness action={() => order.push(`accion (exportando: ${holder.store?.running})`)} />);
    holder.store = getExportStore(doc);
    getExportStore(doc).start({ entry: control.entry, options: {}, selectedPages: [], language: "es" });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.replaceConfirm }));
    expect(order).toEqual(["accion (exportando: false)"]);
    expect(control.signal().aborted).toBe(true);
    expect(getExportStore(doc).getState().job).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => control.resolve());
    expect(downloads.items).toEqual([]);
  });

  it("cancelar la hoja deja la exportacion corriendo y no ejecuta la accion", async () => {
    const action = vi.fn();
    const control = exportRunning("excel");
    const { doc } = await mountTab(<Harness action={action} />);
    getExportStore(doc).start({ entry: control.entry, options: {}, selectedPages: [], language: "es" });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
    expect(control.signal().aborted).toBe(false);
    expect(getExportStore(doc).running).toBe(true);
  });

  it("exportacion + cambios sin descargar: la hoja dice las dos cosas", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    await act(async () => {
      await doc.commit(fakeBytes(300, 5), "Rotar", "operation", { pageCount: 3 });
    });
    getExportStore(doc).start({ entry: exportRunning("csv").entry, options: {}, selectedPages: [], language: "es" });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`${S.replaceBody} ${E.notices.also("CSV")}`)).toBeTruthy();
  });

  it("con la exportacion ya terminada no pregunta", async () => {
    const action = vi.fn();
    const control = exportRunning("json");
    const { doc } = await mountTab(<Harness action={action} />);
    getExportStore(doc).start({ entry: control.entry, options: {}, selectedPages: [], language: "es" });
    await act(async () => control.resolve());
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
