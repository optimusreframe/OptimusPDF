import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { freshLibrary, seedDocument, seedReadyTemplate } from "@/app/documents/documents.testkit";
import { replaceDocumentBytes } from "@/lib/docLibrary/store";
import { sampleBytes, sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/** «Mis documentos» en INGLES: mismos controles, sin claves crudas ni texto en espanol. */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/documents" }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(freshLibrary);

describe("Mis documentos (EN)", () => {
  it("todo sale en inglés, sin claves crudas ni español", async () => {
    await seedDocument("a", { name: "Contract A" });
    await seedReadyTemplate("a");
    const { container } = render(
      <LanguageProvider>
        <MyDocumentsView />
      </LanguageProvider>,
    );
    await screen.findByRole("heading", { name: en.documents.listLabel });
    expect(screen.getByRole("heading", { level: 1, name: en.documents.title })).toBeTruthy();
    expect(screen.getByText(en.documents.statusReady)).toBeTruthy();
    expect(screen.getByRole("button", { name: fill(en.documents.signNamed, { name: "Contract A" }) })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.documents.add })).toBeTruthy();
    expect(screen.getByText(en.documents.privacy)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toContain(es.documents.statusReady);
    expect(text).not.toContain(es.documents.privacy);
    expect(text).not.toContain(es.documents.sign + es.documents.configure);
    expect(text).not.toMatch(/documents\.|\{n\}|\{name\}/);
  });

  it("plantilla desactualizada en inglés: icono + texto, «Set up again» y «still valid», sin español", async () => {
    await seedDocument("a", { name: "Contract A", seed: 7 });
    await seedReadyTemplate("a");
    await replaceDocumentBytes("a", sampleBytes(60, 3), { fingerprinter: async () => sampleFingerprint(6, 99) });
    const { container } = render(
      <LanguageProvider>
        <MyDocumentsView />
      </LanguageProvider>,
    );
    await screen.findByRole("heading", { name: en.documents.listLabel });
    expect(await screen.findByText(en.documents.statusStale)).toBeTruthy();
    expect(screen.queryByText(en.documents.statusReady)).toBeNull();
    expect(container.querySelector('[data-template-state="stale"] svg')).not.toBeNull();
    expect(screen.getByText(en.documents.staleHint)).toBeTruthy();
    expect(screen.getByRole("button", { name: fill(en.documents.reconfigureNamed, { name: "Contract A" }) })).toBeTruthy();
    expect(screen.getByRole("button", { name: fill(en.documents.keepTemplateNamed, { name: "Contract A" }) })).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toContain(es.documents.statusStale);
    expect(text).not.toMatch(/documents\.|\{n\}|\{name\}/);
  });

  it("los diccionarios ES y EN de «documents» tienen las mismas claves y los mismos marcadores", () => {
    expect(Object.keys(en.documents).sort()).toEqual(Object.keys(es.documents).sort());
    for (const key of Object.keys(es.documents) as (keyof typeof es.documents)[]) {
      expect(en.documents[key], key).toBeTruthy();
      // `backup` es un bloque anidado (U4.5): se compara su texto serializado (las claves anidadas, en `documentsBackup.test.ts`).
      const textOf = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
      for (const marker of ["{n}", "{name}", "{max}", "{used}", "{maxDocs}"]) {
        expect(textOf(en.documents[key]).includes(marker), `${key} ${marker}`).toBe(textOf(es.documents[key]).includes(marker));
      }
    }
  });
});
