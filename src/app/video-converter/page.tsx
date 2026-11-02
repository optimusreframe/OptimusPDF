import type { Metadata } from "next";
import { VideoConverterToolClient } from "@/app/video-converter/VideoConverterToolClient";

export const metadata: Metadata = {
  title: "Convertidor de video",
  description:
    "Convierte un video a MP4 o WebM, cambia su resolución y su calidad, o quítale el audio. Todo ocurre en tu dispositivo: el video no se sube a ningún sitio.",
  alternates: { canonical: "/video-converter" },
};

export default function VideoConverterPage() {
  return <VideoConverterToolClient />;
}
