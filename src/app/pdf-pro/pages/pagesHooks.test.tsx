import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { usePagesPendingCount, usePagesStore } from "@/app/pdf-pro/pages/pagesHooks";
import { rotatePages } from "@/lib/pdf/pageAssemblyPlan";

afterEach(cleanup);

describe("hooks del organizador", () => {
  it("usePagesStore devuelve el organizador del documento y sigue sus cambios", () => {
    const doc = createProWorkingDoc();
    const { result } = renderHook(() => usePagesStore(doc));
    act(() => {
      result.current.store.syncBase("s1", 3);
    });
    expect(result.current.state.plan).toHaveLength(3);
    expect(result.current.store).toBe(getPagesStore(doc));
  });

  it("usePagesPendingCount cuenta los cambios sin aplicar", () => {
    const doc = createProWorkingDoc();
    const store = getPagesStore(doc);
    const { result } = renderHook(() => usePagesPendingCount(doc));
    expect(result.current).toBe(0);
    act(() => {
      store.syncBase("s1", 3);
      store.commit(rotatePages(store.getState().plan, [store.getState().plan[0].id as string], 90), "girar");
    });
    expect(result.current).toBe(1);
    act(() => {
      store.discard();
    });
    expect(result.current).toBe(0);
  });

  it("dos documentos de trabajo no comparten organizador", () => {
    const a = createProWorkingDoc();
    const b = createProWorkingDoc();
    getPagesStore(a).syncBase("s1", 2);
    expect(getPagesStore(b).getState().plan).toHaveLength(0);
  });
});
