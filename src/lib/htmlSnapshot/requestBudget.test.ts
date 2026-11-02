import { describe, expect, it } from "vitest";
import { RequestBudget, withRequestBudget } from "@/lib/htmlSnapshot/requestBudget";
import { SnapshotError } from "@/lib/htmlSnapshot/types";
import { noAbort } from "@/lib/htmlSnapshot/testSupport";
import type { Transport } from "@/lib/htmlSnapshot/nodeTransport";

const LIMITS = { requests: 40, hosts: 6, concurrent: 4, perHost: 2 };

describe("RequestBudget", () => {
  it("como mucho 2 conexiones a la vez por servidor y 4 en total; el resto espera su turno", async () => {
    const budget = new RequestBudget(LIMITS);
    const a1 = await budget.acquire("a.example.com", noAbort);
    const a2 = await budget.acquire("a.example.com", noAbort);
    let thirdA = false;
    const pendingA = budget.acquire("a.example.com", noAbort).then((release) => {
      thirdA = true;
      return release;
    });
    const b1 = await budget.acquire("b.example.com", noAbort);
    const b2 = await budget.acquire("b.example.com", noAbort); // 4 en total
    let fifth = false;
    const pendingC = budget.acquire("c.example.com", noAbort).then((release) => {
      fifth = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdA).toBe(false);
    expect(fifth).toBe(false);

    a1(); // libera un hueco de a y uno global: el tercero de `a` es el primero de la cola y puede entrar
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdA).toBe(true);
    expect(fifth).toBe(false); // sigue habiendo 4 activas
    b1();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fifth).toBe(true);
    for (const release of [a2, b2, await pendingA, await pendingC]) release();
  });

  it("liberar dos veces no libera dos huecos", async () => {
    const budget = new RequestBudget({ ...LIMITS, concurrent: 1, perHost: 1 });
    const release = await budget.acquire("a.example.com", noAbort);
    release();
    release();
    const first = await budget.acquire("a.example.com", noAbort);
    let second = false;
    const pending = budget.acquire("a.example.com", noAbort).then((r) => {
      second = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second).toBe(false);
    first();
    (await pending)();
  });

  it("maximo 40 peticiones en total y 6 servidores distintos", async () => {
    const budget = new RequestBudget({ ...LIMITS, concurrent: 100, perHost: 100 });
    for (let index = 0; index < 40; index += 1) (await budget.acquire(`h${index % 6}.example.com`, noAbort))();
    await expect(budget.acquire("h0.example.com", noAbort)).rejects.toMatchObject({ code: "unreachable" });

    const hosts = new RequestBudget(LIMITS);
    for (let index = 0; index < 6; index += 1) hosts.noteHost(`h${index}.example.com`);
    expect(() => hosts.noteHost("h0.example.com")).not.toThrow();
    expect(() => hosts.noteHost("h6.example.com")).toThrow(SnapshotError);
  });

  it("abortar mientras se espera turno rechaza con timeout y no deja el turno ocupado", async () => {
    const budget = new RequestBudget({ ...LIMITS, concurrent: 1, perHost: 1 });
    const held = await budget.acquire("a.example.com", noAbort);
    const controller = new AbortController();
    const waiting = budget.acquire("a.example.com", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "timeout" });
    held();
    const next = await budget.acquire("a.example.com", noAbort);
    next();
  });
});

describe("withRequestBudget", () => {
  function fake(): { transport: Transport; closes: number[]; inFlight: () => number } {
    let active = 0;
    const closes: number[] = [];
    const transport: Transport = async () => {
      active += 1;
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield new Uint8Array(1);
        })(),
        close: () => {
          closes.push(1);
        },
      };
    };
    return { transport, closes, inFlight: () => active };
  }

  it("el hueco se ocupa hasta terminar de LEER el cuerpo o cerrarlo", async () => {
    const budget = new RequestBudget({ ...LIMITS, concurrent: 1, perHost: 1 });
    const { transport } = fake();
    const deps = withRequestBudget({ resolve: async () => [], transport }, budget);
    const request = { url: new URL("https://a.example.com/x"), address: { address: "93.184.216.34", family: 4 as const }, signal: noAbort, accept: "*/*" };

    const first = await deps.transport(request);
    let secondStarted = false;
    const second = deps.transport(request).then((response) => {
      secondStarted = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStarted).toBe(false);
    for await (const chunk of first.body) void chunk;
    const secondResponse = await second;
    expect(secondStarted).toBe(true);
    secondResponse.close();
  });

  it("un transporte que falla libera el hueco", async () => {
    const budget = new RequestBudget({ ...LIMITS, concurrent: 1, perHost: 1 });
    const failing: Transport = async () => {
      throw new Error("boom");
    };
    const deps = withRequestBudget({ resolve: async () => [], transport: failing }, budget);
    const request = { url: new URL("https://a.example.com/x"), address: { address: "93.184.216.34", family: 4 as const }, signal: noAbort, accept: "*/*" };
    await expect(deps.transport(request)).rejects.toThrow("boom");
    await expect(deps.transport(request)).rejects.toThrow("boom"); // no se quedo esperando
  });
});
