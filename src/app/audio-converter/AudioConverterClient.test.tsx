import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { AudioError } from "@/lib/media/audio/errors";
import type { ConvertOutcome } from "@/lib/media/audio/convert";
import type { FileCheck } from "@/lib/media/audio/decode";
import { AudioConverterClient } from "@/app/audio-converter/AudioConverterClient";
import { AudioExtractorClient } from "@/app/audio-extractor/AudioExtractorClient";

/**
 * Marco de «Convertidor de audio» y «Extraer audio»: la comprobacion de cada archivo y la conversion se sustituyen para
 * ver SOLO la interfaz (los motores tienen sus propias pruebas con audio sintetico y el E2E usa codecs reales).
 */

const checkMediaFile = vi.fn<(file: File) => Promise<FileCheck>>();
const convertBatch = vi.fn();
vi.mock("@/lib/media/audio/decode", () => ({ checkMediaFile: (file: File) => checkMediaFile(file), decodeMedia: vi.fn() }));
vi.mock("@/lib/media/audio/convert", () => ({ convertBatch: (...args: unknown[]) => convertBatch(...args) }));

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));
beforeEach(() => {
  checkMediaFile.mockImplementation(async () => ({ ok: true, probe: { kind: "wav", durationSec: 125 } }));
});
afterEach(() => {
  cleanup();
  checkMediaFile.mockReset();
  convertBatch.mockReset();
});

function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

const file = (name: string, type = "audio/wav", size = 2048) => new File([new Uint8Array(size)], name, { type });
const outcome = (patch: Partial<ConvertOutcome> = {}): ConvertOutcome => ({
  blob: new Blob([new Uint8Array(1000)]),
  filename: "uno-convertido.wav",
  zipped: false,
  items: [{ inputName: "uno.wav", outputName: "uno-convertido.wav", inputBytes: 2048, outputBytes: 1000, durationSec: 125 }],
  failed: [],
  ...patch,
});

