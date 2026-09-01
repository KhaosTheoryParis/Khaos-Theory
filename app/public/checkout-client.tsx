"use client";

import { useEffect, useMemo, useState } from "react";
import type { TranslationDictionary } from "../i18n";
import { localizedHref } from "../i18n/routes";
import type { Locale } from "../i18n/config";
import {
  changeCheckoutQuantity,
  checkoutDisplayLine,
  checkoutTotal,
  interpolateCheckoutText,
  isCheckoutItemValid,
  MAX_CART_QUANTITY,
  removeCheckoutItem,
} from "./checkout-cart";
import { readHistoricalCart, writeHistoricalCart, type HistoricalCartItem } from "./historical-cart";
import CheckoutElementsPayment from "./checkout-elements-payment";

type CheckoutClientProps = {
  locale: Locale;
  dictionary: TranslationDictionary;
};

function formatPrice(price: number): string {
  return `${price} €`;
}

export default function CheckoutClient({ locale, dictionary }: CheckoutClientProps) {
  const [cart, setCart] = useState<HistoricalCartItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cartError, setCartError] = useState("");
  const total = useMemo(() => checkoutTotal(cart, dictionary), [cart, dictionary]);

  useEffect(() => {
    setCart(readHistoricalCart(window.localStorage));
    setLoaded(true);
  }, []);

  function persist(nextCart: HistoricalCartItem[]) {
    try {
      writeHistoricalCart(window.localStorage, nextCart);
      setCart(nextCart);
      setCartError("");
    } catch {
      setCartError(dictionary.checkout.cartUpdateError);
    }
  }

  function updateQuantity(key: string, direction: -1 | 1) {
    persist(changeCheckoutQuantity(cart, key, direction));
  }

  function removeItem(key: string) {
    persist(removeCheckoutItem(cart, key));
  }

  if (!loaded) {
    return <section className="checkout-summary" aria-labelledby="checkout-title"><h1 id="checkout-title" className="section-title">{dictionary.checkout.yourKart}</h1><p className="checkout-status" aria-live="polite">{dictionary.checkout.loading}</p></section>;
  }

  if (cart.length === 0) {
    return (
      <section className="checkout-summary" aria-labelledby="checkout-title">
        <h1 id="checkout-title" className="section-title">{dictionary.checkout.yourKart}</h1>
        <p className="checkout-empty">{dictionary.checkout.empty}</p>
        <a className="continue-shopping" href={localizedHref(locale, "rings")}>{dictionary.checkout.continueShopping}</a>
      </section>
    );
  }

  return (
    <section className="checkout-summary" aria-labelledby="checkout-title">
      <h1 id="checkout-title" className="section-title">{dictionary.checkout.orderSummary}</h1>
      <div className="checkout-lines" role="list" aria-label={dictionary.checkout.yourKart}>
        {cart.map((item) => {
          const line = checkoutDisplayLine(item, dictionary);
          return (
            <div className="checkout-line" role="listitem" key={item.key}>
              <div className="checkout-line-details"><strong>{line.name}</strong><span>FR {item.size} / US {item.usSize}</span></div>
              <div className="checkout-quantity" aria-label={interpolateCheckoutText(dictionary.checkout.quantityFor, line.name)}>
                <button type="button" onClick={() => updateQuantity(item.key, -1)} aria-label={interpolateCheckoutText(dictionary.checkout.removeOne, line.name)}>−</button>
                <span aria-live="polite">{line.quantity}</span>
                <button type="button" onClick={() => updateQuantity(item.key, 1)} aria-label={interpolateCheckoutText(dictionary.checkout.addOne, line.name)} disabled={line.quantity >= MAX_CART_QUANTITY}>+</button>
              </div>
              <span className="checkout-line-price">{formatPrice(line.lineTotal)}</span>
              <button type="button" className="checkout-remove-button" onClick={() => removeItem(item.key)} aria-label={`${dictionary.checkout.remove} ${line.name}`}>×</button>
            </div>
          );
        })}
      </div>
      <div className="checkout-total"><span>{dictionary.checkout.productsSubtotal}</span><strong>{formatPrice(total)}</strong></div>
      {cartError ? <p className="checkout-status checkout-status--error" role="alert">{cartError}</p> : null}
      {cart.every(isCheckoutItemValid)
        ? <CheckoutElementsPayment cart={cart} locale={locale} dictionary={dictionary} />
        : <p className="checkout-status" role="alert">{dictionary.checkout.invalidCart}</p>}
    </section>
  );
}
