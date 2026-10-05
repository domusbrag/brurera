"use client";

import { D } from "@bakery/domain";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  PERMISSIONS as P,
  WASTE_REASONS,
  WASTE_REASON_LABELS,
  type InventoryDetailDto,
  type Page,
  type RawMaterialDto,
  type StockOperationResultDto,
  type WarehouseDto,
  instantToZonedLocal,
  zonedLocalToInstant,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatMoney, formatQuantity, formatUnitCost } from "@/lib/format";
import { Loading, PageHeader, useResource } from "../masters/ui";
import { WallClockInput, formatWallClock, isCompleteWallClock } from "../orders/order-shared";
import { Combobox, type ComboOption } from "../ui/combobox";
import { useCan, useCurrentUser } from "../user-context";
import { STOCK_BASE } from "./inventory-pages";

/*
 * Operaciones manuales de inventario: stock inicial, ajuste y merma. Cada una
 * genera UN movimiento (nunca se edita un saldo). Antes de confirmar se muestra
 * el impacto: stock antes, movimiento y stock después.
 */

export type StockOperationKind = "initial" | "adjust" | "waste";

const COPY: Record<
  StockOperationKind,
  { title: string; subtitle: string; endpoint: string; confirm: string; panel: string }
> = {
  initial: {
    title: "Cargar stock inicial",
    subtitle:
      "Existencias con las que arranca el sistema. Se carga una vez por materia prima y depósito, con su costo de valorización.",
    endpoint: "/api/inventory/initial-stock",
    confirm: "Confirmar stock inicial",
    panel: "panel",
  },
  adjust: {
    title: "Ajustar stock",
    subtitle:
      "Corrección explícita (recuento físico, error de carga, rotura). Queda registrada como un movimiento con su motivo.",
    endpoint: "/api/inventory/adjustments",
    confirm: "Confirmar ajuste",
    panel: "panel",
  },
  waste: {
    title: "Registrar merma",
    subtitle:
      "Mercadería que se pierde (vencida, dañada, descartada). Sale del stock al costo promedio vigente.",
    endpoint: "/api/inventory/waste",
    confirm: "Confirmar merma",
    panel: "panel panel--waste",
  },
};

/** Hora de pared actual de la EMPRESA ("AAAA-MM-DDTHH:mm"), no la del navegador. */
const companyNow = (timeZone: string) => instantToZonedLocal(new Date(), timeZone);

export function StockOperationForm({ kind }: { kind: StockOperationKind }) {
  return (
    <Suspense fallback={<Loading />}>
      <StockOperationInner kind={kind} />
    </Suspense>
  );
}

