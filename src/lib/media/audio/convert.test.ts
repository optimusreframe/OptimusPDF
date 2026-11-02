import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { convertBatch, convertOne } from "@/lib/media/audio/convert";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { silentVideoMp4, stereoSine } from "@/lib/media/audio/testAudio";
import { DEFAULT_ENCODE_OPTIONS } from "@/lib/media/audio/types";
import { decodeWav, encodeWav } from "@/lib/media/audio/wav";

const context = { suffix: "convertido", fallbackName: "audio", zipName: "audios-convertidos" };

async function wavFile(name: string, seconds = 0.5, rate = 22050): Promise<File> {
  const blob = await encodeWav(sourceOfAudio(stereoSine(440, 880, seconds, rate)));
  return new File([await blob.arrayBuffer()], name, { type: "audio/wav" });
}

describe("convertOne", () => {
  it("convierte un WAV a WAV con otra frecuencia y devuelve tamano antes/despues y duracion", async () => {
    const file = await wavFile("cancion.wav", 1, 44100);
    const { blob, item } = await convertOne(file, { ...DEFAULT_ENCODE_OPTIONS, sampleRate: 8000, channels: 1 }, context);
    expect(item.inputName).toBe("cancion.wav");
    expect(item.outputName).toBe("cancion-convertido.wav");
    expect(item.inputBytes).toBe(file.size);
    expect(item.outputBytes).toBe(blob.size);
    expect(item.durationSec).toBeCloseTo(1, 3);
    expect(blob.size).toBeLessThan(file.size / 5);
    expect(decodeWav(new Uint8Array(await blob.arrayBuffer())).sampleRate).toBe(8000);
  });

  it("el progreso va de 0 a 1 sin retroceder", async () => {
    const seen: number[] = [];
    await convertOne(await wavFile("a.wav", 3), DEFAULT_ENCODE_OPTIONS, { ...context, onProgress: (v) => seen.push(v) });
    expect(seen[seen.length - 1]).toBeCloseTo(1, 5);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1e-9)).toBe(true);
  });
});

describe("convertBatch", () => {
  it("un archivo: devuelve el audio solo, sin ZIP", async () => {
    const outcome = await convertBatch([await wavFile("uno.wav")], DEFAULT_ENCODE_OPTIONS, context);
    expect(outcome.zipped).toBe(false);
    expect(outcome.filename).toBe("uno-convertido.wav");
    expect(outcome.failed).toEqual([]);
    expect(outcome.items).toHaveLength(1);
  });

  it("varios: un ZIP con todos, nombres unicos aunque se repitan, y tamano de cada uno", async () => {
    const files = [await wavFile("a.wav"), await wavFile("a.wav", 1), await wavFile("b.wav")];
    const outcome = await convertBatch(files, DEFAULT_ENCODE_OPTIONS, context);
    expect(outcome.zipped).toBe(true);
    expect(outcome.filename).toBe("audios-convertidos.zip");
    const zip = await JSZip.loadAsync(await outcome.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["a-convertido (1).wav", "a-convertido.wav", "b-convertido.wav"]);
    expect(outcome.items.map((item) => item.outputName).sort()).toEqual(Object.keys(zip.files).sort());
    expect(outcome.items.every((item) => item.outputBytes > 44 && item.inputBytes > 44)).toBe(true);
  });

  it("fallo parcial: los buenos van en el ZIP y el malo se informa con su motivo, sin tirar el lote", async () => {
    const bad = new File([new TextEncoder().encode("esto no es audio")], "roto.mp3", { type: "audio/mpeg" });
    const mute = new File([silentVideoMp4() as BlobPart], "mudo.mp4", { type: "video/mp4" });
    const outcome = await convertBatch([await wavFile("a.wav"), bad, mute, await wavFile("b.wav")], DEFAULT_ENCODE_OPTIONS, context);
    expect(outcome.items.map((item) => item.inputName)).toEqual(["a.wav", "b.wav"]);
    expect(outcome.failed.map((f) => [f.inputName, f.code])).toEqual([
      ["roto.mp3", expect.stringMatching(/corrupt|unsupportedFormat/)],
      ["mudo.mp4", "noAudioTrack"],
    ]);
  });

  it("si TODOS fallan, lanza el error del primero (para mostrar su motivo)", async () => {
    const mute = new File([silentVideoMp4() as BlobPart], "mudo.mp4", { type: "video/mp4" });
    await expect(convertBatch([mute], DEFAULT_ENCODE_OPTIONS, context)).rejects.toMatchObject({ code: "noAudioTrack" });
    await expect(convertBatch([], DEFAULT_ENCODE_OPTIONS, context)).rejects.toMatchObject({ code: "empty" });
  });

  it("cancelar corta el lote entero (no lo cuenta como fallo de un archivo)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(convertBatch([await wavFile("a.wav")], DEFAULT_ENCODE_OPTIONS, { ...context, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("mas de 50 archivos: `tooLarge`", async () => {
    const many = Array.from({ length: 51 }, (_, i) => new File([new Uint8Array(1)], `${i}.wav`));
    await expect(convertBatch(many, DEFAULT_ENCODE_OPTIONS, context)).rejects.toMatchObject({ code: "tooLarge" });
  });
});
