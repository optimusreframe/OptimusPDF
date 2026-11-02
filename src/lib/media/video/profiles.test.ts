import { describe, expect, it } from "vitest";
import { MAX_VIDEO_BITRATE, MIN_VIDEO_BITRATE, audioBitrate, encodeProfileOf, videoBitrate } from "@/lib/media/video/profiles";

const base = { codec: "avc", width: 1920, height: 1080, fps: 30 } as const;

describe("videoBitrate", () => {
  it("1080p30 H.264: alta > equilibrada > pequena, con cifras de uso real (Mbps)", () => {
    const high = videoBitrate({ ...base, profile: "high" });
    const balanced = videoBitrate({ ...base, profile: "balanced" });
    const small = videoBitrate({ ...base, profile: "small" });
    expect(high).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(small);
    expect(balanced).toBeGreaterThan(3_000_000);
    expect(balanced).toBeLessThan(6_000_000);
  });

  it("baja con la resolucion y con los fotogramas por segundo", () => {
    const full = videoBitrate({ ...base, profile: "balanced" });
    expect(videoBitrate({ ...base, width: 1280, height: 720, profile: "balanced" })).toBeLessThan(full / 2);
    expect(videoBitrate({ ...base, fps: 15, profile: "balanced" })).toBeLessThan(full);
    // 60 fps cuesta mas que 30, pero menos del doble.
    const sixty = videoBitrate({ ...base, fps: 60, profile: "balanced" });
    expect(sixty).toBeGreaterThan(full);
    expect(sixty).toBeLessThan(full * 2);
  });

  it("VP9 necesita menos que H.264 para el mismo perfil", () => {
    expect(videoBitrate({ ...base, codec: "vp9", profile: "balanced" })).toBeLessThan(videoBitrate({ ...base, profile: "balanced" }));
  });

  it("«Conservar» recodifica con el perfil alto", () => {
    expect(encodeProfileOf("keep")).toBe("high");
    expect(videoBitrate({ ...base, profile: "keep" })).toBe(videoBitrate({ ...base, profile: "high" }));
  });

  it("respeta un minimo y un maximo", () => {
    expect(videoBitrate({ ...base, width: 64, height: 64, fps: 1, profile: "small" })).toBe(MIN_VIDEO_BITRATE);
    expect(videoBitrate({ ...base, width: 15360, height: 8640, fps: 120, profile: "high" })).toBe(MAX_VIDEO_BITRATE);
  });

  it("no pide mas de lo que tenia el original (un video ya muy comprimido no engorda)", () => {
    const capped = videoBitrate({ ...base, profile: "high", source: { codec: "avc", bitrate: 2_000_000, width: 1920, height: 1080 } });
    expect(capped).toBeLessThanOrEqual(2_300_000);
    const free = videoBitrate({ ...base, profile: "high", source: { codec: "avc", bitrate: 30_000_000, width: 1920, height: 1080 } });
    expect(free).toBe(videoBitrate({ ...base, profile: "high" }));
  });

  it("de HEVC a H.264 deja mas margen que de H.264 a H.264 (HEVC rinde mas por bit)", () => {
    const fromHevc = videoBitrate({ ...base, profile: "high", source: { codec: "hevc", bitrate: 5_000_000, width: 1920, height: 1080 } });
    const fromAvc = videoBitrate({ ...base, profile: "high", source: { codec: "avc", bitrate: 5_000_000, width: 1920, height: 1080 } });
    expect(fromHevc).toBeGreaterThan(fromAvc);
  });

  it("un codec de origen desconocido o sin perdida (ProRes) no limita", () => {
    const prores = videoBitrate({ ...base, profile: "high", source: { codec: "prores", bitrate: 100_000_000, width: 1920, height: 1080 } });
    expect(prores).toBe(videoBitrate({ ...base, profile: "high" }));
  });

  it("al reducir la resolucion el tope del original se reparte por pixeles", () => {
    const small = videoBitrate({ ...base, width: 1280, height: 720, profile: "high", source: { codec: "avc", bitrate: 1_800_000, width: 1920, height: 1080 } });
    expect(small).toBeLessThanOrEqual(1_000_000);
  });
});

describe("audioBitrate", () => {
  it("estereo por perfil y mono al ~60 %", () => {
    expect(audioBitrate("balanced", "aac", 2)).toBe(128_000);
    expect(audioBitrate("high", "opus", 2)).toBe(160_000);
    expect(audioBitrate("small", "aac", 2)).toBeLessThan(audioBitrate("high", "aac", 2));
    expect(audioBitrate("balanced", "aac", 1)).toBeLessThan(128_000);
    expect(audioBitrate("balanced", "aac", 1)).toBeGreaterThan(48_000);
  });
});