function StockOperationInner({ kind }: { kind: StockOperationKind }) {
  const router = useRouter();
  const params = useSearchParams();
  const user = useCurrentUser();
  const can = useCan();
  const tz = user.company.timezone;
  const showCosts = can(P.INVENTORY_COST_READ);
  const copy = COPY[kind];
  const [materials, setMaterials] = useState<RawMaterialDto[] | null>(null);
  const { data: warehousePage } = useResource<Page<WarehouseDto>>(
    "/api/warehouses?pageSize=100&status=active",
  );
  const [rawMaterialId, setRawMaterialId] = useState(params.get("rawMaterialId") ?? "");
  const [chosenWarehouseId, setWarehouseId] = useState("");
  // Sin valor por defecto: el sentido del ajuste define el signo y se elige a conciencia.
  const [direction, setDirection] = useState<"POSITIVE" | "NEGATIVE" | "">("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => companyNow(tz));
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchOptions<RawMaterialDto>("/api/raw-materials")
      .then(setMaterials)
      .catch(() => setMaterials([]));
  }, []);
  const { data: detail } = useResource<InventoryDetailDto>(
    rawMaterialId ? `/api/inventory/raw-materials/${rawMaterialId}` : null,
  );
  const materialOptions = useMemo<ComboOption[]>(
    () =>
      (materials ?? [])
        .filter((m) => m.active || m.id === rawMaterialId)
        .map((m) => ({
          value: m.id,
          label: m.name,
          detail: m.baseUnit.symbol,
          keywords: `${m.code} ${m.category.name}`,
        })),
    [materials, rawMaterialId],
  );

  if (!materials || !warehousePage) return <Loading />;
  const warehouseId = chosenWarehouseId || warehousePage.items[0]?.id || "";
  const material = materials.find((m) => m.id === rawMaterialId);
  const currentDetail = detail && detail.rawMaterial.id === rawMaterialId ? detail : null;
  const unit = material?.baseUnit.symbol ?? "";
  const currency = user.company.currencyCode;
  const warehouse = warehousePage.items.find((w) => w.id === warehouseId);
  const before = currentDetail
    ? new D(currentDetail.byWarehouse.find((b) => b.warehouse.id === warehouseId)?.quantity ?? "0")
    : null;
  const qty = isPositive(quantity) ? parseDecimal(quantity) : null;
  const outbound = kind === "waste" || (kind === "adjust" && direction === "NEGATIVE");
  const after = before && qty ? (outbound ? before.minus(qty) : before.plus(qty)) : null;
  // Promedio vigente: el costo efectivo cuando su origen es el promedio de compras.
  const average =
    currentDetail?.effectiveCostSource === "PURCHASE_MOVING_AVERAGE"
      ? currentDetail.effectiveCost
      : null;
  const needsCost =
    kind === "initial" || (kind === "adjust" && direction === "POSITIVE" && !average);
  const allowsCost = kind === "initial" || (kind === "adjust" && direction === "POSITIVE");
  const reasons =
    kind === "waste"
      ? WASTE_REASONS.map((r) => ({ value: r, label: WASTE_REASON_LABELS[r] }))
      : kind === "adjust"
        ? ADJUSTMENT_REASONS.map((r) => ({ value: r, label: ADJUSTMENT_REASON_LABELS[r] }))
        : [];
  const costOk = unitCost.trim() === "" ? !needsCost : isDecimal(unitCost);
  const dateComplete = isCompleteWallClock(occurredAt);
  const dateInFuture = dateComplete && occurredAt > companyNow(tz);
  // Lo que falta para poder revisar, en palabras (el botón deshabilitado no queda mudo).
  const missing = [
    !material && "la materia prima",
    !warehouseId && "el depósito",
    kind === "adjust" && !direction && "el tipo de ajuste",
    !qty && "una cantidad mayor a 0",
    !costOk && "el costo unitario",
    reasons.length > 0 && !reason && "el motivo",
    !dateComplete && "la fecha y hora",
  ].filter(Boolean) as string[];
  const ready = missing.length === 0 && !dateInFuture && !(after && after.lt(0));
  const movementLabel =
    kind === "initial"
      ? "Stock inicial"
      : kind === "waste"
        ? "Merma"
        : direction === "NEGATIVE"
          ? "Ajuste (salida)"
          : direction === "POSITIVE"
            ? "Ajuste (entrada)"
            : "Ajuste";
  const valuationCost =
    unitCost.trim() !== "" && isDecimal(unitCost)
      ? toDecimal(unitCost)
      : outbound || !needsCost
        ? average
        : null;

  async function confirm() {
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      await apiFetch<StockOperationResultDto>(copy.endpoint, {
        method: "POST",
        body: {
          rawMaterialId,
          warehouseId,
          quantity: toDecimal(quantity),
          // Hora de pared de la empresa → instante ISO (mismo formato de payload que antes).
          occurredAt: dateComplete ? zonedLocalToInstant(occurredAt, tz).toISOString() : null,
          notes: notes || null,
          ...(kind === "adjust" ? { direction, reason } : {}),
          ...(kind === "waste" ? { reason } : {}),
          ...(allowsCost ? { unitCost: unitCost.trim() === "" ? null : toDecimal(unitCost) } : {}),
        },
      });
      router.push(`${STOCK_BASE}/${rawMaterialId}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setFormError(
          err.code === "INSUFFICIENT_STOCK"
            ? "No hay stock suficiente en ese depósito para esta salida."
            : err.code === "VALUATION_COST_REQUIRED"
              ? "Esta materia prima no tiene costo promedio: indicá el costo unitario de valorización."
              : Object.keys(err.fieldErrors).length > 0
                ? "Revisá los datos marcados."
                : describeError(err),
        );
      } else setFormError("No se pudo registrar la operación.");
      setStep("edit");
      setPending(false);
    }
  }

  const impact = (
    <dl className="cost-summary impact">
      <div>
        <dt>Stock antes</dt>
        <dd>{before ? formatQuantity(before.toString(), unit) : "—"}</dd>
      </div>
      <div>
        <dt>{movementLabel}</dt>
        <dd className={outbound ? "text-negative" : "text-positive"}>
          {qty ? `${outbound ? "−" : "+"}${formatQuantity(qty.toString(), unit)}` : "—"}
        </dd>
      </div>
      <div>
        <dt>Stock después</dt>
        <dd className={after?.lt(0) ? "text-negative" : undefined}>
          {after ? formatQuantity(after.toString(), unit) : "—"}
        </dd>
      </div>
    </dl>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          material
            ? { href: `${STOCK_BASE}/${material.id}`, label: material.name }
            : { href: STOCK_BASE, label: "Stock" }
        }
        title={copy.title}
        subtitle={copy.subtitle}
      />
      {formError && (
        <p className="alert" role="alert">
          {formError}
        </p>
      )}
      {step === "edit" ? (
        <form
          className="form"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (ready) setStep("review");
          }}
        >
          <section className={copy.panel}>
            <div className="form-grid">
              <div className="form__field">
                <label htmlFor="rawMaterialId">
                  Materia prima <Required />
                </label>
                <Combobox
                  id="rawMaterialId"
                  options={materialOptions}
                  value={rawMaterialId}
                  onChange={setRawMaterialId}
                  placeholder="Buscar por nombre o código"
                  emptyText="Ninguna materia prima coincide"
                  required
                  invalid={Boolean(fieldErrors.rawMaterialId)}
                  describedBy={fieldErrors.rawMaterialId ? "rawMaterialId-error" : undefined}
                />
                {fieldErrors.rawMaterialId && (
                  <span id="rawMaterialId-error" className="form__error">
                    {fieldErrors.rawMaterialId}
                  </span>
                )}
              </div>
              <div className="form__field">
                <label htmlFor="warehouseId">
                  Depósito <Required />
                </label>
                <select
                  id="warehouseId"
                  value={warehouseId}
                  aria-required="true"
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  {warehousePage.items.length === 0 && (
                    <option value="">Sin depósitos activos</option>
                  )}
                  {warehousePage.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                {warehousePage.items.length > 1 && !chosenWarehouseId && (
                  <span className="form__hint">
                    Se propone el primer depósito: cambialo si corresponde.
                  </span>
                )}
              </div>
              {kind === "adjust" && (
                <fieldset className="form__field form__field--full">
                  <legend className="form__label">
                    Tipo de ajuste <Required />
                  </legend>
                  <div className="segmented" role="radiogroup" aria-label="Tipo de ajuste">
                    <label>
                      <input
                        type="radio"
                        name="direction"
                        value="POSITIVE"
                        checked={direction === "POSITIVE"}
                        onChange={() => setDirection("POSITIVE")}
                      />
                      Entrada: hay más de lo registrado
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="direction"
                        value="NEGATIVE"
                        checked={direction === "NEGATIVE"}
                        onChange={() => setDirection("NEGATIVE")}
                      />
                      Salida: hay menos de lo registrado
                    </label>
                  </div>
                </fieldset>
              )}
              <div className="form__field">
                <label htmlFor="quantity">
                  Cantidad{unit ? ` (${unit})` : ""} <Required />
                </label>
                <div className="input-group">
                  <input
                    id="quantity"
                    inputMode="decimal"
                    autoComplete="off"
                    value={quantity}
                    aria-required="true"
                    aria-invalid={fieldErrors.quantity || (quantity && !qty) ? true : undefined}
                    aria-describedby={
                      fieldErrors.quantity || (quantity && !qty) ? "quantity-error" : undefined
                    }
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                  {unit && <span className="muted">{unit}</span>}
                </div>
                {(fieldErrors.quantity || (quantity && !qty)) && (
                  <span id="quantity-error" className="form__error">
                    {fieldErrors.quantity ?? "Escribí una cantidad mayor a 0."}
                  </span>
                )}
              </div>
              {allowsCost && (
                <div className="form__field">
                  <label htmlFor="unitCost">
                    Costo unitario por {unit || "unidad"} ({currency})
                    {needsCost && (
                      <>
                        {" "}
                        <Required />
                      </>
                    )}
                  </label>
                  <input
                    id="unitCost"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={
                      needsCost
                        ? "Obligatorio"
                        : average && showCosts
                          ? `Promedio vigente: ${formatUnitCost(average, currency, unit)}`
                          : undefined
                    }
                    value={unitCost}
                    aria-required={needsCost || undefined}
                    aria-invalid={fieldErrors.unitCost || !costOk ? true : undefined}
                    aria-describedby="unitCost-hint"
                    onChange={(e) => setUnitCost(e.target.value)}
                  />
                  <span id="unitCost-hint" className="form__hint">
                    {kind === "initial"
                      ? "Valoriza el stock inicial y fija el primer costo promedio."
                      : needsCost
                        ? "Sin costo promedio vigente: hace falta para valorizar la entrada."
                        : "Vacío: entra al costo promedio vigente."}
                  </span>
                  {fieldErrors.unitCost && (
                    <span className="form__error">{fieldErrors.unitCost}</span>
                  )}
                </div>
              )}
              {reasons.length > 0 && (
                <div className="form__field">
                  <label htmlFor="reason">
                    Motivo <Required />
                  </label>
                  <select
                    id="reason"
                    value={reason}
                    aria-required="true"
                    aria-invalid={fieldErrors.reason ? true : undefined}
                    onChange={(e) => setReason(e.target.value)}
                  >
                    <option value="">Elegí un motivo</option>
                    {reasons.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.reason && <span className="form__error">{fieldErrors.reason}</span>}
                </div>
              )}
              <div className="form__field">
                <label htmlFor="occurredAt">
                  Fecha y hora <Required />
                </label>
                <WallClockInput
                  id="occurredAt"
                  value={occurredAt}
                  timeZone={tz}
                  onChange={setOccurredAt}
                  invalid={dateInFuture || Boolean(fieldErrors.occurredAt)}
                  describedBy={
                    dateInFuture || fieldErrors.occurredAt ? "occurredAt-error" : undefined
                  }
                />
                {(dateInFuture || fieldErrors.occurredAt) && (
                  <span id="occurredAt-error" className="form__error">
                    {fieldErrors.occurredAt ?? "La fecha no puede ser posterior a ahora."}
                  </span>
                )}
              </div>
            </div>
            <div className="form__field form__field--full" style={{ marginTop: "1rem" }}>
              <label htmlFor="notes">Observación</label>
              <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>
          <section className="panel" aria-labelledby="impact-title" aria-live="polite">
            <h2 id="impact-title">Impacto en {warehouse?.name ?? "el depósito"}</h2>
            {impact}
            {after?.lt(0) && (
              <p className="form__error" role="alert">
                No alcanza el stock del depósito: el stock no puede quedar negativo.
              </p>
            )}
            <div className="form__footer">
              <button
                type="submit"
                className="button button--primary"
                disabled={!ready}
                aria-describedby={missing.length > 0 ? "review-missing" : undefined}
              >
                Revisar
              </button>
              <Link
                className="button button--tertiary"
                href={material ? `${STOCK_BASE}/${material.id}` : STOCK_BASE}
              >
                Cancelar
              </Link>
              {missing.length > 0 && (
                <span id="review-missing" className="muted small">
                  Para revisar falta: {missing.join(", ")}.
                </span>
              )}
            </div>
          </section>
        </form>
      ) : (
        <section className={copy.panel} aria-labelledby="review-title" aria-live="polite">
          <h2 id="review-title">
            {copy.title}: {material?.name}
          </h2>
          <p className="muted">
            {warehouse?.name}
            {reason
              ? ` · ${
                  kind === "waste"
                    ? WASTE_REASON_LABELS[reason as keyof typeof WASTE_REASON_LABELS]
                    : ADJUSTMENT_REASON_LABELS[reason as keyof typeof ADJUSTMENT_REASON_LABELS]
                }`
              : ""}
            {showCosts && valuationCost && qty
              ? ` · valorizado a ${formatUnitCost(valuationCost, currency, unit)} (${formatMoney(
                  qty.times(valuationCost).toString(),
                  currency,
                )})`
              : ""}
          </p>
          {impact}
          <p className="muted small">
            Fecha del movimiento: {formatWallClock(occurredAt)} (hora de la empresa).
          </p>
          <p className="muted small">
            Se registra como movimiento de inventario y no se puede editar: una corrección se hace
            con otro ajuste.
          </p>
          <div className="form__footer">
            <button
              type="button"
              className={`button ${kind === "waste" ? "button--danger" : "button--primary"}`}
              disabled={pending}
              onClick={confirm}
            >
              {pending ? "Registrando…" : copy.confirm}
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setStep("edit")}
            >
              Volver a editar
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Required() {
  return (
    <span className="form__required" aria-hidden="true">
      *
    </span>
  );
}
