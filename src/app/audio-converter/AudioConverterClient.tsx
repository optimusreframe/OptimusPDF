"use client";

import { useI18n } from "@/lib/i18n";
import { AudioWorkFrame } from "@/lib/media/audio/ui/AudioWorkFrame";
import { STRINGS } from "@/app/audio-converter/strings";

export function AudioConverterClient() {
  const { language } = useI18n();
  return <AudioWorkFrame slug="audio-converter" kind="audio" strings={STRINGS[language]} />;
}
