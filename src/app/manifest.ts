import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OptimusPDF — Herramientas PDF locales",
    short_name: "OptimusPDF",
    description:
      "Suite de herramientas PDF que se ejecuta entera en tu navegador. Tus archivos no se suben a ningún servidor.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    categories: ["productivity", "utilities"],
    lang: "es",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
