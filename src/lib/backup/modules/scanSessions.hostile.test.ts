import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  __setScanSessionBytesCapForTests,
  applyScanSessionsImport,
  defaultScanSessionDecisions,
  exportScanSessionsDetailed,
  planScanSessionsImport,
  type ScanPagePayload,
  type ScanSessionImportItem,
  type ScanSessionsImportPlan,
} from "@/lib/backup/modules/scanSessions";
import { MAX_SCAN_PACKAGE_PAGES, MAX_SCAN_PACKAGE_SESSIONS } from "@/lib/backup/modules/scanSessionsSchema";
import { resetScanStore, seedSimpleSession } from "@/lib/backup/__fixtures__/scanKit";
import { asFile, rewriteZip, timed } from "@/lib/backup/__fixtures__/testKit";
import type { PackageFileInput, PackageModuleInput } from "@/lib/backup/types";
import { SCAN_SESSION_TTL_MS, listScanSessionSummaries } from "@/lib/scan/sessionStore";
import { tinyJpegBytes } from "@/lib/scan/testing/testImages";

/**
 * Corpus HOSTIL del modulo «Escaneos en curso» (patron de `drafts.hostile.test.ts`): cada paquete malo se rechaza o se recorta
 * SIN romper el resto, en menos de 2 s, y NUNCA escribe nada en el almacen al planificar. Se parte de un paquete legitimo de
 * dos sesiones de dos paginas y se le cambia UNA cosa; el contenedor (zips hostiles, rutas, bombas) ya tiene su corpus aparte.
 */

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- el indice se rompe a proposito de mil maneras
type Index = { sessions: Raw[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetScanStore();
  __setScanSessionBytesCapForTests(undefined);
});

