import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import { localizedHref } from "../i18n/routes";

type PublicFooterProps = {
  locale: Locale;
};

export default function PublicFooter({ locale }: PublicFooterProps) {
  const dictionary = getDictionary(locale);

  return (
    <footer>
      <span>© 2026 {dictionary.brand}</span>
      <span>{dictionary.footer.city}</span>
      <a href={localizedHref(locale, "contact")}>{dictionary.footer.contact}</a>
      <a href={localizedHref(locale, "terms")}>{dictionary.common.terms}</a>
      <a href={localizedHref(locale, "privacy")}>{dictionary.common.privacy}</a>
      <a href={localizedHref(locale, "cookies")}>{dictionary.common.cookies}</a>
      <a href={localizedHref(locale, "legal")}>{dictionary.common.legalNotice}</a>
    </footer>
  );
}
