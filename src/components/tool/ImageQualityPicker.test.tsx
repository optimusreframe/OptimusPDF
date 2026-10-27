import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageQualityPicker } from "@/components/tool/ImageQualityPicker";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { setIosWebkitOverride } from "@/lib/image/platform";
import type { PdfSizeEstimate } from "@/lib/image/estimatePdfSize";

const MB = 1024 * 1024;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => setIosWebkitOverride(null));

function estimate(overrides: Partial<PdfSizeEstimate> = {}): PdfSizeEstimate {
  return {
    photos: 39,
    sourceBytes: 348 * MB,
    optimizedBytes: 40 * MB,
    lowBytes: 40 * MB,
    highBytes: 40 * MB,
    uncertain: false,
    sampled: true,
    unoptimizedBytes: 348 * MB,
    maxPhotoPixels: 48_000_000,
    ...overrides,
  };
}

function renderPicker(props: Partial<Parameters<typeof ImageQualityPicker>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <LanguageProvider>
      <ImageQualityPicker value="balanced" onChange={onChange} estimate={estimate()} {...props} />
    </LanguageProvider>,
  );
  return { ...view, onChange };
}

const estimateText = (container: HTMLElement): string => container.querySelector("[data-image-quality-estimate]")?.textContent ?? "";

