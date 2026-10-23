import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panelConfigPath = resolve(projectRoot, "esphome/panel-unified.yaml");
const firmwareEntryPath = "esphome/nspanel-unified.yaml";
const firmwareOutputPath = resolve(projectRoot, "esphome/.esphome/build/nspanel/build/firmware.ota.bin");
const visibleFirmwarePath = resolve(projectRoot, "esphome/nspanel-unified.bin");
const temporaryFirmwarePath = resolve(projectRoot, "esphome/.nspanel-unified.bin.tmp");
const source = readFileSync(panelConfigPath, "utf8");
const versionLine = source.match(/^([ \t]*firmware_version:[ \t]*)"(\d+)\.(\d+)\.(\d+)"$/m);

if (!versionLine) {
  console.error(`Could not find a numeric firmware_version in ${panelConfigPath}.`);
  process.exit(1);
}

const nextVersion = `${versionLine[2]}.${versionLine[3]}.${Number(versionLine[4]) + 1}`;
const compile = spawnSync("esphome", [
  "-s", "firmware_version", nextVersion,
  "compile", firmwareEntryPath
], { cwd: projectRoot, stdio: "inherit" });

if (compile.error) {
  console.error(`Could not start ESPHome: ${compile.error.message}`);
  process.exit(1);
}
if (compile.status !== 0) process.exit(compile.status ?? 1);

try {
  const firmware = statSync(firmwareOutputPath);
  if (!firmware.isFile() || firmware.size === 0) throw new Error("The compiled OTA image is missing or empty.");
  copyFileSync(firmwareOutputPath, temporaryFirmwarePath);
  renameSync(temporaryFirmwarePath, visibleFirmwarePath);
} catch (error) {
  rmSync(temporaryFirmwarePath, { force: true });
  console.error(`Could not copy the compiled OTA image to esphome/nspanel-unified.bin: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const updatedSource = source.replace(versionLine[0], `${versionLine[1]}"${nextVersion}"`);
writeFileSync(panelConfigPath, updatedSource);
console.log(`Unified firmware version advanced to ${nextVersion}.`);
console.log("OTA image copied to esphome/nspanel-unified.bin.");
