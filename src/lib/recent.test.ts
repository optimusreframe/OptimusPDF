import { describe, expect, it } from "vitest";
import { rankByUsage, type RecentEntry } from "@/lib/recent";
import type { ToolSlug } from "@/lib/tools-registry";

function entry(slug: ToolSlug, fileName: string, date: string): RecentEntry {
  return { id: `${slug}-${date}`, slug, fileName, date };
}

describe("rankByUsage — src/lib/recent.ts", () => {
  it("ordena por frecuencia real, no por el orden de llegada", () => {
    const entries: RecentEntry[] = [
      entry("compress-pdf", "a.pdf", "2026-01-01T00:00:00.000Z"),
      entry("merge-pdf", "b.pdf", "2026-01-02T00:00:00.000Z"),
      entry("compress-pdf", "c.pdf", "2026-01-03T00:00:00.000Z"),
      entry("compress-pdf", "d.pdf", "2026-01-04T00:00:00.000Z"),
    ];

    const ranked = rankByUsage(entries, 4);

    expect(ranked.map((r) => r.slug)).toEqual(["compress-pdf", "merge-pdf"]);
    expect(ranked[0].count).toBe(3);
    expect(ranked[1].count).toBe(1);
  });

  it("cada resultado lleva la entrada mas reciente de esa herramienta, no la primera", () => {
    const entries: RecentEntry[] = [
      entry("compress-pdf", "viejo.pdf", "2026-01-01T00:00:00.000Z"),
      entry("compress-pdf", "nuevo.pdf", "2026-01-05T00:00:00.000Z"),
    ];

    const ranked = rankByUsage(entries, 4);

    expect(ranked[0].latest.fileName).toBe("nuevo.pdf");
  });

  it("en empate de frecuencia, desempata por el uso mas reciente", () => {
    const entries: RecentEntry[] = [
      entry("compress-pdf", "a.pdf", "2026-01-01T00:00:00.000Z"),
      entry("merge-pdf", "b.pdf", "2026-01-05T00:00:00.000Z"),
    ];

    const ranked = rankByUsage(entries, 4);

    expect(ranked.map((r) => r.slug)).toEqual(["merge-pdf", "compress-pdf"]);
  });

  it("respeta el limite pedido", () => {
    const entries: RecentEntry[] = [
      entry("compress-pdf", "a.pdf", "2026-01-01T00:00:00.000Z"),
      entry("merge-pdf", "b.pdf", "2026-01-02T00:00:00.000Z"),
      entry("split-pdf", "c.pdf", "2026-01-03T00:00:00.000Z"),
    ];

    expect(rankByUsage(entries, 2)).toHaveLength(2);
  });

  it("sin entradas, devuelve una lista vacia", () => {
    expect(rankByUsage([], 4)).toEqual([]);
  });
});
