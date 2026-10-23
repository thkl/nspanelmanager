import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panelConfigPath = resolve(projectRoot, "esphome/panel-unified.yaml");
const firmwareEntryPath = "esphome/nspanel-unified.yaml";
const firmwareOutputPath = resolve(projectRoot, "esphome/.esphome/build/nspanel/build/firmware.ota.bin");
const firmwareElfOutputPath = resolve(projectRoot, "esphome/.esphome/build/nspanel/build/firmware.elf");
const partitionTableOutputPath = resolve(projectRoot, "esphome/.esphome/build/nspanel/build/partition_table/partition-table.bin");
const visibleFirmwarePath = resolve(projectRoot, "esphome/nspanel-unified.bin");
const visibleFirmwareElfPath = resolve(projectRoot, "esphome/nspanel-unified.elf");
const visiblePartitionTablePath = resolve(projectRoot, "esphome/nspanel-unified.partitions.bin");
const temporaryFirmwarePath = resolve(projectRoot, "esphome/.nspanel-unified.bin.tmp");
const temporaryFirmwareElfPath = resolve(projectRoot, "esphome/.nspanel-unified.elf.tmp");
const temporaryPartitionTablePath = resolve(projectRoot, "esphome/.nspanel-unified.partitions.bin.tmp");
const firmwareBundlePath = resolve(projectRoot, "esphome/nspanel-unified.zip");
const temporaryBundlePath = resolve(projectRoot, "esphome/.nspanel-unified.zip.tmp");
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
  const firmwareElf = statSync(firmwareElfOutputPath);
  if (!firmwareElf.isFile() || firmwareElf.size === 0) throw new Error("The compiled ELF symbols are missing or empty.");
  const partitionTable = statSync(partitionTableOutputPath);
  if (!partitionTable.isFile() || partitionTable.size === 0) throw new Error("The compiled partition table is missing or empty.");
  copyFileSync(firmwareOutputPath, temporaryFirmwarePath);
  renameSync(temporaryFirmwarePath, visibleFirmwarePath);
  copyFileSync(firmwareElfOutputPath, temporaryFirmwareElfPath);
  renameSync(temporaryFirmwareElfPath, visibleFirmwareElfPath);
  copyFileSync(partitionTableOutputPath, temporaryPartitionTablePath);
  renameSync(temporaryPartitionTablePath, visiblePartitionTablePath);
  const firmwareBytes = readFileSync(visibleFirmwarePath);
  const manifestBytes = Buffer.from(JSON.stringify({
    format: "nspanel-unified-firmware",
    format_version: 1,
    version: nextVersion,
    firmware: "nspanel-unified.bin",
    sha256: createHash("sha256").update(firmwareBytes).digest("hex")
  }, null, 2));
  const bundle = createZip([
    { name: "manifest.json", bytes: manifestBytes },
    { name: "nspanel-unified.bin", bytes: firmwareBytes }
  ]);
  writeFileSync(temporaryBundlePath, bundle, { flag: "w" });
  renameSync(temporaryBundlePath, firmwareBundlePath);
} catch (error) {
  rmSync(temporaryFirmwarePath, { force: true });
  rmSync(temporaryFirmwareElfPath, { force: true });
  rmSync(temporaryPartitionTablePath, { force: true });
  rmSync(temporaryBundlePath, { force: true });
  console.error(`Could not prepare the firmware upload files: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const updatedSource = source.replace(versionLine[0], `${versionLine[1]}"${nextVersion}"`);
writeFileSync(panelConfigPath, updatedSource);
console.log(`Unified firmware version advanced to ${nextVersion}.`);
console.log("OTA image copied to esphome/nspanel-unified.bin.");
console.log("Matching ELF symbols copied to esphome/nspanel-unified.elf for crash dump analysis.");
console.log("Partition table copied to esphome/nspanel-unified.partitions.bin.");
console.log("Versioned firmware package created at esphome/nspanel-unified.zip.");

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const checksum = crc32(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
