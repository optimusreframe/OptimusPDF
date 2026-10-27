import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { discardItem } from "@/app/recent/discardDraft";
import { buildRecentRows } from "@/app/recent/recentIndex";
import { buildUnfinishedItems } from "@/app/recent/unfinishedWork";
import { continueHrefFor, isValidResumeId, parseResume, readResumeFromSearch, resumeHref, resumeKindsOfTool, toolOfResumeKind, verifiableResume, withoutResume } from "@/lib/resumeLinks";
import { __resetScanStoreMemoryForTests, clearScanSessions, listScanSessionSummaries, newScanSessionId, scanSessionStore, type ScanSessionSummary } from "@/lib/scan/sessionStore";
import { DEFAULT_SCAN_SETTINGS, type ScanSession } from "@/lib/scan/types";

/**
 * Escanear a PDF en «Recientes»: una sesion sin terminar aparece con «Continuar» (`?resume=scan:<id>`) y se borra desde ahi.
 * Pruebas aditivas: las de los otros tres tipos de borrador siguen en `unfinishedWork.test.ts`.
 */

const NOW = "2026-10-26T14:32:00.000Z";
const summary = (patch: Partial<ScanSessionSummary> = {}): ScanSessionSummary => ({ id: "sc-mgx4k2w1-1a2b3c", name: "Contrato · 2026-10-26", updatedAt: NOW, savedAt: NOW, pageCount: 3, thumb: null, ...patch });

describe("resumeLinks · tipo `scan`", () => {
  it("el enlace es /scan-to-pdf?resume=scan:<id> y la herramienta lo restaura", () => {
    expect(resumeHref({ kind: "scan", id: "sc-mgx4k2w1-1a2b3c" })).toBe("/scan-to-pdf?resume=scan:sc-mgx4k2w1-1a2b3c");
    expect(toolOfResumeKind("scan")).toBe("scan-to-pdf");
    expect(resumeKindsOfTool("scan-to-pdf")).toEqual(["scan"]);
    expect(resumeKindsOfTool("sign-pdf")).not.toContain("scan");
    const read = readResumeFromSearch("?resume=scan:sc-mgx4k2w1-1a2b3c", resumeKindsOfTool("scan-to-pdf"));
    expect(read).toEqual({ present: true, target: { kind: "scan", id: "sc-mgx4k2w1-1a2b3c" } });
    expect(withoutResume("/scan-to-pdf?resume=scan:sc-mgx4k2w1-1a2b3c&x=1")).toBe("/scan-to-pdf?x=1");
  });

  it("el id es entrada no confiable: solo [a-z0-9-] de 8 a 64; nada de rutas, comillas ni mayusculas", () => {
    for (const bad of ["", "corto", "../../x", "sc/abc12345", "sc abc12345", "SC-ABC-12345", "sc-<script>1", "a".repeat(65), "sc-abc;12345"]) {
      expect(isValidResumeId("scan", bad), bad).toBe(false);
      expect(parseResume(`scan:${bad}`), bad).toBeNull();
    }
    expect(isValidResumeId("scan", "sc-mgx4k2w1-1a2b3c")).toBe(true);
    expect(isValidResumeId("scan", newScanSessionId())).toBe(true);
    // Una herramienta distinta no restaura el tipo `scan`.
    expect(readResumeFromSearch("?resume=scan:sc-mgx4k2w1-1a2b3c", resumeKindsOfTool("edit-pdf")).target).toBeNull();
    expect(readResumeFromSearch("?resume=sign:" + "a".repeat(64), resumeKindsOfTool("scan-to-pdf")).target).toBeNull();
  });

  it("«Continuar» solo se ofrece con un puntero verificable de la herramienta de la fila", () => {
    const target = { kind: "scan", id: "sc-mgx4k2w1-1a2b3c" };
    expect(continueHrefFor("scan-to-pdf", target)).toBe("/scan-to-pdf?resume=scan:sc-mgx4k2w1-1a2b3c");
    expect(continueHrefFor("sign-pdf", target)).toBeNull();
    expect(verifiableResume("scan-to-pdf", { kind: "scan", id: "../x" })).toBeNull();
  });
});

