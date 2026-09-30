import { createHash, randomBytes } from "node:crypto";

/** Token opaco de 256 bits generado por el CSPRNG del sistema. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** En base se guarda solo el SHA-256 del token, nunca el token. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
