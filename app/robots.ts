import type { MetadataRoute } from "next";
import { publicUrl } from "./public/public-seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api/", "/fr/checkout", "/en/checkout", "/fr/success", "/en/success"],
    },
    sitemap: publicUrl("/sitemap.xml"),
  };
}
