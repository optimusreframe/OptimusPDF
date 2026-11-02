import { describe, expect, it } from "vitest";
import { LIMITS, detectDeviceClass } from "@/lib/media/video/limits";

describe("detectDeviceClass", () => {
  it("iPhone y iPad son dispositivos con poca memoria", () => {
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toBe("constrained");
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" })).toBe("constrained");
  });

  it("un iPad que se presenta como Mac (MacIntel con pantalla tactil) tambien", () => {
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 })).toBe("constrained");
  });

  it("un Mac de verdad, Windows y Linux son escritorio", () => {
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 })).toBe("desktop");
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" })).toBe("desktop");
  });

  it("Android y los equipos de 4 GB o menos son de poca memoria", () => {
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (Linux; Android 14)" })).toBe("constrained");
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (X11; Linux)", deviceMemory: 4 })).toBe("constrained");
    expect(detectDeviceClass({ userAgent: "Mozilla/5.0 (X11; Linux)", deviceMemory: 8 })).toBe("desktop");
  });
});

describe("LIMITS", () => {
  it("los de poca memoria son siempre mas estrictos que los de escritorio", () => {
    for (const key of Object.keys(LIMITS.desktop) as Array<keyof typeof LIMITS.desktop>) {
      expect(LIMITS.constrained[key]).toBeLessThan(LIMITS.desktop[key]);
    }
  });

  it("el aviso llega antes que el rechazo", () => {
    for (const device of Object.values(LIMITS)) {
      expect(device.warnInputBytes).toBeLessThan(device.maxInputBytes);
      expect(device.warnDurationSec).toBeLessThan(device.maxDurationSec);
    }
    expect(LIMITS.desktop.warnInputBytes).toBe(500 * 1024 * 1024);
  });
});
