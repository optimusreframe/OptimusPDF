import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { OutputSupport } from "@/lib/media/audio/capabilities";
import { DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from "@/lib/media/audio/types";
import { OutputOptions } from "@/lib/media/audio/ui/OutputOptions";
import { SHARED_STRINGS } from "@/lib/media/audio/ui/strings";

afterEach(cleanup);

const all: OutputSupport = { wav: { available: true }, m4a: { available: true }, opus: { available: true }, mp3: { available: false, reason: "license" } };
const noCodecs: OutputSupport = { ...all, m4a: { available: false, reason: "codecUnsupported" }, opus: { available: false, reason: "noWebCodecs" } };

function setup(value: Partial<EncodeOptions> = {}, support: OutputSupport | null = all, language: "es" | "en" = "es") {
  const onChange = vi.fn();
  render(<OutputOptions value={{ ...DEFAULT_ENCODE_OPTIONS, ...value }} onChange={onChange} support={support} strings={SHARED_STRINGS[language]} idPrefix="t" />);
  return onChange;
}

describe("OutputOptions: formatos", () => {
  it("ofrece WAV, M4A, Opus y MP3; MP3 va SIEMPRE desactivado y con el motivo de la licencia visible y asociado", () => {
    const onChange = setup();
    const mp3 = screen.getByRole("radio", { name: /MP3/ });
    expect(mp3.getAttribute("aria-disabled")).toBe("true");
    expect(mp3.getAttribute("aria-checked")).toBe("false");
    const reasonId = mp3.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId as string)?.textContent).toMatch(/LGPL/);
    fireEvent.click(mp3);
    expect(onChange).not.toHaveBeenCalled();
    // Sigue siendo alcanzable con el teclado (no es `disabled`).
    expect((mp3 as HTMLButtonElement).disabled).toBe(false);
  });

  it("elegir M4A u Opus cambia el formato y ajusta la tasa de bits por defecto", () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole("radio", { name: /M4A/ }));
    expect(onChange).toHaveBeenLastCalledWith({ format: "m4a", bitrateKbps: 128 });
    fireEvent.click(screen.getByRole("radio", { name: /Opus/ }));
    expect(onChange).toHaveBeenLastCalledWith({ format: "opus", bitrateKbps: 96 });
  });

  it("si el navegador no puede crear M4A/Opus se muestran desactivados con su motivo, y no se pueden elegir", () => {
    const onChange = setup({}, noCodecs);
    const m4a = screen.getByRole("radio", { name: /M4A/ });
    const opus = screen.getByRole("radio", { name: /Opus/ });
    expect(m4a.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(m4a.getAttribute("aria-describedby") as string)?.textContent).toMatch(/no sabe crear/);
    expect(document.getElementById(opus.getAttribute("aria-describedby") as string)?.textContent).toMatch(/WebCodecs/);
    fireEvent.click(m4a);
    fireEvent.click(opus);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /WAV/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("mientras se comprueba el navegador, solo WAV esta disponible y se avisa", () => {
    setup({}, null);
    expect(screen.getByRole("status").textContent).toMatch(/Comprobando/);
    expect(screen.getByRole("radio", { name: /M4A/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("radio", { name: /WAV/ }).getAttribute("aria-disabled")).toBe("false");
  });

  it("en ingles, los textos y el motivo salen en ingles", () => {
    setup({}, all, "en");
    expect(screen.getByText("Output format")).toBeTruthy();
    expect(document.body.textContent).toMatch(/we cannot bundle/);
  });
});

describe("OutputOptions: calidad, frecuencia y canales", () => {
  it("WAV no muestra tasa de bits; M4A y Opus si, con sus valores", () => {
    setup({ format: "wav" });
    expect(screen.queryByLabelText("Calidad (tasa de bits)")).toBeNull();
    cleanup();
    setup({ format: "m4a", bitrateKbps: 192 });
    const select = screen.getByLabelText("Calidad (tasa de bits)") as HTMLSelectElement;
    expect(select.value).toBe("192");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["64", "96", "128", "160", "192", "256", "320"]);
    cleanup();
    setup({ format: "opus", bitrateKbps: 96 });
    expect(Array.from((screen.getByLabelText("Calidad (tasa de bits)") as HTMLSelectElement).options).map((o) => o.value)).toContain("32");
  });

  it("frecuencia: `original` y las habituales; con Opus queda fija en 48 kHz y se explica", () => {
    const onChange = setup({});
    const select = screen.getByLabelText("Frecuencia de muestreo") as HTMLSelectElement;
    expect(select.value).toBe("original");
    fireEvent.change(select, { target: { value: "22050" } });
    expect(onChange).toHaveBeenLastCalledWith({ sampleRate: 22050 });
    fireEvent.change(select, { target: { value: "original" } });
    expect(onChange).toHaveBeenLastCalledWith({ sampleRate: "original" });
    cleanup();
    setup({ format: "opus" });
    const fixed = screen.getByLabelText("Frecuencia de muestreo") as HTMLSelectElement;
    expect(fixed.disabled).toBe(true);
    expect(fixed.value).toBe("48000");
    expect(screen.getByText("Opus siempre se crea a 48 kHz.")).toBeTruthy();
  });

  it("canales: igual que el original / mono / estereo", () => {
    const onChange = setup({});
    const group = screen.getByRole("radiogroup", { name: "Canales" });
    expect(within(group).getByRole("radio", { name: "Igual que el original" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Mono" }));
    expect(onChange).toHaveBeenLastCalledWith({ channels: 1 });
    fireEvent.click(within(group).getByRole("radio", { name: "Estéreo" }));
    expect(onChange).toHaveBeenLastCalledWith({ channels: 2 });
    fireEvent.click(within(group).getByRole("radio", { name: "Igual que el original" }));
    expect(onChange).toHaveBeenLastCalledWith({ channels: "original" });
  });
});
