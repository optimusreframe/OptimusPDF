import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, createSnapshotHandler } from "@/lib/htmlSnapshot/handler";
import { createRateLimiter } from "@/lib/htmlSnapshot/rateLimit";
import { makeEnv, textBody } from "@/lib/htmlSnapshot/testSupport";
import { SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

const PAGE_HTML = '<!doctype html><html><head><title>Hola</title><link rel="stylesheet" href="/s.css"></head><body><h1>Titulo</h1><img src="/i.png"><script>alert(1)</script></body></html>';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function goodEnv() {
  return makeEnv({
    routes: {
      "https://ejemplo.com/": { body: PAGE_HTML },
      "https://ejemplo.com/s.css": { body: "h1{color:red}", headers: { "content-type": "text/css" } },
      "https://ejemplo.com/i.png": { body: new Uint8Array(PNG), headers: { "content-type": "image/png" } },
    },
  });
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://optimuspdf.test/api/html-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/html-snapshot (logica)", () => {
  it("devuelve { html, finalUrl, title, notes } autocontenido y saneado, con no-store", async () => {
    const env = goodEnv();
    const handle = createSnapshotHandler(env);
    const response = await handle(post({ url: "https://ejemplo.com/" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const data = await response.json();
    expect(Object.keys(data).sort()).toEqual(["finalUrl", "html", "notes", "title"]);
    expect(data.finalUrl).toBe("https://ejemplo.com/");
    expect(data.title).toBe("Hola");
    expect(data.html).toContain("h1{color:red}");
    expect(data.html).toContain("data:image/png;base64,");
    expect(data.html).not.toMatch(/<script|alert\(1\)|<link/i);
    expect(data.notes).toEqual(expect.arrayContaining([{ code: "scripts-ignored", count: 1 }]));
  });

  it("no registra nada: ni console.* ni la direccion", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const handle = createSnapshotHandler(goodEnv());
    await handle(post({ url: "https://ejemplo.com/" }));
    await handle(post({ url: "http://127.0.0.1/" }));
    await handle(post("no es json"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("solo acepta peticiones de la propia web", async () => {
    const handle = createSnapshotHandler(goodEnv());
    expect((await handle(post({ url: "https://ejemplo.com/" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await handle(post({ url: "https://ejemplo.com/" }, { "sec-fetch-site": "same-site" }))).status).toBe(403);
    const sinCabeceras = new Request("https://optimuspdf.test/api/html-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://ejemplo.com/" }),
    });
    const forbidden = await handle(sinCabeceras);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("acepta Origin con el mismo host cuando no hay Sec-Fetch-Site, y rechaza otro", async () => {
    const handle = createSnapshotHandler(goodEnv());
    const base = { "content-type": "application/json", host: "optimuspdf.test" };
    const ok = new Request("https://optimuspdf.test/api/html-snapshot", {
      method: "POST",
      headers: { ...base, origin: "https://optimuspdf.test" },
      body: JSON.stringify({ url: "https://ejemplo.com/" }),
    });
    expect((await handle(ok)).status).toBe(200);
    const otro = new Request("https://optimuspdf.test/api/html-snapshot", {
      method: "POST",
      headers: { ...base, origin: "https://malo.example.org" },
      body: JSON.stringify({ url: "https://ejemplo.com/" }),
    });
    expect((await handle(otro)).status).toBe(403);
  });

  it("exige application/json", async () => {
    const handle = createSnapshotHandler(goodEnv());
    const response = await handle(post({ url: "https://ejemplo.com/" }, { "content-type": "text/plain" }));
    expect(response.status).toBe(400);
  });

  it("cuerpo > 4 KB, JSON roto, sin url o url que no es texto -> invalid-url sin consultar nada", async () => {
    const env = goodEnv();
    const handle = createSnapshotHandler(env);
    for (const body of [JSON.stringify({ url: "https://ejemplo.com/" + "a".repeat(5000) }), "{roto", "[]", "null", JSON.stringify({ url: 5 }), JSON.stringify({})]) {
      const response = await handle(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-url" });
    }
    expect(env.calls).toHaveLength(0);
  });

  it("corta la lectura del cuerpo aunque no declare Content-Length", async () => {
    const handle = createSnapshotHandler(goodEnv());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 20; index += 1) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const request = new Request("https://optimuspdf.test/api/html-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await handle(request)).status).toBe(400);
  });

  it("direcciones bloqueadas -> blocked-address (403), sin conectar", async () => {
    const env = goodEnv();
    const handle = createSnapshotHandler(env);
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/", "http://[::ffff:127.0.0.1]/"]) {
      const response = await handle(post({ url }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "blocked-address" });
    }
    expect(env.calls).toHaveLength(0);
  });

  it("errores tipados y genericos de la pagina", async () => {
    const env = makeEnv({
      routes: {
        "https://pdf.example.com/": { headers: { "content-type": "application/pdf" }, body: "%PDF" },
        "https://caida.example.com/": { status: 503 },
        "https://enorme.example.com/": { body: textBody("x".repeat(SNAPSHOT_LIMITS.maxPageBytes + 10)) },
        "https://meta.example.com/": { status: 302, headers: { location: "http://169.254.169.254/" } },
      },
    });
    const handle = createSnapshotHandler(env);
    const expected: Array<[string, number, string]> = [
      ["https://pdf.example.com/", 415, "unsupported-type"],
      ["https://caida.example.com/", 502, "unreachable"],
      ["https://enorme.example.com/", 413, "too-large"],
      ["https://meta.example.com/", 403, "blocked-address"],
    ];
    for (const [url, status, error] of expected) {
      const response = await handle(post({ url }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("un fallo interno no filtra detalles", async () => {
    const env = goodEnv();
    env.transport = async () => {
      throw new Error("ECONNREFUSED 10.1.2.3:5432 /var/secreto");
    };
    const handle = createSnapshotHandler(env);
    const response = await handle(post({ url: "https://ejemplo.com/" }));
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"unreachable"}');
  });

  it("limitador por IP: la peticion N+1 de la misma IP -> rate-limited (429); otra IP no", async () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    const handle = createSnapshotHandler({ ...goodEnv(), limiter });
    for (let index = 0; index < 3; index += 1) expect((await handle(post({ url: "https://ejemplo.com/" }))).status).toBe(200);
    const blocked = await handle(post({ url: "https://ejemplo.com/" }));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate-limited" });
    expect((await handle(post({ url: "https://ejemplo.com/" }, { "x-forwarded-for": "198.51.100.7" }))).status).toBe(200);
    now = 61_000; // ventana nueva
    expect((await handle(post({ url: "https://ejemplo.com/" }))).status).toBe(200);
  });

  it("tope de concurrencia por instancia", async () => {
    const env = goodEnv();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = env.transport;
    env.transport = async (request) => {
      await gate;
      return original(request);
    };
    const handle = createSnapshotHandler({ ...env, maxConcurrent: 2, limiter: createRateLimiter({ limit: 100, windowMs: 60_000 }) });
    const first = handle(post({ url: "https://ejemplo.com/" }));
    const second = handle(post({ url: "https://ejemplo.com/" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = await handle(post({ url: "https://ejemplo.com/" }));
    expect(third.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // Liberado el cupo, vuelve a aceptar.
    expect((await handle(post({ url: "https://ejemplo.com/" }))).status).toBe(200);
  });
});

describe("createRateLimiter", () => {
  it("no crece sin limite", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: () => 0 });
    for (let index = 0; index < 100; index += 1) limiter.allow(`ip-${index}`);
    expect(limiter.allow("nueva")).toBe(true);
  });
});

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://optimuspdf.test/api/html-snapshot", { method: "POST", headers, body: "{}" });
}

describe("clientKey (clave del limitador)", () => {
  it("prefiere lo que fija la plataforma y NO se deja engañar por X-Forwarded-For", () => {
    expect(clientKey(requestWith({ "x-vercel-forwarded-for": "203.0.113.5", "x-real-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("203.0.113.5");
    expect(clientKey(requestWith({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1" }))).toBe("198.51.100.1");
    // Sin cabeceras de la plataforma: el ULTIMO valor (el del proxy mas cercano); el primero lo inventa el cliente.
    expect(clientKey(requestWith({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("una IPv6 se agrupa por su /64", () => {
    const a = clientKey(requestWith({ "x-real-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    const b = clientKey(requestWith({ "x-real-ip": "2001:db8:1:2:1111:2222:3333:4444" }));
    const other = clientKey(requestWith({ "x-real-ip": "2001:db8:1:3::1" }));
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).toBe("v6:20010db800010002");
  });

  it("lo que no es una IP comparte la clave `unknown` (el atacante no decide cuantas claves hay)", () => {
    expect(clientKey(requestWith({}))).toBe("unknown");
    expect(clientKey(requestWith({ "x-real-ip": "no-soy-una-ip" }))).toBe("unknown");
    expect(clientKey(requestWith({ "x-real-ip": `${"9".repeat(500)}` }))).toBe("unknown");
  });

  it("el tope de concurrencia por instancia es 2", () => {
    expect(SNAPSHOT_LIMITS.maxConcurrent).toBe(2);
  });
});

describe("createRateLimiter — la tabla llena no se vacia", () => {
  it("llenar la tabla con claves falsas NO borra el contador de quien ya estaba al limite", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 50, now: () => 0 });
    expect(limiter.allow("victima")).toBe(true);
    expect(limiter.allow("victima")).toBe(true);
    expect(limiter.allow("victima")).toBe(false);
    // Una avalancha de claves nuevas llena la tabla varias veces.
    for (let index = 0; index < 500; index += 1) limiter.allow(`falsa-${index}`);
    // Las claves mas antiguas se descartan primero, asi que la de la victima (la mas antigua) puede salir... pero NUNCA se vacia
    // todo de golpe: una clave reciente sigue contada.
    expect(limiter.allow("falsa-499")).toBe(true); // 2.ª peticion de esa clave (la 1.ª fue en el bucle)
    expect(limiter.allow("falsa-499")).toBe(false);
  });

  it("descarta primero las caducadas", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: () => now });
    for (let index = 0; index < 10; index += 1) limiter.allow(`a-${index}`);
    now = 2000; // caducan todas
    expect(limiter.allow("nueva")).toBe(true);
    expect(limiter.allow("nueva")).toBe(false);
  });
});
