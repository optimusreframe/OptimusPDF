import { describe, expect, it } from "vitest";
import { editedName, outputName, safeBaseName, stripExtension } from "@/lib/media/audio/names";
import { formatBytes, formatClock, formatDuration } from "@/lib/media/audio/format";
import { DECODED_BUDGET_BYTES, DECODED_BUDGET_LOW_MEMORY_BYTES, decodedBytes, isLowMemoryDevice, minutesThatFit } from "@/lib/media/audio/limits";
import { AudioError, toAudioError } from "@/lib/media/audio/errors";
import { describeAudioError, SHARED_STRINGS } from "@/lib/media/audio/ui/strings";

describe("nombres de salida", () => {
  it("cambia la extension; si el formato coincide con la entrada anade el sufijo para no confundir", () => {
    expect(outputName("cancion.mp3", "wav", "convertido", "audio")).toBe("cancion.wav");
    expect(outputName("cancion.wav", "wav", "convertido", "audio")).toBe("cancion-convertido.wav");
    expect(outputName("video.mp4", "m4a", "audio", "x")).toBe("video-audio.m4a");
    expect(outputName("voz.ogg", "opus", "convertido", "x")).toBe("voz-convertido.opus");
    expect(outputName("Informe final.v2.MP3", "opus", "c", "x")).toBe("Informe final.v2.opus");
  });
  it("limpia caracteres no validos y usa el nombre de reserva si no queda nada", () => {
    expect(safeBaseName('a/b\\c:d*e?"f<g>h|i.wav', "audio")).toBe("a-b-c-d-e--f-g-h-i");
    expect(safeBaseName("....wav", "audio")).toBe("audio");
    expect(safeBaseName("", "audio")).toBe("audio");
    expect(stripExtension("sin-extension")).toBe("sin-extension");
    expect(safeBaseName("x".repeat(300) + ".wav", "a")).toHaveLength(120);
  });
  it("lo exportado del estudio lleva siempre el sufijo", () => {
    expect(editedName("grabacion.mp3", "wav", "editado", "audio")).toBe("grabacion-editado.wav");
    expect(editedName("", "opus", "edited", "audio")).toBe("audio-edited.opus");
  });
});

describe("formato", () => {
  it("tamanos y relojes", () => {
    expect(formatBytes(0, "es-ES")).toBe("0 KB");
    expect(formatBytes(1536, "en-GB")).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024, "es-ES")).toBe("5,0 MB");
    expect(formatClock(75.4)).toBe("1:15.40");
    expect(formatClock(3723.456)).toBe("1:02:03.46");
    expect(formatClock(0.004)).toBe("0:00.00");
    expect(formatClock(-3)).toBe("0:00.00");
    expect(formatClock(75.4, false)).toBe("1:15");
    expect(formatDuration(12.5, "en-GB")).toBe("12.5 s");
    expect(formatDuration(185, "en-GB")).toBe("3 min 05 s");
    expect(formatDuration(3720, "en-GB")).toBe("1 h 02 min");
  });
});

describe("limites de memoria", () => {
  it("bytes decodificados y minutos que caben", () => {
    expect(decodedBytes(1, 44100, 2)).toBe(352800);
    expect(minutesThatFit(DECODED_BUDGET_BYTES)).toBe(50);
    expect(minutesThatFit(DECODED_BUDGET_LOW_MEMORY_BYTES)).toBe(19);
    expect(minutesThatFit(1)).toBe(1);
  });
  it("dispositivo con poca memoria: deviceMemory bajo, movil o iPad que se presenta como Mac", () => {
    const nav = (props: Record<string, unknown>) => props as unknown as Navigator;
    expect(isLowMemoryDevice(nav({ deviceMemory: 2, userAgent: "x" }))).toBe(true);
    expect(isLowMemoryDevice(nav({ deviceMemory: 8, userAgent: "Windows NT" }))).toBe(false);
    expect(isLowMemoryDevice(nav({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }))).toBe(true);
    expect(isLowMemoryDevice(nav({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", maxTouchPoints: 5 }))).toBe(true);
    expect(isLowMemoryDevice(nav({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", maxTouchPoints: 0 }))).toBe(false);
    expect(isLowMemoryDevice(undefined)).toBe(false);
  });
});

describe("errores", () => {
  it("toAudioError traduce lo que lanza el navegador", () => {
    expect(toAudioError(new AudioError("empty")).code).toBe("empty");
    expect(toAudioError(new DOMException("x", "AbortError")).code).toBe("cancelled");
    expect(toAudioError(new DOMException("x", "NotSupportedError")).code).toBe("unsupportedFormat");
    expect(toAudioError(new DOMException("x", "EncodingError")).code).toBe("corrupt");
    expect(toAudioError(new RangeError("Invalid array length")).code).toBe("outOfMemory");
    expect(toAudioError(new Error("Out of memory")).code).toBe("outOfMemory");
    expect(toAudioError(new Error("otra cosa")).code).toBe("unknown");
    expect(toAudioError("texto").code).toBe("unknown");
  });
  it("cada codigo tiene mensaje en ES y EN, y `tooLong` rellena los minutos", () => {
    for (const language of ["es", "en"] as const) {
      const strings = SHARED_STRINGS[language];
      for (const code of Object.keys(strings.errors) as Array<keyof typeof strings.errors>) {
        expect(describeAudioError(strings, code).message.length).toBeGreaterThan(5);
      }
      expect(describeAudioError(strings, "tooLong", "37").message).toContain("37");
      expect(describeAudioError(strings, "tooLong").message).not.toContain("{minutes}");
    }
  });
});
