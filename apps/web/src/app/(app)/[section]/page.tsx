import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findUpcomingSection } from "@/lib/navigation";

type Params = Promise<{ section: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const item = findUpcomingSection((await params).section);
  return { title: item?.label ?? "No encontrado" };
}

/**
 * Módulos del roadmap que todavía no existen. No están en el menú; un enlace
 * directo explica que llegan más adelante, sin funcionalidad simulada.
 */
export default async function UpcomingSectionPage({ params }: { params: Params }) {
  const item = findUpcomingSection((await params).section);
  if (!item) notFound();

  return (
    <div className="page">
      <header className="page__header">
        <h1>{item.label}</h1>
      </header>
      <section className="panel panel--empty">
        <p className="upcoming">Disponible en próxima etapa</p>
        <p className="muted">Este módulo todavía no está habilitado.</p>
      </section>
    </div>
  );
}
