"use client";

import { areUnitsCompatible } from "@bakery/domain";
import {
  PERMISSIONS as P,
  PRODUCTION_STATUS_LABELS,
  type ProductionAvailabilityDto,
  type ProductionOrderDto,
  type ProductionStatusDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchOptions, listPath } from "@/lib/api-client";
import {
  formatDecimal,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatUnitCost,
} from "@/lib/format";
import { toCostingUnit } from "../recipes/cost-views";
import { useCan } from "../user-context";

/*
 * Piezas comunes de Producción (Fase 4): estado, disponibilidad de materias
 * primas y los cuatro conceptos de costo, siempre separados y con nombre propio.
 */

export const PRODUCTION_BASE = "/produccion";

const STATUS_BADGE: Record<ProductionStatusDto, string> = {
  DRAFT: "badge badge--draft",
  PLANNED: "badge badge--info",
  IN_PROGRESS: "badge badge--warn",
  COMPLETED: "badge",
  CANCELLED: "badge badge--off",
};

export function ProductionStatusBadge({ status }: { status: ProductionStatusDto }) {
  return <span className={STATUS_BADGE[status]}>{PRODUCTION_STATUS_LABELS[status]}</span>;
}

/** Unidades activas de la empresa (para elegir en qué unidad se carga una cantidad). */
export function useUnits(): UnitDto[] | null {
  const [units, setUnits] = useState<UnitDto[] | null>(null);
  useEffect(() => {
    fetchOptions<UnitDto>("/api/units")
      .then(setUnits)
      .catch(() => setUnits([]));
  }, []);
  return units;
}

/** Unidades en las que se puede expresar una cantidad de `unitId` (misma magnitud). */
export function compatibleUnits(units: UnitDto[], unitId: string): UnitDto[] {
  const base = units.find((u) => u.id === unitId);
  if (!base) return [];
  const ref = toCostingUnit(base);
  return units.filter((u) => u.id === unitId || areUnitsCompatible(toCostingUnit(u), ref));
}