describe("ImageQualityPicker", () => {
  it("muestra las cuatro calidades como pestanas, con la elegida seleccionada", () => {
    renderPicker({ value: "high" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Original", "Alta", "Equilibrada", "Compacta"]);
    expect(screen.getByRole("tab", { name: "Alta" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Equilibrada" }).getAttribute("aria-selected")).toBe("false");
  });

  it("elegir una calidad avisa al padre", () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole("tab", { name: "Compacta" }));
    expect(onChange).toHaveBeenCalledWith("compact");
  });

  it("describe la calidad elegida: «Alta» para expediente/peritaje y «Compacta» que no sirve como evidencia", () => {
    const { container, rerender, onChange } = renderPicker({ value: "high" });
    const description = (): string => container.querySelector("[data-image-quality-description]")?.textContent ?? "";
    expect(description()).toContain("expediente o peritaje");
    expect(description()).toContain("detalle al ampliar");
    rerender(
      <LanguageProvider>
        <ImageQualityPicker value="compact" onChange={onChange} estimate={estimate()} />
      </LanguageProvider>,
    );
    expect(description()).toContain("no sirve como evidencia");
  });

  it("estimacion: un numero cuando se conoce bien, un rango «≈ a-b» cuando la incertidumbre es alta, «Calculando…» sin estimacion", () => {
    const point = renderPicker();
    expect(estimateText(point.container)).toBe("Tamaño estimado del PDF: ≈ 40,0 MB frente a ≈ 348 MB sin optimizar.");
    point.unmount();

    const range = renderPicker({ estimate: estimate({ uncertain: true, lowBytes: 35 * MB, highBytes: 45 * MB }) });
    expect(estimateText(range.container)).toBe("Tamaño estimado del PDF: ≈ 35,0-45,0 MB frente a ≈ 348 MB sin optimizar.");
    range.unmount();

    const waiting = renderPicker({ estimate: null });
    expect(estimateText(waiting.container)).toBe("Calculando el tamaño estimado…");
    waiting.unmount();

    const original = renderPicker({ value: "original", estimate: estimate({ optimizedBytes: 348 * MB, lowBytes: 348 * MB, highBytes: 348 * MB }) });
    expect(estimateText(original.container)).toBe("Tamaño estimado del PDF: ≈ 348 MB (lo que pesan tus fotos).");
  });

  it("la estimacion y los avisos viven en UNA region viva (role=status, aria-live=polite) y se leen a 14 px o mas", () => {
    setIosWebkitOverride(false);
    const { container } = renderPicker({ estimate: estimate({ optimizedBytes: 60 * MB, lowBytes: 60 * MB, highBytes: 60 * MB }) });
    const live = container.querySelectorAll('[role="status"]');
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute("aria-live")).toBe("polite");
    expect(live[0].contains(container.querySelector("[data-image-quality-estimate]"))).toBe(true);
    expect(live[0].contains(container.querySelector("[data-image-quality-warning]"))).toBe(true);
    // Ningun texto de ayuda a 12 px (`text-xs`): descripcion, estimacion, avisos y nota.
    expect(container.querySelectorAll(".text-xs")).toHaveLength(0);
    for (const element of container.querySelectorAll("p")) expect(element.className).toContain("text-sm");
  });

  it("aviso PREVIO de correo (> 20 MB) y de WhatsApp (> 100 MB), antes de generar", () => {
    setIosWebkitOverride(false);
    const none = renderPicker({ estimate: estimate({ optimizedBytes: 18 * MB, lowBytes: 18 * MB, highBytes: 18 * MB }) });
    expect(none.container.querySelector("[data-image-quality-warning]")).toBeNull();
    none.unmount();
    const mail = renderPicker({ estimate: estimate({ optimizedBytes: 25 * MB, lowBytes: 25 * MB, highBytes: 25 * MB }) });
    expect(mail.container.querySelector('[data-image-quality-warning="mail"]')?.textContent).toContain("~20 MB");
    mail.unmount();
    const huge = renderPicker({ estimate: estimate({ optimizedBytes: 130 * MB, lowBytes: 130 * MB, highBytes: 130 * MB }) });
    expect(huge.container.querySelector('[data-image-quality-warning="huge"]')?.textContent).toContain("~100 MB");
    expect(huge.container.querySelector('[data-image-quality-warning="mail"]')).toBeNull();
  });

  it("«Original» con mas de 120 MB de fotos en iPhone/iPad avisa del riesgo de memoria y sugiere otra calidad", () => {
    const big = estimate({ sourceBytes: 348 * MB, optimizedBytes: 348 * MB, lowBytes: 348 * MB, highBytes: 348 * MB });
    setIosWebkitOverride(true);
    const ios = renderPicker({ value: "original", estimate: big });
    expect(ios.container.querySelector('[data-image-quality-warning="memory"]')?.textContent).toMatch(/memoria.*«Alta» o «Equilibrada»/);
    ios.unmount();
    setIosWebkitOverride(false);
    const desktop = renderPicker({ value: "original", estimate: big });
    expect(desktop.container.querySelector('[data-image-quality-warning="memory"]')).toBeNull();
    desktop.unmount();
    setIosWebkitOverride(true);
    const small = renderPicker({ value: "original", estimate: estimate({ sourceBytes: 90 * MB, optimizedBytes: 90 * MB, lowBytes: 90 * MB, highBytes: 90 * MB }) });
    expect(small.container.querySelector('[data-image-quality-warning="memory"]')).toBeNull();
  });

  it("con fotos de mas de 12 Mpx, «Alta conserva mas detalle al ampliar (≈ X MB)» salvo con «Alta» u «Original»", () => {
    const withLine = renderPicker({ highDetailBytes: 114 * MB });
    expect(withLine.container.querySelector("[data-image-quality-high-detail]")?.textContent).toBe("«Alta» conserva más detalle al ampliar (≈ 114 MB).");
    withLine.unmount();
    expect(renderPicker({ highDetailBytes: null }).container.querySelector("[data-image-quality-high-detail]")).toBeNull();
    expect(renderPicker({ value: "high", highDetailBytes: 114 * MB }).container.querySelector("[data-image-quality-high-detail]")).toBeNull();
    expect(renderPicker({ value: "original", highDetailBytes: 114 * MB }).container.querySelector("[data-image-quality-high-detail]")).toBeNull();
  });

  it("dice que los originales no se tocan y, al optimizar, que se usa sRGB (Display P3 puede verse algo mas apagado)", () => {
    const optimized = renderPicker();
    expect(optimized.container.textContent).toContain("Tus archivos originales no se modifican.");
    expect(optimized.container.textContent).toContain("sRGB");
    expect(optimized.container.textContent).toContain("Display P3");
    optimized.unmount();
    const original = renderPicker({ value: "original" });
    expect(original.container.textContent).toContain("Tus archivos originales no se modifican.");
    expect(original.container.textContent).not.toContain("sRGB");
  });
});
