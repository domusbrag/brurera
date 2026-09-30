import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api.server";
import { safeNextPath } from "@/lib/navigation";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(next);
  if (await getCurrentUser()) redirect(nextPath);

  return (
    <main className="login">
      <section className="login__card" aria-labelledby="login-title">
        <h1 id="login-title" className="login__title">
          Panificadora ERP
        </h1>
        <p className="login__subtitle">Ingresá con tu usuario</p>
        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
