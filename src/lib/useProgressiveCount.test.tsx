import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useProgressiveCount } from "@/lib/useProgressiveCount";
import { useAfterTasks } from "@/lib/useAfterTasks";

describe("useProgressiveCount", () => {
  it("con pocos elementos los pinta todos de golpe", () => {
    const { result } = renderHook(() => useProgressiveCount(8));
    expect(result.current).toBe(8);
  });

  it("con una lista larga empieza por los primeros y va sumando por fotogramas hasta el total", async () => {
    const rendered: number[] = [];
    const { result } = renderHook(() => {
      const count = useProgressiveCount(117);
      rendered.push(count);
      return count;
    });
    expect(result.current).toBe(10);
    await waitFor(() => expect(result.current).toBe(117));
    // Nunca de golpe: cada pintado suma 20 como mucho (o llega al total).
    const distinct = [...new Set(rendered)];
    expect(distinct.length).toBeGreaterThan(3);
    for (let index = 1; index < distinct.length; index += 1) expect(distinct[index] - distinct[index - 1]).toBeLessThanOrEqual(20);
  });

  it("si la lista crece (se anaden fotos) sigue pintando lo nuevo; si se acorta, no pinta de mas", async () => {
    const { result, rerender } = renderHook(({ total }) => useProgressiveCount(total), { initialProps: { total: 30 } });
    await waitFor(() => expect(result.current).toBe(30));
    rerender({ total: 80 });
    await waitFor(() => expect(result.current).toBe(80));
    rerender({ total: 5 });
    expect(result.current).toBe(5);
  });
});

describe("useAfterTasks", () => {
  it("es falso en el primer pintado y verdadero tras las tareas pedidas", async () => {
    const { result } = renderHook(() => useAfterTasks(2));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("con 0 tareas es verdadero de inmediato", () => {
    const { result } = renderHook(() => useAfterTasks(0));
    expect(result.current).toBe(true);
    act(() => {});
  });
});
