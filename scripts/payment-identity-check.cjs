const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync("src/shared/payment-identity.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: exportsObject });
const { paymentUnits, exactPaymentAmount, orderReference } = exportsObject;
let checks = 0;
function check(name, test) { test(); checks++; console.log("PASS:", name); }
check("full order UUID retained", () =>
  assert.equal(orderReference("a743af43-0f9a-7120-c62a-3e12b4a71bea"), "CL-A743AF43-0F9A-7120-C62A-3E12B4A71BEA"));
check("BTC satoshi", () => assert.equal(paymentUnits("0.00000001", "BTC"), 1n));
check("scientific-notation BTC", () => assert.equal(paymentUnits(1e-8, "BTC"), 1n));
check("USDC native precision", () => assert.equal(paymentUnits("150.000001", "USDC_ERC20"), 150000001n));
check("equal amounts normalize", () => assert.ok(exactPaymentAmount("1.00000000", 1, "BTC")));
check("adjacent BTC quotes do not collide", () => assert.equal(exactPaymentAmount("0.00100001", "0.00100002", "BTC"), false));
check("adjacent USDT quotes do not collide", () => assert.equal(exactPaymentAmount("150.000001", "150.000002", "USDT_ERC20"), false));
check("old broad tolerance is not accepted", () => assert.equal(exactPaymentAmount("150.000099", 150, "USDT_ERC20"), false));
for (const amount of ["-1", "NaN", "Infinity", "", "0", "1.0000001", "1e999"]) {
  check(`reject invalid/nonpayable USDC ${JSON.stringify(amount)}`, () =>
    assert.equal(exactPaymentAmount(amount, amount, "USDC_ERC20"), false));
}
console.log(`${checks} payment-identity checks passed. No database or blockchain calls made.`);
