import http from "node:http";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedFetch } from "@/lib/htmlSnapshot/guardedFetch";
import { decodeBody, nodeTransport } from "@/lib/htmlSnapshot/nodeTransport";
import { SnapshotError, SNAPSHOT_USER_AGENT } from "@/lib/htmlSnapshot/types";
import { noAbort } from "@/lib/htmlSnapshot/testSupport";

/**
 * Transporte real, pero SOLO contra un servidor local en 127.0.0.1 levantado por la propia prueba (nada sale a Internet).
 * El transporte no valida direcciones (eso es `guardedFetch`): aqui se comprueba COMO conecta y descomprime.
 */

async function readAll(stream: AsyncIterable<Uint8Array>, max: number): Promise<number> {
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) return total;
  }
  return total;
}

describe("decodeBody — bomba de gzip (sin red)", () => {
  it("una bomba de 200 MB comprimida en ~200 KB solo se descomprime hasta el tope que lee quien la consume", async () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024); // viaja en menos de 1 MB
    const { stream, close } = decodeBody(Readable.from([bomb]), "gzip");
    const started = Date.now();
    const seen = await readAll(stream as unknown as AsyncIterable<Uint8Array>, 5 * 1024 * 1024);
    close();
    expect(seen).toBeGreaterThan(5 * 1024 * 1024);
    expect(seen).toBeLessThan(40 * 1024 * 1024); // se corto: no se produjeron los 200 MB
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("deflate, br e identity se aceptan; un encoding desconocido -> unsupported-type", () => {
    expect(() => decodeBody(Readable.from([Buffer.from("x")]), "zstd")).toThrow(SnapshotError);
    expect(() => decodeBody(Readable.from([Buffer.from("x")]), "gzip, br")).toThrow(SnapshotError);
    const identity = decodeBody(Readable.from([Buffer.from("x")]), "");
    identity.close();
  });
});

describe("nodeTransport — contra un servidor local", () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      if (request.url === "/gzip") {
        response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        response.end(gzipSync("<p>comprimido</p>"));
      } else if (request.url === "/bomba") {
        response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        response.end(gzipSync(Buffer.alloc(100 * 1024 * 1024)));
      } else if (request.url === "/redir") {
        response.writeHead(302, { location: "http://127.0.0.1/otro" });
        response.end("cuerpo que no se lee");
      } else if (request.url === "/lento") {
        response.writeHead(200, { "content-type": "text/html" });
        response.write("<p>empieza");
        // nunca termina
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<p>hola</p>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("conecta a la IP validada aunque el nombre no exista (anti DNS-rebinding), con Host del nombre y User-Agent fijo", async () => {
    const response = await nodeTransport({
      url: new URL(`http://nombre-que-no-resuelve.invalid:${port}/ruta?x=1`),
      address: { address: "127.0.0.1", family: 4 },
      signal: noAbort,
      accept: "text/html",
    });
    expect(response.status).toBe(200);
    const body = await readAll(response.body, 1024);
    expect(body).toBe("<p>hola</p>".length);
    const last = seen[seen.length - 1];
    expect(last.url).toBe("/ruta?x=1");
    expect(last.headers.host).toBe(`nombre-que-no-resuelve.invalid:${port}`);
    expect(last.headers["user-agent"]).toBe(SNAPSHOT_USER_AGENT);
    expect(last.headers.cookie).toBeUndefined();
    expect(last.headers.authorization).toBeUndefined();
    expect(last.headers.referer).toBeUndefined();
    expect(last.headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(last.headers.connection).toBe("close");
  });

  it("descomprime gzip", async () => {
    const result = await guardedFetchLocal("/gzip", 1024);
    expect(new TextDecoder().decode(result)).toBe("<p>comprimido</p>");
  });

  it("una bomba de gzip real contra el servidor local -> too-large sin agotar la memoria", async () => {
    await expect(guardedFetchLocal("/bomba", 1024 * 1024)).rejects.toMatchObject({ code: "too-large" });
  });

  it("devuelve la redireccion sin leer su cuerpo", async () => {
    const response = await nodeTransport({
      url: new URL(`http://127.0.0.1:${port}/redir`),
      address: { address: "127.0.0.1", family: 4 },
      signal: noAbort,
      accept: "text/html",
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1/otro");
    response.close();
  });

  it("el plazo corta una respuesta que nunca termina -> el lector falla y la conexion se cierra", async () => {
    const controller = new AbortController();
    const response = await nodeTransport({
      url: new URL(`http://127.0.0.1:${port}/lento`),
      address: { address: "127.0.0.1", family: 4 },
      signal: controller.signal,
      accept: "text/html",
    });
    setTimeout(() => controller.abort(), 100);
    await expect(readAll(response.body, 1024 * 1024)).rejects.toBeDefined();
  });

  it("un puerto cerrado -> unreachable (sin detalles)", async () => {
    await expect(
      nodeTransport({
        url: new URL("http://127.0.0.1:9/"),
        address: { address: "127.0.0.1", family: 4 },
        signal: noAbort,
        accept: "text/html",
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  /** Atajo: pasa por el transporte real y LEE con tope, como hace `guardedFetch`, pero hacia el servidor local. */
  async function guardedFetchLocal(path: string, maxBytes: number): Promise<Uint8Array> {
    const env = {
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      // Se desvia SOLO la conexion al servidor local; la validacion de guardedFetch se ejecuta entera.
      transport: (request: Parameters<typeof nodeTransport>[0]) =>
        nodeTransport({ ...request, url: new URL(`http://127.0.0.1:${port}${request.url.pathname}`), address: { address: "127.0.0.1", family: 4 } }),
    };
    const result = await guardedFetch(`http://ejemplo.com${path}`, "page", { maxBytes }, env, noAbort);
    return result.bytes;
  }
});
