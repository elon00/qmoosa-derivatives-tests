import { test } from "node:test";
import assert from "node:assert/strict";
import { WAD } from "@qmoosa/derivatives-protocol";
import { DerivativesEngine } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

test("Negative Control 1: Over-leverage attempt (>20x) strictly rejected across SDK and Engine", () => {
  const client = new QmoosaDerivativesClient();
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD);

  // SDK rejection
  assert.throws(() => {
    client.buildOpenPositionPayload({
      account: "0xAttacker",
      symbol: "ETH-USD",
      isLong: true,
      size: 10n * WAD,
      collateral: 100n * WAD,
      leverage: 50n // 50x not permitted
    });
  }, /Leverage must be between 1x and 20x/);

  // Engine direct rejection
  assert.throws(() => {
    engine.openPosition({
      account: "0xAttacker",
      symbol: "ETH-USD",
      isLong: true,
      size: 10n * WAD,
      collateral: 100n * WAD,
      leverage: 50n
    });
  }, /between 1x and 20x/);
});

test("Negative Control 2: Premature liquidation of healthy position fails closed", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD);

  const pos = engine.openPosition({
    account: "0xHonestUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD, // 3x leverage (very safe)
    leverage: 3n
  });

  // Malicious liquidation attempt
  assert.throws(() => {
    engine.liquidatePosition(pos.id, "0xPredator");
  }, /is healthy and cannot be liquidated/);

  // Position remains untouched
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 3: Liquidating non-existent position fails closed", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD);

  assert.throws(() => {
    engine.liquidatePosition("POS-NONEXISTENT-999", "0xPredator");
  }, /not found/);
});

test("Negative Control 4: Unconfigured SDK adapter fails closed with zero manufactured hashes", async () => {
  const client = new QmoosaDerivativesClient();
  const payload = client.buildClosePositionPayload({
    account: "0xUser",
    positionId: "POS-1"
  });

  await assert.rejects(
    () => client.sendTransaction(payload),
    /No chain adapter configured/
  );
});
