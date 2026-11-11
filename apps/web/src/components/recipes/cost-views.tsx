"use client";

import type { CostingUnit } from "@bakery/domain";
import {
  COST_SOURCE_LABELS,
  RECIPE_VERSION_STATUS_LABELS,
  type CostSourceDto,
  type CostSnapshotDto,
  type CostVariationDto,
  type RecipeVersionDiffDto,
  type RecipeVersionStatus,
  type TheoreticalCostDto,
  type UnitDto,
} from "@bakery/shared";
import { RECIPE_VERSION_TONE } from "@/lib/status";
import { StatusBadge } from "../ui/status";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  formatMoney,
  formatPercent,
  formatQuantity,
  formatReferenceCost,
  formatUnitCost,
} from "@/lib/format";
import { ConfirmAction } from "../masters/ui";

/*
 * Piezas de UI de costos de recetas. No calculan nada: muestran resultados del
 * dominio (@bakery/domain), ya sea calculados por la API o, en el editor, por
 * las mismas funciones puras en el navegador.
 */

/** UnitDto de la API → unidad que entiende el dominio de conversiones. */
export function toCostingUnit(u: UnitDto): CostingUnit {
  return {
    id: u.id,
    code: u.code,
    symbol: u.symbol,
    dimension: u.dimension,
    baseUnitId: u.baseUnit?.id ?? null,
    conversionFactor: u.conversionFactor,
  };
}

export function VersionStatusBadge({ status }: { status: RecipeVersionStatus }) {
  return (
    <StatusBadge tone={RECIPE_VERSION_TONE[status]}>
      {RECIPE_VERSION_STATUS_LABELS[status]}
    </StatusBadge>
  );
}

export function IncompleteCostAlert({ missing }: { missing: { rawMaterialName: string }[] }) {
  return (
    <div className="alert alert--warn" role="status">
      <strong>Costo teórico incompleto.</strong>
      {missing.length > 0 ? (
        <>
          {" "}
          Falta costo para:
          <ul>
            {missing.map((m) => (
              <li key={m.rawMaterialName}>{m.rawMaterialName}</li>
            ))}
          </ul>
        </>
      ) : (
        " Agregá ingredientes para calcularlo."
      )}
    </div>
  );
}

/** Costo por unidad base usado en el cálculo, con su procedencia (promedio de compras o referencia manual). */
function UsedCost({
  cost,
  source,
  currency,
  unitSymbol,
}: {
  cost: string | null;
  source: CostSourceDto | null;
  currency: string;
  unitSymbol: string;
}) {
  if (cost === null) return <span className="badge badge--warn">Sin costo</span>;
  return (
    <>
      {formatReferenceCost(cost, currency, unitSymbol)}
      {source && <span className="cost-source">{COST_SOURCE_LABELS[source]}</span>}
    </>
  );
}

