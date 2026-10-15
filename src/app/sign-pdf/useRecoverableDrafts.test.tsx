import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HASH, SESSION_ID, seedDocument, seedSession } from "@/app/sign-pdf/draftTestUtils";
import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";
import { DRAFT_LIST_REFRESH_MS, useRecoverableDrafts } from "@/app/sign-pdf/useRecoverableDrafts";

/** La lista de borradores recuperables (tarjeta de entrada, oferta, contador): se lee al montar y se relee con calma. */

beforeEach(async () => {
  await clearAllDrafts();
});
afterEach(async () => {
  await clearAllDrafts();
});

describe("useRecoverableDrafts", () => {
  it("empieza en `null` (leyendo) y despues da la lista, del mas reciente al mas antiguo", async () => {
    await seedSession({ id: SESSION_ID("a") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seedDocument();
    const { result } = renderHook(() => useRecoverableDrafts());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.map((entry) => entry.kind)).toEqual(["document", "session"]);
  });

  it("sin borradores da una lista vacia, no `null`", async () => {
    const { result } = renderHook(() => useRecoverableDrafts());
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("se actualiza solo cuando algo cambia (guardar, borrar), tras la calma", async () => {
    const { result } = renderHook(() => useRecoverableDrafts());
    await waitFor(() => expect(result.current).toEqual([]));
    await act(async () => {
      await seedSession({ id: SESSION_ID("a") });
    });
    await waitFor(() => expect(result.current).toHaveLength(1), { timeout: DRAFT_LIST_REFRESH_MS + 4000 });
    await act(async () => {
      await clearAllDrafts();
    });
    await waitFor(() => expect(result.current).toEqual([]), { timeout: DRAFT_LIST_REFRESH_MS + 4000 });
  });

  it("una rafaga de cambios seguidos produce UNA relectura al final, no una por cambio", async () => {
    const { result } = renderHook(() => useRecoverableDrafts());
    await waitFor(() => expect(result.current).toEqual([]));
    await act(async () => {
      // Tres guardados en menos de la calma (como los autoguardados de una edicion seguida).
      await seedSession({ id: SESSION_ID("a") });
      await seedSession({ id: SESSION_ID("b"), keys: [HASH("e"), HASH("f")] });
      await seedDocument();
    });
    // Aun dentro de la calma, la lista vieja sigue.
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toHaveLength(3), { timeout: DRAFT_LIST_REFRESH_MS + 4000 });
  });

  it("ignora los borradores que la herramienta no sabria restaurar", async () => {
    await seedSession({ id: "s-<script>-x" });
    await seedSession({ id: SESSION_ID("ok") });
    const { result } = renderHook(() => useRecoverableDrafts());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.map((entry) => entry.meta.id)).toEqual([SESSION_ID("ok")]);
  });

  it("al desmontar deja de leer", async () => {
    const { result, unmount } = renderHook(() => useRecoverableDrafts());
    await waitFor(() => expect(result.current).toEqual([]));
    unmount();
    await seedSession({ id: SESSION_ID("a") });
    await new Promise((resolve) => setTimeout(resolve, DRAFT_LIST_REFRESH_MS + 300));
    expect(result.current).toEqual([]);
  });
});
