"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  StripeAddressElement,
  StripeAddressElementChangeEvent,
  StripeCheckoutElementsSdk,
  StripeCheckoutLoadActionsSuccess,
  StripeCheckoutSession,
} from "@stripe/stripe-js";
import type { TranslationDictionary } from "../i18n";
import type { Locale } from "../i18n/config";
import { checkoutSessionItems } from "./checkout-cart";
import {
  beginCheckoutConfirmation,
  canConfirmCheckoutElements,
  createCheckoutElementsGate,
  finishCheckoutAddressValidation,
  invalidateCheckoutAddress,
  type CheckoutElementsGate,
} from "./checkout-elements-gate";
import type { HistoricalCartItem } from "./historical-cart";

type CheckoutElementsPaymentProps = {
  cart: HistoricalCartItem[];
  locale: Locale;
  dictionary: TranslationDictionary;
};

type CheckoutElementsSessionConfig = {
  checkoutSessionId: string;
  clientSecret: string;
  publishableKey: string;
};

type ShippingUpdateResult =
  | { ok: true; session: StripeCheckoutSession; shippingAmount: number; amountTotal: number }
  | { ok: false; reason: "ineligible" | "error" };

const SHIPPING_UPDATE_DEBOUNCE_MS = 300;

export default function CheckoutElementsPayment({ cart, locale, dictionary }: CheckoutElementsPaymentProps) {
  const cartItems = useMemo(() => checkoutSessionItems(cart), [cart]);
  const cartKey = useMemo(() => JSON.stringify(cartItems), [cartItems]);
  const [gate, setGateState] = useState<CheckoutElementsGate>(() => createCheckoutElementsGate(cartKey));
  const gateRef = useRef(gate);
  const generationRef = useRef(0);
  const actionsRef = useRef<StripeCheckoutLoadActionsSuccess | null>(null);
  const shippingElementRef = useRef<StripeAddressElement | null>(null);
  const sessionConfigRef = useRef<CheckoutElementsSessionConfig | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [stripeCanConfirm, setStripeCanConfirm] = useState(false);
  const [shippingAmount, setShippingAmount] = useState<number | null>(null);
  const [amountTotal, setAmountTotal] = useState<number | null>(null);
  const [statusText, setStatusText] = useState(dictionary.checkout.initializingPayment);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const shippingMountRef = useRef<HTMLDivElement>(null);
  const contactMountRef = useRef<HTMLDivElement>(null);
  const paymentMountRef = useRef<HTMLDivElement>(null);

  function setGate(next: CheckoutElementsGate | ((current: CheckoutElementsGate) => CheckoutElementsGate)) {
    setGateState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      gateRef.current = resolved;
      return resolved;
    });
  }

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const initialGate = createCheckoutElementsGate(cartKey);
    gateRef.current = initialGate;
    setGateState(initialGate);
    setStripeCanConfirm(false);
    setShippingAmount(null);
    setAmountTotal(null);
    setStatusText(dictionary.checkout.initializingPayment);
    setInitializationFailed(false);

    let active = true;
    let checkoutSdk: StripeCheckoutElementsSdk | null = null;
    let shippingElement: StripeAddressElement | null = null;
    let contactElement: ReturnType<StripeCheckoutElementsSdk["createContactDetailsElement"]> | null = null;
    let paymentElement: ReturnType<StripeCheckoutElementsSdk["createPaymentElement"]> | null = null;
    let addressHandler: ((event: StripeAddressElementChangeEvent) => void) | null = null;

    async function initialize() {
      try {
        const response = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: cartItems, locale }),
        });
        const responseBody = await response.json() as unknown;
        const config = parseElementsSessionConfig(responseBody);
        if (!active || generationRef.current !== generation) return;
        if (!response.ok || !config) throw new Error("INVALID_CHECKOUT_SESSION_RESPONSE");

        const { loadStripe } = await import("@stripe/stripe-js/pure/index.js");
        const stripe = await loadStripe(config.publishableKey, { locale });
        if (!active || generationRef.current !== generation) return;
        if (!stripe) throw new Error("STRIPE_JS_UNAVAILABLE");

        const sdk = stripe.initCheckoutElementsSdk({ clientSecret: config.clientSecret });
        checkoutSdk = sdk;
        shippingElement = sdk.createShippingAddressElement({ display: { name: "full" } });
        contactElement = sdk.createContactDetailsElement();
        paymentElement = sdk.createPaymentElement();
        if (!shippingMountRef.current || !contactMountRef.current || !paymentMountRef.current) {
          throw new Error("CHECKOUT_ELEMENT_MOUNT_UNAVAILABLE");
        }
        shippingElement.mount(shippingMountRef.current);
        contactElement.mount(contactMountRef.current);
        paymentElement.mount(paymentMountRef.current);

        const loaded = await sdk.loadActions();
        if (!active || generationRef.current !== generation) return;
        if (loaded.type !== "success") throw new Error("CHECKOUT_ACTIONS_UNAVAILABLE");

        actionsRef.current = loaded.actions;
        shippingElementRef.current = shippingElement;
        sessionConfigRef.current = config;
        setStripeCanConfirm(loaded.actions.getSession().canConfirm);
        sdk.on("change", (session) => {
          if (active && generationRef.current === generation) setStripeCanConfirm(session.canConfirm);
        });

        addressHandler = (event) => {
          if (!active || generationRef.current !== generation) return;
          if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
          const invalidated = invalidateCheckoutAddress(gateRef.current, event.complete);
          gateRef.current = invalidated;
          setGateState(invalidated);
          setShippingAmount(null);
          setAmountTotal(null);

          if (!event.complete) {
            setStatusText("");
            return;
          }

          setStatusText(dictionary.checkout.checkingAddress);
          const addressRevision = invalidated.addressRevision;
          const shippingDetails = stripeShippingDetails(event);
          debounceRef.current = window.setTimeout(() => {
            void validateShippingAddress({
              actions: loaded.actions,
              config,
              shippingDetails,
              addressRevision,
              generation,
              active: () => active,
            });
          }, SHIPPING_UPDATE_DEBOUNCE_MS);
        };
        shippingElement.on("change", addressHandler);

        const readyGate = { ...gateRef.current, status: "incomplete" as const };
        gateRef.current = readyGate;
        setGateState(readyGate);
        setStatusText("");
      } catch {
        if (!active || generationRef.current !== generation) return;
        const failed = { ...gateRef.current, status: "error" as const, validatedAddressRevision: null };
        gateRef.current = failed;
        setGateState(failed);
        setInitializationFailed(true);
        setStatusText(dictionary.checkout.checkoutInitializationError);
      }
    }

    async function validateShippingAddress({
      actions,
      config,
      shippingDetails,
      addressRevision,
      generation: requestGeneration,
      active: isActive,
    }: {
      actions: StripeCheckoutLoadActionsSuccess;
      config: CheckoutElementsSessionConfig;
      shippingDetails: ReturnType<typeof stripeShippingDetails>;
      addressRevision: number;
      generation: number;
      active: () => boolean;
    }) {
      const result = await runAuthoritativeShippingUpdate(actions, config, shippingDetails);
      if (!isActive() || generationRef.current !== requestGeneration || gateRef.current.addressRevision !== addressRevision) {
        return;
      }
      const outcome = result.ok ? "eligible" : result.reason;
      const completed = finishCheckoutAddressValidation(gateRef.current, addressRevision, outcome);
      gateRef.current = completed;
      setGateState(completed);

      if (result.ok) {
        setShippingAmount(result.shippingAmount);
        setAmountTotal(result.amountTotal);
        setStripeCanConfirm(result.session.canConfirm);
        setStatusText(dictionary.checkout.shippingValidated);
      } else {
        setShippingAmount(null);
        setAmountTotal(null);
        setStatusText(result.reason === "ineligible"
          ? dictionary.checkout.ineligibleAddress
          : dictionary.checkout.shippingQuoteError);
      }
    }

    void initialize();
    return () => {
      active = false;
      generationRef.current += 1;
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (shippingElement && addressHandler) shippingElement.off("change", addressHandler);
      shippingElement?.destroy();
      contactElement?.destroy();
      paymentElement?.destroy();
      actionsRef.current = null;
      shippingElementRef.current = null;
      sessionConfigRef.current = null;
      checkoutSdk = null;
    };
  }, [cartItems, cartKey, dictionary.checkout, initializationAttempt, locale]);

  function retryInitialization() {
    const retryGate = createCheckoutElementsGate(cartKey);
    gateRef.current = retryGate;
    setGateState(retryGate);
    setStripeCanConfirm(false);
    setShippingAmount(null);
    setAmountTotal(null);
    setInitializationFailed(false);
    setStatusText(dictionary.checkout.initializingPayment);
    setInitializationAttempt((attempt) => attempt + 1);
  }

  async function confirmPayment() {
    const actions = actionsRef.current;
    const shippingElement = shippingElementRef.current;
    const config = sessionConfigRef.current;
    const generation = generationRef.current;
    if (!actions || !shippingElement || !config) {
      return;
    }

    const started = beginCheckoutConfirmation(gateRef.current, cartKey, stripeCanConfirm);
    if (!started) return;
    gateRef.current = started;
    setGateState(started);

    let currentAddress: Awaited<ReturnType<StripeAddressElement["getValue"]>>;
    try {
      currentAddress = await shippingElement.getValue();
    } catch {
      if (generationRef.current !== generation) return;
      const failed = { ...gateRef.current, status: "error" as const, validatedAddressRevision: null };
      gateRef.current = failed;
      setGateState(failed);
      setStatusText(dictionary.checkout.paymentError);
      return;
    }
    if (generationRef.current !== generation) return;
    if (!currentAddress.complete) {
      const incomplete = invalidateCheckoutAddress(gateRef.current, false);
      gateRef.current = incomplete;
      setGateState(incomplete);
      setStatusText("");
      return;
    }
    const checkingGate = invalidateCheckoutAddress(gateRef.current, true);
    gateRef.current = checkingGate;
    setGateState(checkingGate);
    setStatusText(dictionary.checkout.checkingAddress);

    const shippingResult = await runAuthoritativeShippingUpdate(
      actions,
      config,
      stripeShippingDetails(currentAddress),
    );
    if (generationRef.current !== generation || gateRef.current.addressRevision !== checkingGate.addressRevision) return;
    if (!shippingResult.ok) {
      const failed = finishCheckoutAddressValidation(gateRef.current, checkingGate.addressRevision, shippingResult.reason);
      gateRef.current = failed;
      setGateState(failed);
      setStatusText(shippingResult.reason === "ineligible"
        ? dictionary.checkout.ineligibleAddress
        : dictionary.checkout.shippingQuoteError);
      return;
    }

    const eligible = finishCheckoutAddressValidation(gateRef.current, checkingGate.addressRevision, "eligible");
    gateRef.current = { ...eligible, status: "confirming" };
    setGateState(gateRef.current);
    setShippingAmount(shippingResult.shippingAmount);
    setAmountTotal(shippingResult.amountTotal);
    setStatusText(dictionary.checkout.confirmingPayment);

    const validation = await actions.validateElements();
    if (generationRef.current !== generation || gateRef.current.addressRevision !== checkingGate.addressRevision) return;
    if (validation.type !== "success" || !validation.session.canConfirm) {
      const failed = { ...gateRef.current, status: "error" as const, validatedAddressRevision: null };
      gateRef.current = failed;
      setGateState(failed);
      setStatusText(dictionary.checkout.paymentError);
      return;
    }

    const confirmation = await actions.confirm({ redirect: "always" });
    if (generationRef.current !== generation) return;
    if (confirmation.type === "error") {
      const failed = { ...gateRef.current, status: "error" as const, validatedAddressRevision: null };
      gateRef.current = failed;
      setGateState(failed);
      setStatusText(dictionary.checkout.paymentError);
      return;
    }

    window.location.assign(`/${locale}/success?session_id=${encodeURIComponent(config.checkoutSessionId)}`);
  }

  const confirmEnabled = canConfirmCheckoutElements(gate, cartKey, stripeCanConfirm);
  const isShippingUpdating = gate.status === "initializing" || gate.status === "checking";
  const isConfirming = gate.status === "confirming";
  const isProcessing = isShippingUpdating || isConfirming;
  const hasStatusError = initializationFailed || gate.status === "ineligible" || gate.status === "error";
  return (
    <section
      className={`checkout-elements checkout-elements--${gate.status}`}
      aria-label={dictionary.checkout.securePayment}
      aria-busy={isProcessing}
    >
      <fieldset className="shipping-address">
        <legend>{dictionary.checkout.shippingAddress}</legend>
        {shippingAmount === null ? <p className="shipping-address-hint">{dictionary.checkout.shippingAddressHint}</p> : null}
        <div ref={shippingMountRef} className="stripe-element-mount" />
      </fieldset>
      <section className="stripe-element-section" aria-label={dictionary.checkout.contactDetails}>
        <h2>{dictionary.checkout.contactDetails}</h2>
        <div ref={contactMountRef} className="stripe-element-mount" />
      </section>
      <section className="stripe-element-section" aria-label={dictionary.checkout.paymentDetails}>
        <h2>{dictionary.checkout.paymentDetails}</h2>
        <div ref={paymentMountRef} className="stripe-element-mount" />
      </section>
      <div
        className={`shipping-preview-row${isShippingUpdating ? " shipping-preview-row--checking" : ""}`}
        aria-live="polite"
        aria-busy={isShippingUpdating}
      >
        <span>{dictionary.checkout.shipping}</span>
        <strong>{shippingAmount === null ? "—" : shippingAmount === 0
          ? dictionary.checkout.freeShipping
          : formatCurrency(shippingAmount, locale)}</strong>
      </div>
      {amountTotal !== null ? (
        <div className="checkout-total"><span>{dictionary.checkout.total}</span><strong>{formatCurrency(amountTotal, locale)}</strong></div>
      ) : null}
      <button
        className={`stripe-checkout-button${isConfirming ? " stripe-checkout-button--processing" : ""}`}
        type="button"
        onClick={() => void confirmPayment()}
        disabled={!confirmEnabled || isConfirming}
        aria-busy={isConfirming}
      >
        {dictionary.checkout.confirmAndPay}
      </button>
      {initializationFailed || gate.status === "error" ? (
        <button className="checkout-retry-button" type="button" onClick={retryInitialization}>
          {dictionary.checkout.retryCheckout}
        </button>
      ) : null}
      <p
        className={`checkout-status checkout-status--${gate.status}`}
        role={hasStatusError ? "alert" : undefined}
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </p>
    </section>
  );
}

