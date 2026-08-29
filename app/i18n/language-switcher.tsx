import type { Locale } from "./config";
import { getDictionary } from "./index";
import { localizedHref, type LocalizedRoute, type LocalizedRouteOptions } from "./routes";

type LanguageSwitcherProps = LocalizedRouteOptions & {
  locale: Locale;
  route: LocalizedRoute;
  className?: string;
};

export default function LanguageSwitcher({ locale, route, query, hash, className }: LanguageSwitcherProps) {
  const dictionary = getDictionary(locale);
  const options = { query, hash };

  return (
    <nav className={className} aria-label={dictionary.language.switcherLabel}>
      <a href={localizedHref("fr", route, options)} lang="fr" aria-current={locale === "fr" ? "page" : undefined}>
        {dictionary.language.french}
      </a>
      {" / "}
      <a href={localizedHref("en", route, options)} lang="en" aria-current={locale === "en" ? "page" : undefined}>
        {dictionary.language.english}
      </a>
    </nav>
  );
}
