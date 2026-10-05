"use client";

import {
  COVERAGE_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  REQUESTED_CONSERVATION_LABELS,
  formatLocalDateTime,
  instantToZonedLocal,
  timeZoneLabel,
  type CoverageStatusDto,
  type LineCoverageDto,
  type MaterialProjectionDto,
  type OrderStatusDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { formatQuantity } from "@/lib/format";
import { COVERAGE_TONE, ORDER_STATUS_TONE } from "@/lib/status";
import { StatusBadge } from "../ui/status";
import { LOTS_BASE, ConservationBadge } from "../lots/lot-shared";

/*
 * Piezas compartidas de Pedidos y Necesidades (Fase 5A): estados, cobertura,
 * hora de pared de la EMPRESA y la explicación de cobertura de cada producto.
 */

export const ORDERS_BASE = "/pedidos";
export const NEEDS_BASE = "/necesidades";

export function OrderStatusBadge({ status }: { status: OrderStatusDto }) {
  return <StatusBadge tone={ORDER_STATUS_TONE[status]}>{ORDER_STATUS_LABELS[status]}</StatusBadge>;
}

export function CoverageBadge({ coverage }: { coverage: CoverageStatusDto | null }) {
  if (coverage === null) return <span className="muted">Sin calcular</span>;
  return (
    <StatusBadge tone={COVERAGE_TONE[coverage]}>{COVERAGE_STATUS_LABELS[coverage]}</StatusBadge>
  );
}

/** "10/10/2026 10:00" a partir de la hora de pared ya calculada por la API. */
export function formatWallClock(local: string): string {
  return formatLocalDateTime(local);
}

/** Hora de pared de la empresa dentro de `days` días (para valores por defecto). */
export function wallClockIn(timeZone: string, days: number, hour = 10): string {
  const local = instantToZonedLocal(new Date(Date.now() + days * 86_400_000), timeZone);
  return `${local.slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
}

/**
 * Fecha y hora en la zona de la EMPRESA: dos campos (fecha y hora) que arman
 * "AAAA-MM-DDTHH:mm" sin pasar por `new Date()`, así el navegador no corre la
 * hora a su propia zona (deuda de Fase 4.5 corregida en 5A).
 */
export function WallClockInput({
  id,
  value,
  onChange,
  timeZone,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  timeZone: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [date = "", time = ""] = value.split("T");
  const emit = (d: string, t: string) => onChange(d && t ? `${d}T${t}` : d ? `${d}T` : "");
  return (
    <div className="input-group wall-clock">
      <input
        id={id}
        type="date"
        value={date}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => emit(e.target.value, time || "10:00")}
      />
      <input
        type="time"
        aria-label="Hora"
        value={time}
        step={60}
        onChange={(e) => emit(date, e.target.value.slice(0, 5))}
      />
      <span className="muted small" title={timeZone}>
        hora de {timeZoneLabel(timeZone)}
      </span>
    </div>
  );
}

export const isCompleteWallClock = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);

const gt0 = (v: string | null | undefined) => v !== null && v !== undefined && new D(v).gt(0);

/** Cobertura de un producto: números y explicación en palabras, con sus lotes. */
export function LineCoverage({
  line,
  showLots = true,
}: {
  line: LineCoverageDto;
  showLots?: boolean;
}) {
  const unit = line.unit.symbol;
  return (
    <article className="card" data-testid="line-coverage">
      <h3 className="card__title">
        {line.product.name}{" "}
        {line.requestedConservation !== "ANY" && (
          <span className="badge badge--info">
            {REQUESTED_CONSERVATION_LABELS[line.requestedConservation]}
          </span>
        )}
      </h3>
      <dl className="cost-summary">
        <div>
          <dt>Pedido</dt>
          <dd>{formatQuantity(line.requested, unit)}</dd>
        </div>
        <div>
          <dt>Stock físico</dt>
          <dd>{formatQuantity(line.physical, unit)}</dd>
        </div>
        <div>
          <dt>Stock válido para la fecha</dt>
          <dd>{formatQuantity(line.eligible, unit)}</dd>
        </div>
        <div>
          <dt>Ya comprometido</dt>
          <dd>{formatQuantity(line.committed, unit)}</dd>
        </div>
        <div>
          <dt>Disponible</dt>
          <dd>{formatQuantity(line.available, unit)}</dd>
        </div>
        <div>
          <dt>Reservado para este pedido</dt>
          <dd>
            <strong>{formatQuantity(line.reserve, unit)}</strong>
          </dd>
        </div>
        <div>
          <dt>Falta producir</dt>
          <dd className={gt0(line.toProduce) ? "text-negative" : undefined}>
            {formatQuantity(line.toProduce, unit)}
          </dd>
        </div>
        {gt0(line.uncovered) && (
          <div>
            <dt>Sin cubrir (sin receta)</dt>
            <dd className="text-negative">{formatQuantity(line.uncovered, unit)}</dd>
          </div>
        )}
      </dl>
      <ul className="check-list" aria-label={`Explicación de ${line.product.name}`}>
        {line.explanation.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {line.materials.length > 0 && (
        <p className="muted small">
          Para producir lo que falta:{" "}
          {line.materials
            .map((m) => `${formatQuantity(m.required, m.unit.symbol)} de ${m.rawMaterial.name}`)
            .join(", ")}
          {line.recipe && ` (receta versión ${line.recipe.versionNumber})`}.
        </p>
      )}
      {showLots && line.lots.length > 0 && (
        <details>
          <summary>Lotes ({line.lots.length})</summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Lote</th>
                  <th scope="col">Conservación</th>
                  <th scope="col" className="num">
                    Físico
                  </th>
                  <th scope="col" className="num">
                    Ya comprometido
                  </th>
                  <th scope="col" className="num">
                    Reservado aquí
                  </th>
                  <th scope="col">Para la fecha</th>
                </tr>
              </thead>
              <tbody>
                {line.lots.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={`${LOTS_BASE}/${l.id}`}>{l.code}</Link>
                    </td>
                    <td>
                      <ConservationBadge state={l.conservationState} />
                    </td>
                    <td className="num">{formatQuantity(l.physical, unit)}</td>
                    <td className="num">{formatQuantity(l.committed, unit)}</td>
                    <td className="num">
                      {gt0(l.reserve) ? formatQuantity(l.reserve, unit) : "—"}
                    </td>
                    <td>
                      {l.eligible ? (
                        l.usableUntil === null ? (
                          <span className="muted">Sin vida útil configurada</span>
                        ) : (
                          "Sirve"
                        )
                      ) : (
                        <span className="text-negative">
                          {l.reason === "EXPIRED"
                            ? "Vence antes"
                            : l.reason === "BLOCKED"
                              ? "Bloqueado"
                              : "Otra conservación"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  );
}

/** Materias primas que requiere lo que falta producir, contra stock y demás pedidos. */
export function MaterialProjection({ materials }: { materials: MaterialProjectionDto[] }) {
  if (materials.length === 0) {
    return <p className="muted">No hace falta materia prima: no hay nada para producir.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Materias primas necesarias">
        <thead>
          <tr>
            <th scope="col">Materia prima</th>
            <th scope="col" className="num">
              Necesita este pedido
            </th>
            <th scope="col" className="num hide-sm">
              Otros pedidos
            </th>
            <th scope="col" className="num">
              Stock
            </th>
            <th scope="col" className="num">
              Falta comprar
            </th>
            <th scope="col" className="hide-md">
              Proveedor sugerido
            </th>
          </tr>
        </thead>
        <tbody>
          {materials.map((m) => (
            <tr key={m.rawMaterial.id}>
              <td>{m.rawMaterial.name}</td>
              <td className="num">{formatQuantity(m.required, m.unit.symbol)}</td>
              <td className="num hide-sm">{formatQuantity(m.otherOrdersDemand, m.unit.symbol)}</td>
              <td className="num">{formatQuantity(m.currentStock, m.unit.symbol)}</td>
              <td className={`num ${gt0(m.projectedShortage) ? "text-negative" : ""}`}>
                {gt0(m.projectedShortage)
                  ? formatQuantity(m.projectedShortage, m.unit.symbol)
                  : "—"}
              </td>
              <td className="hide-md">{m.preferredSupplier?.name ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
