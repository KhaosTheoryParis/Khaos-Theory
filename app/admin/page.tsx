import type { Metadata } from "next";
import { headers } from "next/headers";
import { unauthorized } from "next/navigation";
import { verifyCloudflareAccess } from "../services/cloudflare-access";

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
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#050505",
        color: "#f2f2f2",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <section style={{ textAlign: "center" }}>
        <h1>Khaos Theory Admin</h1>
        <p>Authenticated</p>
      </section>
    </main>
  );
}
