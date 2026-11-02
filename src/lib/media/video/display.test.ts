import { describe, expect, it } from "vitest";
import { formatDimensions, formatDuration, formatFps } from "@/lib/media/video/display";

describe("display", () => {
  it("formatDuration", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7.4)).toBe("0:07");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(-3)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });

  it("formatFps", () => {
    expect(formatFps(30)).toBe("30");
    expect(formatFps(29.97003)).toBe("29.97");
    expect(formatFps(23.976)).toBe("23.98");
    expect(formatFps(null)).toBeNull();
    expect(formatFps(0)).toBeNull();
  });

  it("formatDimensions", () => {
    expect(formatDimensions(1920, 1080)).toBe("1920 × 1080");
  });
});