async function baseModule(): Promise<PackageModuleInput> {
  await seedSimpleSession("Contrato A", 2, 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  await seedSimpleSession("Contrato B", 2, 10);
  const { module } = await exportScanSessionsDetailed();
  await resetScanStore();
  return module;
}

type Forge = {
  index?: (index: Index) => void;
  rawIndex?: Uint8Array;
  files?: (files: PackageFileInput[]) => PackageFileInput[] | void;
  schemaVersion?: number;
};

/** Paquete legitimo con UNA cosa cambiada (en el indice o en los archivos), leido de vuelta con el lector real. */
async function forge(change: Forge = {}) {
  const base = await baseModule();
  let files = base.files.map((file) => ({ ...file }));
  if (change.index) {
    const index = JSON.parse(decoder.decode(files[0].data)) as Index;
    change.index(index);
    files[0] = { ...files[0], data: encoder.encode(JSON.stringify(index)) };
  }
  if (change.rawIndex) files[0] = { ...files[0], data: change.rawIndex };
  if (change.files) files = change.files(files) ?? files;
  const blob = await buildPackage({ modules: [{ ...base, files, schemaVersion: change.schemaVersion ?? base.schemaVersion }] });
  return readPackage(asFile(blob));
}

async function planOf(change: Forge = {}, now?: number): Promise<ScanSessionsImportPlan> {
  const read = await forge(change);
  const plan = await timed(() => planScanSessionsImport(read, { now }));
  // Planificar NUNCA escribe.
  expect(await listScanSessionSummaries()).toEqual([]);
  return plan;
}

const statuses = (plan: ScanSessionsImportPlan) => plan.items.map((item) => item.status);
const reasons = (plan: ScanSessionsImportPlan) => plan.items.map((item) => item.reason);

describe("control: el paquete legitimo del que parten los casos hostiles", () => {
  it("dos sesiones nuevas de dos paginas, sin nada descartado", async () => {
    const plan = await planOf();
    expect(plan.state).toBe("ok");
    expect(statuses(plan)).toEqual(["new", "new"]);
    expect(plan.items.map((item) => [item.pageCount, item.discardedPages])).toEqual([[2, 0], [2, 0]]);
  });
});

describe("indice roto: el modulo queda «damaged» y no se lee nada", () => {
  const rawIndexes: Array<[string, string | Uint8Array]> = [
    ["no es JSON", "esto no es json"],
    ["JSON vacio", ""],
    ["un array", "[]"],
    ["un numero", "5"],
    ["null", "null"],
    ["una cadena", '"hola"'],
    ["sin sessions", "{}"],
    ["sessions es un objeto", '{"sessions":{}}'],
    ["sessions es una cadena", '{"sessions":"x"}'],
    ["profundidad de 10 000 niveles", `{"sessions":${"[".repeat(10_000)}${"]".repeat(10_000)}}`],
    ["BOM al principio", new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"sessions":[]}')])],
    ["UTF-8 invalido", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
  ];
  for (const [name, text] of rawIndexes) {
    it(`${name} -> damaged`, async () => {
      const plan = await planOf({ rawIndex: typeof text === "string" ? encoder.encode(text) : text });
      expect(plan.state).toBe("damaged");
      expect(plan.items).toEqual([]);
    });
  }

  it("sin index.json -> damaged", async () => {
    const plan = await planOf({ files: (files) => files.filter((file) => file.path !== "scan-sessions/index.json") });
    expect(plan.state).toBe("damaged");
  });

  it(`mas de ${MAX_SCAN_PACKAGE_SESSIONS} sesiones -> damaged (no se recorre)`, async () => {
    const plan = await planOf({ index: (index) => { index.sessions = Array.from({ length: MAX_SCAN_PACKAGE_SESSIONS + 1 }, (_, n) => ({ ...index.sessions[0], ref: `s${n + 1}`, id: `sc-clon-${String(n).padStart(4, "0")}` })); } });
    expect(plan.state).toBe("damaged");
  });

  it(`mas de ${MAX_SCAN_PACKAGE_PAGES} paginas en total -> damaged (no se recorre)`, async () => {
    const plan = await planOf({
      index: (index) => {
        const pages = Array.from({ length: 400 }, (_, n) => ({ ...index.sessions[0].pages[0], ref: `p${n + 1}`, id: `pg-${n}`, file: `scan-sessions/s1-p${n + 1}.jpg` }));
        index.sessions = Array.from({ length: 3 }, (_, n) => ({ ...index.sessions[0], ref: `s${n + 1}`, id: `sc-clon-${n}0000000`, pages }));
      },
    });
    expect(plan.state).toBe("damaged");
  });

  it("10 000 sesiones de relleno se rechazan en menos de 2 s", async () => {
    const plan = await planOf({ index: (index) => { index.sessions = Array.from({ length: 10_000 }, () => ({})); } });
    expect(plan.state).toBe("damaged");
  });
});

describe("una sesion mala se aisla: «no se puede importar» y la otra sigue", () => {
  const TOO_LONG = "x".repeat(100_000);
  const cases: Array<[string, (session: Raw) => void, string]> = [
    ["id que falta", (s) => { delete s.id; }, "invalidEntry"],
    ["id numerico", (s) => { s.id = 7; }, "invalidEntry"],
    ["id vacio", (s) => { s.id = ""; }, "invalidEntry"],
    ["id en mayusculas", (s) => { s.id = "SC-ABCDEFGH"; }, "invalidEntry"],
    ["id con ruta", (s) => { s.id = "../../etc/passwd"; }, "invalidEntry"],
    ["id con espacios", (s) => { s.id = "sc-abc def-12"; }, "invalidEntry"],
    ["id de 65 caracteres", (s) => { s.id = `sc-${"a".repeat(62)}`; }, "invalidEntry"],
    ["id __proto__", (s) => { s.id = "__proto__"; }, "invalidEntry"],
    ["id con salto de linea", (s) => { s.id = "sc-abcdefgh\n"; }, "invalidEntry"],
    ["ref que falta", (s) => { delete s.ref; }, "invalidEntry"],
    ["ref en mayuscula", (s) => { s.ref = "S1"; }, "invalidEntry"],
    ["ref con 4 cifras", (s) => { s.ref = "s1000"; }, "invalidEntry"],
    ["ref con ruta", (s) => { s.ref = "s1/../x"; }, "invalidEntry"],
    ["nombre numerico", (s) => { s.name = 5; }, "invalidEntry"],
    ["nombre de 100 000 caracteres", (s) => { s.name = TOO_LONG; }, "invalidEntry"],
    ["createdAt que no es fecha", (s) => { s.createdAt = "ayer"; }, "invalidEntry"],
    ["updatedAt numerico", (s) => { s.updatedAt = 1.7e12; }, "invalidEntry"],
    ["savedAt que falta", (s) => { delete s.savedAt; }, "invalidEntry"],
    ["savedAt infinito (1e999)", (s) => { s.savedAt = Infinity; }, "invalidEntry"],
    ["settings es un array", (s) => { s.settings = []; }, "invalidEntry"],
    ["settings.mode inventado", (s) => { s.settings.mode = "teletransporte"; }, "invalidEntry"],
    ["settings.defaultFilter inventado", (s) => { s.settings.defaultFilter = "sepia"; }, "invalidEntry"],
    ["settings.autoCapture como texto", (s) => { s.settings.autoCapture = "si"; }, "invalidEntry"],
    ["settings.searchable numerico", (s) => { s.settings.searchable = 1; }, "invalidEntry"],
    ["nameSuggested con fuente inventada", (s) => { s.nameSuggested = { title: "x", date: null, source: "adivino" }; }, "invalidEntry"],
    ["nameSuggested con fecha imposible", (s) => { s.nameSuggested = { title: null, date: "2026-13-45", source: "date" }; }, "invalidEntry"],
    ["nameSuggested.title numerico", (s) => { s.nameSuggested = { title: 5, date: null, source: "ocr" }; }, "invalidEntry"],
    ["pages es un objeto", (s) => { s.pages = {}; }, "invalidEntry"],
    ["pages que falta", (s) => { delete s.pages; }, "invalidEntry"],
    ["501 paginas", (s) => { s.pages = Array.from({ length: 501 }, () => s.pages[0]); }, "tooMany"],
    ["sin ninguna pagina", (s) => { s.pages = []; }, "noValidPages"],
    ["la entrada es un numero", () => undefined, "invalidEntry"],
  ];
  for (const [name, mutate, reason] of cases) {
    it(`${name} -> ${reason}; la otra sesion sigue`, async () => {
      const plan = await planOf({
        index: (index) => {
          if (name === "la entrada es un numero") index.sessions[0] = 5 as unknown as Raw;
          else mutate(index.sessions[0]);
        },
      });
      expect(plan.state).toBe("ok");
      expect(statuses(plan)).toEqual(["invalid", "new"]);
      expect(reasons(plan)).toEqual([reason, undefined]);
      expect(plan.counts).toEqual({ new: 1, identical: 0, different: 0, invalid: 1 });
      // Lo invalido no se puede aprobar: aunque se marque «Importar», solo entra la buena.
      const forced = Object.fromEntries(plan.items.map((item) => [item.key, "import" as const]));
      const result = await applyScanSessionsImport(plan, forced);
      expect(result).toMatchObject({ ok: true, written: 1 });
      expect((await listScanSessionSummaries()).map((s) => s.name)).toEqual(["Contrato B"]);
    });
  }

  it("un id repetido en el indice: el segundo se aisla (duplicateId) y no pisa al primero", async () => {
    const plan = await planOf({ index: (index) => { index.sessions[1].id = index.sessions[0].id; } });
    expect(statuses(plan)).toEqual(["new", "invalid"]);
    expect(reasons(plan)).toEqual([undefined, "duplicateId"]);
    expect(plan.items[0].name).toBe("Contrato A");
  });

  it("claves __proto__, constructor y desconocidas no llegan a lo guardado", async () => {
    const read = await forge({
      index: (index) => {
        const session = index.sessions[0];
        session.__proto__x = 1;
        session.evil = { x: 1 };
        Object.defineProperty(session, "constructor", { value: { polluted: true }, enumerable: true });
        session.settings = JSON.parse('{"mode":"document","__proto__":{"polluted":true},"constructor":{"x":1},"extra":5}');
        session.pages[0].flags = JSON.parse('{"blank":true,"__proto__":{"polluted":true},"unknown":true}');
        session.pages[0].unknownField = "x";
      },
    });
    const plan = await planScanSessionsImport(read);
    expect(plan.items[0].status).toBe("new");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const [summary] = (await listScanSessionSummaries()).filter((s) => s.name === "Contrato A");
    expect(summary).toBeDefined();
    const saved = await (await import("@/lib/scan/sessionStore")).scanSessionStore.load(summary.id);
    expect(saved?.settings).toEqual({ mode: "document", autoCapture: true, batch: true, defaultFilter: "auto", searchable: false });
    expect(Object.keys(saved!.pages[0].flags)).toEqual(["blank"]);
    expect(Object.keys(saved!.pages[0]).includes("unknownField")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("las banderas en false equivalen a «ausente» (solo se guardan las puestas) y el resto de claves se ignora", async () => {
    const plan = await planOf({ index: (index) => { index.sessions[0].pages[0].flags = { blank: false, blurry: true, glare: false, duplicateOf: "pg-otra" }; } });
    expect(plan.items[0].payload?.pages[0].flags).toEqual({ blurry: true, duplicateOf: "pg-otra" });
  });

  it("controles y marcas bidi del nombre se limpian (la sesion entra)", async () => {
    const plan = await planOf({ index: (index) => { index.sessions[0].name = "Con\u0000trol‮es\u0007 y   texto"; } });
    expect(plan.items[0].status).toBe("new");
    expect(plan.items[0].name).toBe("Con troles  y   texto");
  });
});

describe("una pagina mala se descarta y el resto de su sesion sigue", () => {
  const pageCases: Array<[string, (page: Raw) => void]> = [
    ["id que falta", (p) => { delete p.id; }],
    ["id vacio", (p) => { p.id = ""; }],
    ["id con ruta", (p) => { p.id = "../x"; }],
    ["id de 65 caracteres", (p) => { p.id = "a".repeat(65); }],
    ["id numerico", (p) => { p.id = 3; }],
    ["ref invalida", (p) => { p.ref = "page1"; }],
    ["createdAt que no es fecha", (p) => { p.createdAt = "x"; }],
    ["source inventada", (p) => { p.source = "web"; }],
    ["ancho 0", (p) => { p.originalWidth = 0; }],
    ["ancho negativo", (p) => { p.originalWidth = -5; }],
    ["ancho decimal", (p) => { p.originalWidth = 10.5; }],
    ["ancho como texto", (p) => { p.originalWidth = "64"; }],
    ["ancho de 1e9", (p) => { p.originalWidth = 1e9; }],
    ["area de mas de 200 Mpx", (p) => { p.originalWidth = 90_000; p.originalHeight = 90_000; }],
    ["corners: array", (p) => { p.corners = []; }],
    ["corners: un punto que falta", (p) => { delete p.corners.topLeft; }],
    ["corners: x como texto", (p) => { p.corners.topLeft.x = "0.1"; }],
    ["corners: x infinito", (p) => { p.corners.topLeft.x = Infinity; }],
    ["corners: x fuera de rango", (p) => { p.corners.topLeft.x = 9; }],
    ["corners: y fuera de rango", (p) => { p.corners.bottomRight.y = 9; }],
    ["corners: x muy negativa", (p) => { p.corners.topRight.x = -3; }],
    ["corners: punto que es un numero", (p) => { p.corners.topRight = 5; }],
    ["rotation 45", (p) => { p.rotation = 45; }],
    ["rotation como texto", (p) => { p.rotation = "90"; }],
    ["filter inventado", (p) => { p.filter = "magia"; }],
    ["adjust que falta", (p) => { delete p.adjust; }],
    ["adjust fuera de -1..1", (p) => { p.adjust.brightness = 2; }],
    ["adjust contrast infinito", (p) => { p.adjust.contrast = -Infinity; }],
    ["adjust como texto", (p) => { p.adjust.brightness = "0"; }],
    ["flags es un array", (p) => { p.flags = [1]; }],
    ["flags.blank como texto", (p) => { p.flags = { blank: "si" }; }],
    ["flags.duplicateOf numerico", (p) => { p.flags = { duplicateOf: 7 }; }],
    ["flags.duplicateOf con ruta", (p) => { p.flags = { duplicateOf: "../x" }; }],
    ["mode inventado", (p) => { p.mode = "ovni"; }],
    ["resolvedFilter inventado", (p) => { p.resolvedFilter = "sepia"; }],
    ["jpegSample: side negativo", (p) => { p.jpegSample = { side: -1, bytesPerPixel: 0.5 }; }],
    ["jpegSample: bytesPerPixel como texto", (p) => { p.jpegSample = { side: 100, bytesPerPixel: "x" }; }],
    ["jpegSample: qualityRatio con 17 entradas", (p) => { p.jpegSample = { side: 100, bytesPerPixel: 0.5, qualityRatio: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`q${n}`, 1])) }; }],
    ["jpegSample: qualityRatio con __proto__", (p) => { p.jpegSample = { side: 100, bytesPerPixel: 0.5, qualityRatio: JSON.parse('{"__proto__":1}') }; }],
    ["file que falta", (p) => { delete p.file; }],
    ["file con ruta de salida", (p) => { p.file = "../../etc/passwd"; }],
    ["file absoluta", (p) => { p.file = "/etc/passwd"; }],
    ["file de OTRA sesion", (p) => { p.file = "scan-sessions/s2-p1.jpg"; }],
    ["file de otra pagina", (p) => { p.file = "scan-sessions/s1-p2.jpg"; }],
    ["file con extension .svg", (p) => { p.file = "scan-sessions/s1-p1.svg"; }],
    ["file con extension .exe", (p) => { p.file = "scan-sessions/s1-p1.exe"; }],
    ["file con extension en mayusculas", (p) => { p.file = "scan-sessions/s1-p1.JPG"; }],
    ["file apunta al indice", (p) => { p.file = "scan-sessions/index.json"; }],
    ["file de otro modulo", (p) => { p.file = "drafts/d1.pdf"; }],
    ["file numerico", (p) => { p.file = 5; }],
    ["la entrada es un array", () => undefined],
  ];
  for (const [name, mutate] of pageCases) {
    it(`${name} -> la pagina se descarta, la otra pagina y la otra sesion siguen`, async () => {
      const plan = await planOf({
        index: (index) => {
          if (name === "la entrada es un array") index.sessions[0].pages[0] = [] as unknown as Raw;
          else mutate(index.sessions[0].pages[0]);
        },
      });
      const [first, second] = plan.items;
      expect(first).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
      expect(first.payload?.pages).toHaveLength(1);
      expect(second).toMatchObject({ status: "new", pageCount: 2, discardedPages: 0 });
    });
  }

  it("un texto reconocido de 100 000 caracteres NO tumba la pagina: se descarta el texto (se vuelve a reconocer)", async () => {
    const plan = await planOf({ index: (index) => { index.sessions[0].pages[0].ocrText = "x".repeat(100_000); } });
    expect(plan.items[0]).toMatchObject({ status: "new", pageCount: 2, discardedPages: 0 });
    expect(plan.items[0].payload?.pages[0].ocrText).toBeUndefined();
  });

  it("un texto reconocido que no es texto se ignora; con controles se limpia y conserva los saltos de linea", async () => {
    const plan = await planOf({
      index: (index) => {
        index.sessions[0].pages[0].ocrText = { x: 1 };
        index.sessions[0].pages[1].ocrText = "uno\u0000\ndos‮\ttres";
      },
    });
    expect(plan.items[0].payload?.pages[0].ocrText).toBeUndefined();
    expect(plan.items[0].payload?.pages[1].ocrText).toBe("uno \ndos\ttres");
  });

  it("dos paginas con el mismo id o la misma referencia: la segunda se descarta", async () => {
    const sameId = await planOf({ index: (index) => { index.sessions[0].pages[1].id = index.sessions[0].pages[0].id; } });
    expect(sameId.items[0]).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
    const sameRef = await planOf({ index: (index) => { index.sessions[0].pages[1].ref = "p1"; index.sessions[0].pages[1].file = "scan-sessions/s1-p1.jpg"; } });
    expect(sameRef.items[0]).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
  });

  it("si TODAS las paginas de una sesion son malas, la sesion es «no se puede importar» (noValidPages)", async () => {
    const plan = await planOf({ index: (index) => { for (const page of index.sessions[0].pages) page.rotation = 1; } });
    expect(plan.items[0]).toMatchObject({ status: "invalid", reason: "noValidPages" });
    expect(plan.items[1].status).toBe("new");
  });
});

describe("fotos malas: se descarta la pagina, nunca se confia en el nombre ni en el tipo", () => {
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(encoder.encode(type), 4);
    out.set(data, 8);
    return out;
  }
  function pngWithDims(width: number, height: number): Uint8Array {
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0, 0, 0, 1])), chunk("IEND", new Uint8Array())];
    return Uint8Array.from(parts.flatMap((part) => [...part]));
  }
  function jpegWithDims(width: number, height: number): Uint8Array {
    const bytes = tinyJpegBytes(32, 40, 5).slice();
    for (let i = 2; i + 8 < bytes.length; i += 1) {
      if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
        bytes[i + 5] = height >> 8;
        bytes[i + 6] = height & 255;
        bytes[i + 7] = width >> 8;
        bytes[i + 8] = width & 255;
        return bytes;
      }
    }
    throw new Error("sin SOF");
  }
  function webpWithDims(width: number, height: number): Uint8Array {
    const out = new Uint8Array(30);
    out.set(encoder.encode("RIFF"), 0);
    new DataView(out.buffer).setUint32(4, 22, true);
    out.set(encoder.encode("WEBPVP8X"), 8);
    new DataView(out.buffer).setUint32(16, 10, true);
    const w = width - 1;
    const h = height - 1;
    out.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
    return out;
  }

  /** Cambia los bytes de la primera foto (y, si hace falta, su extension) con el zip legitimo (sha y tamano arreglados). */
  async function withFirstPhoto(data: Uint8Array, ext = "jpg") {
    return planOf({
      index: (index) => { index.sessions[0].pages[0].file = `scan-sessions/s1-p1.${ext}`; },
      files: (files) => files.map((file) => (file.path === "scan-sessions/s1-p1.jpg" ? { ...file, path: `scan-sessions/s1-p1.${ext}`, data } : file)),
    });
  }

  const photoCases: Array<[string, () => Uint8Array, string?]> = [
    ["un PDF", () => encoder.encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF")],
    ["un texto", () => encoder.encode("no soy una foto, soy un texto largo".repeat(5))],
    ["un SVG con script", () => encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["un HTML", () => encoder.encode("<html><script>alert(1)</script></html>")],
    ["un ejecutable (MZ)", () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(60).fill(1)])],
    ["un JPEG truncado", () => tinyJpegBytes(64, 80, 1).slice(0, 200)],
    ["un JPEG solo con la firma", () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2])],
    ["un PNG truncado", () => pngWithDims(10, 10).slice(0, 40)],
    ["un PNG sin IEND", () => pngWithDims(10, 10).slice(0, pngWithDims(10, 10).length - 12)],
    ["un PNG de 60 000 x 60 000 px (bomba de pixeles)", () => pngWithDims(60_000, 60_000)],
    ["un JPEG que declara 65 535 x 65 535 px (bomba de pixeles)", () => jpegWithDims(65_535, 65_535)],
    ["un WebP que declara 16 000 000 x 16 000 000 px", () => webpWithDims(16_000_000, 16_000_000), "webp"],
    ["un GIF truncado", () => encoder.encode("GIF89a\x01\x00")],
  ];
  for (const [name, make, ext] of photoCases) {
    it(`${name} -> la pagina se descarta (la sesion sigue con la otra)`, async () => {
      const plan = await withFirstPhoto(make(), ext);
      expect(plan.items[0]).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
      expect(plan.items[1]).toMatchObject({ status: "new", pageCount: 2 });
    });
  }

  it("una foto cuyos bytes son de OTRO formato que su extension (PNG bajo .jpg, JPEG bajo .png) se descarta", async () => {
    const png = pngWithDims(10, 10);
    expect((await withFirstPhoto(png, "jpg")).items[0]).toMatchObject({ pageCount: 1, discardedPages: 1 });
    expect((await withFirstPhoto(tinyJpegBytes(64, 80, 1), "png")).items[0]).toMatchObject({ pageCount: 1, discardedPages: 1 });
    // Control: el PNG bajo su extension verdadera entra.
    expect((await withFirstPhoto(png, "png")).items[0]).toMatchObject({ pageCount: 2, discardedPages: 0 });
  });

  it("las dimensiones se leen de la cabecera de la foto, no de lo declarado (declarar 10 x 10 para una foto de 64 x 80 no engana)", async () => {
    const plan = await planOf({ index: (index) => { index.sessions[0].pages[0].originalWidth = 10; index.sessions[0].pages[0].originalHeight = 10; } });
    expect(plan.items[0].payload?.pages[0]).toMatchObject({ originalWidth: 64, originalHeight: 80 });
  });

  it("el tipo MIME del paquete se ignora: la foto se guarda con el tipo de sus bytes", async () => {
    const read = await forge({ files: (files) => files.map((file) => (file.path.endsWith(".jpg") ? { ...file, type: "application/x-msdownload" } : file)) });
    const plan = await planScanSessionsImport(read);
    expect(plan.items[0].payload?.pages.map((page) => page.mime)).toEqual(["image/jpeg", "image/jpeg"]);
  });

  it("una foto que no coincide con su SHA-256 del manifiesto (zip manipulado) se descarta: integrity si son todas", async () => {
    const base = await baseModule();
    const blob = await buildPackage({ modules: [base] });
    const tampered = await rewriteZip(blob, (zip) => {
      const photo = zip.file("scan-sessions/s1-p1.jpg");
      if (!photo) throw new Error("falta");
      return photo.async("uint8array").then((bytes) => {
        const copy = bytes.slice();
        copy[copy.length - 5] ^= 0xff;
        zip.file("scan-sessions/s1-p1.jpg", copy);
      });
    });
    const plan = await planScanSessionsImport(await readPackage(asFile(tampered)));
    expect(plan.items[0]).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
    const allBad = await rewriteZip(blob, async (zip) => {
      for (const name of ["scan-sessions/s1-p1.jpg", "scan-sessions/s1-p2.jpg"]) {
        const bytes = (await zip.file(name)!.async("uint8array")).slice();
        bytes[bytes.length - 5] ^= 0xff;
        zip.file(name, bytes);
      }
    });
    const plan2 = await planScanSessionsImport(await readPackage(asFile(allBad)));
    expect(plan2.items[0]).toMatchObject({ status: "invalid", reason: "integrity" });
    expect(plan2.items[1].status).toBe("new");
  });

  it("una foto que falta en el zip (el manifiesto la lista pero no esta) se descarta", async () => {
    const base = await baseModule();
    const blob = await buildPackage({ modules: [base] });
    const missing = await rewriteZip(blob, (zip) => {
      zip.remove("scan-sessions/s2-p1.jpg");
    });
    const plan = await planScanSessionsImport(await readPackage(asFile(missing)));
    expect(plan.items[1]).toMatchObject({ status: "new", pageCount: 1, discardedPages: 1 });
  });

  it("validateImage (la puerta de decodificacion de la interfaz) descarta lo que no pase", async () => {
    const read = await forge();
    const plan = await planScanSessionsImport(read, { validateImage: async (bytes) => bytes.byteLength > 1_000_000 });
    expect(plan.items.map((item) => item.reason)).toEqual(["noValidPages", "noValidPages"]);
    const calls: string[] = [];
    await planScanSessionsImport(read, { validateImage: async (_bytes, mime) => (calls.push(mime), true) });
    expect(calls).toEqual(["image/jpeg", "image/jpeg", "image/jpeg", "image/jpeg"]);
  });
});