describe("«Sin terminar»: sesiones de escaneo", () => {
  it("una sesion con paginas aparece con la herramienta, el nombre, la fecha, sus paginas, la portada y «Continuar»", () => {
    const cover = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const [item] = buildUnfinishedItems({ sign: [], edit: [], pro: [], scan: [summary({ thumb: cover })] });
    expect(item).toMatchObject({ key: "scan:sc-mgx4k2w1-1a2b3c", slug: "scan-to-pdf", fileName: "Contrato · 2026-10-26", savedAt: NOW, pages: 3, href: "/scan-to-pdf?resume=scan:sc-mgx4k2w1-1a2b3c" });
    expect(item.scanCover).toBe(cover);
  });

  it("se descartan las sesiones vacias y las de id no valido (no se promete un «Continuar» que no continua)", () => {
    const items = buildUnfinishedItems({ sign: [], edit: [], pro: [], scan: [summary({ pageCount: 0 }), summary({ id: "../mal", name: "x" }), summary({ id: "sc-bueno-0000001", name: "Buena" })] });
    expect(items.map((i) => i.fileName)).toEqual(["Buena"]);
  });

  it("las demas fuentes siguen igual y `scan` es opcional (los almacenes anteriores no lo traen)", () => {
    expect(buildUnfinishedItems({ sign: [], edit: [], pro: [] })).toEqual([]);
  });

  it("se mezcla con el resto por fecha (lo mas reciente primero) y entra en el indice unificado con su «Continuar»", () => {
    const items = buildUnfinishedItems({ sign: [], edit: [], pro: [], scan: [summary({ savedAt: "2026-10-20T00:00:00.000Z", id: "sc-viejo-0000001", name: "Vieja" }), summary({ savedAt: "2026-10-25T00:00:00.000Z", id: "sc-nuevo-0000001", name: "Nueva" })] });
    expect(items.map((i) => i.fileName)).toEqual(["Nueva", "Vieja"]);
    const rows = buildRecentRows({ unfinished: items, history: [] });
    expect(rows.map((r) => r.continueHref)).toEqual(["/scan-to-pdf?resume=scan:sc-nuevo-0000001", "/scan-to-pdf?resume=scan:sc-viejo-0000001"]);
    expect(rows.every((r) => r.status === "unfinished" && r.slug === "scan-to-pdf")).toBe(true);
  });
});

describe("descartar desde Recientes borra la sesion de verdad", () => {
  beforeEach(async () => {
    __resetScanStoreMemoryForTests();
    await clearScanSessions();
  });

  it("guardar -> aparece en la lista -> descartar -> ya no esta (ni sus paginas ni sus originales)", async () => {
    const session: ScanSession = {
      id: newScanSessionId(),
      createdAt: NOW,
      updatedAt: NOW,
      name: "Para descartar",
      settings: { ...DEFAULT_SCAN_SETTINGS },
      pages: [
        {
          id: "p-1-aaaaaaaa",
          createdAt: NOW,
          source: "camera",
          original: new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }),
          originalWidth: 10,
          originalHeight: 10,
          corners: null,
          rotation: 0,
          filter: "auto",
          adjust: { brightness: 0, contrast: 0 },
          processed: null,
          thumb: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
          flags: {},
        },
      ],
    };
    await scanSessionStore.save(session);
    const items = buildUnfinishedItems({ sign: [], edit: [], pro: [], scan: await listScanSessionSummaries() });
    expect(items).toHaveLength(1);
    await discardItem(items[0]);
    expect(await listScanSessionSummaries()).toEqual([]);
    expect(await scanSessionStore.load(session.id)).toBeNull();
  });
});
