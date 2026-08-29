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
  localizedCheckoutSessionPayload,
  MAX_CART_QUANTITY,
  removeCheckoutItem,
} from "./checkout-cart";
import { readHistoricalCart, writeHistoricalCart, type HistoricalCartItem } from "./historical-cart";

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
  const [status, setStatus] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const total = useMemo(() => checkoutTotal(cart, dictionary), [cart, dictionary]);

  useEffect(() => {
    setCart(readHistoricalCart(window.localStorage));
    setLoaded(true);
  }, []);

  function persist(nextCart: HistoricalCartItem[]) {
    writeHistoricalCart(window.localStorage, nextCart);
    setCart(nextCart);
  }

  function updateQuantity(key: string, direction: -1 | 1) {
    persist(changeCheckoutQuantity(cart, key, direction));
  }

  function removeItem(key: string) {
    persist(removeCheckoutItem(cart, key));
  }

  async function startCheckout() {
    if (!cart.every(isCheckoutItemValid)) {
      setStatus(dictionary.checkout.invalidCart);
      return;
    }

    setRedirecting(true);
    setStatus(dictionary.checkout.redirecting);
    try {
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localizedCheckoutSessionPayload(cart, locale)),
      });
      const session = await response.json() as { url?: unknown };
      if (!response.ok || typeof session.url !== "string") throw new Error("CHECKOUT_REQUEST_FAILED");
      window.location.assign(session.url);
    } catch {
      setRedirecting(false);
      setStatus(dictionary.checkout.paymentError);
    }
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
      <div className="checkout-total"><span>{dictionary.checkout.total}</span><strong>{formatPrice(total)}</strong></div>
      <button className="stripe-checkout-button" type="button" onClick={startCheckout} disabled={redirecting}>{dictionary.checkout.confirmAndPay}</button>
      <p className="checkout-status" aria-live="polite">{status}</p>
    </section>
  );
}
