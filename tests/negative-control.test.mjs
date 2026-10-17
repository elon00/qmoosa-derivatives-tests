import { test } from "node:test";
import assert from "node:assert/strict";
import { WAD } from "@qmoosa/derivatives-protocol";
import { DerivativesEngine, DeterministicClock } from "@qmoosa/derivatives-engine";
import { QmoosaDerivativesClient } from "@qmoosa/derivatives-sdk";

const ADMIN_AUTH = { actor: "0xAdmin", role: "ADMIN" };
const USER_AUTH = { actor: "0xUser", role: "USER" };
const ATTACKER_AUTH = { actor: "0xAttacker", role: "USER" };

test("Negative Control 1: Over-leverage attempt (>20x) strictly rejected across SDK and Engine", () => {
  const client = new QmoosaDerivativesClient();
  const engine = new DerivativesEngine();
  engine.registerMarket(ADMIN_AUTH, "ETH-USD", 3000n * WAD);

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
    engine.openPosition(ATTACKER_AUTH, {
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
  engine.registerMarket(ADMIN_AUTH, "ETH-USD", 3000n * WAD);

  const pos = engine.openPosition(USER_AUTH, {
    account: "0xUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 1000n * WAD, // 3x leverage (very safe)
    leverage: 3n
  });

  // Malicious liquidation attempt
  assert.throws(() => {
    engine.liquidatePosition(ATTACKER_AUTH, pos.id);
  }, /is healthy and cannot be liquidated/);

  // Position remains untouched
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 3: Liquidating non-existent position fails closed", () => {
  const engine = new DerivativesEngine();
  engine.registerMarket(ADMIN_AUTH, "ETH-USD", 3000n * WAD);

  assert.throws(() => {
    engine.liquidatePosition(ATTACKER_AUTH, "POS-NONEXISTENT-999");
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
  engine.registerMarket(ADMIN_AUTH, "ETH-USD", 3000n * WAD);

  const pos = engine.openPosition(USER_AUTH, {
    account: "0xUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 500n * WAD,
    leverage: 6n
  });

  // Malicious closure attempt by unapproved actor
  assert.throws(
    () => engine.closePosition(ATTACKER_AUTH, pos.id),
    /Unauthorized: actor 0xAttacker cannot close position/
  );

  // Position remains intact
  assert.equal(engine.listPositions().length, 1);
});

test("Negative Control 6: Premature duplicate funding settlement in same epoch is skipped without double-charging", () => {
  const clock = new DeterministicClock(1_700_000_000_000);
  const engine = new DerivativesEngine(clock);
  engine.registerMarket(ADMIN_AUTH, "ETH-USD", 3000n * WAD, 500n, 0n);

  engine.openPosition(USER_AUTH, {
    account: "0xUser",
    symbol: "ETH-USD",
    isLong: true,
    size: 1n * WAD,
    collateral: 300n * WAD,
    leverage: 10n
  });

  // Premature settlement attempt (clock has not advanced to next 8-hour epoch)
  const res = engine.settleFunding("ETH-USD");
  assert.equal(res.status, "SKIPPED_DUPLICATE_EPOCH");
  assert.equal(res.settledPositions, 0);

  // Accrued funding remains 0
  const pos = engine.listPositions()[0];
  assert.equal(pos.accruedFunding, 0n);
});
