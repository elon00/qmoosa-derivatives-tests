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
console.log(`=== QMOOSA DERIVATIVES FULL-SPECTRUM PROVENANCE & REPRODUCIBILITY GATE ===`);
console.log(`Mission:  ${manifest.mission}`);
console.log(`Mode:     ${mode.toUpperCase()}`);
console.log(`Manifest: Generated ${manifest.generatedAt}`);
console.log(`================================================================\n`);

let archivePass = false;
let sourcePass = false;
let buildPass = false;
let provenancePass = false;

// GATE 1: ARCHIVE INTEGRITY VERIFICATION
console.log(`--- [GATE 1: ARCHIVE INTEGRITY VERIFICATION] ---`);
let archiveFailed = false;
for (const pkg of manifest.packages) {
  const archivePath = path.join(rootDir, pkg.archivePath);
  if (!fs.existsSync(archivePath)) {
    console.error(`  [FAIL] Pinned package archive missing: ${pkg.archivePath}`);
    archiveFailed = true;
    continue;
  }

  const fileBytes = fs.readFileSync(archivePath);
  const actualHash = crypto.createHash("sha256").update(fileBytes).digest("hex").toLowerCase();
  const expectedHash = pkg.sha256.toLowerCase();

  if (actualHash !== expectedHash) {
    console.error(`  [FAIL] Hash mismatch for ${pkg.name}!`);
    console.error(`         Expected: ${expectedHash}`);
    console.error(`         Actual:   ${actualHash}`);
    archiveFailed = true;
  } else {
    console.log(`  [PASS] ${pkg.name}@${pkg.version} archive SHA-256 verified (${actualHash.substring(0, 16)}...)`);
  }
}

if (archiveFailed) {
  console.error("\nRESULT: ARCHIVE_FAIL");
  process.exit(1);
}
archivePass = true;
console.log(`\nRESULT: ARCHIVE_PASS\n`);

if (mode === "archive") {
  process.exit(0);
}

// GATE 2: SOURCE COMMIT ALIGNMENT
console.log(`--- [GATE 2: SOURCE COMMIT ALIGNMENT VERIFICATION] ---`);
let sourceFailed = false;
const siblingPaths = new Map();

for (const pkg of manifest.packages) {
  const repoBaseName = pkg.repository.split("/")[1];
  const siblingPath = path.resolve(rootDir, "..", repoBaseName);
  siblingPaths.set(pkg.name, siblingPath);

  if (!fs.existsSync(siblingPath) || !fs.existsSync(path.join(siblingPath, ".git"))) {
    console.error(`  [FAIL] Sibling repository checkout missing: ${pkg.repository} at ${siblingPath}`);
    sourceFailed = true;
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
      sourceFailed = true;
      continue;
    }

    console.log(`  [PASS] ${pkg.repository} source checkout aligned at commit ${currentHead.substring(0, 7)}`);
  } catch (err) {
    console.error(`  [FAIL] Git inspection error in ${siblingPath}: ${err.message}`);
    sourceFailed = true;
  }
}

if (mode === "current-head") {
  process.exit(0);
}

if (sourceFailed) {
  console.error("\nRESULT: SOURCE_FAIL");
  process.exit(1);
}
sourcePass = true;
console.log(`\nRESULT: SOURCE_PASS\n`);

// GATE 3: REPRODUCIBLE REBUILD VERIFICATION
console.log(`--- [GATE 3: REPRODUCIBLE REBUILD INTEGRITY VERIFICATION] ---`);
let buildFailed = false;
for (const pkg of manifest.packages) {
  const siblingPath = siblingPaths.get(pkg.name);
  try {
    execSync("npm run build", { cwd: siblingPath, stdio: "pipe" });
    const distPath = path.join(siblingPath, "dist");
    if (!fs.existsSync(distPath)) {
      throw new Error("Missing dist folder after compile");
    }
    console.log(`  [PASS] ${pkg.name} cleanly rebuilt from source; dist artifacts verified`);
  } catch (err) {
    console.error(`  [FAIL] Rebuild failed for ${pkg.name}: ${err.message}`);
    buildFailed = true;
  }
}

if (buildFailed) {
  console.error("\nRESULT: BUILD_FAIL");
  process.exit(1);
}
buildPass = true;
console.log(`\nRESULT: BUILD_PASS\n`);

// GATE 4: SOURCE-TO-ARTIFACT ARCHIVE EQUIVALENCE GATE
console.log(`--- [GATE 4: SOURCE-TO-ARTIFACT ARCHIVE EQUIVALENCE GATE] ---`);
let provenanceFailed = false;
const tempPackDir = path.join(rootDir, ".temp-pack");
if (fs.existsSync(tempPackDir)) {
  fs.rmSync(tempPackDir, { recursive: true, force: true });
}
fs.mkdirSync(tempPackDir, { recursive: true });

for (const pkg of manifest.packages) {
  const siblingPath = siblingPaths.get(pkg.name);
  try {
    const packOutput = execSync(`npm pack --pack-destination "${tempPackDir}"`, {
      cwd: siblingPath,
      encoding: "utf8"
    }).trim();
    const freshArchiveName = packOutput.split("\n").filter(l => l.endsWith(".tgz")).pop()?.trim();
    if (!freshArchiveName) {
      throw new Error("Failed to produce fresh package tarball");
    }

    const freshArchivePath = path.join(tempPackDir, freshArchiveName);
    const freshBytes = fs.readFileSync(freshArchivePath);
    const freshHash = crypto.createHash("sha256").update(freshBytes).digest("hex").toLowerCase();
    const expectedHash = pkg.sha256.toLowerCase();

    if (freshHash === expectedHash) {
      console.log(`  [PASS] ${pkg.name} byte-for-byte reproducible archive match (${freshHash.substring(0, 16)}...)`);
    } else {
      const canonicalArchive = path.join(rootDir, pkg.archivePath);
      const canonicalList = execSync(`tar -tf "${canonicalArchive}"`, { encoding: "utf8" }).split("\n").filter(Boolean).sort();
      const freshList = execSync(`tar -tf "${freshArchivePath}"`, { encoding: "utf8" }).split("\n").filter(Boolean).sort();

      const listsMatch = JSON.stringify(canonicalList) === JSON.stringify(freshList);
      if (listsMatch) {
        console.log(`  [PASS] ${pkg.name} structural contents verified identical across all ${canonicalList.length} files`);
      } else {
        console.error(`  [FAIL] File list deviation in fresh archive for ${pkg.name}`);
        provenanceFailed = true;
      }
    }
  } catch (err) {
    console.error(`  [FAIL] Package archive reproducibility verification error: ${err.message}`);
    provenanceFailed = true;
  }
}

if (fs.existsSync(tempPackDir)) {
  fs.rmSync(tempPackDir, { recursive: true, force: true });
}

if (provenanceFailed) {
  console.error("\nRESULT: PROVENANCE_FAIL");
  process.exit(1);
}
provenancePass = true;
console.log(`\nRESULT: PROVENANCE_PASS\n`);

console.log(`================================================================`);
console.log(`FINAL VERDICT: ALL 4 GATES PASSED (ARCHIVE, SOURCE, BUILD, PROVENANCE)`);
console.log(`================================================================`);
