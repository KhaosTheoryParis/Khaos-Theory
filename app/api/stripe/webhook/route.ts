import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  getPennylaneErrorDetails,
  syncPaidCheckoutSessionToPennylane,
  syncTotalRefundToPennylane,
} from "../../../services/pennylane";

export const runtime = "nodejs";

async function createPennylaneInvoice(
  stripe: Stripe,
  sessionId: string,
  token: string | undefined,
) {
  if (!token) {
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      code: "MISSING_PENNYLANE_API_TOKEN",
    });
    return;
  }

  try {
    const result = await syncPaidCheckoutSessionToPennylane({ stripe, sessionId, token });

    if (result.status === "already_exists") {
      console.log("PENNYLANE_INVOICE_ALREADY_EXISTS", {
        stripe_session_id: sessionId,
        pennylane_invoice_id: result.invoiceId,
        stripe_payment_intent_id: result.paymentIntentId,
      });
    } else {
      console.log("PENNYLANE_INVOICE_FINALIZED", {
        stripe_session_id: sessionId,
        pennylane_invoice_id: result.invoiceId,
        stripe_payment_intent_id: result.paymentIntentId,
        customer_email: result.customerEmail,
        amount: result.amount,
        currency: result.currency,
      });
    }

    if (result.markAsPaid.status === "marked_paid") {
      console.log("PENNYLANE_SANDBOX_INVOICE_MARKED_PAID", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        stripe_payment_intent_id: result.paymentIntentId,
        amount: result.amount,
        currency: result.currency,
        remaining_amount_with_tax: result.markAsPaid.remainingAmountWithTax ?? null,
      });
    } else if (result.markAsPaid.status === "error") {
      console.error("PENNYLANE_MARK_AS_PAID_ERROR", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        stripe_payment_intent_id: result.paymentIntentId,
        ...result.markAsPaid.error,
      });
    }

    if (result.email.status === "sent" && result.status === "created") {
      console.log("PENNYLANE_SANDBOX_INVOICE_EMAIL_SENT", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        customer_email: result.customerEmail,
      });
    } else if (result.email.status === "error") {
      console.error("PENNYLANE_INVOICE_EMAIL_ERROR", {
        pennylane_invoice_id: result.invoiceId,
        stripe_session_id: sessionId,
        ...result.email.error,
      });
    }
  } catch (error) {
    console.error("PENNYLANE_INVOICE_ERROR", {
      stripe_session_id: sessionId,
      ...getPennylaneErrorDetails(error),
    });
  }
}

async function createPennylaneCreditNote(
  stripe: Stripe,
  charge: Stripe.Charge,
  eventCreated: number,
  token: string | undefined,
) {
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!token) {
    console.error("PENNYLANE_CREDIT_NOTE_ERROR", {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: paymentIntentId ?? null,
      code: "MISSING_PENNYLANE_API_TOKEN",
    });
    return;
  }

  try {
    const result = await syncTotalRefundToPennylane({
      stripe,
      charge,
      eventCreated,
      token,
    });
    const logDetails = {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: result.paymentIntentId,
      pennylane_invoice_id: result.invoiceId,
      pennylane_credit_note_id: result.creditNoteId,
      amount: result.amount,
      currency: result.currency,
    };

    if (result.status === "already_exists") {
      console.log("PENNYLANE_CREDIT_NOTE_ALREADY_EXISTS", logDetails);
    } else {
      console.log("PENNYLANE_CREDIT_NOTE_FINALIZED", logDetails);
    }

    if (result.email.status === "sent" && result.status === "created") {
      console.log("PENNYLANE_SANDBOX_CREDIT_NOTE_EMAIL_SENT", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_charge_id: charge.id,
        stripe_payment_intent_id: result.paymentIntentId,
        customer_email: result.customerEmail,
      });
    } else if (result.email.status === "error") {
      const emailError = result.email.error;

      console.error("PENNYLANE_CREDIT_NOTE_EMAIL_ERROR", {
        pennylane_credit_note_id: result.creditNoteId,
        pennylane_invoice_id: result.invoiceId,
        stripe_charge_id: charge.id,
        stripe_payment_intent_id: result.paymentIntentId,
        operation: emailError.operation ?? "send_credit_note_by_email",
        http_status: emailError.http_status,
        request_id: emailError.request_id,
        error_body: emailError.error_body,
        error_message:
          emailError.error_message ?? (emailError.error_body ? undefined : emailError.code),
      });
    }
  } catch (error) {
    console.error("PENNYLANE_CREDIT_NOTE_ERROR", {
      stripe_charge_id: charge.id,
      stripe_payment_intent_id: paymentIntentId ?? null,
      ...getPennylaneErrorDetails(error),
    });
  }
}

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const pennylaneToken = (env as typeof env & { PENNYLANE_API_TOKEN?: string }).PENNYLANE_API_TOKEN;
  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  if (!signature || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing Stripe signature or configuration." }, { status: 400 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        console.log("PAYMENT_SUCCEEDED", {
          session_id: session.id,
          payment_intent:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null),
          amount_total: session.amount_total,
          currency: session.currency,
          customer_email: session.customer_details?.email ?? session.customer_email ?? null,
        });

        await createPennylaneInvoice(stripe, session.id, pennylaneToken);
      } else {
        console.log("CHECKOUT_COMPLETED_NOT_PAID", {
          session_id: session.id,
          payment_status: session.payment_status,
        });
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;

      console.error("PAYMENT_FAILED", {
        payment_intent_id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        error_message: paymentIntent.last_payment_error?.message ?? null,
      });
      break;
    }

    case "checkout.session.expired": {
      const session = event.data.object;

      console.log("CHECKOUT_EXPIRED", { session_id: session.id });
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object;

      console.log("PAYMENT_REFUNDED", {
        charge_id: charge.id,
        payment_intent:
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null),
        amount_refunded: charge.amount_refunded,
        currency: charge.currency,
      });

      if (charge.amount_refunded !== charge.amount) {
        console.log("REFUND_PARTIAL_NOT_SUPPORTED", {
          stripe_charge_id: charge.id,
          amount: charge.amount,
          amount_refunded: charge.amount_refunded,
          currency: charge.currency,
        });
        break;
      }

      await createPennylaneCreditNote(stripe, charge, event.created, pennylaneToken);
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
