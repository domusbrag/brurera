/*
 * Emblema de la marca: una espiga de trigo dentro de un sello redondo, en tinta
 * sobre papel kraft (diseño «La Espiga», 2026-11). Lleva el nombre de la empresa
 * de la sesión, no uno fijo.
 */

export function EspigaMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden="true">
      <path d="M24 40V10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M24 14C19 14 16 10 16 7C20 7 24 10 24 14Z" fill="currentColor" />
      <path d="M24 14C29 14 32 10 32 7C28 7 24 10 24 14Z" fill="currentColor" />
      <path d="M24 21C18 21 14 17 14 13C19 13 24 17 24 21Z" fill="currentColor" />
      <path d="M24 21C30 21 34 17 34 13C29 13 24 17 24 21Z" fill="currentColor" />
      <path d="M24 28C18 28 14 24 14 20C19 20 24 24 24 28Z" fill="currentColor" />
      <path d="M24 28C30 28 34 24 34 20C29 20 24 24 24 28Z" fill="currentColor" />
    </svg>
  );
}

export function Brand({ company }: { company: string }) {
  return (
    <div className="flex flex-col items-center text-center text-kraft-ink select-none">
      <span className="mb-2 flex size-14 items-center justify-center rounded-full border-2 border-kraft-ink/80 bg-kraft-deep/40 shadow-inner">
        <EspigaMark />
      </span>
      <span className="font-display text-2xl leading-none font-bold tracking-wider uppercase [overflow-wrap:anywhere]">
        {company}
      </span>
      <span className="mt-1.5 flex items-center gap-2 text-[10px] font-bold tracking-[0.22em] text-kraft-ink/80 uppercase">
        <span className="h-px w-5 bg-kraft-ink/50" aria-hidden="true" />
        Panificadora artesanal
        <span className="h-px w-5 bg-kraft-ink/50" aria-hidden="true" />
      </span>
    </div>
  );
}
