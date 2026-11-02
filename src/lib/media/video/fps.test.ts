import { describe, expect, it } from "vitest";
import { ASSUMED_FPS, availableFps, planFps } from "@/lib/media/video/fps";

describe("planFps", () => {
  it("«original» no pide ningun tope", () => {
    expect(planFps(60, "original")).toEqual({ cap: null, output: 60 });
  });

  it("baja de verdad un video de 60 fps a 30", () => {
    expect(planFps(60, "30")).toEqual({ cap: 30, output: 30 });
  });

  it("no recodifica por 29,97 fps contra un tope de 30, ni sube un video de 24 a 30", () => {
    expect(planFps(29.97, "30")).toEqual({ cap: null, output: 29.97 });
    expect(planFps(24, "30")).toEqual({ cap: null, output: 24 });
  });

  it("sin dato de fps no pide tope (no se puede saber si hace falta) y estima con 30", () => {
    expect(planFps(null, "15")).toEqual({ cap: null, output: ASSUMED_FPS });
  });
});

describe("availableFps", () => {
  it("solo ofrece topes por debajo del ritmo del original", () => {
    expect(availableFps(60)).toEqual(["original", "30", "24", "15"]);
    expect(availableFps(30)).toEqual(["original", "24", "15"]);
    expect(availableFps(29.97)).toEqual(["original", "24", "15"]);
    expect(availableFps(12)).toEqual(["original"]);
    expect(availableFps(null)).toEqual(["original"]);
  });
});
