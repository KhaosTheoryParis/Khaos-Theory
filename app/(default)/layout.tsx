import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Khaos Theory",
  icons: {
    icon: [{ url: "/logo.jpeg", type: "image/jpeg" }],
  },
};

export default function DefaultRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
