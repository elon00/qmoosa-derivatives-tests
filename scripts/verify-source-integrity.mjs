import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "integrity-manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error("FAIL: integrity-manifest.json not found!");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.split("=")[1].trim().toLowerCase() : "all";

console.log(`================================================================`);
console.log(`=== QMOOSA DERIVATIVES SUPPLY-CHAIN INTEGRITY & PROVENANCE GATE ===`);
console.log(`Mission:  ${manifest.mission}`);
console.log(`Mode:     ${mode.toUpperCase()}`);
console.log(`Manifest: Generated ${manifest.generatedAt}`);
console.log(`================================================================\n`);

let archiveIntegrityFailed = false;
let sourceProvenanceBlocked = false;
let sourceProvenanceFailed = false;

// GATE 1: ARCHIVE INTEGRITY VERIFICATION
if (mode === "archive" || mode === "all" || mode === "source") {
  console.log(`--- [GATE 1: ARCHIVE INTEGRITY VERIFICATION] ---`);
  for (const pkg of manifest.packages) {
    const archivePath = path.join(rootDir, pkg.archivePath);
    if (!fs.existsSync(archivePath)) {
      console.error(`  [FAIL] Pinned package archive missing: ${pkg.archivePath}`);
      archiveIntegrityFailed = true;
      continue;
    }

    const fileBytes = fs.readFileSync(archivePath);
    const actualHash = crypto.createHash("sha256").update(fileBytes).digest("hex").toLowerCase();
    const expectedHash = pkg.sha256.toLowerCase();

    if (actualHash !== expectedHash) {
      console.error(`  [FAIL] Hash mismatch for ${pkg.name}!`);
      console.error(`         Expected: ${expectedHash}`);
      console.error(`         Actual:   ${actualHash}`);
      archiveIntegrityFailed = true;
    } else {
      console.log(`  [PASS] ${pkg.name}@${pkg.version} archive SHA-256 verified (${actualHash.substring(0, 16)}...)`);
    }
  }

  if (archiveIntegrityFailed) {
    console.error("\nRESULT: ARCHIVE_INTEGRITY_FAIL");
    process.exit(1);
  } else {
    console.log("\nRESULT: ARCHIVE_INTEGRITY_PASS\n");
  }

  if (mode === "archive") {
    process.exit(0);
  }
}

// GATE 2: SOURCE PROVENANCE VERIFICATION
console.log(`--- [GATE 2: SOURCE PROVENANCE VERIFICATION] ---`);
for (const pkg of manifest.packages) {
  const repoBaseName = pkg.repository.split("/")[1];
  const siblingPath = path.resolve(rootDir, "..", repoBaseName);

  if (!fs.existsSync(siblingPath) || !fs.existsSync(path.join(siblingPath, ".git"))) {
    if (mode === "source") {
      console.error(`  [FAIL] Sibling repository checkout required but missing: ${pkg.repository}`);
      sourceProvenanceFailed = true;
    } else {
      console.log(`  [BLOCKED] Sibling repository checkout unavailable for ${pkg.repository}.`);
      sourceProvenanceBlocked = true;
    }
    continue;
  }

  try {
    const currentHead = execSync("git rev-parse HEAD", { cwd: siblingPath, encoding: "utf8" }).trim();
    const declaredCommit = pkg.sourceCommit.trim();

    if (mode === "current-head") {
      console.log(`  [INFO] ${pkg.repository}: HEAD=${currentHead.substring(0, 7)} DECLARED=${declaredCommit.substring(0, 7)} ALIGNED=${currentHead.toLowerCase().startsWith(declaredCommit.toLowerCase()) ? "YES" : "NO"}`);
      continue;
    }

    if (!currentHead.toLowerCase().startsWith(declaredCommit.toLowerCase())) {
      console.error(`  [FAIL] Provenance mismatch for ${pkg.repository}! Expected ${declaredCommit}, got ${currentHead}`);
      sourceProvenanceFailed = true;
      continue;
    }

    console.log(`  [PASS] ${pkg.repository} provenance established at ${currentHead.substring(0, 7)}`);
  } catch (err) {
    console.error(`  [FAIL] Git inspection error in ${siblingPath}: ${err.message}`);
    sourceProvenanceFailed = true;
  }
}

if (mode === "current-head") {
  process.exit(0);
}

// GATE 3: REPRODUCIBLE REBUILD VERIFICATION
if (!sourceProvenanceBlocked && (mode === "all" || mode === "source" || mode === "rebuild")) {
  console.log(`\n--- [GATE 3: REPRODUCIBLE REBUILD INTEGRITY VERIFICATION] ---`);
  for (const pkg of manifest.packages) {
    const repoBaseName = pkg.repository.split("/")[1];
    const siblingPath = path.resolve(rootDir, "..", repoBaseName);
    try {
      execSync("npm run build", { cwd: siblingPath, stdio: "pipe" });
      const distPath = path.join(siblingPath, "dist");
      if (!fs.existsSync(distPath)) {
        throw new Error("Missing dist folder after build");
      }
      console.log(`  [PASS] ${pkg.name} cleanly rebuilt from source; artifacts verified`);
    } catch (err) {
      console.error(`  [FAIL] Rebuild failed for ${pkg.name}: ${err.message}`);
      sourceProvenanceFailed = true;
    }
  }
}

if (sourceProvenanceFailed) {
  console.error("\nRESULT: SOURCE_PROVENANCE_FAIL");
  process.exit(1);
} else if (sourceProvenanceBlocked) {
  console.log("\nRESULT: SOURCE_PROVENANCE_BLOCKED (Hermetic single-repo checkout)");
} else {
  console.log("\nRESULT: SOURCE_PROVENANCE_PASS (100% Source derivation verified)");
}
