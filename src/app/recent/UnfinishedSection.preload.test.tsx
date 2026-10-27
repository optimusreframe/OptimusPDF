import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { UnfinishedSection } from "@/app/recent/UnfinishedSection";
import type { RecentRow } from "@/app/recent/recentIndex";
import type { UnfinishedItem } from "@/app/recent/unfinishedWork";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/** Recientes con un escaneo para retomar: precarga el motor del Escaner (con conexion) para que «Continuar» funcione sin ella. */
const preload = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/scan/engine", () => ({ preloadScanEngine: preload }));
vi.mock("@/app/pdf-pro/session/useDraftThumbnails", () => ({ useDraftThumbnails: () => ({}) }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => {
  cleanup();
  preload.mockClear();
});

function row(slug: UnfinishedItem["slug"], id: string): RecentRow {
  const draft = {
    key: `${slug === "scan-to-pdf" ? "scan" : "edit"}:${id}`,
    target: { kind: slug === "scan-to-pdf" ? "scan" : "edit", id },
    slug,
    fileName: "Contrato",
    savedAt: "2026-10-27T10:00:00.000Z",
    href: `/${slug}?resume=x:${id}`,
    pages: 3,
    scanCover: null,
  } as unknown as UnfinishedItem;
  return { key: `draft:${draft.key}`, origin: "draft", status: "unfinished", slug, fileName: "Contrato", date: draft.savedAt, draft, continueHref: draft.href } as unknown as RecentRow;
}

function mount(rows: RecentRow[]) {
  return render(
    <LanguageProvider>
      <UnfinishedSection rows={rows} refresh={async () => {}} onDiscarded={() => {}} fallbackFocus={createRef<HTMLElement>()} />
    </LanguageProvider>,
  );
}

describe("Recientes: precarga del motor del Escaner", () => {
  it("con un escaneo sin terminar precarga el motor (una vez)", async () => {
    mount([row("scan-to-pdf", "scan-abcd1234")]);
    await waitFor(() => expect(preload).toHaveBeenCalledTimes(1));
  });

  it("sin escaneos no carga nada del Escaner", async () => {
    mount([row("edit-pdf", "e-abcd1234")]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preload).not.toHaveBeenCalled();
  });
});
