import Link from "next/link";

export default function NotFound() {
  return (
    <main className="login">
      <section className="login__card">
        <h1 className="login__title">Página no encontrada</h1>
        <p className="muted">La dirección no existe.</p>
        <Link className="button button--primary" href="/">
          Volver al inicio
        </Link>
      </section>
    </main>
  );
}
