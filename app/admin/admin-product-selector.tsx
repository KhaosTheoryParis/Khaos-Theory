"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fr } from "../i18n";
import type { PublicCategory } from "../i18n/types";
import { publicProductCatalog } from "../public/home-catalog";
import styles from "./admin.module.css";

const productIds = publicProductCatalog.map((product) => product.id);
const categoryOrder: readonly PublicCategory[] = ["rings", "bracelets", "earrings", "pendants"];

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase("fr-FR");
}

function CategoryCheckbox({
  category,
  productIds: categoryProductIds,
  selectedIds,
  onToggle,
}: {
  category: PublicCategory;
  productIds: string[];
  selectedIds: Set<string>;
  onToggle: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const selectedCount = categoryProductIds.filter((productId) => selectedIds.has(productId)).length;
  const checked = categoryProductIds.length > 0 && selectedCount === categoryProductIds.length;
  const indeterminate = selectedCount > 0 && !checked;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={styles.productSelectorCategory}>
      <input ref={checkboxRef} type="checkbox" checked={checked} onChange={onToggle} />
      <span>{fr.categories[category]}</span>
    </label>
  );
}

export default function AdminProductSelector() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(productIds));
  const containerRef = useRef<HTMLDivElement>(null);
  const allSelected = selectedIds.size === productIds.length;
  const selectedLabel = allSelected
    ? "Tous les produits"
    : `Produits sélectionnés (${selectedIds.size})`;

  const filteredProducts = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    if (!normalizedQuery) return publicProductCatalog;

    return publicProductCatalog.filter((product) => {
      const name = fr.home.products[product.id].name;
      return normalizeSearch(name).includes(normalizedQuery) || product.id.includes(normalizedQuery);
    });
  }, [query]);

  const visibleGroups = useMemo(
    () => categoryOrder
      .map((category) => ({
        category,
        products: filteredProducts.filter((product) => product.category === category),
        allProducts: publicProductCatalog.filter((product) => product.category === category),
      }))
      .filter((group) => group.products.length > 0),
    [filteredProducts],
  );

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggleProduct = (productId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  return (
    <div ref={containerRef} className={styles.productSelector}>
      <button
        type="button"
        className={styles.productSelectorTrigger}
        aria-expanded={open}
        aria-controls="admin-product-selector-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div id="admin-product-selector-panel" className={styles.productSelectorPanel}>
          <label className={styles.productSelectorSearch}>
            <span>Rechercher un produit…</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher un produit…"
              autoComplete="off"
            />
          </label>

          <div className={styles.productSelectorActions}>
            <button type="button" onClick={() => setSelectedIds(new Set(productIds))}>
              Tout sélectionner
            </button>
            <button type="button" onClick={() => setSelectedIds(new Set())}>
              Tout désélectionner
            </button>
          </div>

          {visibleGroups.length > 0 ? visibleGroups.map((group) => (
            <div key={group.category} className={styles.productSelectorGroup}>
              <CategoryCheckbox
                category={group.category}
                productIds={group.allProducts.map((product) => product.id)}
                selectedIds={selectedIds}
                onToggle={() => setSelectedIds((current) => {
                  const next = new Set(current);
                  const allSelected = group.allProducts.every((product) => next.has(product.id));
                  for (const product of group.allProducts) {
                    if (allSelected) next.delete(product.id);
                    else next.add(product.id);
                  }
                  return next;
                })}
              />
              <div className={styles.productSelectorList}>
                {group.products.map((product) => {
                  const name = fr.home.products[product.id].name;
                  return (
                    <label key={product.id} className={styles.productSelectorItem}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(product.id)}
                        onChange={() => toggleProduct(product.id)}
                      />
                      <span>{name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )) : <p className={styles.productSelectorEmpty}>Aucun produit trouvé.</p>}
        </div>
      )}
    </div>
  );
}
