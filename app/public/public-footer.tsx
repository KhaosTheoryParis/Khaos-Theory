import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";

type PublicFooterProps = {
  locale: Locale;
};

export default function PublicFooter({ locale }: PublicFooterProps) {
  const dictionary = getDictionary(locale);

  return (
    <footer>
      <span>© 2026 {dictionary.brand}</span>
      <span>{dictionary.footer.city}</span>
      <a href="/legal.html">{dictionary.common.legalNotice}</a>
    </footer>
  );
}