describe("tope de una sesion y caducidad", () => {
  it("una sesion que pasa del tope del almacen es «no se puede importar» (tooLarge)", async () => {
    __setScanSessionBytesCapForTests(100);
    const plan = await planOf();
    expect(reasons(plan)).toEqual(["tooLarge", "tooLarge"]);
  });

  it("caducada en el paquete -> expired (y no se miran sus fotos); a punto de caducar entra", async () => {
    const old = await planOf({ index: (index) => { index.sessions[0].savedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - 1000).toISOString(); } });
    expect(reasons(old)).toEqual(["expired", undefined]);
    const fresh = await planOf({ index: (index) => { index.sessions[0].savedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS + 60_000).toISOString(); } });
    expect(statuses(fresh)).toEqual(["new", "new"]);
    const year = await planOf({ index: (index) => { index.sessions[0].savedAt = "1999-01-01T00:00:00.000Z"; } });
    expect(reasons(year)).toEqual(["expired", undefined]);
  });
});

describe("un plan manipulado (viene de la interfaz) no escribe nada que no valga", () => {
  async function freshPlan(): Promise<ScanSessionsImportPlan> {
    const plan = await planScanSessionsImport(await forge());
    expect(plan.state).toBe("ok");
    return plan;
  }
  const payloadOf = (plan: ScanSessionsImportPlan, index = 0) => (plan.items[index] as ScanSessionImportItem).payload!;
  const pageOf = (plan: ScanSessionsImportPlan, index = 0): ScanPagePayload => payloadOf(plan, index).pages[0];

  const tampers: Array<[string, (plan: ScanSessionsImportPlan) => void]> = [
    ["id de sesion con forma de ataque", (plan) => { payloadOf(plan).id = "../../x"; }],
    ["id de sesion __proto__", (plan) => { payloadOf(plan).id = "__proto__"; }],
    ["sin paginas", (plan) => { payloadOf(plan).pages = []; }],
    ["pages que no es una lista", (plan) => { (payloadOf(plan) as unknown as Raw).pages = "x"; }],
    ["una foto que no es una foto", (plan) => { pageOf(plan).bytes = encoder.encode("%PDF-1.4 no soy una foto"); }],
    ["bytes que no son un Uint8Array", (plan) => { (pageOf(plan) as unknown as Raw).bytes = [1, 2, 3]; }],
    ["tipo MIME que no es el de los bytes", (plan) => { pageOf(plan).mime = "image/png"; }],
    ["id de pagina con ruta", (plan) => { pageOf(plan).id = "../x"; }],
    ["dos paginas con el mismo id", (plan) => { payloadOf(plan).pages[1].id = payloadOf(plan).pages[0].id; }],
    ["rotacion inventada", (plan) => { (pageOf(plan) as unknown as Raw).rotation = 33; }],
    ["filtro inventado", (plan) => { (pageOf(plan) as unknown as Raw).filter = "magia"; }],
    ["ajuste fuera de rango", (plan) => { pageOf(plan).adjust = { brightness: 5, contrast: 0 }; }],
    ["esquinas con texto", (plan) => { (pageOf(plan) as unknown as Raw).corners = { topLeft: { x: "a", y: 0 } }; }],
    ["dimensiones absurdas", (plan) => { pageOf(plan).originalWidth = 1e9; }],
    ["ajustes inventados", (plan) => { (payloadOf(plan) as unknown as Raw).settings = { mode: "ovni" }; }],
    ["texto reconocido enorme", (plan) => { pageOf(plan).ocrText = "x".repeat(50_000); }],
    ["nombre enorme", (plan) => { payloadOf(plan).name = "x".repeat(10_000); }],
    ["fecha de guardado vencida", (plan) => { payloadOf(plan).savedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - DAY).toISOString(); }],
    ["fecha de creacion que no es fecha", (plan) => { payloadOf(plan).createdAt = "x"; }],
    ["sugerencia de nombre inventada", (plan) => { (payloadOf(plan) as unknown as Raw).nameSuggested = { source: "adivino" }; }],
  ];
  for (const [name, tamper] of tampers) {
    it(`${name} -> invalid, almacen intacto`, async () => {
      const plan = await freshPlan();
      tamper(plan);
      const result = await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
      expect(result).toEqual({ ok: false, reason: "invalid" });
      expect(await listScanSessionSummaries()).toEqual([]);
    });
  }

  it("control: sin manipular, el mismo plan se aplica", async () => {
    const plan = await freshPlan();
    expect(await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan))).toMatchObject({ ok: true, written: 2 });
  });

  it("una sesion manipulada que NO esta aprobada no impide aplicar las demas (solo se revalida lo que se escribe)", async () => {
    const plan = await freshPlan();
    pageOf(plan, 1).bytes = encoder.encode("%PDF-1.4 no soy una foto");
    const decisions = { ...defaultScanSessionDecisions(plan), [plan.items[1].key]: "omit" as const };
    expect(await applyScanSessionsImport(plan, decisions)).toMatchObject({ ok: true, written: 1 });
    expect((await listScanSessionSummaries()).map((s) => s.name)).toEqual(["Contrato A"]);
  });

  it("lo que se escribe es lo SANEADO, no el objeto recibido: claves extra y banderas ajenas no llegan al almacen", async () => {
    const plan = await freshPlan();
    (pageOf(plan) as unknown as Raw).evil = "x";
    (pageOf(plan) as unknown as Raw).flags = { blank: true, evil: true, "__proto__x": 1 };
    (payloadOf(plan) as unknown as Raw).rev = 999;
    (payloadOf(plan) as unknown as Raw).writerId = "otra-pestana";
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const store = (await import("@/lib/scan/sessionStore")).scanSessionStore;
    const loaded = await store.load(payloadOf(plan).id);
    expect(Object.keys(loaded!.pages[0])).not.toContain("evil");
    expect(loaded!.pages[0].flags).toEqual({ blank: true });
  });

  it("decisiones con claves raras (__proto__, constructor, ids que no existen) no hacen nada", async () => {
    const plan = await freshPlan();
    const decisions = JSON.parse('{"__proto__":"import","constructor":"import","scan:no-existe":"import"}') as Record<string, "import">;
    expect(await applyScanSessionsImport(plan, decisions)).toMatchObject({ ok: true, written: 0 });
    expect(await listScanSessionSummaries()).toEqual([]);
  });

  it("un plan sin `items`, con otro modulo o con estado distinto de ok se bloquea", async () => {
    const plan = await freshPlan();
    expect(await applyScanSessionsImport({ ...plan, items: undefined as unknown as [] }, {})).toEqual({ ok: false, reason: "blocked" });
    expect(await applyScanSessionsImport({ ...plan, state: "damaged" }, defaultScanSessionDecisions(plan))).toEqual({ ok: false, reason: "blocked" });
  });
});

describe("rendimiento: ningun caso hostil cuelga la pestana", () => {
  it("500 paginas (casi todas rotas: sin foto, o con campos invalidos) se planifican en menos de 2 s", async () => {
    const plan = await planOf({
      index: (index) => {
        const goodFile = index.sessions[0].pages[0].file;
        const pages = Array.from({ length: 300 }, (_, n) => ({ ...index.sessions[0].pages[0], ref: `p${n + 1}`, id: `pg-${n}`, file: `scan-sessions/s1-p${n + 1}.jpg` }));
        const bad = Array.from({ length: 200 }, (_, n) => ({ ...index.sessions[0].pages[0], ref: `p${301 + n}`, id: `bad-${n}`, rotation: 7, file: goodFile }));
        index.sessions[0].pages = [...pages, ...bad];
      },
    });
    expect(plan.items[0]).toMatchObject({ discardedPages: 200 + 298 });
  });
});
