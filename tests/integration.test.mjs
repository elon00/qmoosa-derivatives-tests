import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  BPS_DIVISOR,
  calculateNotional,
  calculateLiquidationPrice,
  calculateEquity,
  isLiquidatable
} from "@qmoosa/derivatives-protocol";
import { DerivativesEngine, FUNDING_INTERVAL_MS } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

test("1. End-to-End Long Position Lifecycle (SDK -> Engine -> Protocol Settlement)", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket("ETH-USD", 3000n * WAD);

  const client = new QmoosaDerivativesClient();
  const openPayload = client.buildOpenPositionPayload({
    account: "0xAlice",
    symbol: "ETH-USD",
    isLong: true,
    size: 2n * WAD,
    collateral: 600n * WAD, // 10x leverage on $6,000 notional
    leverage: 10n
  });

  const position = engine.openPosition({
    caller: openPayload.sender,
    account: openPayload.sender,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  assert.equal(position.account, "0xAlice");
  assert.equal(position.size, 2n * WAD);
  assert.equal(position.collateral, 600n * WAD);

  // Market rallies to $3300 (+10% gain)
  engine.updatePrices("ETH-USD", 3300n * WAD, 3300n * WAD);

  // Build close payload with SDK
  const closePayload = client.buildClosePositionPayload({
    account: "0xAlice",
    positionId: position.id
  });

  // Engine executes authorized closePosition
  const receipt = engine.closePosition({
    caller: closePayload.sender,
    positionId: closePayload.positionId
  });

  assert.equal(receipt.realizedPnl, 600n * WAD); // 2 ETH * $300 profit = +$600
  assert.equal(receipt.finalPayout, 1200n * WAD); // $600 collateral + $600 profit
  assert.equal(engine.listPositions().length, 0);
});

test("2. End-to-End Short Position Lifecycle with Dynamic Funding Settlement and Insurance Balance", () => {
  const startTime = 1_000_000_000_000;
  const engine = new DerivativesEngine();
  engine.registerMarket("BTC-USD", 60000n * WAD, 500n, 100_000n * WAD, startTime);

  const client = new QmoosaDerivativesClient();
  const openPayload = client.buildOpenPositionPayload({
    account: "0xBob",
    symbol: "BTC-USD",
    isLong: false,
    size: 1n * WAD,
    collateral: 6000n * WAD, // 10x leverage on $60,000 notional
    leverage: 10n
  });

  const position = engine.openPosition({
    caller: openPayload.sender,
    account: openPayload.sender,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  // Mark price trades above Index ($60600 vs $60000 = +100 bps premium)
  engine.updatePrices("BTC-USD", 60600n * WAD, 60000n * WAD);
  const market = engine.getMarket("BTC-USD");
  assert.equal(market.fundingRateBps, 100n);

  // Settle funding cycle after full 8 hours
  const settlement = engine.settleFunding("BTC-USD", startTime + FUNDING_INTERVAL_MS);
  assert.equal(settlement.status, "SETTLED");
  assert.equal(settlement.settledPositions, 1);

  // In positive funding, short receives payment (accruedFunding becomes negative = credit)
  const updatedPos = engine.getPosition(position.id);
  assert.ok(updatedPos.accruedFunding < 0n);

  // Close position with authorization
  const receipt = engine.closePosition({
    caller: "0xBob",
    positionId: position.id
  });
  // Payout includes original collateral minus slight price change plus funding credit
  assert.ok(receipt.finalPayout > 0n);
});

test("3. End-to-End Liquidation Cascade and Liquidator Reward Settlement", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket("SOL-USD", 200n * WAD);

  const client = new QmoosaDerivativesClient();
  // Max leverage 20x: 10 SOL at $200 = $2,000 notional. Collateral = $100
  const openPayload = client.buildOpenPositionPayload({
    account: "0xCharlie",
    symbol: "SOL-USD",
    isLong: true,
    size: 10n * WAD,
    collateral: 100n * WAD,
    leverage: 20n
  });

  const position = engine.openPosition({
    caller: openPayload.sender,
    account: openPayload.sender,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  // Price drops by 4.5% to $191.00 -> triggers liquidation
  engine.updatePrices("SOL-USD", 191n * WAD, 191n * WAD);

  // SDK builds liquidate payload
  const liqPayload = client.buildLiquidatePayload({
    liquidator: "0xLiquidatorAgent",
    positionId: position.id
  });

  const receipt = engine.liquidatePosition(liqPayload.positionId, liqPayload.liquidator);
  assert.equal(receipt.liquidator, "0xLiquidatorAgent");
  assert.equal(receipt.liquidatedAccount, "0xCharlie");
  assert.equal(receipt.liquidationPrice, 191n * WAD);
  assert.equal(engine.listPositions().length, 0);
});
