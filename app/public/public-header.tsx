"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import { localizedHref, type LocalizedRoute, type LocalizedRouteOptions } from "../i18n/routes";
import { checkoutDisplayLine, checkoutTotal } from "./checkout-cart";
import { readHistoricalCart, subscribeToHistoricalCart, totalHistoricalCartQuantity, type HistoricalCartItem } from "./historical-cart";

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
  const cartMenuRef = useRef<HTMLDivElement>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [cartMenuOpen, setCartMenuOpen] = useState(false);
  const [cartQuantity, setCartQuantity] = useState(0);
  const [cartItems, setCartItems] = useState<HistoricalCartItem[]>([]);

  useEffect(() => {
    const refreshCart = () => {
      const nextCart = readHistoricalCart(window.localStorage);
      setCartItems(nextCart);
      setCartQuantity(totalHistoricalCartQuantity(nextCart));
    };
    refreshCart();
    return subscribeToHistoricalCart(refreshCart);
  }, []);

  useEffect(() => {
    if (!cartMenuOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!cartMenuRef.current?.contains(event.target as Node)) setCartMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [cartMenuOpen]);

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
            <div ref={cartMenuRef} className={`cart-menu${cartMenuOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="cart-toggle"
                aria-expanded={cartMenuOpen}
                aria-controls={`cart-submenu-${locale}`}
                aria-label={cartQuantity > 0 ? `${dictionary.navigation.cart} (${cartQuantity})` : dictionary.navigation.cart}
                onClick={() => setCartMenuOpen((current) => !current)}
              >
              <span className="cart-icon-wrap">
                <svg className="cart-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 3.5h2.6l2 10.1h10.3l2-7.2H6.2M9 19.2a1.1 1.1 0 1 0 0 2.2Zm7.5 0a1.1 1.1 0 1 0 0 2.2Z" />
                </svg>
                {cartQuantity > 0 ? <span className="cart-quantity-badge" aria-hidden="true">{cartQuantity}</span> : null}
              </span>
              </button>
              <div className="cart-submenu" id={`cart-submenu-${locale}`}>
                <div className="cart-summary">
                  <span className="cart-summary-title">{locale === "fr" ? "Mon Panier" : "My Kart"}</span>
                  <span className="cart-item-count">{cartQuantity} {locale === "fr" ? "article(s)" : "item(s)"}</span>
                </div>
                {cartItems.length > 0 ? (
                  <>
                    <div className="cart-lines">
                      {cartItems.map((item) => {
                        const line = checkoutDisplayLine(item, dictionary);
                        return (
                          <div className="cart-line" key={item.key}>
                            <div>
                              <strong>{line.name}</strong>
                              <span>{locale === "fr" ? "Quantité" : "Quantity"} · {line.quantity}</span>
                            </div>
                            <span>{formatHeaderPrice(line.lineTotal, locale)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="cart-total">
                      <span>{locale === "fr" ? "TOTAL" : "TOTAL"}</span>
                      <strong>{formatHeaderPrice(checkoutTotal(cartItems, dictionary), locale)}</strong>
                    </div>
                  </>
                ) : <p className="cart-empty">{dictionary.checkout.empty}</p>}
                <a
                  className="cart-checkout-link"
                  href={localizedHref(locale, "checkout")}
                  onClick={() => setCartMenuOpen(false)}
                >
                  {locale === "fr" ? "Mon Panier" : "My Kart"}
                </a>
              </div>
            </div>
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

function formatHeaderPrice(amount: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    style: "currency",
    currency: "EUR",
  }).format(amount);
}
