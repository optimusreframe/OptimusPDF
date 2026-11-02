import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSnapshotResponse, requestSnapshot, SnapshotRequestError, snapshotFileName, snapshotToFile } from "@/lib/htmlSnapshot/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GOOD = { html: "<p>x</p>", finalUrl: "https://ejemplo.com/a/b.html", title: "T", notes: [{ code: "scripts-ignored" as const, count: 2 }] };

function stubFetch(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  });
  return calls;
}

describe("parseSnapshotResponse", () => {
  it("acepta la forma buena y descarta avisos desconocidos o mal formados", () => {
    expect(parseSnapshotResponse(GOOD)).toEqual(GOOD);
    const parsed = parseSnapshotResponse({ ...GOOD, notes: [{ code: "inventado" }, { code: "images-limit", count: -3.7 }, null, "x", { code: "little-content" }] });
    expect(parsed?.notes).toEqual([{ code: "images-limit", count: 0 }, { code: "little-content" }]);
  });

  it("rechaza lo que no es la forma esperada", () => {
    for (const bad of [null, undefined, "x", 5, {}, { ...GOOD, html: 5 }, { ...GOOD, html: "" }, { ...GOOD, finalUrl: null }, { ...GOOD, title: 1 }]) {
      expect(parseSnapshotResponse(bad)).toBeNull();
    }
    expect(parseSnapshotResponse({ ...GOOD, notes: "no" })?.notes).toEqual([]);
  });
});

describe("requestSnapshot", () => {
  it("hace POST JSON sin cookies ni referer y devuelve la instantanea", async () => {
    const calls = stubFetch(Response.json(GOOD));
    await expect(requestSnapshot("https://ejemplo.com/a")).resolves.toEqual(GOOD);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/html-snapshot");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: "https://ejemplo.com/a" });
  });

  it("traduce los errores tipados de la ruta y el resto a 'unreachable'", async () => {
    stubFetch(Response.json({ error: "blocked-address" }, { status: 403 }));
    await expect(requestSnapshot("x")).rejects.toMatchObject({ code: "blocked-address" });
    stubFetch(Response.json({ error: "algo-raro" }, { status: 500 }));
    await expect(requestSnapshot("x")).rejects.toMatchObject({ code: "unreachable" });
    stubFetch(new Response("<html>502</html>", { status: 502 }));
    await expect(requestSnapshot("x")).rejects.toMatchObject({ code: "unreachable" });
  });

  it("sin red -> 'network'; abortada -> 'cancelled'; respuesta 200 inutilizable -> 'bad-response'", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    await expect(requestSnapshot("x")).rejects.toMatchObject({ code: "network" });

    const controller = new AbortController();
    controller.abort();
    stubFetch(new DOMException("aborted", "AbortError"));
    await expect(requestSnapshot("x", controller.signal)).rejects.toMatchObject({ code: "cancelled" });

    stubFetch(Response.json({ html: 1 }));
    await expect(requestSnapshot("x")).rejects.toBeInstanceOf(SnapshotRequestError);
    stubFetch(Response.json({ html: 1 }));
    await expect(requestSnapshot("x")).rejects.toMatchObject({ code: "bad-response" });
  });
});

describe("snapshotFileName / snapshotToFile", () => {
  it("nombre seguro a partir de la direccion final", () => {
    expect(snapshotFileName("https://ejemplo.com/a/b.html")).toBe("ejemplo.com-b.html");
    expect(snapshotFileName("https://ejemplo.com/")).toBe("ejemplo.com.html");
    expect(snapshotFileName("https://xn--espaol-zwa.example.com/art%C3%ADculo?x=1")).toMatch(/^[A-Za-z0-9._-]+\.html$/);
    expect(snapshotFileName("no es una url")).toBe("pagina-web.html");
    expect(snapshotFileName(`https://ejemplo.com/${"a".repeat(300)}`).length).toBeLessThanOrEqual(85);
  });

  it("el archivo sintetico es HTML en UTF-8", async () => {
    const file = snapshotToFile({ ...GOOD, html: "<p>ñandú</p>" });
    expect(file.type).toBe("text/html");
    expect(file.name).toBe("ejemplo.com-b.html");
    expect(await file.text()).toBe("<p>ñandú</p>");
  });
});