async function addFiles(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  await screen.findAllByText(files[0].name);
}
const runButtons = () => screen.getAllByRole("button", { name: "Procesar" });
const clickRun = async () => {
  await waitFor(() => expect((runButtons()[0] as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(runButtons()[0]);
};

describe("Convertidor de audio: archivos", () => {
  it("al entrar muestra la zona de carga con los formatos y el tope REAL (no el de PDF), y la nota de privacidad", () => {
    render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Convertidor de audio" })).toBeTruthy();
    expect(screen.getByText(/Acepta \.mp3, \.wav, \.m4a.*hasta 300 MB por archivo/)).toBeTruthy();
    expect(screen.getByText("Todo ocurre en tu dispositivo")).toBeTruthy();
  });

  it("cada archivo se comprueba al subirlo: muestra peso y duracion; uno con problema se explica y no bloquea a los demas", async () => {
    checkMediaFile.mockImplementation(async (f) =>
      f.name === "largo.mp3" ? { ok: false, code: "tooLong", detail: "50" } : { ok: true, probe: { kind: "wav", durationSec: 125 } },
    );
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"), file("largo.mp3", "audio/mpeg", 5000));
    expect(await screen.findByText(/2,0 KB · 2 min 05 s/)).toBeTruthy();
    expect(await screen.findByText(/demasiado largo.*unos 50 minutos/)).toBeTruthy();
    await waitFor(() => expect((runButtons()[0] as HTMLButtonElement).disabled).toBe(false));
  });

  it("si ninguno se puede usar, «Procesar» queda desactivado y dice por que", async () => {
    checkMediaFile.mockImplementation(async () => ({ ok: false, code: "unsupportedFormat" }));
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("raro.mp3", "audio/mpeg"));
    await waitFor(() => expect((runButtons()[0] as HTMLButtonElement).disabled).toBe(true));
    expect(document.querySelector("[data-run-reason]")?.textContent).toMatch(/al menos un audio que se pueda convertir/);
  });

  it("lo que no es audio se avisa por nombre; quitar un archivo lo saca de la lista", async () => {
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"), file("foto.png", "image/png"));
    expect(screen.getByText(/No se añadieron porque no son audio: foto\.png/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar uno.wav" }));
    expect(screen.queryByText("uno.wav")).toBeNull();
    expect(screen.getByRole("heading", { name: "Suelta tus audios aquí" })).toBeTruthy();
  });
});

describe("Convertidor de audio: conversion", () => {
  it("convierte con las opciones elegidas, muestra el progreso y la pantalla de resultado con tamano antes y despues", async () => {
    convertBatch.mockImplementation(async (files: File[], options: unknown, context: { onProgress: (v: number) => void }) => {
      context.onProgress(0.5);
      return outcome();
    });
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"));
    await clickRun();
    await screen.findByRole("button", { name: "Descargar" });
    expect(convertBatch).toHaveBeenCalledTimes(1);
    expect(convertBatch.mock.calls[0][1]).toMatchObject({ format: "wav", sampleRate: "original", channels: "original" });
    expect(screen.getByText("1 audio convertido.")).toBeTruthy();
    // El nombre sale en el resultado y en la lista de «tamano antes y despues».
    expect(screen.getAllByText("uno-convertido.wav").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2,0 KB → 1000 B")).toBeTruthy();
  });

  it("informe de fallos parciales: lista cada archivo que fallo con su motivo, junto al ZIP de los buenos", async () => {
    convertBatch.mockResolvedValue(
      outcome({ filename: "audios-convertidos.zip", zipped: true, failed: [{ inputName: "roto.mp3", code: "unsupportedFormat" }] }),
    );
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"), file("roto.mp3", "audio/mpeg"));
    await clickRun();
    const report = await screen.findByTestId("audio-failure-report");
    expect(within(report).getByText("No se pudo convertir")).toBeTruthy();
    expect(within(report).getByText("roto.mp3")).toBeTruthy();
    expect(report.textContent).toMatch(/Este navegador no puede leer este archivo/);
  });

  it("un error del motor sale en un aviso con su explicacion (no «Algo ha fallado») y los archivos siguen ahi", async () => {
    convertBatch.mockRejectedValue(new AudioError("encoderUnavailable", "m4a"));
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"));
    await clickRun();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Tu navegador no puede crear el formato elegido/);
    expect(screen.getAllByText("uno.wav").length).toBeGreaterThan(0);
  });

  it("cancelar durante el proceso vuelve a la lista con un aviso neutro y aborta el trabajo", async () => {
    let signal: AbortSignal | undefined;
    convertBatch.mockImplementation((_files: File[], _options: unknown, context: { signal: AbortSignal }) => {
      signal = context.signal;
      return new Promise(() => {});
    });
    const { container } = render(<LanguageProvider><AudioConverterClient /></LanguageProvider>);
    await addFiles(container, file("uno.wav"));
    await clickRun();
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await screen.findByText("Proceso cancelado.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Extraer audio", () => {
  it("admite un solo video; un video sin pista de audio se explica y no se puede procesar", async () => {
    checkMediaFile.mockImplementation(async () => ({ ok: false, code: "noAudioTrack" }));
    const { container } = render(<LanguageProvider><AudioExtractorClient /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Extraer audio de un video" })).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(false);
    expect(screen.getByText(/hasta 2,0 GB/)).toBeTruthy();
    await addFiles(container, file("clip.mp4", "video/mp4"));
    expect(await screen.findByText(/no tiene pista de audio/)).toBeTruthy();
    await waitFor(() => expect((runButtons()[0] as HTMLButtonElement).disabled).toBe(true));
  });

  it("extrae y ofrece la descarga; una foto o un audio no se admiten", async () => {
    convertBatch.mockResolvedValue(outcome({ filename: "clip-audio.m4a" }));
    const { container } = render(<LanguageProvider><AudioExtractorClient /></LanguageProvider>);
    await addFiles(container, file("clip.mp4", "video/mp4"), file("cancion.mp3", "audio/mpeg"));
    expect(screen.getByText(/No se añadió porque no es un video: cancion\.mp3/)).toBeTruthy();
    await clickRun();
    await screen.findByRole("button", { name: "Descargar" });
    expect(screen.getByText("Audio extraído del video.")).toBeTruthy();
  });
});

describe("Ingles", () => {
  it("los textos del convertidor salen en ingles", async () => {
    const { container } = render(<LanguageProvider><UseLanguage language="en" /><AudioConverterClient /></LanguageProvider>);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Audio Converter" })).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Drop your audio files here" })).toBeTruthy();
    await addFiles(container, file("one.wav"));
    expect(screen.getAllByRole("button", { name: "Process" }).length).toBeGreaterThan(0);
  });
});