export async function runAuthoritativeShippingUpdate(
  actions: Pick<StripeCheckoutLoadActionsSuccess, "runServerUpdate">,
  config: CheckoutElementsSessionConfig,
  shippingDetails: ReturnType<typeof stripeShippingDetails>,
  fetcher: typeof fetch = fetch,
): Promise<ShippingUpdateResult> {
  let responseStatus = 0;
  let responseBody: unknown;
  let result: Awaited<ReturnType<typeof actions.runServerUpdate>>;
  try {
    result = await actions.runServerUpdate(async () => {
      const response = await fetcher("/api/checkout/update-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: config.checkoutSessionId,
          clientSecret: config.clientSecret,
          shippingDetails,
        }),
      });
      responseStatus = response.status;
      responseBody = await response.json() as unknown;
      if (!response.ok) throw new Error("CHECKOUT_SHIPPING_UPDATE_REJECTED");
      return responseBody;
    });
  } catch {
    return { ok: false, reason: responseStatus === 422 ? "ineligible" : "error" };
  }

  if (result.type !== "success") {
    return { ok: false, reason: responseStatus === 422 ? "ineligible" : "error" };
  }
  const amounts = parseShippingUpdateResponse(responseBody);
  if (
    !amounts ||
    result.session.id !== config.checkoutSessionId ||
    result.session.livemode !== false ||
    result.session.total.shippingRate.minorUnitsAmount !== amounts.shippingAmount ||
    result.session.total.total.minorUnitsAmount !== amounts.amountTotal
  ) {
    return { ok: false, reason: "error" };
  }
  return { ok: true, session: result.session, ...amounts };
}