/** "Necesario / disponible / diferencia" por materia prima en el depósito de origen. */
export function AvailabilityTable({ availability }: { availability: ProductionAvailabilityDto }) {
  const can = useCan();
  const short = availability.lines.filter((l) => l.status === "SHORT");
  const canBuy = can(P.PURCHASES_CREATE);
  return (
    <>
      {short.length > 0 ? (
        <div className="alert alert--warn" role="status">
          <strong>Falta materia prima en {availability.warehouse.name}.</strong>{" "}
          {availability.basis === "ACTUAL"
            ? "No alcanza para el consumo cargado."
            : "Se puede planificar igual, pero no iniciar hasta que haya stock."}
          <ul>
            {short.map((l) => (
              <li key={l.rawMaterial.id}>
                {l.rawMaterial.name}: faltan {formatQuantity(l.missing, l.baseUnit.symbol)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted small">
          Hay stock suficiente de todas las materias primas en {availability.warehouse.name}.
        </p>
      )}
      <div className="table-wrap">
        <table className="table" aria-label="Disponibilidad de materias primas">
          <thead>
            <tr>
              <th scope="col">Materia prima</th>
              <th scope="col" className="num">
                {availability.basis === "ACTUAL" ? "A consumir" : "Necesario"}
              </th>
              <th scope="col" className="num">
                Disponible
              </th>
              <th scope="col" className="num">
                Diferencia
              </th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {availability.lines.map((l) => (
              <tr key={l.rawMaterial.id}>
                <td>
                  <Link href={`/stock/${l.rawMaterial.id}`}>{l.rawMaterial.name}</Link>
                </td>
                <td className="num">{formatQuantity(l.required, l.baseUnit.symbol)}</td>
                <td className="num">{formatQuantity(l.available, l.baseUnit.symbol)}</td>
                <td className={`num ${l.status === "SHORT" ? "text-negative" : ""}`}>
                  {formatQuantity(l.difference, l.baseUnit.symbol)}
                </td>
                <td>
                  {l.status === "SHORT" ? (
                    <>
                      <span className="badge badge--danger">Falta</span>
                      {canBuy && (
                        <>
                          {" "}
                          <Link
                            href={listPath("/compras/nueva", { rawMaterialId: l.rawMaterial.id })}
                          >
                            Comprar
                          </Link>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="badge">Alcanza</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Costos de la orden. Son cuatro conceptos distintos y nunca se mezclan:
 * esperado (fijado al planificar), estimado (consumo cargado, en curso),
 * real (fijado al completar) y la diferencia real − esperado.
 */
export function ProductionCosts({
  order,
  embedded = false,
}: {
  order: ProductionOrderDto;
  /** Dentro de otro panel (vista previa, revisión): sin marco propio. */
  embedded?: boolean;
}) {
  const costs = order.costs;
  if (!costs) return null;
  const unit = order.saleUnit.symbol;
  const c = costs.currency;
  const planned = costs.planned;
  const Wrapper = embedded ? "div" : "section";
  const Heading = embedded ? "h3" : "h2";
  return (
    <Wrapper className={embedded ? "costs-block" : "panel"} aria-labelledby="costs-title">
      <Heading id="costs-title">Costo material</Heading>
      <dl className="cost-summary cost-summary--costs">
        <div>
          <dt>
            {order.status === "DRAFT"
              ? "Costo esperado (se fija al planificar)"
              : "Costo esperado (fijado al planificar)"}
          </dt>
          <dd>
            {planned?.total ? formatMoney(planned.total, c) : "Incompleto"}
            {planned?.unit && (
              <span className="cost-summary__note"> {formatUnitCost(planned.unit, c, unit)}</span>
            )}
          </dd>
        </div>
        {costs.estimated && (
          <div>
            <dt>Costo estimado del consumo cargado</dt>
            <dd>
              {costs.estimated.total ? formatMoney(costs.estimated.total, c) : "Incompleto"}
              {costs.estimated.unit && (
                <span className="cost-summary__note">
                  {" "}
                  {formatUnitCost(costs.estimated.unit, c, unit)}
                </span>
              )}
            </dd>
          </div>
        )}
        {costs.actual && (
          <div>
            <dt>Costo real (fijado al completar)</dt>
            <dd>
              {formatMoney(costs.actual.total, c)}
              <span className="cost-summary__note">
                {" "}
                {formatUnitCost(costs.actual.unit, c, unit)}
              </span>
            </dd>
          </div>
        )}
        {costs.variance && (
          <div>
            <dt>Diferencia real − esperado</dt>
            <dd className={costs.variance.total.startsWith("-") ? "" : "text-negative"}>
              {formatMoney(costs.variance.total, c)}
              <span className="cost-summary__note">
                {" "}
                {formatUnitCost(costs.variance.unit, c, unit)}
                {costs.variance.percentage !== null &&
                  ` · ${formatPercent(costs.variance.percentage)}`}
              </span>
            </dd>
          </div>
        )}
      </dl>
      {planned && planned.status === "INCOMPLETE" && planned.missing.length > 0 && (
        <p className="muted small">
          Sin costo para: {planned.missing.join(", ")}. El costo esperado queda incompleto.
        </p>
      )}
      <p className="muted small">
        Sólo materias primas: no incluye mano de obra, energía ni gastos indirectos.{" "}
        {order.status === "IN_PROGRESS"
          ? "El estimado valoriza lo cargado al costo promedio de hoy; el real se fija al confirmar."
          : order.status === "COMPLETED"
            ? "El costo real es la suma de los consumos al costo promedio de inventario del momento."
            : "El costo esperado sale de la receta escalada con los costos de hoy."}
      </p>
    </Wrapper>
  );
}

/** Factor "×1,5" con hasta 4 decimales. */
export function formatFactor(value: string | null): string {
  return value === null ? "—" : `×${formatDecimal(value, 0, 4)}`;
}
