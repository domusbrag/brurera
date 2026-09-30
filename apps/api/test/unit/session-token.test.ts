import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken } from "../../src/modules/auth/session-token.js";

describe("tokens de sesión", () => {
  it("genera tokens de 256 bits distintos en cada llamada", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("el hash es determinístico, hex de 64 caracteres y distinto del token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });
});
