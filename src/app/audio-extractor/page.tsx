import type { Metadata } from "next";
import { AudioExtractorClient } from "@/app/audio-extractor/AudioExtractorClient";

export const metadata: Metadata = {
  title: "Extraer audio de un video",
  description:
    "Saca la pista de audio de un video (MP4, MOV, WebM, MKV, M4V) y guárdala como WAV, M4A u Opus. Todo en tu dispositivo: el video no se sube a ningún servidor.",
  alternates: { canonical: "/audio-extractor" },
};

export default function AudioExtractorPage() {
  return <AudioExtractorClient />;
}
