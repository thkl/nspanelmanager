import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panelConfigPath = resolve(projectRoot, "esphome/panel5.yaml");
const source = readFileSync(panelConfigPath, "utf8");
const versionLine = source.match(/^([ \t]*firmware_version:[ \t]*)"(\d+)\.(\d+)\.(\d+)"$/m);

if (!versionLine) {
  console.error(`Could not find a numeric firmware_version in ${panelConfigPath}.`);
  process.exit(1);
}

const nextVersion = `${versionLine[2]}.${versionLine[3]}.${Number(versionLine[4]) + 1}`;
const compile = spawnSync("esphome", [
  "-s", "firmware_version", nextVersion,
  "compile", "esphome/nsp-livingroom.yaml"
], { cwd: projectRoot, stdio: "inherit" });

if (compile.error) {
  console.error(`Could not start ESPHome: ${compile.error.message}`);
  process.exit(1);
}
if (compile.status !== 0) process.exit(compile.status ?? 1);

const updatedSource = source.replace(versionLine[0], `${versionLine[1]}"${nextVersion}"`);
writeFileSync(panelConfigPath, updatedSource);
console.log(`Firmware version advanced to ${nextVersion}.`);
