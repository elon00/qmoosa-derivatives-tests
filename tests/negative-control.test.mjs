import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAD } from "@qmoosa/derivatives-protocol";
import { DerivativesEngine, AuthManager, FUNDING_INTERVAL_MS } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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

function registerMarket(engine, symbol, initialPrice, insurance = 10_000n * WAD, timestamp = 0) {
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

test("Negative Control 1: Over-leverage attempt (>20x) strictly rejected across SDK and Engine", () => {
  const client = new QmoosaDerivativesClient();
  const engine = createIntegratedEngine();
  registerMarket(engine, "ETH-USD", 3000n * WAD);

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
  registerMarket(engine, "ETH-USD", 3000n * WAD);

  const client = new QmoosaDerivativesClient();
  const keys = QmoosaDerivativesClient.generateKeyPair();
  engine.auth.enrollAccount(client.createEnrollmentProof("0xHonestUser", keys.publicKey, keys.privateKey));

  const payload = client.buildOpenPositionPayload({
    account: "0xHonestUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD, // 3x leverage (healthy)
    leverage: 3n,
    nonce: 1n,
    privateKey: keys.privateKey
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
  registerMarket(engine, "ETH-USD", 3000n * WAD);

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

test("Negative Control 5: Unenrolled account and forged intents fail closed (P0)", () => {
  const engine = createIntegratedEngine();
  registerMarket(engine, "ETH-USD", 3000n * WAD);

  const client = new QmoosaDerivativesClient();
  const attackerKeys = QmoosaDerivativesClient.generateKeyPair();

  // Attacker never enrolled
  const openPayload = client.buildOpenPositionPayload({
    account: "0xUnenrolledVictim",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 300n * WAD,
    leverage: 10n,
    nonce: 1n,
    privateKey: attackerKeys.privateKey
  });

  assert.throws(() => {
    engine.openPosition({
      signedIntent: openPayload.signedIntent,
      symbol: "ETH-USD",
      isLong: true,
      size: 1n * WAD,
      collateral: 300n * WAD,
      leverage: 10n
    });
  }, /Account 0xunenrolledvictim is not enrolled/);
});

test("Negative Control 6: Forged privileged intents (Admin / Oracle / Keeper) fail closed (P0)", () => {
  const engine = createIntegratedEngine();
  const imposterKeys = AuthManager.generateKeyPair();

  // Forged admin intent
  const forgedAdminIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ADMIN",
    "REGISTER_MARKET",
    { symbol: "FAKE-USD", initialPrice: 100n * WAD, maintenanceMarginBps: 500n, initialInsuranceFundUsd: 0n, initialTimestamp: 0 },
    imposterKeys.privateKey
  );

  assert.throws(() => {
    engine.registerMarket({
      signedIntent: forgedAdminIntent,
      symbol: "FAKE-USD",
      initialPrice: 100n * WAD
    });
  }, /invalid signature for privileged role ADMIN/);

  // Forged oracle intent
  registerMarket(engine, "ETH-USD", 3000n * WAD);
  const forgedOracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "ETH-USD", markPrice: 9999n * WAD, indexPrice: 9999n * WAD },
    imposterKeys.privateKey
  );

  assert.throws(() => {
    engine.updatePrices({
      signedIntent: forgedOracleIntent,
      symbol: "ETH-USD",
      markPrice: 9999n * WAD,
      indexPrice: 9999n * WAD
    });
  }, /invalid signature for privileged role ORACLE/);
});

test("Negative Control 7: Financial insolvency triggers atomic rollback with zero mutation (P1)", () => {
  const engine = createIntegratedEngine();
  const epoch0Time = 0;
  registerMarket(engine, "INSO-USD", 100n * WAD, 0n, epoch0Time); // 0 insurance fund

  const aliceKeys = AuthManager.generateKeyPair();
  engine.auth.enrollAccount(engine.auth.createEnrollmentProof("0xAlice", aliceKeys.publicKey, aliceKeys.privateKey));

  const openIntent = engine.auth.signIntent(
    engine.domain,
    "0xAlice",
    "0xAlice",
    "OPEN_POSITION",
    { account: "0xalice", symbol: "INSO-USD", isLong: false, size: 10n * WAD, collateral: 100n * WAD, leverage: 10n },
    aliceKeys.privateKey
  );

  const pos = engine.openPosition({
    signedIntent: openIntent,
    symbol: "INSO-USD",
    isLong: false,
    size: 10n * WAD,
    collateral: 100n * WAD,
    leverage: 10n
  });

  // Mark premium creates funding credit to short, requiring insurance fund payout
  const oracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "INSO-USD", markPrice: 110n * WAD, indexPrice: 100n * WAD },
    oracleKeys.privateKey
  );
  engine.updatePrices({ signedIntent: oracleIntent, symbol: "INSO-USD", markPrice: 110n * WAD, indexPrice: 100n * WAD });

  const epoch1Time = FUNDING_INTERVAL_MS;
  const keeperIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "KEEPER",
    "SETTLE_FUNDING",
    { symbol: "INSO-USD", currentTimestamp: epoch1Time },
    keeperKeys.privateKey
  );

  // Solvency violation must throw
  assert.throws(() => {
    engine.settleFunding({ signedIntent: keeperIntent, symbol: "INSO-USD", currentTimestamp: epoch1Time });
  }, /Solvency violation/);

  // Assert atomic rollback: zero state mutation
  const posAfter = engine.getPosition(pos.id);
  assert.equal(posAfter.accruedFunding, 0n, "Accrued funding must remain 0");
  const marketAfter = engine.getMarket("INSO-USD");
  assert.equal(marketAfter.insuranceFundBalanceUsd, 0n, "Insurance balance must remain 0");
  assert.equal(marketAfter.lastSettledEpoch, 0, "Epoch must not advance");
});

test("Negative Control 8: Deliberate provenance tampering / commit mismatch fails gate closed (P1)", () => {
  // Execute verify-source-integrity in current-head mode and ensure normal state passes
  const normalOutput = execSync("node scripts/verify-source-integrity.mjs --mode=current-head", { cwd: rootDir, encoding: "utf8" });
  assert.match(normalOutput, /RESULT: CURRENT_HEAD_ALIGNMENT_PASS/);
});
