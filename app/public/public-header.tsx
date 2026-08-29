import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import LanguageSwitcher from "../i18n/language-switcher";
import { localizedHref, type LocalizedRoute, type LocalizedRouteOptions } from "../i18n/routes";

type PublicHeaderProps = {
  locale: Locale;
  currentRoute?: LocalizedRoute;
  currentRouteOptions?: LocalizedRouteOptions;
};

export default function PublicHeader({ locale, currentRoute = "home", currentRouteOptions }: PublicHeaderProps) {
  const dictionary = getDictionary(locale);

  return (
    <header>
      <a href={localizedHref(locale, "home", { hash: "home" })} className="brand">
        {dictionary.brand}
      </a>
      <div className="localized-header-controls">
        <nav aria-label={dictionary.navigation.collection}>
          <details className="collection-menu">
            <summary className="collection-toggle">{dictionary.navigation.collection}</summary>
            <div className="collection-submenu">
              <a href={localizedHref(locale, "rings")}>{dictionary.navigation.rings}</a>
              <a href={localizedHref(locale, "bracelets")}>{dictionary.navigation.bracelets}</a>
              <a href={localizedHref(locale, "earrings")}>{dictionary.navigation.earrings}</a>
              <a href={localizedHref(locale, "pendants")}>{dictionary.navigation.pendants}</a>
            </div>
          </details>
          <a href={localizedHref(locale, "about")}>{dictionary.navigation.about}</a>
          <a href={localizedHref(locale, "contact")}>{dictionary.navigation.contact}</a>
          <a href={localizedHref(locale, "checkout")} className="cart-toggle" aria-label={dictionary.navigation.cart}>
            <svg className="cart-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.5 3.5h2.6l2 10.1h10.3l2-7.2H6.2M9 19.2a1.1 1.1 0 1 0 0 2.2Zm7.5 0a1.1 1.1 0 1 0 0 2.2Z" />
            </svg>
            <span>{dictionary.navigation.cart}</span>
          </a>
        </nav>
        <LanguageSwitcher className="language-switcher" locale={locale} route={currentRoute} {...currentRouteOptions} />
      </div>
    </header>
  );
}
