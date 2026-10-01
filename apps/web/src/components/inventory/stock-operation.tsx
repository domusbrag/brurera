"use client";

import { D } from "@bakery/domain";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  WASTE_REASONS,
  WASTE_REASON_LABELS,
  type InventoryDetailDto,
  type Page,
  type RawMaterialDto,
  type StockOperationResultDto,
  type WarehouseDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { formatMoney, formatQuantity, formatReferenceCost } from "@/lib/format";
import { Loading, PageHeader, useResource } from "../masters/ui";
import { useCurrentUser } from "../user-context";
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

const localNow = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};

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
  const copy = COPY[kind];
  const [materials, setMaterials] = useState<RawMaterialDto[] | null>(null);
  const { data: warehousePage } = useResource<Page<WarehouseDto>>(
    "/api/warehouses?pageSize=100&status=active",
  );
  const [rawMaterialId, setRawMaterialId] = useState(params.get("rawMaterialId") ?? "");
  const [chosenWarehouseId, setWarehouseId] = useState("");
  const [direction, setDirection] = useState<"POSITIVE" | "NEGATIVE">("NEGATIVE");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");
  const [occurredAt, setOccurredAt] = useState(localNow);
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
  const ready =
    !!material &&
    !!warehouseId &&
    !!qty &&
    costOk &&
    (reasons.length === 0 || !!reason) &&
    !(after && after.lt(0));
  const movementLabel =
    kind === "initial"
      ? "Stock inicial"
      : kind === "waste"
        ? "Merma"
        : direction === "NEGATIVE"
          ? "Ajuste (salida)"
          : "Ajuste (entrada)";
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
          occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
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
                ? Object.values(err.fieldErrors).join(". ")
                : err.message,
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
                <label htmlFor="rawMaterialId">Materia prima</label>
                <select
                  id="rawMaterialId"
                  value={rawMaterialId}
                  aria-invalid={fieldErrors.rawMaterialId ? true : undefined}
                  onChange={(e) => setRawMaterialId(e.target.value)}
                >
                  <option value="">Elegí una materia prima</option>
                  {materials
                    .filter((m) => m.active || m.id === rawMaterialId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
                {fieldErrors.rawMaterialId && (
                  <span className="form__error">{fieldErrors.rawMaterialId}</span>
                )}
              </div>
              <div className="form__field">
                <label htmlFor="warehouseId">Depósito</label>
                <select
                  id="warehouseId"
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  {warehousePage.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              {kind === "adjust" && (
                <div className="form__field">
                  <label htmlFor="direction">Tipo de ajuste</label>
                  <select
                    id="direction"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as "POSITIVE" | "NEGATIVE")}
                  >
                    <option value="NEGATIVE">Salida (hay menos de lo registrado)</option>
                    <option value="POSITIVE">Entrada (hay más de lo registrado)</option>
                  </select>
                </div>
              )}
              <div className="form__field">
                <label htmlFor="quantity">Cantidad{unit ? ` (${unit})` : ""}</label>
                <input
                  id="quantity"
                  inputMode="decimal"
                  autoComplete="off"
                  value={quantity}
                  aria-invalid={fieldErrors.quantity || (quantity && !qty) ? true : undefined}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                {fieldErrors.quantity && (
                  <span className="form__error">{fieldErrors.quantity}</span>
                )}
              </div>
              {allowsCost && (
                <div className="form__field">
                  <label htmlFor="unitCost">
                    Costo unitario por {unit || "unidad"} ({currency}){needsCost ? " *" : ""}
                  </label>
                  <input
                    id="unitCost"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={
                      needsCost
                        ? "Obligatorio"
                        : average
                          ? `Promedio vigente: ${formatReferenceCost(average, currency, unit)}`
                          : undefined
                    }
                    value={unitCost}
                    aria-invalid={fieldErrors.unitCost ? true : undefined}
                    onChange={(e) => setUnitCost(e.target.value)}
                  />
                  <span className="form__hint">
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
                  <label htmlFor="reason">Motivo</label>
                  <select
                    id="reason"
                    value={reason}
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
                </div>
              )}
              <div className="form__field">
                <label htmlFor="occurredAt">Fecha y hora</label>
                <input
                  id="occurredAt"
                  type="datetime-local"
                  value={occurredAt}
                  max={localNow()}
                  onChange={(e) => setOccurredAt(e.target.value)}
                />
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
              <button type="submit" className="button button--primary" disabled={!ready}>
                Revisar
              </button>
              <Link
                className="button"
                href={material ? `${STOCK_BASE}/${material.id}` : STOCK_BASE}
              >
                Cancelar
              </Link>
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
            {valuationCost && qty
              ? ` · valorizado a ${formatReferenceCost(valuationCost, currency, unit)} (${formatMoney(
                  qty.times(valuationCost).toString(),
                  currency,
                )})`
              : ""}
          </p>
          {impact}
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
