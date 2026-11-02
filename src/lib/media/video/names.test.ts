import { describe, expect, it } from "vitest";
import { outputFileName, stripVideoExtension } from "@/lib/media/video/names";

describe("outputFileName", () => {
  it("cambia la extension y anade el sufijo", () => {
    expect(outputFileName("Vacaciones 2024.MOV", "mp4", "convertido")).toBe("Vacaciones 2024-convertido.mp4");
    expect(outputFileName("clip.mp4", "webm", "converted")).toBe("clip-converted.webm");
  });

  it("MP4 a MP4 no pisa el original", () => {
    expect(outputFileName("clip.mp4", "mp4", "convertido")).not.toBe("clip.mp4");
  });

  it("solo quita una extension real, no cualquier cosa tras un punto", () => {
    expect(stripVideoExtension("Mi.video.largo")).toBe("Mi.video");
    expect(stripVideoExtension("v1.0 final")).toBe("v1.0 final");
    expect(stripVideoExtension(".mp4")).toBe("");
  });

  it("limpia caracteres prohibidos y nombres vacios", () => {
    expect(outputFileName("a/b:c*.mov", "mp4", "x")).toBe("a-b-c--x.mp4");
    expect(outputFileName("   .mov", "mp4", "x")).toBe("video-x.mp4");
    expect(outputFileName("", "webm", "")).toBe("video.webm");
  });
});
