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
import { DerivativesEngine, AuthManager, FUNDING_INTERVAL_MS } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

const adminKeys = AuthManager.generateKeyPair();
const oracleKeys = AuthManager.generateKeyPair();
const keeperKeys = AuthManager.generateKeyPair();

function createIntegratedEngine() {
  return new DerivativesEngine({
    adminPublicKey: adminKeys.publicKey,
    oraclePublicKey: oracleKeys.publicKey,
    keeperPublicKey: keeperKeys.publicKey
  });
}

function registerMarket(engine, symbol, initialPrice, insurance = 100_000n * WAD, timestamp = 0) {
  const intent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ADMIN",
    "REGISTER_MARKET",
    {
      symbol: symbol.toUpperCase(),
      initialPrice,
      maintenanceMarginBps: 500n,
      initialInsuranceFundUsd: insurance,
      initialTimestamp: timestamp
    },
    adminKeys.privateKey
  );

  return engine.registerMarket({
    signedIntent: intent,
    symbol,
    initialPrice,
    maintenanceMarginBps: 500n,
    initialInsuranceFundUsd: insurance,
    initialTimestamp: timestamp
  });
}

test("1. End-to-End Long Position Lifecycle (SDK -> Engine -> Protocol Settlement with Ed25519 Asymmetric Auth)", () => {
  const engine = createIntegratedEngine();
  registerMarket(engine, "ETH-USD", 3000n * WAD);

  const client = new QmoosaDerivativesClient();
  const aliceKeys = QmoosaDerivativesClient.generateKeyPair();

  // Verifiable account enrollment with asymmetric ownership proof
  const proof = client.createEnrollmentProof("0xAlice", aliceKeys.publicKey, aliceKeys.privateKey);
  engine.auth.enrollAccount(proof);

  // Build open payload with SDK, supplying Ed25519 privateKey to generate domain-bound SignedIntent
  const openPayload = client.buildOpenPositionPayload({
    account: "0xAlice",
    symbol: "ETH-USD",
    isLong: true,
    size: 2n * WAD,
    collateral: 600n * WAD, // 10x leverage on $6,000 notional
    leverage: 10n,
    nonce: 1n,
    privateKey: aliceKeys.privateKey
  });

  assert.ok(openPayload.signedIntent, "SDK must generate signed intent");

  const position = engine.openPosition({
    signedIntent: openPayload.signedIntent,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  assert.equal(position.account, "0xalice");
  assert.equal(position.size, 2n * WAD);
  assert.equal(position.collateral, 600n * WAD);

  // Market rallies to $3300 (+10% gain) - Oracle updates mark price with signed intent
  const oracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "ETH-USD", markPrice: 3300n * WAD, indexPrice: 3300n * WAD },
    oracleKeys.privateKey
  );
  engine.updatePrices({ signedIntent: oracleIntent, symbol: "ETH-USD", markPrice: 3300n * WAD, indexPrice: 3300n * WAD });

  // Build close payload with SDK
  const closePayload = client.buildClosePositionPayload({
    account: "0xAlice",
    positionId: position.id,
    nonce: 2n,
    privateKey: aliceKeys.privateKey
  });

  assert.ok(closePayload.signedIntent, "SDK must generate signed intent for position closure");

  // Engine executes authorized closePosition
  const receipt = engine.closePosition({
    signedIntent: closePayload.signedIntent,
    positionId: closePayload.positionId
  });

  assert.equal(receipt.realizedPnl, 600n * WAD); // 2 ETH * $300 profit = +$600
  assert.equal(receipt.finalPayout, 1200n * WAD); // $600 collateral + $600 profit
  assert.equal(engine.listPositions().length, 0);
});

