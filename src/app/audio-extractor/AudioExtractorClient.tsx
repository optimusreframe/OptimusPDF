"use client";

import { useI18n } from "@/lib/i18n";
import { AudioWorkFrame } from "@/lib/media/audio/ui/AudioWorkFrame";
import { STRINGS } from "@/app/audio-extractor/strings";

export function AudioExtractorClient() {
  const { language } = useI18n();
  return <AudioWorkFrame slug="audio-extractor" kind="video" strings={STRINGS[language]} />;
}
