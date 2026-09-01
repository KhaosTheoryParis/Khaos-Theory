import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isLocale } from "../i18n/config";
import { publicSiteUrl } from "../public/public-seo";
import "../../public/style.css";
import "./localized-home.css";

type LocaleRootLayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export const metadata: Metadata = {
  title: "Khaos Theory",
  metadataBase: publicSiteUrl,
  icons: {
    icon: [{ url: "/logo.jpeg", type: "image/jpeg" }],
  },
};

export default async function LocaleRootLayout({ children, params }: LocaleRootLayoutProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
