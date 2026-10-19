import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Creates a private credential-encryption key without replacing an existing key. */
async function createEncryptionKey(): Promise<void> {
  const outputPath = path.resolve(
    process.argv[2] ?? path.resolve(process.cwd(), "../../secrets/manager_encryption_key")
  );
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const key = `${randomBytes(32).toString("hex")}\n`;

  try {
    await writeFile(outputPath, key, { flag: "wx", mode: 0o600 });
    await chmod(outputPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to replace the existing credential encryption key at "${outputPath}".`);
    }
    throw error;
  }

  console.info(`Created credential encryption key at ${outputPath}. Keep it outside the manager data volume and back it up securely.`);
}

void createEncryptionKey().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
