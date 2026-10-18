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

test("Negative Control 5: Unauthorized position closure by non-owner fails closed", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD);

  const pos = engine.openPosition({
    account: "0xRealOwner",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 500n * WAD,
    leverage: 6n
  });

  // Malicious closure attempt by unapproved actor
  assert.throws(
    () => engine.closePosition({ caller: "0xImpersonator", positionId: pos.id }),
    /Unauthorized: caller 0xImpersonator is not authorized/
  );

  // Position remains intact
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 6: Premature duplicate funding settlement does not double-charge traders", () => {
  const startTime = 1_000_000_000_000;
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD, 500n, 0n, startTime);

  engine.openPosition({
    account: "0xTrader",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 300n * WAD,
    leverage: 10n
  });

  // Premature settlement attempt after only 5 minutes
  const res = engine.settleFunding("ETH-USD", startTime + (5 * 60 * 1000));
  assert.equal(res.status, "SKIPPED_INTERVAL_NOT_ELAPSED");
  assert.equal(res.settledPositions, 0);

  // Accrued funding remains 0
  const pos = engine.listPositions()[0];
  assert.equal(pos.accruedFunding, 0n);
});
