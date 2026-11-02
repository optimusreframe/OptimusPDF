import { beforeEach, describe, expect, it, vi } from "vitest";

/** `node:dns/promises` se sustituye por un Resolver falso: la prueba NO hace ninguna consulta DNS. */
const state = vi.hoisted(() => ({
  instances: [] as Array<{ options: unknown; cancelled: boolean }>,
  v4: [] as string[] | Error,
  v6: [] as string[] | Error,
  hang: false,
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    entry: { options: unknown; cancelled: boolean };
    constructor(options: unknown) {
      this.entry = { options, cancelled: false };
      state.instances.push(this.entry);
    }
    cancel() {
      this.entry.cancelled = true;
    }
    private answer(value: string[] | Error): Promise<string[]> {
      if (state.hang) {
        return new Promise((_resolve, reject) => {
          const timer = setInterval(() => {
            if (this.entry.cancelled) {
              clearInterval(timer);
              reject(new Error("ECANCELLED"));
            }
          }, 5);
        });
      }
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    resolve4() {
      return this.answer(state.v4);
    }
    resolve6() {
      return this.answer(state.v6);
    }
  },
}));

import { DNS_TIMEOUT_MS, DNS_TRIES, dnsResolver, memoizeResolver } from "@/lib/htmlSnapshot/dnsResolver";

const signal = () => new AbortController().signal;

beforeEach(() => {
  state.instances.length = 0;
  state.v4 = [];
  state.v6 = [];
  state.hang = false;
});

describe("dnsResolver (c-ares, sin red)", () => {
  it("junta A y AAAA y usa plazo corto y pocos reintentos", async () => {
    state.v4 = ["93.184.216.34"];
    state.v6 = ["2606:4700:4700::1111"];
    await expect(dnsResolver("ejemplo.com", signal())).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(state.instances[0].options).toEqual({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
    expect(DNS_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(DNS_TRIES).toBeLessThanOrEqual(2);
  });

  it("que falle un tipo (ENODATA) no importa si el otro responde", async () => {
    state.v4 = Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
    state.v6 = ["2606:4700:4700::1111"];
    await expect(dnsResolver("solo-v6.example.com", signal())).resolves.toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
  });

  it("sin ninguna respuesta -> unreachable", async () => {
    state.v4 = new Error("ENOTFOUND");
    state.v6 = new Error("ENOTFOUND");
    await expect(dnsResolver("no-existe.example.com", signal())).rejects.toMatchObject({ code: "unreachable" });
  });

  it("el plazo de la peticion CANCELA las consultas pendientes (no queda nada colgado) -> timeout", async () => {
    state.hang = true;
    const controller = new AbortController();
    const pending = dnsResolver("lento.example.com", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(state.instances[0].cancelled).toBe(true);
  });

  it("una senal ya abortada no consulta nada", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(dnsResolver("x.example.com", controller.signal)).rejects.toMatchObject({ code: "timeout" });
  });

  it("cada resolucion usa su propio Resolver (cancelar una no afecta a otra)", async () => {
    state.v4 = ["93.184.216.34"];
    await dnsResolver("a.example.com", signal());
    await dnsResolver("b.example.com", signal());
    expect(state.instances).toHaveLength(2);
  });
});

describe("memoizeResolver", () => {
  it("resuelve cada nombre una sola vez por peticion y no guarda los fallos", async () => {
    let calls = 0;
    const memo = memoizeResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error("falla");
      return [{ address: "93.184.216.34", family: 4 as const }];
    });
    await expect(memo("a.example.com", signal())).rejects.toThrow();
    await memo("a.example.com", signal());
    await memo("a.example.com", signal());
    expect(calls).toBe(2);
  });
});
