"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Email o contraseña incorrectos.",
  VALIDATION_ERROR: "Revisá el email y la contraseña.",
  RATE_LIMITED: "Demasiados intentos. Esperá un minuto y volvé a intentar.",
};

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (res.ok) {
        router.replace(nextPath);
        router.refresh();
        return;
      }
      const code =
        res.status === 429
          ? "RATE_LIMITED"
          : ((await res.json()) as { error?: { code?: string } }).error?.code;
      setError((code && MESSAGES[code]) ?? "No se pudo ingresar. Intentá nuevamente.");
    } catch {
      setError("No hay conexión con el servidor.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} noValidate>
      <label className="form__field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="username" required autoFocus />
      </label>
      <label className="form__field">
        <span>Contraseña</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
      <button className="button button--primary" type="submit" disabled={pending}>
        {pending ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
