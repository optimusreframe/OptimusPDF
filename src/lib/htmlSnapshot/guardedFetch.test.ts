import { describe, expect, it } from "vitest";
import { guardedFetch } from "@/lib/htmlSnapshot/guardedFetch";
import { SNAPSHOT_LIMITS, SnapshotError } from "@/lib/htmlSnapshot/types";
import { makeEnv, noAbort, textBody } from "@/lib/htmlSnapshot/testSupport";

const OPTIONS = { maxBytes: 1024 };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof SnapshotError ? error.code : `otro:${String(error)}`;
  }
}

describe("guardedFetch — casos buenos", () => {
  it("descarga una pagina y devuelve bytes, tipo y direccion final", async () => {
    const env = makeEnv({ routes: { "https://example.com/": { body: "<p>hola</p>" } } });
    const result = await guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort);
    expect(new TextDecoder().decode(result.bytes)).toBe("<p>hola</p>");
    expect(result.mime).toBe("text/html");
    expect(result.url.href).toBe("https://example.com/");
  });

  it("conecta a la IP ya validada (no al nombre) y quita el fragmento", async () => {
    const env = makeEnv({
      dns: { "example.com": [{ address: "93.184.216.34", family: 4 }] },
      routes: { "https://example.com/a?b=1": { body: "x" } },
    });
    await guardedFetch("https://example.com/a?b=1#secreto", "page", OPTIONS, env, noAbort);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(env.calls[0].url.hash).toBe("");
    expect(env.calls[0].url.href).not.toContain("secreto");
  });

  it("sigue una redireccion y valida el destino", async () => {
    const env = makeEnv({
      routes: {
        "https://example.com/": { status: 301, headers: { location: "/nueva" } },
        "https://example.com/nueva": { body: "ok" },
      },
    });
    const result = await guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort);
    expect(result.url.pathname).toBe("/nueva");
    expect(env.calls).toHaveLength(2);
  });

  it("hasta 5 redirecciones pasan y la sexta falla", async () => {
    const routes: Record<string, { status: number; headers: Record<string, string> } | { body: string }> = {};
    for (let index = 0; index < 5; index += 1) {
      routes[`https://example.com/${index}`] = { status: 302, headers: { location: `/${index + 1}` } };
    }
    routes["https://example.com/5"] = { body: "fin" };
    const env = makeEnv({ routes });
    expect((await guardedFetch("https://example.com/0", "page", OPTIONS, env, noAbort)).url.pathname).toBe("/5");

    const sixth = makeEnv({
      routes: { ...routes, "https://example.com/5": { status: 302, headers: { location: "/6" } }, "https://example.com/6": { body: "x" } },
    });
    expect(await codeOf(guardedFetch("https://example.com/0", "page", OPTIONS, sixth, noAbort))).toBe("unreachable");
  });

  it("acepta text/css e image/* como recursos y exige el tipo por clase de recurso", async () => {
    const env = makeEnv({
      routes: {
        "https://example.com/a.css": { body: "a{}", headers: { "content-type": "text/css" } },
        "https://example.com/a.png": { body: "PNG", headers: { "content-type": "image/png" } },
        "https://example.com/a.js": { body: "x", headers: { "content-type": "text/javascript" } },
      },
    });
    expect((await guardedFetch("https://example.com/a.css", "css", OPTIONS, env, noAbort)).mime).toBe("text/css");
    expect((await guardedFetch("https://example.com/a.png", "image", OPTIONS, env, noAbort)).mime).toBe("image/png");
    expect(await codeOf(guardedFetch("https://example.com/a.js", "css", OPTIONS, env, noAbort))).toBe("unsupported-type");
    expect(await codeOf(guardedFetch("https://example.com/a.css", "image", OPTIONS, env, noAbort))).toBe("unsupported-type");
  });
});

