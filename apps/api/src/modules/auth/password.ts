import { hash, verify } from "@node-rs/argon2";

/**
 * Hash de contraseñas con Argon2id (librería madura @node-rs/argon2, parámetros
 * por defecto recomendados por OWASP). No hay criptografía propia aquí.
 * El algoritmo por defecto de la librería es Argon2id (verificado en tests).
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  return verify(passwordHash, plain);
}

/** Hash de referencia para igualar tiempos cuando el usuario no existe. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalization");
  return dummyHash;
}

export const MIN_PASSWORD_LENGTH = 8;
