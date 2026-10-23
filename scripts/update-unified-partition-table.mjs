import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const firmwareEntryPath = "esphome/nspanel-unified.yaml";
const partitionTablePath = resolve(projectRoot, "esphome/nspanel-unified.partitions.bin");

if (!existsSync(partitionTablePath)) {
  console.error("The compiled partition table is missing. Run pnpm firmware:compile first.");
  process.exit(1);
}

console.log("Uploading the partition table over ESPHome OTA. The panel must already be running a firmware with allow_partition_access enabled.");
const upload = spawnSync("esphome", [
  "upload",
  "--partition-table",
  "--file", partitionTablePath,
  firmwareEntryPath
], { cwd: projectRoot, stdio: "inherit" });

if (upload.error) {
  console.error(`Could not start ESPHome: ${upload.error.message}`);
  process.exit(1);
}
if (upload.status !== 0) process.exit(upload.status ?? 1);

console.log("Partition table upload completed.");
