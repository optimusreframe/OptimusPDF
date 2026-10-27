import { describe, expect, it } from "vitest";
import { beginHeavyWork, whenNoHeavyWork } from "@/lib/image/heavyWork";

describe("heavyWork", () => {
  it("sin trabajo pesado en marcha se resuelve de inmediato", async () => {
    let resolved = false;
    void whenNoHeavyWork().then(() => (resolved = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("espera a que terminen TODOS los trabajos (cuenta anidada) y terminar dos veces el mismo no resta dos", async () => {
    const endA = beginHeavyWork();
    const endB = beginHeavyWork();
    let resolved = false;
    void whenNoHeavyWork().then(() => (resolved = true));
    endA();
    endA(); // idempotente
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);
    endB();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(true);
  });

  it("despierta a todos los que esperan", async () => {
    const end = beginHeavyWork();
    const woke: number[] = [];
    const waits = [1, 2, 3].map((id) => whenNoHeavyWork().then(() => woke.push(id)));
    end();
    await Promise.all(waits);
    expect(woke.sort()).toEqual([1, 2, 3]);
  });
});
