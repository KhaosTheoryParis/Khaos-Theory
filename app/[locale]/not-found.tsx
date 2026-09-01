"use client";

import { useParams } from "next/navigation";
import { defaultLocale, isLocale, type Locale } from "../i18n/config";
import PublicNotFound from "../public/public-not-found";

export function resolveNotFoundLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale;
}

export default function LocalizedNotFound() {
  const params = useParams<{ locale?: string }>();

  return <PublicNotFound locale={resolveNotFoundLocale(params.locale)} />;
}
