export const supportedLocales = ["fr", "en"] as const;

export type Locale = (typeof supportedLocales)[number];

export const defaultLocale: Locale = "fr";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (supportedLocales as readonly string[]).includes(value);
}
