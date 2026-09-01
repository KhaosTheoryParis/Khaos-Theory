import type { Metadata } from "next";
import { defaultLocale, supportedLocales, type Locale } from "../i18n/config";
import { localizedHref, type LocalizedRoute, type LocalizedRouteOptions } from "../i18n/routes";

const FALLBACK_SITE_URL = "https://khaostheoryparis.com";

function resolveConfiguredSiteUrl(): URL {
  const configured = process.env.SITE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        return new URL("/", url);
      }
    } catch {
      // The public fallback keeps generated metadata valid when SITE_URL is absent or malformed.
    }
  }

  return new URL(FALLBACK_SITE_URL);
}

export const publicSiteUrl = resolveConfiguredSiteUrl();

export function publicUrl(path: string): string {
  return new URL(path, publicSiteUrl).toString();
}

type LocalizedPublicMetadataInput = {
  locale: Locale;
  route: LocalizedRoute;
  title: string;
  description: string;
  options?: LocalizedRouteOptions;
  indexable?: boolean;
};

export function localizedPublicMetadata({
  locale,
  route,
  title,
  description,
  options,
  indexable = true,
}: LocalizedPublicMetadataInput): Metadata {
  const localizedUrl = (targetLocale: Locale) => publicUrl(localizedHref(targetLocale, route, options));
  const canonical = localizedUrl(locale);
  const alternateLocale = locale === "fr" ? "en_US" : "fr_FR";

  return {
    title,
    description,
    alternates: {
      canonical,
      languages: {
        ...Object.fromEntries(supportedLocales.map((targetLocale) => [targetLocale, localizedUrl(targetLocale)])),
        "x-default": localizedUrl(defaultLocale),
      },
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      siteName: "Khaos Theory",
      locale: locale === "fr" ? "fr_FR" : "en_US",
      alternateLocale,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    ...(indexable ? {} : { robots: { index: false, follow: false } }),
  };
}
