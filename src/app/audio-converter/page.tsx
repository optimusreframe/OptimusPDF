import type { Metadata } from "next";
import { AudioConverterClient } from "@/app/audio-converter/AudioConverterClient";

export const metadata: Metadata = {
  title: "Convertidor de audio",
  description:
    "Convierte audios entre WAV, MP3, M4A (AAC) y Opus en tu propio dispositivo. Varios archivos a la vez, con ZIP y tamaño antes y después. Nada se sube a ningún servidor.",
  alternates: { canonical: "/audio-converter" },
};

export default function AudioConverterPage() {
  return <AudioConverterClient />;
}
