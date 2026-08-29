import type { Locale } from "./config";
import { en } from "./en";
import { fr } from "./fr";
import type { TranslationDictionary } from "./types";

export { en, fr };
export type { TranslationDictionary } from "./types";

export const dictionaries: Record<Locale, TranslationDictionary> = { fr, en };

export function getDictionary(locale: Locale): TranslationDictionary {
  return dictionaries[locale];
}