export function parseElementsSessionConfig(value: unknown): CheckoutElementsSessionConfig | null {
  if (!isRecord(value)) return null;
  const { checkoutSessionId, clientSecret, publishableKey } = value;
  if (
    typeof checkoutSessionId !== "string" ||
    !checkoutSessionId.startsWith("cs_test_") ||
    typeof clientSecret !== "string" ||
    !clientSecret.startsWith(`${checkoutSessionId}_secret_`) ||
    typeof publishableKey !== "string" ||
    !publishableKey.startsWith("pk_test_")
  ) {
    return null;
  }
  return { checkoutSessionId, clientSecret, publishableKey };
}

function parseShippingUpdateResponse(value: unknown) {
  if (!isRecord(value)) return null;
  if (
    value.updated !== true ||
    value.currency !== "eur" ||
    !isNonNegativeSafeInteger(value.shippingAmount) ||
    !isNonNegativeSafeInteger(value.amountTotal)
  ) {
    return null;
  }
  return { shippingAmount: value.shippingAmount, amountTotal: value.amountTotal };
}

function stripeShippingDetails(event: Pick<StripeAddressElementChangeEvent, "value">) {
  return {
    name: event.value.name,
    address: {
      country: event.value.address.country,
      postal_code: event.value.address.postal_code,
      city: event.value.address.city,
      line1: event.value.address.line1,
      ...(event.value.address.line2 ? { line2: event.value.address.line2 } : {}),
    },
  };
}

function formatCurrency(amount: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-FR", {
    style: "currency",
    currency: "EUR",
  }).format(amount / 100);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
