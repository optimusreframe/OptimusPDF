import { describe, expect, it } from "vitest";
import { isBlockedIp, parseIPv4, parseIPv6, sameIp } from "@/lib/htmlSnapshot/ipGuard";

describe("parseIPv4 / parseIPv6", () => {
  it("analiza formas validas y rechaza las ambiguas", () => {
    expect(parseIPv4("8.8.8.8")).toEqual([8, 8, 8, 8]);
    expect(parseIPv4("08.8.8.8")).toBeNull(); // cero a la izquierda: octal en algunos analizadores
    expect(parseIPv4("256.1.1.1")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv6("::1")).toHaveLength(16);
    expect(parseIPv6("2001:db8::")).toHaveLength(16);
    expect(parseIPv6("::ffff:127.0.0.1")?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6("fe80::1%eth0")).toBeNull(); // zona
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("zzzz::1")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("isBlockedIp — corpus hostil", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // metadatos de la nube
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "224.0.0.1", // multicast
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1", // ULA
    "fd12:3456:789a::1",
    "fe80::1", // enlace local
    "febf::1",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // mapeada IPv4
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1", // NAT64
    "2002:7f00:1::1", // 6to4 con 127.0.0.1 dentro
    "2001:db8::1", // documentacion
    "2001::1", // Teredo
    "[::1]",
    "no-es-una-ip",
    "",
  ];
  for (const ip of blocked) {
    it(`bloquea ${JSON.stringify(ip)}`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"];
  for (const ip of allowed) {
    it(`permite ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  }
});

describe("sameIp", () => {
  it("compara bytes, no cadenas", () => {
    expect(sameIp("::1", "0:0:0:0:0:0:0:1")).toBe(true);
    expect(sameIp("2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111")).toBe(true);
    expect(sameIp("1.2.3.4", "1.2.3.5")).toBe(false);
    expect(sameIp("1.2.3.4", "::ffff:1.2.3.4")).toBe(false);
  });
});
