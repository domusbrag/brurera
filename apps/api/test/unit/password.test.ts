import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password.js";

describe("hash de contraseñas", () => {
  it("usa Argon2id y nunca guarda el texto plano", async () => {
    const hash = await hashPassword("secreto-123");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("secreto-123");
  });

  it("verifica la contraseña correcta y rechaza la incorrecta", async () => {
    const hash = await hashPassword("secreto-123");
    expect(await verifyPassword(hash, "secreto-123")).toBe(true);
    expect(await verifyPassword(hash, "secreto-124")).toBe(false);
  });

  it("dos hashes de la misma contraseña difieren (salt)", async () => {
    expect(await hashPassword("x-password")).not.toBe(await hashPassword("x-password"));
  });
});
