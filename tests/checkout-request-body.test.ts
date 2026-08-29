import assert from "node:assert/strict";
import test from "node:test";
import { isCheckoutRequestBody } from "../app/services/checkout-request";

test("checkout request body accepts a JSON object", () => {
  assert.equal(isCheckoutRequestBody({ items: [] }), true);
});

for (const [label, value] of [
  ["null", null],
  ["string", "items"],
  ["number", 1],
  ["array", []],
] as const) {
  test(`checkout request body rejects ${label}`, () => {
    assert.equal(isCheckoutRequestBody(value), false);
  });
}