/** Tabla Materia prima | Cantidad | Costo usado | Costo del ingrediente. */
export function IngredientCostTable({ cost }: { cost: TheoreticalCostDto }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Materia prima</th>
            <th scope="col" className="num">
              Cantidad
            </th>
            <th scope="col" className="num">
              Costo usado
            </th>
            <th scope="col" className="num">
              Costo del ingrediente
            </th>
          </tr>
        </thead>
        <tbody>
          {cost.ingredients.map((line) => (
            <tr key={line.rawMaterialId}>
              <td>{line.rawMaterialName}</td>
              <td className="num">
                {formatQuantity(line.quantity, line.unit.symbol)}
                {line.unit.id !== line.baseUnit.id && (
                  <span className="muted">
                    {" "}
                    ({formatQuantity(line.normalizedQuantity, line.baseUnit.symbol)})
                  </span>
                )}
              </td>
              <td className="num">
                <UsedCost
                  cost={line.referenceCost}
                  source={line.costSource}
                  currency={cost.currency}
                  unitSymbol={line.baseUnit.symbol}
                />
              </td>
              <td className="num">
                {line.cost === null ? "—" : formatMoney(line.cost, cost.currency)}
              </td>
            </tr>
          ))}
        </tbody>
        {cost.ingredients.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={3}>Costo del lote</td>
              <td className="num">
                {cost.totalCost === null
                  ? "Incompleto"
                  : formatMoney(cost.totalCost, cost.currency)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Variation({ variation }: { variation: CostVariationDto }) {
  const up = !variation.amount.startsWith("-") && variation.amount.replace(/[0.]/g, "") !== "";
  return (
    <span className={up ? "text-negative" : "text-positive"}>
      {up ? "+" : ""}
      {variation.percentage === null ? "—" : formatPercent(variation.percentage)}
    </span>
  );
}

/**
 * Resumen: costo del lote, rendimiento, costo por unidad de venta, precio y
 * margen bruto teórico. Con snapshot, muestra además el costo al publicar.
 */
export function CostSummary({
  cost,
  snapshot,
  variation,
  currentLabel = "actual",
}: {
  cost: TheoreticalCostDto;
  snapshot?: CostSnapshotDto | null;
  variation?: CostVariationDto | null;
  currentLabel?: string;
}) {
  const sale = cost.saleUnit.symbol;
  const sameUnit = cost.yieldUnit.id === cost.saleUnit.id;
  return (
    <>
      {cost.status === "INCOMPLETE" && <IncompleteCostAlert missing={cost.missingCosts} />}
      <dl className="cost-summary">
        <div>
          <dt>Costo del lote ({currentLabel})</dt>
          <dd>
            {cost.totalCost === null ? "Incompleto" : formatMoney(cost.totalCost, cost.currency)}
          </dd>
        </div>
        <div>
          <dt>Rendimiento</dt>
          <dd>
            {formatQuantity(cost.yieldQuantity, cost.yieldUnit.symbol)}
            {!sameUnit && (
              <span className="cost-summary__note">
                {" "}
                = {formatQuantity(cost.normalizedYield, sale)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            Costo por {sale} ({currentLabel})
          </dt>
          <dd>
            {cost.unitCost === null
              ? "Incompleto"
              : formatUnitCost(cost.unitCost, cost.currency, sale)}
          </dd>
        </div>
        {snapshot && (
          <div>
            <dt>Costo por {snapshot.saleUnit.symbol} al publicar</dt>
            <dd>
              {snapshot.unitCost === null
                ? "Incompleto"
                : formatUnitCost(snapshot.unitCost, snapshot.currency, snapshot.saleUnit.symbol)}
              {variation && (
                <span className="cost-summary__note">
                  {" "}
                  · variación <Variation variation={variation} />
                </span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Precio de venta</dt>
          <dd>
            {cost.salePrice === null ? "—" : formatUnitCost(cost.salePrice, cost.currency, sale)}
          </dd>
        </div>
        <div>
          <dt>Margen bruto teórico</dt>
          <dd>
            {cost.grossMargin ? (
              <>
                {formatMoney(cost.grossMargin.amount, cost.currency)}{" "}
                <span className="cost-summary__note">
                  ({formatPercent(cost.grossMargin.percentage)})
                </span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      <p className="muted small">
        Margen bruto teórico = precio de venta − costo de ingredientes por {sale}. No incluye mano
        de obra, energía, alquiler, impuestos, merma real ni otros costos indirectos: no es ganancia
        neta.
      </p>
    </>
  );
}

/** Desglose congelado al publicar: con qué costos de referencia se calculó. */
export function SnapshotTable({ snapshot }: { snapshot: CostSnapshotDto }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Materia prima</th>
            <th scope="col" className="num">
              Cantidad
            </th>
            <th scope="col" className="num">
              Costo usado
            </th>
            <th scope="col" className="num">
              Costo del ingrediente
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshot.lines.map((line) => (
            <tr key={line.rawMaterialId}>
              <td>{line.rawMaterialName}</td>
              <td className="num">{formatQuantity(line.quantity, line.unit.symbol)}</td>
              <td className="num">
                <UsedCost
                  cost={line.referenceCost}
                  source={line.costSource}
                  currency={snapshot.currency}
                  unitSymbol={line.baseUnit.symbol}
                />
              </td>
              <td className="num">
                {line.ingredientCost === null
                  ? "—"
                  : formatMoney(line.ingredientCost, snapshot.currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Costo del lote al publicar</td>
            <td className="num">
              {snapshot.totalCost === null
                ? "Incompleto"
                : formatMoney(snapshot.totalCost, snapshot.currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Cambios respecto de la versión anterior (sin diff visual sofisticado). */
export function DiffView({ diff }: { diff: RecipeVersionDiffDto }) {
  if (!diff.from) return <p className="muted">Es la primera versión de la receta.</p>;
  if (!diff.hasChanges)
    return <p className="muted">Sin cambios respecto de la versión {diff.from.versionNumber}.</p>;
  const q = (x: { quantity: string; unit: { symbol: string } }) =>
    formatQuantity(x.quantity, x.unit.symbol);
  return (
    <ul className="diff-list">
      {diff.added.map((i) => (
        <li key={`a-${i.rawMaterialId}`}>
          Agregado: <strong>{i.rawMaterialName}</strong> ({q(i)})
        </li>
      ))}
      {diff.removed.map((i) => (
        <li key={`r-${i.rawMaterialId}`}>
          Quitado: <strong>{i.rawMaterialName}</strong> ({q(i)})
        </li>
      ))}
      {diff.changed.map((i) => (
        <li key={`c-${i.rawMaterialId}`}>
          Cantidad: <strong>{i.rawMaterialName}</strong> {q(i.from)} → {q(i.to)}
        </li>
      ))}
      {diff.yield && (
        <li>
          Rendimiento: {q(diff.yield.from)} → {q(diff.yield.to)}
        </li>
      )}
      {diff.waste && (
        <li>
          Merma teórica: {diff.waste.from === null ? "sin merma" : formatPercent(diff.waste.from)} →{" "}
          {diff.waste.to === null ? "sin merma" : formatPercent(diff.waste.to)}
        </li>
      )}
      {diff.instructionsChanged && <li>Instrucciones modificadas</li>}
    </ul>
  );
}

/**
 * Publicar un borrador. Si el costo está incompleto, la publicación exige
 * marcar la confirmación (la API también lo exige).
 */
export function PublishVersionButton({
  versionId,
  versionNumber,
  cost,
  onDone,
}: {
  versionId: string;
  versionNumber: number;
  cost: TheoreticalCostDto | null;
  onDone: () => void;
}) {
  const incomplete = cost?.status === "INCOMPLETE";
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <ConfirmAction
      label="Publicar"
      variant="primary"
      title={`¿Publicar la versión ${versionNumber}?`}
      validate={() =>
        incomplete && !acknowledged
          ? "El costo está incompleto: marcá «Publicar igual, con el costo incompleto» para continuar."
          : null
      }
      confirmLabel="Publicar versión"
      message={
        <>
          Pasa a ser la versión vigente y la anterior queda archivada. Una vez publicada no se puede
          modificar: para cambiarla hay que crear una nueva versión. Se guarda el costo calculado
          con los costos de referencia de hoy.
        </>
      }
      onConfirm={async () => {
        await apiFetch(`/api/recipe-versions/${versionId}/publish`, {
          method: "POST",
          body: { acknowledgeIncompleteCost: incomplete && acknowledged },
        });
        onDone();
      }}
    >
      {incomplete && (
        <>
          <IncompleteCostAlert missing={cost.missingCosts} />
          <label className="form__field--check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>Publicar igual, con el costo incompleto</span>
          </label>
        </>
      )}
    </ConfirmAction>
  );
}
