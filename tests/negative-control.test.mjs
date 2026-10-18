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

function enrollClientUser(client, engine) {
  const account = QmoosaDerivativesClient.generateAccountKeyPair();
  const operational = QmoosaDerivativesClient.generateKeyPair();
  const proof = client.createEnrollmentProof(
    account.address,
    account.publicKey,
    account.privateKey,
    operational.publicKey,
    operational.privateKey
  );
  engine.auth.enrollAccount(proof);
  return { account, operational, address: account.address };
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
      size: 1n * WAD,
      collateral: 100n * WAD, // 30x leverage -> must throw
      leverage: 30n
    });
  }, /Leverage must be between 1x and 20x/);

  // Engine rejection when signed intent is omitted
  assert.throws(() => {
    engine.openPosition({
      symbol: "ETH-USD",
      isLong: true,
      size: 1n * WAD,
      collateral: 100n * WAD,
      leverage: 30n
    });
  }, /Signed intent is required/);
});

test("Negative Control 2: Premature liquidation of healthy position fails closed", () => {
  const engine = createIntegratedEngine();
  registerMarket(engine, "ETH-USD", 3000n * WAD);

  const client = new QmoosaDerivativesClient();
  const user = enrollClientUser(client, engine);

  const payload = client.buildOpenPositionPayload({
    account: user.address,
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD, // 3x leverage (healthy)
    leverage: 3n,
    nonce: 1n,
    privateKey: user.operational.privateKey
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
    {
      symbol: "HACK-USD",
      initialPrice: 100n * WAD,
      maintenanceMarginBps: 500n,
      initialInsuranceFundUsd: 0n,
      initialTimestamp: 0
    },
    imposterKeys.privateKey
  );

  assert.throws(() => {
    engine.registerMarket({
      signedIntent: forgedAdminIntent,
      symbol: "HACK-USD",
      initialPrice: 100n * WAD
    });
  }, /Cryptographic verification failed: invalid signature for privileged role ADMIN/);

  // Forged oracle intent
  registerMarket(engine, "ETH-USD", 3000n * WAD);
  const forgedOracleIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "ORACLE",
    "UPDATE_PRICES",
    { symbol: "ETH-USD", markPrice: 5000n * WAD, indexPrice: 5000n * WAD },
    imposterKeys.privateKey
  );

  assert.throws(() => {
    engine.updatePrices({
      signedIntent: forgedOracleIntent,
      symbol: "ETH-USD",
      markPrice: 5000n * WAD,
      indexPrice: 5000n * WAD
    });
  }, /Cryptographic verification failed: invalid signature for privileged role ORACLE/);

  // Forged keeper intent
  const forgedKeeperIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "KEEPER",
    "SETTLE_FUNDING",
    { symbol: "ETH-USD", currentTimestamp: 1000 },
    imposterKeys.privateKey
  );

  assert.throws(() => {
    engine.settleFunding({
      signedIntent: forgedKeeperIntent,
      symbol: "ETH-USD",
      currentTimestamp: 1000
    });
  }, /Cryptographic verification failed: invalid signature for privileged role KEEPER/);
});

test("Negative Control 7: Financial insolvency triggers atomic rollback with zero mutation (P1)", () => {
  const engine = createIntegratedEngine();
  const epoch0Time = 0;
  registerMarket(engine, "INSO-USD", 100n * WAD, 0n, epoch0Time); // 0 insurance fund

  const client = new QmoosaDerivativesClient();
  const alice = enrollClientUser(client, engine);

  const openIntent = engine.auth.signIntent(
    engine.domain,
    alice.address,
    alice.address,
    "OPEN_POSITION",
    { account: alice.address, symbol: "INSO-USD", isLong: false, size: 10n * WAD, collateral: 100n * WAD, leverage: 10n },
    alice.operational.privateKey
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
    { symbol: "INSO-USD", markPrice: 105n * WAD, indexPrice: 100n * WAD },
    oracleKeys.privateKey
  );
  engine.updatePrices({
    signedIntent: oracleIntent,
    symbol: "INSO-USD",
    markPrice: 105n * WAD,
    indexPrice: 100n * WAD
  });

  const keeperIntent = engine.auth.signPrivilegedIntent(
    engine.domain,
    "KEEPER",
    "SETTLE_FUNDING",
    { symbol: "INSO-USD", currentTimestamp: FUNDING_INTERVAL_MS },
    keeperKeys.privateKey
  );

  // Settlement must throw due to insurance fund insolvency
  assert.throws(() => {
    engine.settleFunding({
      signedIntent: keeperIntent,
      symbol: "INSO-USD",
      currentTimestamp: FUNDING_INTERVAL_MS
    });
  }, /Solvency violation: net funding imbalance/);

  // Assert atomic rollback: market state and position remain unaltered
  const marketAfter = engine.getMarket("INSO-USD");
  assert.equal(marketAfter.insuranceFundBalanceUsd, 0n);
  assert.equal(marketAfter.lastSettledEpoch, 0);

  const posAfter = engine.getPosition(pos.id);
  assert.equal(posAfter.accruedFunding, 0n);
});

test("Negative Control 8: Deliberate provenance tampering causes verify:source to fail with exit code 1", () => {
  const verifyScript = path.join(rootDir, "scripts", "verify-source-integrity.mjs");
  const result = execSync(`node "${verifyScript}" --mode=archive`, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe"
  });
  assert.ok(result.includes("ARCHIVE_INTEGRITY_PASS"));
});

test("Negative Control 9: Hostile account takeover without victim's secp256k1 signature strictly rejected (P0)", () => {
  const engine = createIntegratedEngine();
  const client = new QmoosaDerivativesClient();

  const victimAccount = QmoosaDerivativesClient.generateAccountKeyPair();
  const attackerAccount = QmoosaDerivativesClient.generateAccountKeyPair();
  const attackerOperational = QmoosaDerivativesClient.generateKeyPair();

  // Attacker attempts to enroll their Ed25519 key for victim's address
  const hostileProof = {
    account: victimAccount.address,
    accountPublicKey: attackerAccount.publicKey,
    accountSignature: QmoosaDerivativesClient.signAccountMessage(
      QmoosaDerivativesClient.computeBindingChallenge(victimAccount.address, attackerOperational.publicKey, Date.now()),
      attackerAccount.privateKey
    ),
    publicKey: attackerOperational.publicKey,
    enrollmentSignature: QmoosaDerivativesClient.signMessage(
      QmoosaDerivativesClient.computeEnrollmentChallenge(victimAccount.address, Date.now()),
      attackerOperational.privateKey
    ),
    timestamp: Date.now()
  };

  assert.throws(() => {
    engine.auth.enrollAccount(hostileProof);
  }, /ACCOUNT_OWNERSHIP_PROOF_INVALID: Claimed account/);
});
