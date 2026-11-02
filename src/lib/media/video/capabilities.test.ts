import { describe, expect, it } from "vitest";
import { browserCodecEnv, canEncodeVideoAt, detectCapabilities, type CodecEnv } from "@/lib/media/video/capabilities";

/** `VideoEncoder`/`AudioEncoder` simulados: aceptan solo los codecs que se les indica (por prefijo, como los de WebCodecs). */
function fakeEnv(video: string[], audio: string[], extra: Partial<CodecEnv> = {}): CodecEnv {
  const accepts = (list: string[], codec: string) => list.some((prefix) => codec.startsWith(prefix));
  return {
    isSecureContext: true,
    VideoDecoder: class {},
    VideoEncoder: { isConfigSupported: async (config) => ({ supported: accepts(video, config.codec) }) },
    AudioEncoder: { isConfigSupported: async (config) => ({ supported: accepts(audio, config.codec) }) },
    ...extra,
  };
}

describe("detectCapabilities", () => {
  it("Chrome de escritorio: MP4 (H.264 + AAC) y WebM (VP9 + Opus)", async () => {
    const caps = await detectCapabilities(fakeEnv(["avc1", "vp09", "vp8"], ["mp4a", "opus"]));
    expect(caps.supported).toBe(true);
    expect(caps.formats.mp4).toMatchObject({ available: true, videoCodecs: ["avc"], audioEncodable: true });
    expect(caps.formats.webm).toMatchObject({ available: true, videoCodecs: ["vp9", "vp8"], audioEncodable: true });
  });

  it("un navegador sin H.264 ofrece solo WebM y dice por que no hay MP4", async () => {
    const caps = await detectCapabilities(fakeEnv(["vp09"], ["opus"]));
    expect(caps.supported).toBe(true);
    expect(caps.formats.mp4).toMatchObject({ available: false, reason: "no-video-encoder", videoCodecs: [] });
    expect(caps.formats.webm).toMatchObject({ available: true, videoCodecs: ["vp9"] });
  });

  it("Safari antiguo: hay video pero no codificador de audio (el audio solo podra pasar tal cual)", async () => {
    const caps = await detectCapabilities(fakeEnv(["avc1", "vp09"], [], { AudioEncoder: undefined }));
    expect(caps.formats.mp4).toMatchObject({ available: true, audioEncodable: false });
    expect(caps.formats.webm).toMatchObject({ available: true, audioEncodable: false });
  });

  it("sin VideoEncoder no hay conversion, con el motivo", async () => {
    const caps = await detectCapabilities({ isSecureContext: true });
    expect(caps).toMatchObject({ supported: false, reason: "no-video-encoder" });
    expect(Object.values(caps.formats).every((format) => !format.available)).toBe(true);
  });

  it("pagina no segura (http fuera de localhost): WebCodecs no existe ahi, y se explica como tal", async () => {
    const caps = await detectCapabilities(fakeEnv(["avc1"], ["mp4a"], { isSecureContext: false }));
    expect(caps).toMatchObject({ supported: false, reason: "insecure-context" });
  });

  it("sin decodificador de video tampoco", async () => {
    const caps = await detectCapabilities(fakeEnv(["avc1"], ["mp4a"], { VideoDecoder: undefined }));
    expect(caps).toMatchObject({ supported: false, reason: "no-video-decoder" });
  });

  it("WebCodecs presente pero ningun codec codificable = no soportado", async () => {
    const caps = await detectCapabilities(fakeEnv([], []));
    expect(caps).toMatchObject({ supported: false, reason: "no-video-encoder" });
  });

  it("un codec que el navegador rechaza lanzando un error cuenta como «no», sin romper la deteccion", async () => {
    const env = fakeEnv([], ["mp4a", "opus"]);
    env.VideoEncoder = {
      isConfigSupported: async (config) => {
        if (config.codec.startsWith("avc1")) throw new TypeError("codec no valido");
        return { supported: config.codec === "vp8" };
      },
    };
    const caps = await detectCapabilities(env);
    expect(caps.formats.mp4.available).toBe(false);
    expect(caps.formats.webm).toMatchObject({ available: true, videoCodecs: ["vp8"] });
  });

  it("prueba varias cadenas de H.264 (alto, principal, base) y basta con una", async () => {
    const seen: string[] = [];
    const env = fakeEnv([], ["mp4a"]);
    env.VideoEncoder = {
      isConfigSupported: async (config) => {
        seen.push(config.codec);
        return { supported: config.codec === "avc1.42001f" };
      },
    };
    const caps = await detectCapabilities(env);
    expect(caps.formats.mp4.available).toBe(true);
    expect(seen.filter((codec) => codec.startsWith("avc1"))).toEqual(["avc1.640028", "avc1.4d0028", "avc1.42001f"]);
  });
});

describe("canEncodeVideoAt", () => {
  it("pregunta con las medidas REALES del resultado (4K puede no existir aunque 720p si)", async () => {
    const env = fakeEnv([], []);
    env.VideoEncoder = { isConfigSupported: async (config) => ({ supported: config.width <= 1920 && config.codec.startsWith("avc1") }) };
    expect(await canEncodeVideoAt(env, "avc", { width: 1920, height: 1080, bitrate: 5e6, framerate: 30 })).toBe(true);
    expect(await canEncodeVideoAt(env, "avc", { width: 3840, height: 2160, bitrate: 2e7, framerate: 30 })).toBe(false);
  });

  it("sin VideoEncoder no bloquea (no se puede saber)", async () => {
    expect(await canEncodeVideoAt({}, "avc", { width: 3840, height: 2160, bitrate: 2e7, framerate: 30 })).toBe(true);
  });
});

describe("browserCodecEnv", () => {
  it("lee globalThis sin lanzar aunque no haya WebCodecs (Node)", () => {
    expect(() => browserCodecEnv()).not.toThrow();
  });
});
