import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = process.env.DATA_DIR ?? "./.test-data";

const { parseSnapshot } = await import("../src/changedetection.ts");
const { parseProductPage, stockToBool } = await import("../src/pricespy.ts");

test("parses a restock/price snapshot", () => {
  assert.deepEqual(parseSnapshot("In Stock: True - Price: 2899.0"), { inStock: true, price: 2899, raw: "In Stock: True - Price: 2899.0" });
  assert.equal(parseSnapshot("In Stock: False - Price: 1,234.50").price, 1234.5);
  assert.equal(parseSnapshot("In Stock: False - Price: 1,234.50").inStock, false);
});

test("text snapshots have no price or stock", () => {
  const s = parseSnapshot("This item cannot be dispatched to your selected delivery location.");
  assert.equal(s.price, null);
  assert.equal(s.inStock, null);
});

test("parses a PriceSpy product page", () => {
  const ld = JSON.stringify({ "@type": "Product", name: "Example Monitor 34", offers: { lowPrice: 1899, priceCurrency: "NZD" } });
  const rows = [
    { id: "100-A", shopId: 100, price: { amount: 1999, currency: "NZD" }, stockStatus: "OutOfStock", condition: "New", shop: { name: "Shop B" }, shipping: "$undefined", name: "Example 34 B" },
    { id: "200-B", shopId: 200, price: { amount: 1899, currency: "NZD" }, stockStatus: "InStock", condition: "New", shop: { name: "Shop A" }, shipping: { nodes: [{ price: { amount: 15 } }, { price: { amount: 0 } }] }, name: "Example 34 A" },
  ];
  // Offer rows appear as escaped JSON inside the page's streamed payload.
  const payload = JSON.stringify({ offerRows: rows }).replace(/"/g, '\\"');
  const html = `<html><script type="application/ld+json">${ld}</script><script>self.__next_f.push([1,"${payload}"])</script></html>`;
  const p = parseProductPage("123", html);
  assert.equal(p.name, "Example Monitor 34");
  assert.equal(p.lowPrice, 1899);
  assert.equal(p.offers.length, 2);
  assert.equal(p.offers[0].seller, "Shop A");
  assert.equal(p.offers[0].shipping, 0);
  assert.equal(p.offers[1].shipping, null);
  assert.equal(stockToBool(p.offers[0].stock), true);
  assert.equal(stockToBool(p.offers[1].stock), false);
});
