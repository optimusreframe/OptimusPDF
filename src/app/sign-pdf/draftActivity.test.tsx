import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  __resetDraftActivityForTests,
  beginDraftWrite,
  hasPendingDraftWrite,
  useDraftWritePending,
  whenDraftWritesSettle,
} from "@/app/sign-pdf/draftActivity";

afterEach(__resetDraftActivityForTests);

describe("escrituras de borrador pendientes", () => {
  it("abrir una marca la deja pendiente y cerrarla (una sola vez) la libera", () => {
    expect(hasPendingDraftWrite()).toBe(false);
    const end = beginDraftWrite();
    expect(hasPendingDraftWrite()).toBe(true);
    end();
    expect(hasPendingDraftWrite()).toBe(false);
    end();
    expect(hasPendingDraftWrite()).toBe(false);
  });

  it("con varias escrituras sigue pendiente hasta que se cierran TODAS", () => {
    const first = beginDraftWrite();
    const second = beginDraftWrite();
    first();
    expect(hasPendingDraftWrite()).toBe(true);
    second();
    expect(hasPendingDraftWrite()).toBe(false);
  });

  it("el hook reacciona al abrir y cerrar", () => {
    const { result } = renderHook(() => useDraftWritePending());
    expect(result.current).toBe(false);
    let end = () => {};
    act(() => {
      end = beginDraftWrite();
    });
    expect(result.current).toBe(true);
    act(() => end());
    expect(result.current).toBe(false);
  });
});

describe("whenDraftWritesSettle (F0 · U0.4)", () => {
  it("sin escrituras pendientes resuelve de inmediato", async () => {
    await expect(whenDraftWritesSettle()).resolves.toBeUndefined();
  });

  it("espera a que se cierren TODAS las escrituras abiertas", async () => {
    const first = beginDraftWrite();
    const second = beginDraftWrite();
    let settled = false;
    const wait = whenDraftWritesSettle(5000).then(() => {
      settled = true;
    });
    first();
    await Promise.resolve();
    expect(settled).toBe(false);
    second();
    await wait;
    expect(settled).toBe(true);
  });

  it("no espera para siempre: pasado el plazo resuelve aunque siga pendiente", async () => {
    beginDraftWrite();
    const started = Date.now();
    await whenDraftWritesSettle(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(hasPendingDraftWrite()).toBe(true);
  });

  it("al resolver se desuscribe (no deja oyentes colgados)", async () => {
    const end = beginDraftWrite();
    const wait = whenDraftWritesSettle(5000);
    end();
    await wait;
    // Abrir y cerrar mas marcas ya no la reactiva ni lanza.
    beginDraftWrite()();
    expect(hasPendingDraftWrite()).toBe(false);
  });
});
