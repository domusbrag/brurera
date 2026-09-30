import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findNavItem } from "@/lib/navigation";

type Params = Promise<{ section: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const item = findNavItem((await params).section);
  return { title: item?.label ?? "No encontrado" };
}

/** Módulos del menú que todavía no están implementados. Sin funcionalidad simulada. */
export default async function UpcomingSectionPage({ params }: { params: Params }) {
  const item = findNavItem((await params).section);
  if (!item) notFound();

  return (
    <div className="page">
      <header className="page__header">
        <h1>{item.label}</h1>
      </header>
      <section className="panel panel--empty">
        <p className="upcoming">Disponible en próxima etapa</p>
        <p className="muted">Este módulo se implementa en la Fase {item.phase} del roadmap.</p>
      </section>
    </div>
  );
}
