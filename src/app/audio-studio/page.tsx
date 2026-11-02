import type { Metadata } from "next";
import { AudioStudioClient } from "@/app/audio-studio/AudioStudioClient";

export const metadata: Metadata = {
  title: "Audio Studio",
  description:
    "Edita audio en tu propio dispositivo: recorta, quita tramos, divide, une varios archivos, aplica fundidos y volumen, escucha y exporta a WAV, M4A u Opus. Nada se sube a ningún servidor.",
  alternates: { canonical: "/audio-studio" },
};

export default function AudioStudioPage() {
  return <AudioStudioClient />;
}
