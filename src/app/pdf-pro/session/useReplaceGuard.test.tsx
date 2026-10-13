import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within, act } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { useReplaceGuard } from "@/app/pdf-pro/session/useReplaceGuard";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";

const S = PRO_STRINGS.es.session;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

function Harness({ action }: { action: () => void }) {
  const guard = useReplaceGuard();
  return (
    <div>
      <button onClick={() => guard.request(action)}>cambiar</button>
      {guard.node}
    </div>
  );
}

describe("useReplaceGuard", () => {
  it("sin cambios sin descargar la accion corre al instante y no hay hoja", async () => {
    const action = vi.fn();
    await mountTab(<Harness action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("con cambios sin descargar pide confirmar y NO ejecuta todavia", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    await act(async () => {
      await doc.commit(await makePdfBytes(3), "Rotar", "operation", { pageCount: 3 });
    });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(S.replaceBody)).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
  });

  it("confirmar ejecuta la accion UNA vez y cierra la hoja", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    await act(async () => {
      await doc.commit(await makePdfBytes(3), "Rotar", "operation", { pageCount: 3 });
    });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.replaceConfirm }));
    expect(action).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancelar descarta la accion: una confirmacion posterior no la ejecuta", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    await act(async () => {
      await doc.commit(await makePdfBytes(3), "Rotar", "operation", { pageCount: 3 });
    });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
  });

  it("tras descargar (limpio) ya no pregunta", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    await act(async () => {
      await doc.commit(await makePdfBytes(3), "Rotar", "operation", { pageCount: 3 });
      doc.markSaved();
    });
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("useReplaceGuard — paso en vuelo (Wave 8 · D7)", () => {
  it("con una confirmacion aun en vuelo (sin cambios todavia) pide confirmar en vez de cambiar al instante", async () => {
    const action = vi.fn();
    const { doc } = await mountTab(<Harness action={action} />);
    let release: (n: number) => void = () => {};
    const slow = new Promise<number>((resolve) => {
      release = resolve;
    });
    // El paso tarda en contar sus paginas: esta encolado pero aun no esta en el historial (`dirty` sigue en false).
    const pending = doc.trackStep(slow);
    expect(doc.getState().dirty).toBe(false);
    expect(doc.getState().stepInFlight).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "cambiar" }));
    expect(action).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    release(3);
    await pending;
    await waitFor(() => expect(doc.getState().stepInFlight).toBe(false));
  });
});