describe("guardedFetch — corpus hostil (anti-SSRF)", () => {
  it("nunca llega a conectar a una direccion literal privada", async () => {
    for (const target of ["http://127.0.0.1/", "http://0.0.0.0/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      const env = makeEnv({ routes: {} });
      expect(await codeOf(guardedFetch(target, "page", OPTIONS, env, noAbort))).toBe("blocked-address");
      expect(env.calls).toHaveLength(0);
      expect(env.lookups).toHaveLength(0); // ni siquiera pregunta al DNS
    }
  });

  it("un nombre que RESUELVE a una privada se bloquea", async () => {
    const env = makeEnv({ dns: { "rebote.example.com": [{ address: "10.0.0.7", family: 4 }] }, routes: {} });
    expect(await codeOf(guardedFetch("https://rebote.example.com/", "page", OPTIONS, env, noAbort))).toBe("blocked-address");
    expect(env.calls).toHaveLength(0);
  });

  it("doble A/AAAA mixto: basta una privada para bloquear TODO el nombre", async () => {
    const env = makeEnv({
      dns: {
        "mixto.example.com": [
          { address: "93.184.216.34", family: 4 },
          { address: "fd00::1", family: 6 },
        ],
      },
      routes: { "https://mixto.example.com/": { body: "x" } },
    });
    expect(await codeOf(guardedFetch("https://mixto.example.com/", "page", OPTIONS, env, noAbort))).toBe("blocked-address");
    expect(env.calls).toHaveLength(0);
  });

  it("A publica y AAAA mapeada a 127.0.0.1 tambien se bloquea", async () => {
    const env = makeEnv({
      dns: { "m.example.com": [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }] },
      routes: {},
    });
    expect(await codeOf(guardedFetch("https://m.example.com/", "page", OPTIONS, env, noAbort))).toBe("blocked-address");
  });

  it("DNS sin respuesta o que falla -> unreachable", async () => {
    const empty = makeEnv({ dns: { "vacio.example.com": [] }, routes: {} });
    expect(await codeOf(guardedFetch("https://vacio.example.com/", "page", OPTIONS, empty, noAbort))).toBe("unreachable");
    const failing = makeEnv({ routes: {} });
    failing.resolve = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await codeOf(guardedFetch("https://no-existe.example.com/", "page", OPTIONS, failing, noAbort))).toBe("unreachable");
  });

  it("una redireccion a los metadatos de la nube se bloquea y NO se conecta", async () => {
    const env = makeEnv({
      routes: { "https://example.com/": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } } },
    });
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("blocked-address");
    expect(env.calls).toHaveLength(1); // solo la primera
  });

  it("una redireccion a localhost, a otro esquema o a un puerto raro se bloquea", async () => {
    for (const [location, expected] of [
      ["http://localhost/admin", "blocked-address"],
      ["http://localhost:80/admin", "blocked-address"],
      ["file:///etc/passwd", "invalid-url"],
      ["ftp://example.com/x", "invalid-url"],
      ["https://example.com:8443/", "invalid-url"],
      ["https://user:pw@example.com/", "invalid-url"],
    ] as const) {
      const env = makeEnv({ routes: { "https://example.com/": { status: 307, headers: { location } } } });
      expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe(expected);
      expect(env.calls).toHaveLength(1);
    }
  });

  it("una redireccion a un nombre que resuelve a privada se bloquea", async () => {
    const env = makeEnv({
      dns: { "interno.example.org": [{ address: "192.168.1.10", family: 4 }] },
      routes: { "https://example.com/": { status: 302, headers: { location: "https://interno.example.org/" } } },
    });
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("blocked-address");
    expect(env.calls).toHaveLength(1);
  });

  it("redireccion en bucle (mas de 5 saltos) -> unreachable", async () => {
    const env = makeEnv({
      routes: {
        "https://example.com/a": { status: 302, headers: { location: "/b" } },
        "https://example.com/b": { status: 302, headers: { location: "/a" } },
      },
    });
    expect(await codeOf(guardedFetch("https://example.com/a", "page", OPTIONS, env, noAbort))).toBe("unreachable");
    expect(env.calls).toHaveLength(SNAPSHOT_LIMITS.maxRedirects + 1);
  });

  it("una redireccion sin Location -> unreachable", async () => {
    const env = makeEnv({ routes: { "https://example.com/": { status: 302 } } });
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("unreachable");
  });

  it("repite TODA la validacion en cada salto (DNS de cada nombre)", async () => {
    const env = makeEnv({
      routes: {
        "https://a.example.com/": { status: 302, headers: { location: "https://b.example.com/" } },
        "https://b.example.com/": { body: "ok" },
      },
    });
    await guardedFetch("https://a.example.com/", "page", OPTIONS, env, noAbort);
    expect(env.lookups).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("guardedFetch — limites", () => {
  it("cuerpo mas grande que el tope -> too-large y corta la lectura", async () => {
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced += 1;
        yield new Uint8Array(512);
        if (produced > 10_000) return;
      }
    }
    const env = makeEnv({ routes: { "https://example.com/": { body: endless() } } });
    expect(await codeOf(guardedFetch("https://example.com/", "page", { maxBytes: 1024 }, env, noAbort))).toBe("too-large");
    expect(produced).toBeLessThan(10); // se dejo de leer enseguida, no se agoto el flujo
    expect(env.closed).toBeGreaterThan(0);
  });

  it("no se fia de Content-Length: un cuerpo mayor del declarado tambien corta", async () => {
    const env = makeEnv({
      routes: { "https://example.com/": { headers: { "content-length": "10" }, body: textBody("x".repeat(5000)) } },
    });
    expect(await codeOf(guardedFetch("https://example.com/", "page", { maxBytes: 1024 }, env, noAbort))).toBe("too-large");
  });

  it("un Content-Length enorme sin compresion se rechaza sin leer nada", async () => {
    const env = makeEnv({
      routes: { "https://example.com/": { headers: { "content-length": String(50 * 1024 * 1024) }, body: "x" } },
    });
    expect(await codeOf(guardedFetch("https://example.com/", "page", { maxBytes: 1024 }, env, noAbort))).toBe("too-large");
  });

  it("tipo equivocado para la pagina -> unsupported-type", async () => {
    for (const type of ["application/json", "application/pdf", "image/png", "text/plain", "application/octet-stream", ""]) {
      const env = makeEnv({ routes: { "https://example.com/": { headers: { "content-type": type }, body: "x" } } });
      expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("unsupported-type");
    }
    const xhtml = makeEnv({ routes: { "https://example.com/": { headers: { "content-type": "application/xhtml+xml" }, body: "x" } } });
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, xhtml, noAbort))).toBe("ok");
  });

  it("estados de error del servidor -> unreachable", async () => {
    for (const status of [400, 401, 403, 404, 500, 503]) {
      const env = makeEnv({ routes: { "https://example.com/": { status } } });
      expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("unreachable");
    }
  });

  it("puerto raro, usuario:contrasena, esquemas ajenos y URL de 3 KB -> invalid-url sin red", async () => {
    for (const target of [
      "https://example.com:6379/",
      "https://u:p@example.com/",
      "file:///etc/passwd",
      "ftp://example.com/",
      "data:text/html,hola",
      `https://example.com/${"a".repeat(3000)}`,
    ]) {
      const env = makeEnv({ routes: {} });
      expect(await codeOf(guardedFetch(target, "page", OPTIONS, env, noAbort))).toBe("invalid-url");
      expect(env.calls).toHaveLength(0);
    }
  });

  it("una senal ya abortada -> timeout, sin conectar", async () => {
    const controller = new AbortController();
    controller.abort();
    const env = makeEnv({ routes: { "https://example.com/": { body: "x" } } });
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, controller.signal))).toBe("timeout");
    expect(env.calls).toHaveLength(0);
  });

  it("un transporte que falla -> unreachable, y si la senal vence -> timeout", async () => {
    const env = makeEnv({ routes: {} });
    env.transport = async () => {
      throw new Error("ECONNREFUSED 10.0.0.1:443 detalle interno");
    };
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, noAbort))).toBe("unreachable");

    const controller = new AbortController();
    env.transport = async () => {
      controller.abort();
      throw new Error("abortado");
    };
    expect(await codeOf(guardedFetch("https://example.com/", "page", OPTIONS, env, controller.signal))).toBe("timeout");
  });
});
