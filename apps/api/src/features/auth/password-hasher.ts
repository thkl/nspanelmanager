import { Algorithm, Version, hash, verify } from "@node-rs/argon2";
import { scrypt as callbackScrypt, timingSafeEqual } from "node:crypto";

const parameters = {
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
} as const;
const minimumPasswordLength = 12;
const legacyScrypt = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** Creates and checks adaptive Argon2id password hashes for local manager accounts. */
export class PasswordHasher {
  /** Hashes a new password with the current memory-hard Argon2id profile and a fresh salt. */
  async hash(password: string): Promise<string> {
    validatePassword(password);
    return hash(password, parameters);
  }

  /** Verifies a stored Argon2id PHC hash and treats malformed records as invalid credentials. */
  async verify(password: string, encoded: string): Promise<boolean> {
    if (encoded.startsWith("scrypt$")) return verifyLegacyScrypt(password, encoded);
    if (!encoded.startsWith("$argon2id$")) return false;
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  }
}

/** Verifies prototype scrypt hashes so existing local accounts can migrate on their next login. */
async function verifyLegacyScrypt(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || Number(parts[1]) !== legacyScrypt.N ||
    Number(parts[2]) !== legacyScrypt.r || Number(parts[3]) !== legacyScrypt.p) return false;
  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await new Promise<Buffer>((resolve, reject) => callbackScrypt(password, salt, expected.length, legacyScrypt, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    }));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Enforces password length bounds before hashing or verification. */
export function validatePassword(password: string): void {
  if (password.length < minimumPasswordLength || password.length > 1024) {
    throw new Error(`Passwords must contain between ${minimumPasswordLength} and 1024 characters.`);
  }
}
