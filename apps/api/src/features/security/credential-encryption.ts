import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const algorithm = "aes-256-gcm";
const authTagLength = 16;
const initializationVectorLength = 12;

/**
 * Describes the versioned JSON representation stored instead of a plaintext
 * reusable credential. The marker lets the store distinguish encrypted data
 * from pre-encryption configuration during its one-time migration.
 */
export interface EncryptedCredential {
  format: "nspanel-manager-secret";
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Describes a decrypted value and whether it must be rewritten in encrypted form. */
export interface DecryptedCredential {
  value: string;
  needsMigration: boolean;
}

/**
 * Encrypts reusable manager credentials with an externally stored 256-bit key.
 * The key is loaded from a secret file, kept only in process memory, and never
 * stored alongside the manager configuration. AES-GCM authenticates each
 * value so modified ciphertext is rejected during startup.
 */
export class CredentialEncryption {
  private constructor(private readonly key: Buffer) {}

  /** Loads a 32-byte hexadecimal key from the configured secret file. */
  static async fromFile(filePath: string): Promise<CredentialEncryption> {
    let encodedKey: string;
    try {
      encodedKey = (await readFile(filePath, "utf8")).trim();
    } catch {
      throw new Error(`Unable to read the credential encryption key file "${filePath}".`);
    }

    if (!/^[0-9a-f]{64}$/i.test(encodedKey)) {
      throw new Error(`Credential encryption key file "${filePath}" must contain exactly 32 bytes encoded as 64 hexadecimal characters.`);
    }

    return new CredentialEncryption(Buffer.from(encodedKey, "hex"));
  }

  /** Encrypts a non-empty secret for persistence; empty values remain empty. */
  encrypt(value: string, purpose = "broker-password"): "" | EncryptedCredential {
    if (!value) return "";

    const iv = randomBytes(initializationVectorLength);
    const cipher = createCipheriv(algorithm, this.key, iv, { authTagLength });
    // Bind ciphertext to its setting name so a valid encrypted token cannot be moved into another credential field.
    cipher.setAAD(associatedDataFor(purpose));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

    return {
      format: "nspanel-manager-secret",
      version: 1,
      algorithm,
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
  }

  /**
   * Decrypts a stored value or accepts a legacy plaintext string for migration.
   * Unknown envelope formats and authentication failures stop startup rather
   * than silently discarding a credential or replacing the saved configuration.
   */
  decryptStored(value: unknown, purpose = "broker-password"): DecryptedCredential {
    if (typeof value === "string") return { value, needsMigration: value.length > 0 };
    if (!isEncryptedCredential(value)) {
      throw new Error("A stored manager credential has an unsupported encrypted format.");
    }

    const iv = decodeBase64Url(value.iv, "initialization vector", initializationVectorLength);
    const authTag = decodeBase64Url(value.authTag, "authentication tag", authTagLength);
    const ciphertext = decodeBase64Url(value.ciphertext, "ciphertext");
    try {
      const decipher = createDecipheriv(algorithm, this.key, iv, { authTagLength });
      decipher.setAAD(associatedDataFor(purpose));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return { value: plaintext.toString("utf8"), needsMigration: false };
    } catch {
      throw new Error("Unable to decrypt a stored manager credential. Restore the original MANAGER_ENCRYPTION_KEY_FILE and manager data together.");
    }
  }
}

function associatedDataFor(purpose: string): Buffer {
  if (!/^[a-z0-9:-]{1,100}$/.test(purpose)) throw new Error("Credential encryption purpose is invalid.");
  return Buffer.from(`nspanel-manager:${purpose}:v1`, "utf8");
}

function isEncryptedCredential(value: unknown): value is EncryptedCredential {
  return isRecord(value) && value.format === "nspanel-manager-secret" && value.version === 1 &&
    value.algorithm === algorithm && typeof value.iv === "string" &&
    typeof value.authTag === "string" && typeof value.ciphertext === "string";
}

function decodeBase64Url(value: string, label: string, expectedLength?: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (!value || decoded.toString("base64url") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error(`A stored manager credential has an invalid ${label}.`);
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
