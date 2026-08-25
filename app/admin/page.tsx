import type { Metadata } from "next";
import { headers } from "next/headers";
import { unauthorized } from "next/navigation";
import { verifyCloudflareAccess } from "../services/cloudflare-access";
import styles from "./admin.module.css";
import RefundForm from "./refund-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Khaos Theory Admin",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const access = await verifyCloudflareAccess(await headers());

  if (!access.ok) unauthorized();

  return (
    <main className={styles.main}>
      <section className={styles.panel}>
        <header className={styles.header}>
          <h1>Khaos Theory Admin</h1>
          <p>Authenticated</p>
        </header>
        <RefundForm />
      </section>
    </main>
  );
}
