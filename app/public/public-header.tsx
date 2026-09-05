"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import { localizedHref, type LocalizedRoute, type LocalizedRouteOptions } from "../i18n/routes";

type PublicHeaderProps = {
  locale: Locale;
  currentRoute?: LocalizedRoute;
  currentRouteOptions?: LocalizedRouteOptions;
};

const HEADER_LANGUAGES = [
  { locale: "fr", code: "FR", label: "Français", flag: "🇫🇷" },
  { locale: "en", code: "EN", label: "English", flag: "🇬🇧" },
] as const satisfies ReadonlyArray<{ locale: Locale; code: string; label: string; flag: string }>;

export default function PublicHeader({ locale, currentRoute = "home", currentRouteOptions }: PublicHeaderProps) {
  const dictionary = getDictionary(locale);
  const activeLanguage = HEADER_LANGUAGES.find((language) => language.locale === locale) ?? HEADER_LANGUAGES[0];
  const languageMenuRef = useRef<HTMLDetailsElement>(null);
  const [languageOpen, setLanguageOpen] = useState(false);

  useEffect(() => {
    if (!languageOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!languageMenuRef.current?.contains(event.target as Node)) setLanguageOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [languageOpen]);

  function handleLanguageKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape") return;
    setLanguageOpen(false);
    languageMenuRef.current?.querySelector("summary")?.focus();
  }

  return (
    <header>
      <a href={localizedHref(locale, "home", { hash: "home" })} className="brand">
        {dictionary.brand}
      </a>
      <div className="localized-header-bar">
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
        </div>
        <details
          ref={languageMenuRef}
          className="language-menu"
          open={languageOpen}
          onToggle={(event) => setLanguageOpen(event.currentTarget.open)}
          onKeyDown={handleLanguageKeyDown}
        >
          <summary aria-label={dictionary.language.switcherLabel}>
            <span className="language-menu-flag" aria-hidden="true">{activeLanguage.flag}</span>
            <span>{activeLanguage.code}</span>
            <span className="language-menu-indicator" aria-hidden="true">▾</span>
          </summary>
          <ul className="language-menu-list">
            {HEADER_LANGUAGES.map((language) => (
              <li key={language.locale}>
                <a
                  href={localizedHref(language.locale, currentRoute, currentRouteOptions)}
                  lang={language.locale}
                  aria-current={locale === language.locale ? "page" : undefined}
                  onClick={() => setLanguageOpen(false)}
                >
                  <span aria-hidden="true">{language.flag}</span>
                  <span>{language.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </header>
  );
}
