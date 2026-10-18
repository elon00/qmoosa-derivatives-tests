import { test } from "node:test";
import assert from "node:assert/strict";
import { WAD } from "@qmoosa/derivatives-protocol";
import { DerivativesEngine } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

const ADMIN = "0xAdmin";
const ORACLE = "0xOracle";
const KEEPER = "0xKeeper";

function createIntegratedEngine() {
  return new DerivativesEngine({
    admin: ADMIN,
    oracleSigner: ORACLE,
    keeperSigner: KEEPER
  });
}

test("Negative Control 1: Over-leverage attempt (>20x) strictly rejected across SDK and Engine", () => {
  const client = new QmoosaDerivativesClient();
  const engine = createIntegratedEngine();
  engine.registerMarket({ caller: ADMIN, symbol: "ETH-USD", initialPrice: 3000n * WAD });

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

  // Missing signed intent rejection in Engine
  assert.throws(() => {
    engine.openPosition({
      symbol: "ETH-USD",
      isLong: true,
      size: 10n * WAD,
      collateral: 100n * WAD,
      leverage: 50n
    });
  }, /Signed intent is required/);
});

test("Negative Control 2: Premature liquidation of healthy position fails closed", () => {
  const engine = createIntegratedEngine();
  engine.registerMarket({ caller: ADMIN, symbol: "ETH-USD", initialPrice: 3000n * WAD });

  const client = new QmoosaDerivativesClient();
  const secret = "honest-user-secret";
  engine.auth.registerAccountCredential("0xHonestUser", secret);

  const payload = client.buildOpenPositionPayload({
    account: "0xHonestUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD, // 3x leverage (healthy)
    leverage: 3n,
    nonce: 1n,
    secretKey: secret
  });

  const pos = engine.openPosition({
    signedIntent: payload.signedIntent,
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD,
    leverage: 3n
  });

  // Malicious liquidation attempt
  assert.throws(() => {
    engine.liquidatePosition({ positionId: pos.id, liquidator: "0xPredator" });
  }, /is healthy and cannot be liquidated/);

  // Position remains untouched
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 3: Liquidating non-existent position fails closed", () => {
  const engine = createIntegratedEngine();
  engine.registerMarket({ caller: ADMIN, symbol: "ETH-USD", initialPrice: 3000n * WAD });

  assert.throws(() => {
    engine.liquidatePosition({ positionId: "POS-NONEXISTENT-999", liquidator: "0xPredator" });
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

test("Negative Control 5: Unauthorized position closure by attacker fails closed", () => {
  const engine = createIntegratedEngine();
  engine.registerMarket({ caller: ADMIN, symbol: "ETH-USD", initialPrice: 3000n * WAD });

  const client = new QmoosaDerivativesClient();
  const ownerSecret = "real-owner-secret";
  const attackerSecret = "attacker-secret";
  engine.auth.registerAccountCredential("0xRealOwner", ownerSecret);
  engine.auth.registerAccountCredential("0xAttacker", attackerSecret);

  const openPayload = client.buildOpenPositionPayload({
    account: "0xRealOwner",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 500n * WAD,
    leverage: 6n,
    nonce: 1n,
    secretKey: ownerSecret
  });

  const pos = engine.openPosition({
    signedIntent: openPayload.signedIntent,
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 500n * WAD,
    leverage: 6n
  });

  // Attacker tries to forge close intent for RealOwner's position
  const attackerClosePayload = client.buildClosePositionPayload({
    account: "0xRealOwner",
    caller: "0xAttacker",
    positionId: pos.id,
    nonce: 1n,
    secretKey: attackerSecret
  });

  assert.throws(
    () => engine.closePosition({ signedIntent: attackerClosePayload.signedIntent, positionId: pos.id }),
    /Unauthorized: caller 0xattacker is not authorized for account 0xrealowner/
  );

  // Position remains intact
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 6: Premature duplicate funding settlement does not double-charge traders", () => {
  const startTime = 1_000_000_000_000;
  const engine = createIntegratedEngine();
  engine.registerMarket({
    caller: ADMIN,
    symbol: "ETH-USD",
    initialPrice: 3000n * WAD,
    maintenanceMarginBps: 500n,
    initialInsuranceFundUsd: 10_000n * WAD,
    initialTimestamp: startTime
  });

  const client = new QmoosaDerivativesClient();
  const traderSecret = "trader-secret";
  engine.auth.registerAccountCredential("0xTrader", traderSecret);

  const openPayload = client.buildOpenPositionPayload({
    account: "0xTrader",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 300n * WAD,
    leverage: 10n,
    nonce: 1n,
    secretKey: traderSecret
  });

  engine.openPosition({
    signedIntent: openPayload.signedIntent,
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 300n * WAD,
    leverage: 10n
  });

  // Premature settlement attempt after only 5 minutes
  const res = engine.settleFunding({
    caller: KEEPER,
    symbol: "ETH-USD",
    currentTimestamp: startTime + (5 * 60 * 1000)
  });
  assert.equal(res.status, "SKIPPED_INTERVAL_NOT_ELAPSED");
  assert.equal(res.settledPositions, 0);

  // Accrued funding remains 0
  const pos = engine.listPositions()[0];
  assert.equal(pos.accruedFunding, 0n);
});
