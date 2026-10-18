import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
let sourceProvenanceFailed = false;
let currentHeadFailed = false;

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

// GATE 2: STRICT FAIL-CLOSED SOURCE PROVENANCE & CURRENT-HEAD VERIFICATION
console.log(`--- [GATE 2: SOURCE PROVENANCE VERIFICATION] ---`);
for (const pkg of manifest.packages) {
  const repoBaseName = pkg.repository.split("/")[1];
  const siblingPath = path.resolve(rootDir, "..", repoBaseName);

  if (!fs.existsSync(siblingPath) || !fs.existsSync(path.join(siblingPath, ".git"))) {
    console.error(`  [FAIL] Strict reality-gate failure: sibling repository checkout required but missing: ${pkg.repository}`);
    sourceProvenanceFailed = true;
    currentHeadFailed = true;
    continue;
  }

  try {
    const currentHead = execSync("git rev-parse HEAD", { cwd: siblingPath, encoding: "utf8" }).trim();
    const declaredCommit = pkg.sourceCommit.trim();

    if (mode === "current-head") {
      const isAligned = currentHead.toLowerCase().startsWith(declaredCommit.toLowerCase());
      console.log(`  [${isAligned ? "PASS" : "FAIL"}] ${pkg.repository}: HEAD=${currentHead.substring(0, 7)} DECLARED=${declaredCommit.substring(0, 7)} ALIGNED=${isAligned ? "YES" : "NO"}`);
      if (!isAligned) {
        currentHeadFailed = true;
      }
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
    currentHeadFailed = true;
  }
}

if (mode === "current-head") {
  if (currentHeadFailed) {
    console.error("\nRESULT: CURRENT_HEAD_ALIGNMENT_FAIL (One or more repository heads differ from declared commit)");
    process.exit(1);
  } else {
    console.log("\nRESULT: CURRENT_HEAD_ALIGNMENT_PASS (All 3 sibling repository heads aligned)");
    process.exit(0);
  }
}

function getAllFiles(dir, base = "") {
  let res = [];
  if (!fs.existsSync(dir)) return res;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const rel = path.join(base, f);
    if (fs.statSync(full).isDirectory()) {
      res = res.concat(getAllFiles(full, rel));
    } else {
      res.push(rel);
    }
  }
  return res;
}

function verifyCanonicalArtifacts(siblingDistPath, archivePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qmoosa-artifact-"));
  try {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "pipe" });
    const archiveDist = path.join(tmpDir, "package", "dist");
    if (!fs.existsSync(archiveDist)) {
      throw new Error("Missing dist folder inside pinned package archive");
    }

    const archiveFiles = getAllFiles(archiveDist);
    const siblingFiles = getAllFiles(siblingDistPath);

    if (archiveFiles.length === 0) {
      throw new Error("No artifacts found in archive dist folder");
    }

    for (const file of archiveFiles) {
      const archFilePath = path.join(archiveDist, file);
      const sibFilePath = path.join(siblingDistPath, file);

      if (!fs.existsSync(sibFilePath)) {
        throw new Error(`File ${file} present in archive but missing from fresh build dist`);
      }

      const h1 = crypto.createHash("sha256").update(fs.readFileSync(archFilePath)).digest("hex");
      const h2 = crypto.createHash("sha256").update(fs.readFileSync(sibFilePath)).digest("hex");

      if (h1 !== h2) {
        throw new Error(`SHA-256 mismatch for compiled artifact ${file} (archive: ${h1}, fresh build: ${h2})`);
      }
    }

    for (const file of siblingFiles) {
      const archFilePath = path.join(archiveDist, file);
      if (!fs.existsSync(archFilePath)) {
        throw new Error(`File ${file} present in fresh build dist but missing from pinned archive`);
      }
    }

    return archiveFiles.length;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// GATE 3: REPRODUCIBLE REBUILD & CANONICAL ARTIFACT COMPARISON
if (mode === "all" || mode === "source" || mode === "rebuild") {
  console.log(`\n--- [GATE 3: REPRODUCIBLE REBUILD & CANONICAL ARTIFACT COMPARISON] ---`);
  for (const pkg of manifest.packages) {
    const repoBaseName = pkg.repository.split("/")[1];
    const siblingPath = path.resolve(rootDir, "..", repoBaseName);
    const archivePath = path.join(rootDir, pkg.archivePath);

    if (!fs.existsSync(siblingPath)) {
      console.error(`  [FAIL] Cannot rebuild: sibling path ${siblingPath} does not exist`);
      sourceProvenanceFailed = true;
      continue;
    }

    try {
      execSync("npm run build", { cwd: siblingPath, stdio: "pipe" });
      const distPath = path.join(siblingPath, "dist");
      if (!fs.existsSync(distPath)) {
        throw new Error("Missing dist folder after build");
      }

      const verifiedCount = verifyCanonicalArtifacts(distPath, archivePath);
      console.log(`  [PASS] ${pkg.name} cleanly rebuilt from source; ${verifiedCount} compiled artifacts verified against archive`);
    } catch (err) {
      console.error(`  [FAIL] Rebuild verification failed for ${pkg.name}: ${err.message}`);
      if (err.stdout) console.error(`         stdout: ${err.stdout.toString()}`);
      if (err.stderr) console.error(`         stderr: ${err.stderr.toString()}`);
      sourceProvenanceFailed = true;
    }
  }
}

if (sourceProvenanceFailed) {
  console.error("\nRESULT: SOURCE_PROVENANCE_FAIL (Fail-closed security gate triggered)");
  process.exit(1);
} else {
  console.log("\nRESULT: SOURCE_PROVENANCE_PASS (100% Hermetic source derivation and canonical artifact equality verified)");
}
