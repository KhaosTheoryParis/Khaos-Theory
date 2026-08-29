"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import type { TranslationDictionary } from "../i18n";
import type { PublicProduct } from "./home-catalog";
import { ringSizes } from "./home-catalog";
import { addToHistoricalCart, readHistoricalCart, writeHistoricalCart } from "./historical-cart";

type ProductDetailProps = {
  product: PublicProduct;
  dictionary: TranslationDictionary;
};

export default function ProductDetail({ product, dictionary }: ProductDetailProps) {
  const [activeImage, setActiveImage] = useState(0);
  const [status, setStatus] = useState("");
  const copy = dictionary.home.products[product.id];
  const image = product.images[activeImage];

  function moveImage(direction: -1 | 1) {
    setActiveImage((current) => (current + direction + product.images.length) % product.images.length);
  }

  function addToCart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const size = Number(form.get("size"));
    const quantity = Number(form.get("quantity"));
    const selectedSize = ringSizes.find(([fr]) => fr === size);

    if (!selectedSize || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) return;

    try {
      const nextCart = addToHistoricalCart(
        readHistoricalCart(window.localStorage),
        { id: product.id, name: copy.name, price: product.price },
        size,
        selectedSize[1],
        quantity,
      );
      writeHistoricalCart(window.localStorage, nextCart);
      setStatus(dictionary.product.addedToKart);
    } catch {
      setStatus(dictionary.product.cartUnavailable);
    }
  }

  return (
    <section id="product-detail" className="product-detail" aria-labelledby="product-title">
      <div className="product-gallery">
        <div className="product-image-frame">
          <img className="product-main-image is-visible" src={image} alt={`${dictionary.brand} ${copy.name} — ${dictionary.product.photo} ${activeImage + 1}`} />
          {product.images.length > 1 && <>
            <button className="gallery-arrow gallery-arrow-previous" type="button" aria-label={dictionary.product.previousImage} onClick={() => moveImage(-1)}>←</button>
            <button className="gallery-arrow gallery-arrow-next" type="button" aria-label={dictionary.product.nextImage} onClick={() => moveImage(1)}>→</button>
          </>}
          <span className="gallery-counter" aria-live="polite">{activeImage + 1} / {product.images.length}</span>
        </div>
      </div>
      <div className="product-information">
        <h1 id="product-title" className="product-name">{copy.name}</h1>
        <p className="product-price">{product.price} €</p>
        <div className="product-craftsmanship">
          <p>{dictionary.product.craftsmanshipFirstParagraph}</p>
          <p>{dictionary.product.craftsmanshipSecondParagraph}</p>
        </div>
        <form className="add-to-cart-form" onSubmit={addToCart}>
          <label htmlFor="ring-size">{dictionary.product.size}</label>
          <select id="ring-size" name="size" defaultValue={String(ringSizes[0][0])} required>
            {ringSizes.map(([fr, us]) => <option value={fr} key={fr}>FR {fr} — US {us}</option>)}
          </select>
          <label htmlFor="ring-quantity">{dictionary.product.quantity}</label>
          <select id="ring-quantity" name="quantity" defaultValue="1" required>
            {[1, 2, 3, 4, 5].map((quantity) => <option value={quantity} key={quantity}>{quantity}</option>)}
          </select>
          <button className="add-to-cart-button" type="submit">{dictionary.product.addToKart}</button>
          <p className="add-to-cart-confirmation" aria-live="polite">{status}</p>
        </form>
        <p className="size-note">{dictionary.product.sizeNote}</p>
      </div>
    </section>
  );
}