test("2. End-to-End Short Position Lifecycle with Dynamic Funding Settlement and Insurance Balance", () => {
  const startTime = 1_000_000_000_000;
  const engine = createIntegratedEngine();
  registerMarket(engine, "BTC-USD", 60000n * WAD, 100_000n * WAD, startTime);

  const client = new QmoosaDerivativesClient();
  const bobKeys = QmoosaDerivativesClient.generateKeyPair();
  engine.auth.enrollAccount(client.createEnrollmentProof("0xBob", bobKeys.publicKey, bobKeys.privateKey));

  const openPayload = client.buildOpenPositionPayload({
    account: "0xBob",
    symbol: "BTC-USD",
    isLong: false,
    size: 1n * WAD,
    collateral: 6000n * WAD, // 10x leverage on $60,000 notional
    leverage: 10n,
    nonce: 1n,
    privateKey: bobKeys.privateKey
  });

  const position = engine.openPosition({
    signedIntent: openPayload.signedIntent,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  // Mark price trades above Index ($60600 vs $60000 = +100 bps premium)
  const oracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "BTC-USD", markPrice: 60600n * WAD, indexPrice: 60000n * WAD },
    oracleKeys.privateKey
  );
  engine.updatePrices({ signedIntent: oracleIntent, symbol: "BTC-USD", markPrice: 60600n * WAD, indexPrice: 60000n * WAD });
  const market = engine.getMarket("BTC-USD");
  assert.equal(market.fundingRateBps, 100n);

  // Settle funding cycle after full 8 hours with Keeper signed intent
  const keeperIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "KEEPER",
    "SETTLE_FUNDING",
    { symbol: "BTC-USD", currentTimestamp: startTime + FUNDING_INTERVAL_MS },
    keeperKeys.privateKey
  );

  const settlement = engine.settleFunding({
    signedIntent: keeperIntent,
    symbol: "BTC-USD",
    currentTimestamp: startTime + FUNDING_INTERVAL_MS
  });
  assert.equal(settlement.status, "SETTLED");
  assert.equal(settlement.settledPositions, 1);

  // In positive funding, short receives payment (accruedFunding becomes negative = credit)
  const updatedPos = engine.getPosition(position.id);
  assert.ok(updatedPos.accruedFunding < 0n);

  // Close position with authorization
  const closePayload = client.buildClosePositionPayload({
    account: "0xBob",
    positionId: position.id,
    nonce: 2n,
    privateKey: bobKeys.privateKey
  });

  const receipt = engine.closePosition({
    signedIntent: closePayload.signedIntent,
    positionId: position.id
  });
  assert.ok(receipt.finalPayout > 0n);
});

test("3. End-to-End Liquidation Cascade and Liquidator Reward Settlement", () => {
  const engine = createIntegratedEngine();
  registerMarket(engine, "SOL-USD", 200n * WAD);

  const client = new QmoosaDerivativesClient();
  const charlieKeys = QmoosaDerivativesClient.generateKeyPair();
  engine.auth.enrollAccount(client.createEnrollmentProof("0xCharlie", charlieKeys.publicKey, charlieKeys.privateKey));

  // Max leverage 20x: 10 SOL at $200 = $2,000 notional. Collateral = $100
  const openPayload = client.buildOpenPositionPayload({
    account: "0xCharlie",
    symbol: "SOL-USD",
    isLong: true,
    size: 10n * WAD,
    collateral: 100n * WAD,
    leverage: 20n,
    nonce: 1n,
    privateKey: charlieKeys.privateKey
  });

  const position = engine.openPosition({
    signedIntent: openPayload.signedIntent,
    symbol: openPayload.symbol,
    isLong: openPayload.isLong,
    size: openPayload.size,
    collateral: openPayload.collateral,
    leverage: openPayload.leverage
  });

  // Price drops by 4.5% to $191.00 -> triggers liquidation (Oracle updates price with signed intent)
  const oracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "SOL-USD", markPrice: 191n * WAD, indexPrice: 191n * WAD },
    oracleKeys.privateKey
  );
  engine.updatePrices({ signedIntent: oracleIntent, symbol: "SOL-USD", markPrice: 191n * WAD, indexPrice: 191n * WAD });

  // SDK builds liquidate payload
  const liqPayload = client.buildLiquidatePayload({
    liquidator: "0xLiquidatorAgent",
    positionId: position.id
  });

  const receipt = engine.liquidatePosition({
    positionId: liqPayload.positionId,
    liquidator: liqPayload.liquidator
  });
  assert.equal(receipt.liquidator, "0xliquidatoragent");
  assert.equal(receipt.liquidatedAccount, "0xcharlie");
  assert.equal(receipt.liquidationPrice, 191n * WAD);
  assert.equal(engine.listPositions().length, 0);
});
