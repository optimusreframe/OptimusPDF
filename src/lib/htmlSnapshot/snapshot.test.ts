import { describe, expect, it } from "vitest";
import { createSnapshot } from "@/lib/htmlSnapshot/snapshot";
import { SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";
import type { Transport } from "@/lib/htmlSnapshot/nodeTransport";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** Una pagina con muchas imagenes repartidas en muchos servidores, y un transporte falso que mide la concurrencia. */
function amplification(options: { hosts: number; images: number }) {
  const state = { calls: 0, hosts: new Set<string>(), active: 0, maxActive: 0, perHost: new Map<string, number>(), maxPerHost: 0, lookups: new Set<string>() };
  const imgs = Array.from({ length: options.images }, (_, index) => `<img src="https://h${index % options.hosts}.example.com/i${index}.png">`).join("");
  const page = `<html><body><p>${"x".repeat(200)}</p>${imgs}</body></html>`;
  const transport: Transport = async ({ url }) => {
    state.calls += 1;
    state.hosts.add(url.hostname);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const count = (state.perHost.get(url.hostname) ?? 0) + 1;
    state.perHost.set(url.hostname, count);
    state.maxPerHost = Math.max(state.maxPerHost, count);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const isPage = url.hostname === "pagina.example.com";
    const body = isPage ? Buffer.from(page) : PNG;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      state.active -= 1;
      state.perHost.set(url.hostname, (state.perHost.get(url.hostname) ?? 1) - 1);
    };
    return {
      status: 200,
      headers: { "content-type": isPage ? "text/html" : "image/png" },
      body: (async function* () {
        try {
          yield new Uint8Array(body);
        } finally {
          finish();
        }
      })(),
      close: finish,
    };
  };
  return { state, deps: { transport, resolve: async (host: string) => { state.lookups.add(host); return [{ address: "93.184.216.34", family: 4 as const }]; } } };
}

describe("createSnapshot — presupuesto de peticiones salientes", () => {
  it("200 imagenes en 50 servidores: como mucho 6 servidores, 4 conexiones a la vez (2 por servidor) y 40 peticiones", async () => {
    const { state, deps } = amplification({ hosts: 50, images: 200 });
    const result = await createSnapshot("https://pagina.example.com/", deps);
    expect(result.html).toContain("<img");
    expect(state.calls).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxOutboundRequests);
    expect(state.hosts.size).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxHosts);
    expect(state.lookups.size).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxHosts);
    expect(state.maxActive).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxOutboundConcurrent);
    expect(state.maxPerHost).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxOutboundPerHost);
  });

  it("muchas imagenes en UN servidor: nunca mas de 2 a la vez contra el", async () => {
    const { state, deps } = amplification({ hosts: 1, images: 60 });
    // La pagina y las imagenes comparten servidor: se reparte el nombre real de la pagina.
    const original = deps.transport;
    deps.transport = (request) => original({ ...request, url: new URL(request.url.href.replace("h0.example.com", "pagina.example.com")) });
    await createSnapshot("https://pagina.example.com/", deps);
    expect(state.maxPerHost).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxOutboundPerHost);
    expect(state.calls).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxOutboundRequests);
  });
});
