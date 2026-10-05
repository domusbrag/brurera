"use client";

import {
  D,
  acquisitionUnitCost,
  areUnitsCompatible,
  baseQuantityPerPurchaseUnit,
  calculatePurchaseLineAmounts,
  calculatePurchaseTotals,
  toFixedString,
} from "@bakery/domain";
import {
  PERMISSIONS as P,
  type Page,
  type PresentationDto,
  type PurchaseDto,
  type RawMaterialDto,
  type ReceiptDto,
  type SupplierDto,
  type UnitDto,
  type WarehouseDto,
  instantToZonedLocal,
  zonedLocalToInstant,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions, listPath } from "@/lib/api-client";
import { isDecimal, isPositive, parseDecimal, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatDecimal, formatMoney, formatQuantity, formatUnitCost } from "@/lib/format";
import { EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { WallClockInput, formatWallClock, isCompleteWallClock } from "../orders/order-shared";
import { toCostingUnit } from "../recipes/cost-views";
import { Combobox, type ComboOption } from "../ui/combobox";
import { Icon } from "../ui/icons";
import { LineField, LineList, LineRow } from "../ui/lines";
import { useCan, useCurrentUser } from "../user-context";
import {
  ORDER_FAILED_PARAM,
  PURCHASES_BASE,
  commercialQuantity,
  supplierLabel,
} from "./purchase-pages";

/*
 * Alta y edición de una compra (borrador) y registro de una recepción. Los
 * importes se calculan EN VIVO con las mismas funciones de @bakery/domain que
 * usa la API; al guardar, la API vuelve a validar y calcular todo.
 */

/* ---------- Compra ---------- */

interface Line {
  key: number;
  rawMaterialId: string;
  /** "p:<presentationId>" o "u:<unitId>". */
  option: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
}

interface Form {
  supplierId: string;
  purchaseDate: string;
  expectedDate: string;
  supplierDocumentNumber: string;
  taxTotal: string;
  notes: string;
  lines: Line[];
}

let nextKey = 1;
const emptyLine = (rawMaterialId = ""): Line => ({
  key: nextKey++,
  rawMaterialId,
  option: "",
  quantity: "",
  unitPrice: "",
  discountAmount: "",
});

/** Hoy en la zona horaria de la EMPRESA (no la del navegador): "AAAA-MM-DD". */
const companyToday = (timeZone: string) => instantToZonedLocal(new Date(), timeZone).slice(0, 10);

interface Catalog {
  suppliers: SupplierDto[];
  materials: RawMaterialDto[];
  units: UnitDto[];
}

function useCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    Promise.all([
      fetchOptions<SupplierDto>("/api/suppliers"),
      fetchOptions<RawMaterialDto>("/api/raw-materials"),
      fetchOptions<UnitDto>("/api/units"),
    ])
      .then(([suppliers, materials, units]) => setCatalog({ suppliers, materials, units }))
      .catch(() => setCatalog({ suppliers: [], materials: [], units: [] }));
  }, []);
  return catalog;
}

/** Presentaciones activas por materia prima, cargadas a demanda. */
function usePresentations(materialIds: string[]) {
  const [byMaterial, setByMaterial] = useState<Record<string, PresentationDto[]>>({});
  const key = [...new Set(materialIds.filter(Boolean))].sort().join(",");
  useEffect(() => {
    const missing = key.split(",").filter((id) => id && !(id in byMaterial));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((id) =>
        apiFetch<PresentationDto[]>(`/api/raw-materials/${id}/presentations?status=active`)
          .then((items) => [id, items] as const)
          .catch(() => [id, []] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setByMaterial((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return byMaterial;
}

export function PurchaseForm({ id }: { id?: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <PurchaseFormInner id={id} />
    </Suspense>
  );
}

function PurchaseFormInner({ id }: { id?: string }) {
  const catalog = useCatalog();
  const { data: existing, error } = useResource<PurchaseDto>(id ? `/api/purchases/${id}` : null);
  if (error) return <ErrorState error={error} />;
  if (!catalog || (id && !existing)) return <Loading />;
  if (existing && existing.status !== "DRAFT") {
    return (
      <div className="page">
        <PageHeader
          breadcrumb={[
            { href: PURCHASES_BASE, label: "Compras" },
            { href: `${PURCHASES_BASE}/${existing.id}`, label: `Compra ${existing.number}` },
          ]}
          title={`Editar compra ${existing.number}`}
        />
        <EmptyState
          title="Esta compra ya no es un borrador"
          description="Una vez pedida al proveedor, sus líneas y precios ya no se editan."
          action={
            <Link className="button" href={`${PURCHASES_BASE}/${existing.id}`}>
              Ver la compra
            </Link>
          }
        />
      </div>
    );
  }
  return <PurchaseEditor catalog={catalog} existing={existing ?? null} />;
}

function PurchaseEditor({ catalog, existing }: { catalog: Catalog; existing: PurchaseDto | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const user = useCurrentUser();
  const currency = user.company.currencyCode;
  const [form, setForm] = useState<Form>(() =>
    existing
      ? {
          supplierId: existing.supplier.id,
          purchaseDate: existing.purchaseDate,
          expectedDate: existing.expectedDate ?? "",
          supplierDocumentNumber: existing.supplierDocumentNumber ?? "",
          taxTotal: Number(existing.taxTotal) === 0 ? "" : existing.taxTotal,
          notes: existing.notes ?? "",
          lines:
            existing.lines.length > 0
              ? existing.lines.map((l) => ({
                  key: nextKey++,
                  rawMaterialId: l.rawMaterial.id,
                  option: l.presentation ? `p:${l.presentation.id}` : `u:${l.purchaseUnit.id}`,
                  quantity: formatPlain(l.orderedQuantity),
                  unitPrice: formatPlain(l.unitPrice),
                  discountAmount:
                    Number(l.discountAmount) === 0 ? "" : formatPlain(l.discountAmount),
                }))
              : [emptyLine()],
        }
      : {
          supplierId: params.get("supplierId") ?? "",
          purchaseDate: companyToday(user.company.timezone),
          expectedDate: "",
          supplierDocumentNumber: "",
          taxTotal: "",
          notes: "",
          lines: [emptyLine(params.get("rawMaterialId") ?? "")],
        },
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const materialById = useMemo(
    () => new Map(catalog.materials.map((m) => [m.id, m])),
    [catalog.materials],
  );
  const unitById = useMemo(() => new Map(catalog.units.map((u) => [u.id, u])), [catalog.units]);
  const presentations = usePresentations(form.lines.map((l) => l.rawMaterialId));

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key: number, change: Partial<Line>) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l) => (l.key === key ? { ...l, ...change } : l)),
    }));

  /** Opciones de compra de una materia prima: sus presentaciones y unidades sueltas compatibles. */
  const optionsFor = (material: RawMaterialDto | undefined) => {
    if (!material) return [];
    const base = unitById.get(material.baseUnit.id);
    const pres = (presentations[material.id] ?? []).map((p) => ({
      value: `p:${p.id}`,
      label: `${p.name} (${formatDecimal(p.baseQuantity)} ${material.baseUnit.symbol})`,
    }));
    const loose = base
      ? catalog.units
          .filter((u) => u.active && areUnitsCompatible(toCostingUnit(u), toCostingUnit(base)))
          .map((u) => ({ value: `u:${u.id}`, label: `${u.symbol} suelto` }))
      : [];
    return [...pres, ...loose];
  };

  // Sin elección explícita, una línea usa la primera presentación de su materia prima (o la
  // unidad base). Se deriva al renderizar: no hace falta sincronizar estado.
  const optionOf = (l: Line): string => {
    if (l.option || !l.rawMaterialId) return l.option;
    const material = materialById.get(l.rawMaterialId);
    if (!material || !(material.id in presentations)) return "";
    const first = presentations[material.id]?.[0];
    return first ? `p:${first.id}` : `u:${material.baseUnit.id}`;
  };
  const lines = form.lines.map((l) => ({ ...l, option: optionOf(l) }));

  /** Cálculo en vivo de una línea: importes, equivalencia en unidad base y costo de adquisición. */
  const compute = (line: Line) => {
    const material = materialById.get(line.rawMaterialId);
    if (!material || !line.option) return null;
    const qty = parseDecimal(line.quantity);
    const price = parseDecimal(line.unitPrice);
    const discount =
      line.discountAmount.trim() === "" ? new D(0) : parseDecimal(line.discountAmount);
    let perUnit: InstanceType<typeof D> | null = null;
    let commercial = "";
    if (line.option.startsWith("p:")) {
      const p = presentations[material.id]?.find((x) => `p:${x.id}` === line.option);
      if (p) {
        perUnit = new D(p.baseQuantity);
        commercial = p.purchaseUnit.symbol;
      }
    } else {
      const unit = unitById.get(line.option.slice(2));
      const base = unitById.get(material.baseUnit.id);
      if (unit && base) {
        try {
          perUnit = baseQuantityPerPurchaseUnit({
            baseUnit: toCostingUnit(base),
            purchaseUnit: toCostingUnit(unit),
            presentation: null,
          });
          commercial = unit.symbol;
        } catch {
          perUnit = null;
        }
      }
    }
    if (!qty || !price || !discount || !perUnit || qty.lte(0))
      return { commercial, perUnit, amounts: null };
    try {
      const amounts = calculatePurchaseLineAmounts({
        quantity: qty,
        unitPrice: price,
        discountAmount: discount,
      });
      const baseQty = qty.times(perUnit);
      return {
        commercial,
        perUnit,
        amounts,
        baseQty,
        unitCost: acquisitionUnitCost(amounts.net, baseQty),
        baseSymbol: material.baseUnit.symbol,
      };
    } catch {
      return { commercial, perUnit, amounts: null };
    }
  };

  const computed = lines.map(compute);
  const totals = calculatePurchaseTotals(
    computed.flatMap((c) => (c?.amounts ? [c.amounts] : [])),
    isDecimal(form.taxTotal) ? toDecimal(form.taxTotal) : 0,
  );

  /** Validación previa en el cliente: mensajes en palabras antes de llamar a la API. */
  function validate(sent: Line[], order: boolean): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!form.supplierId) errors.supplierId = "Elegí un proveedor.";
    if (!form.purchaseDate) errors.purchaseDate = "Indicá la fecha de la compra.";
    if (form.taxTotal.trim() !== "" && !isDecimal(form.taxTotal))
      errors.taxTotal = "Escribí un importe válido (por ejemplo 1500,50).";
    for (const l of sent) {
      if (!l.rawMaterialId) errors[`line.${l.key}.rawMaterialId`] = "Elegí la materia prima.";
      else if (!l.option) errors[`line.${l.key}.presentationId`] = "Elegí cómo se compra.";
      if (!isPositive(l.quantity))
        errors[`line.${l.key}.quantity`] = "Indicá una cantidad mayor a 0.";
      if (!isDecimal(l.unitPrice)) errors[`line.${l.key}.unitPrice`] = "Indicá el precio unitario.";
      if (l.discountAmount.trim() !== "" && !isDecimal(l.discountAmount))
        errors[`line.${l.key}.discountAmount`] = "Escribí un descuento válido.";
    }
    if (order && sent.length === 0)
      errors.lines = "Agregá al menos una materia prima antes de confirmar el pedido.";
    return errors;
  }

  async function save(order: boolean, event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    setFieldErrors({});
    setFormError(null);
    const sent = lines.filter((l) => l.rawMaterialId || l.quantity || l.unitPrice);
    const local = validate(sent, order);
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      setFormError(local.lines ?? "Revisá los datos marcados.");
      return;
    }
    setPending(true);
    const body = {
      supplierId: form.supplierId,
      purchaseDate: form.purchaseDate,
      expectedDate: form.expectedDate || null,
      supplierDocumentNumber: form.supplierDocumentNumber || null,
      taxTotal: form.taxTotal.trim() === "" ? null : toDecimal(form.taxTotal),
      notes: form.notes || null,
      lines: sent.map((l) => ({
        rawMaterialId: l.rawMaterialId,
        presentationId: l.option.startsWith("p:") ? l.option.slice(2) : null,
        purchaseUnitId: l.option.startsWith("u:") ? l.option.slice(2) : null,
        quantity: toDecimal(l.quantity),
        unitPrice: toDecimal(l.unitPrice),
        discountAmount: l.discountAmount.trim() === "" ? null : toDecimal(l.discountAmount),
      })),
    };
    let saved: PurchaseDto;
    try {
      saved = existing
        ? await apiFetch<PurchaseDto>(`/api/purchases/${existing.id}`, { method: "PATCH", body })
        : await apiFetch<PurchaseDto>("/api/purchases", { method: "POST", body });
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const [path, message] of Object.entries(err.fieldErrors)) {
          const m = /^lines\.(\d+)\.(\w+)$/.exec(path);
          const line = m ? sent[Number(m[1])] : undefined;
          mapped[line ? `line.${line.key}.${m![2]}` : path] = message;
        }
        setFieldErrors(mapped);
        setFormError(
          Object.keys(mapped).length > 0 ? "Revisá los datos marcados." : describeError(err),
        );
      } else {
        setFormError("No se pudo guardar la compra. Revisá la conexión y reintentá.");
      }
      setPending(false);
      return;
    }
    if (order) {
      try {
        await apiFetch(`/api/purchases/${saved.id}/order`, { method: "POST" });
      } catch (err) {
        // La compra YA existe como borrador: no se vuelve a crear. Se abre el borrador con el
        // error a la vista, y desde ahí se reintenta "Confirmar pedido".
        const reason =
          err instanceof ApiError
            ? err.code === "PURCHASE_WITHOUT_LINES"
              ? "no tiene materias primas"
              : describeError(err)
            : "no hubo conexión con el servidor";
        router.push(listPath(`${PURCHASES_BASE}/${saved.id}`, { [ORDER_FAILED_PARAM]: reason }));
        router.refresh();
        return;
      }
    }
    router.push(`${PURCHASES_BASE}/${saved.id}`);
    router.refresh();
  }

  const supplierOptions = useMemo<ComboOption[]>(
    () =>
      catalog.suppliers
        .filter((s) => s.active || s.id === form.supplierId)
        .map((s) => ({
          value: s.id,
          label: supplierLabel(s),
          detail: s.tradeName ? s.legalName : (s.taxId ?? undefined),
          keywords: `${s.code} ${s.legalName} ${s.taxId ?? ""}`,
        })),
    [catalog.suppliers, form.supplierId],
  );
  const materialOptions = (current: string): ComboOption[] =>
    catalog.materials
      .filter((m) => m.active || m.id === current)
      .map((m) => ({
        value: m.id,
        label: m.name,
        detail: m.baseUnit.symbol,
        keywords: `${m.code} ${m.category.name}`,
      }));
  const err = (key: number, f: string) => fieldErrors[`line.${key}.${f}`];
  const canOrder = can(P.PURCHASES_ORDER);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          existing
            ? [
                { href: PURCHASES_BASE, label: "Compras" },
                { href: `${PURCHASES_BASE}/${existing.id}`, label: `Compra ${existing.number}` },
              ]
            : { href: PURCHASES_BASE, label: "Compras" }
        }
        title={existing ? `Editar compra ${existing.number}` : "Nueva compra"}
        subtitle="Pedido al proveedor. El stock y el costo cambian recién al confirmar una recepción."
      />
      <form className="form" onSubmit={(e) => save(false, e)} noValidate>
        {formError && (
          <p className="alert" role="alert">
            {formError}
          </p>
        )}
        <section className="panel" aria-labelledby="purchase-header">
          <h2 id="purchase-header">1. Proveedor y fecha</h2>
          <div className="form-grid">
            <div className="form__field">
              <label htmlFor="supplierId">
                Proveedor <Required />
              </label>
              <Combobox
                id="supplierId"
                options={supplierOptions}
                value={form.supplierId}
                onChange={(v) => set("supplierId", v)}
                placeholder="Buscar por nombre, código o CUIT"
                emptyText="Ningún proveedor coincide"
                required
                invalid={Boolean(fieldErrors.supplierId)}
                describedBy={fieldErrors.supplierId ? "supplierId-error" : undefined}
              />
              {fieldErrors.supplierId && (
                <span id="supplierId-error" className="form__error">
                  {fieldErrors.supplierId}
                </span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="purchaseDate">
                Fecha <Required />
              </label>
              <input
                id="purchaseDate"
                type="date"
                value={form.purchaseDate}
                aria-required="true"
                aria-invalid={fieldErrors.purchaseDate ? true : undefined}
                aria-describedby={fieldErrors.purchaseDate ? "purchaseDate-error" : undefined}
                onChange={(e) => set("purchaseDate", e.target.value)}
              />
              {fieldErrors.purchaseDate && (
                <span id="purchaseDate-error" className="form__error">
                  {fieldErrors.purchaseDate}
                </span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="expectedDate">Fecha esperada de entrega</label>
              <input
                id="expectedDate"
                type="date"
                value={form.expectedDate}
                aria-describedby="expectedDate-hint"
                onChange={(e) => set("expectedDate", e.target.value)}
              />
              <span id="expectedDate-hint" className="form__hint">
                Opcional. Ayuda al depósito a saber qué llega y cuándo.
              </span>
            </div>
            <div className="form__field">
              <label htmlFor="supplierDocumentNumber">Documento del proveedor</label>
              <input
                id="supplierDocumentNumber"
                autoComplete="off"
                placeholder="Opcional (presupuesto, factura…)"
                value={form.supplierDocumentNumber}
                onChange={(e) => set("supplierDocumentNumber", e.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="purchase-lines">
          <h2 id="purchase-lines">2. Materias primas</h2>
          {catalog.materials.length === 0 ? (
            <EmptyState
              compact
              title="No hay materias primas activas para comprar"
              description="Se dan de alta en Materias primas."
            />
          ) : (
            <LineList
              label="Materias primas de la compra"
              head={[
                "Materia prima y presentación",
                "Cantidad",
                "Precio unitario",
                "Descuento $",
                "Importe neto",
              ]}
              variant="full"
            >
              {lines.map((line, index) => {
                const material = materialById.get(line.rawMaterialId);
                const c = computed[index];
                const n = index + 1;
                const presentationError =
                  err(line.key, "presentationId") ?? err(line.key, "purchaseUnitId");
                const lineError =
                  err(line.key, "rawMaterialId") ??
                  presentationError ??
                  err(line.key, "quantity") ??
                  err(line.key, "unitPrice") ??
                  err(line.key, "discountAmount");
                return (
                  <LineRow
                    key={line.key}
                    testId={`purchase-line-${n}`}
                    removeLabel={`Quitar línea ${n}`}
                    canRemove={lines.length > 1}
                    onRemove={() =>
                      setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== line.key) }))
                    }
                    meta={
                      <>
                        {c?.baseQty && c.unitCost && (
                          <span>
                            Equivale a {formatQuantity(c.baseQty.toString(), c.baseSymbol!)} ·{" "}
                            {formatUnitCost(toFixedString(c.unitCost, 6), currency, c.baseSymbol!)}
                          </span>
                        )}
                        {lineError && (
                          <span className="form__error" role="alert">
                            {lineError}
                          </span>
                        )}
                      </>
                    }
                  >
                    <LineField label="Materia prima" htmlFor={`purchase-material-${n}`} product>
                      <Combobox
                        id={`purchase-material-${n}`}
                        ariaLabel={`Materia prima ${n}`}
                        options={materialOptions(line.rawMaterialId)}
                        value={line.rawMaterialId}
                        placeholder="Buscar materia prima por nombre o código"
                        emptyText="Ninguna materia prima coincide"
                        invalid={Boolean(err(line.key, "rawMaterialId"))}
                        onChange={(v) => setLine(line.key, { rawMaterialId: v, option: "" })}
                      />
                      <select
                        aria-label={`Presentación ${n}`}
                        value={line.option}
                        disabled={!material}
                        aria-invalid={presentationError ? true : undefined}
                        onChange={(e) => setLine(line.key, { option: e.target.value })}
                      >
                        <option value="">
                          {material ? "Elegí cómo se compra" : "Primero elegí la materia prima"}
                        </option>
                        {optionsFor(material).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </LineField>
                    <LineField label="Cantidad" htmlFor={`purchase-qty-${n}`}>
                      <div className="input-group">
                        <input
                          id={`purchase-qty-${n}`}
                          className="control"
                          aria-label={`Cantidad ${n}`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          value={line.quantity}
                          aria-invalid={err(line.key, "quantity") ? true : undefined}
                          onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                        />
                        {c?.commercial && <span className="muted">{c.commercial}</span>}
                      </div>
                    </LineField>
                    <LineField label="Precio unitario" htmlFor={`purchase-price-${n}`}>
                      <input
                        id={`purchase-price-${n}`}
                        className="control"
                        aria-label={`Precio unitario ${n}`}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={c?.commercial ? `$ por ${c.commercial}` : "$"}
                        value={line.unitPrice}
                        aria-invalid={err(line.key, "unitPrice") ? true : undefined}
                        onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                      />
                    </LineField>
                    <LineField label="Descuento $" htmlFor={`purchase-discount-${n}`}>
                      <input
                        id={`purchase-discount-${n}`}
                        className="control"
                        aria-label={`Descuento ${n}`}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0"
                        value={line.discountAmount}
                        aria-invalid={err(line.key, "discountAmount") ? true : undefined}
                        onChange={(e) => setLine(line.key, { discountAmount: e.target.value })}
                      />
                    </LineField>
                    <LineField label="Importe neto" amount>
                      <span>
                        {c?.amounts ? formatMoney(c.amounts.net.toString(), currency) : "—"}
                      </span>
                    </LineField>
                  </LineRow>
                );
              })}
            </LineList>
          )}
          <div className="lines__footer">
            <button
              type="button"
              className="button button--small"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              <Icon name="plus" size="sm" />
              Agregar materia prima
            </button>
            {can(P.PRESENTATIONS_MANAGE) && (
              <span className="muted small">
                ¿Falta una presentación (bolsa, paquete, bidón)? Se crea desde la ficha de la
                materia prima.
              </span>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="purchase-totals" aria-live="polite">
          <h2 id="purchase-totals">3. Totales</h2>
          <dl className="cost-summary">
            <div className="metric">
              <dt>Subtotal</dt>
              <dd className="metric__value">{formatMoney(totals.subtotal.toString(), currency)}</dd>
            </div>
            <div className="metric">
              <dt>Descuentos</dt>
              <dd className="metric__value">
                {formatMoney(totals.discountTotal.toString(), currency)}
              </dd>
            </div>
            <div className="metric">
              <dt>Impuestos</dt>
              <dd className="metric__value">{formatMoney(totals.taxTotal.toString(), currency)}</dd>
            </div>
            <div className="metric metric--emphasis">
              <dt>Total</dt>
              <dd className="metric__value">{formatMoney(totals.total.toString(), currency)}</dd>
            </div>
          </dl>
          <div className="form-grid" style={{ marginTop: "1rem" }}>
            <div className="form__field">
              <label htmlFor="taxTotal">Impuestos (informativos)</label>
              <input
                id="taxTotal"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={form.taxTotal}
                aria-invalid={fieldErrors.taxTotal ? true : undefined}
                aria-describedby="taxTotal-hint"
                onChange={(e) => set("taxTotal", e.target.value)}
              />
              <span id="taxTotal-hint" className="form__hint">
                Suman al total a pagar, no al costo del inventario.
              </span>
              {fieldErrors.taxTotal && <span className="form__error">{fieldErrors.taxTotal}</span>}
            </div>
          </div>
          <div className="form__field form__field--full" style={{ marginTop: "1rem" }}>
            <label htmlFor="notes">Observaciones</label>
            <textarea
              id="notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
          <div className="form__footer">
            <Link
              className="button button--tertiary"
              href={existing ? `${PURCHASES_BASE}/${existing.id}` : PURCHASES_BASE}
            >
              Cancelar
            </Link>
            <button
              type="submit"
              className={`button ${canOrder ? "" : "button--primary"}`}
              disabled={pending}
            >
              {pending ? "Guardando…" : "Guardar borrador"}
            </button>
            {canOrder && (
              <button
                type="button"
                className="button button--primary"
                disabled={pending}
                aria-busy={pending || undefined}
                onClick={() => save(true)}
              >
                {pending ? "Guardando…" : "Guardar y confirmar pedido"}
              </button>
            )}
          </div>
          {canOrder && (
            <p className="muted small">
              “Guardar y confirmar pedido” deja la compra pedida al proveedor: las líneas y los
              precios ya no se editan. El borrador se puede seguir editando.
            </p>
          )}
        </section>
      </form>
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

/** Decimal de la API sin ceros de más, para precargar un input ("30000.000000" → "30000"). */
function formatPlain(value: string): string {
  return new D(value).toString();
}

/* ---------- Recepción ---------- */

interface ReceiptLineForm {
  purchaseLineId: string;
  quantity: string;
}

/** Hora de pared actual de la EMPRESA ("AAAA-MM-DDTHH:mm"). */
const companyNow = (timeZone: string) => instantToZonedLocal(new Date(), timeZone);

export function ReceiptForm({ purchaseId }: { purchaseId: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const can = useCan();
  const tz = user.company.timezone;
  const showCosts = can(P.INVENTORY_COST_READ);
  const { data: purchase, error } = useResource<PurchaseDto>(`/api/purchases/${purchaseId}`);
  const { data: warehousePage } = useResource<Page<WarehouseDto>>(
    "/api/warehouses?pageSize=100&status=active",
  );
  const [chosenWarehouseId, setWarehouseId] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => companyNow(tz));
  const [documentNumber, setDocumentNumber] = useState("");
  const [notes, setNotes] = useState("");
  /** Cantidades escritas por línea de compra; sin escribir, se propone lo pendiente. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (error) return <ErrorState error={error} />;
  if (!purchase || !warehousePage) return <Loading />;
  const warehouseId = chosenWarehouseId || warehousePage.items[0]?.id || "";
  const lines: ReceiptLineForm[] = purchase.lines.map((l) => ({
    purchaseLineId: l.id,
    quantity: typed[l.id] ?? (Number(l.pendingQuantity) > 0 ? formatPlain(l.pendingQuantity) : "0"),
  }));
  const currency = purchase.currency;
  if (purchase.status !== "ORDERED" && purchase.status !== "PARTIALLY_RECEIVED") {
    return (
      <div className="page">
        <PageHeader
          breadcrumb={[
            { href: PURCHASES_BASE, label: "Compras" },
            { href: `${PURCHASES_BASE}/${purchaseId}`, label: `Compra ${purchase.number}` },
          ]}
          title="Registrar recepción"
        />
        <EmptyState
          title="Esta compra no admite recepciones"
          description={
            purchase.status === "DRAFT"
              ? "Primero hay que confirmar el pedido."
              : "Sólo se recibe una compra pedida o recibida en parte."
          }
          action={
            <Link className="button" href={`${PURCHASES_BASE}/${purchaseId}`}>
              Ver la compra
            </Link>
          }
        />
      </div>
    );
  }

  const rows = purchase.lines.map((line, i) => {
    const input = lines[i]!;
    const qty = parseDecimal(input.quantity);
    const valid = qty !== null;
    const exceeds = valid && qty.gt(line.pendingQuantity);
    const baseQty = valid ? qty.times(line.baseQuantityPerUnit) : null;
    const value = baseQty ? baseQty.times(line.acquisitionUnitCost) : null;
    return { line, input, qty, valid, exceeds, baseQty, value };
  });
  const receiving = rows.filter((r) => r.qty && r.qty.gt(0));
  const totalValue = receiving.reduce((s, r) => s.plus(r.value ?? 0), new D(0));
  const dateComplete = isCompleteWallClock(receivedAt);
  const dateInFuture = dateComplete && receivedAt > companyNow(tz);
  const invalid =
    rows.some((r) => !r.valid || r.exceeds) ||
    receiving.length === 0 ||
    !dateComplete ||
    dateInFuture;
  const warehouse = warehousePage.items.find((w) => w.id === warehouseId);

  async function confirm() {
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    let receipt: ReceiptDto | null = null;
    try {
      receipt = await apiFetch<ReceiptDto>(`/api/purchases/${purchaseId}/receipts`, {
        method: "POST",
        body: {
          warehouseId,
          // Hora de pared de la empresa → instante ISO (mismo formato de payload que antes).
          receivedAt: dateComplete ? zonedLocalToInstant(receivedAt, tz).toISOString() : null,
          documentNumber: documentNumber || null,
          notes: notes || null,
          lines: rows.map((r) => ({
            purchaseLineId: r.line.id,
            quantity: toDecimal(r.input.quantity) || "0",
          })),
        },
      });
      await apiFetch(`/api/purchase-receipts/${receipt.id}/post`, { method: "POST" });
      router.push(`${PURCHASES_BASE}/${purchaseId}`);
      router.refresh();
    } catch (err) {
      // Si se creó el borrador pero no se pudo confirmar, se descarta: no queda nada a medias.
      if (receipt) {
        await apiFetch(`/api/purchase-receipts/${receipt.id}/cancel`, { method: "POST" }).catch(
          () => undefined,
        );
      }
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setFormError(
          err.code === "RECEIPT_EXCEEDS_PENDING"
            ? "Alguna cantidad supera lo pendiente (puede que otra recepción se haya confirmado recién). Revisá y volvé a intentar."
            : Object.keys(err.fieldErrors).length > 0
              ? "Revisá los datos marcados."
              : describeError(err),
        );
      } else {
        setFormError("No se pudo registrar la recepción. Revisá la conexión y reintentá.");
      }
      setStep("edit");
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { href: PURCHASES_BASE, label: "Compras" },
          { href: `${PURCHASES_BASE}/${purchaseId}`, label: `Compra ${purchase.number}` },
        ]}
        title="Registrar recepción"
        subtitle={`${purchase.supplier.name} · indicá lo que llegó; puede ser una parte del pedido.`}
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
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && warehouseId) setStep("review");
          }}
        >
          <section className="panel">
            <div className="form-grid">
              <div className="form__field">
                <label htmlFor="warehouseId">
                  Depósito <Required />
                </label>
                <select
                  id="warehouseId"
                  aria-required="true"
                  value={warehouseId}
                  aria-invalid={fieldErrors.warehouseId ? true : undefined}
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  {warehousePage.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                {warehousePage.items.length > 1 && !chosenWarehouseId && (
                  <span className="form__hint">
                    Se propone el primer depósito: cambialo si la mercadería entra en otro.
                  </span>
                )}
                {fieldErrors.warehouseId && (
                  <span className="form__error">{fieldErrors.warehouseId}</span>
                )}
              </div>
              <div className="form__field">
                <label htmlFor="receivedAt">
                  Fecha y hora de recepción <Required />
                </label>
                <WallClockInput
                  id="receivedAt"
                  value={receivedAt}
                  timeZone={tz}
                  onChange={setReceivedAt}
                  invalid={dateInFuture || !dateComplete || Boolean(fieldErrors.receivedAt)}
                  describedBy={
                    dateInFuture || !dateComplete || fieldErrors.receivedAt
                      ? "receivedAt-error"
                      : undefined
                  }
                />
                {(dateInFuture || !dateComplete || fieldErrors.receivedAt) && (
                  <span id="receivedAt-error" className="form__error">
                    {fieldErrors.receivedAt ??
                      (dateInFuture
                        ? "La recepción no puede ser posterior a ahora."
                        : "Completá la fecha y la hora.")}
                  </span>
                )}
              </div>
              <div className="form__field">
                <label htmlFor="documentNumber">Remito</label>
                <input
                  id="documentNumber"
                  autoComplete="off"
                  placeholder="Opcional"
                  value={documentNumber}
                  onChange={(e) => setDocumentNumber(e.target.value)}
                />
              </div>
            </div>
          </section>
          <section className="panel" aria-labelledby="receipt-lines-title">
            <h2 id="receipt-lines-title">Mercadería</h2>
            <div className="table-wrap">
              <table className="table ingredients-editor">
                <thead>
                  <tr>
                    <th scope="col">Materia prima</th>
                    <th scope="col" className="num">
                      Pedido
                    </th>
                    <th scope="col" className="num hide-md">
                      Recibido antes
                    </th>
                    <th scope="col" className="num">
                      Pendiente
                    </th>
                    <th scope="col" className="col-qty">
                      Recibido ahora
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.line.id}>
                      <td>
                        {r.line.rawMaterial.name}
                        <span className="cost-source">
                          {r.line.presentation?.name ?? r.line.purchaseUnit.symbol}
                          {r.baseQty && r.qty?.gt(0)
                            ? ` · = ${formatQuantity(r.baseQty.toString(), r.line.rawMaterial.baseUnit.symbol)}`
                            : ""}
                        </span>
                      </td>
                      <td className="num">
                        {formatQuantity(r.line.orderedQuantity, r.line.purchaseUnit.symbol)}
                      </td>
                      <td className="num hide-md">
                        {formatQuantity(r.line.receivedQuantity, r.line.purchaseUnit.symbol)}
                      </td>
                      <td className="num">
                        {formatQuantity(r.line.pendingQuantity, r.line.purchaseUnit.symbol)}
                      </td>
                      <td className="col-qty">
                        <div className="input-group">
                          <input
                            aria-label={`Recibido ahora ${r.line.rawMaterial.name}`}
                            inputMode="decimal"
                            autoComplete="off"
                            value={r.input.quantity}
                            disabled={Number(r.line.pendingQuantity) === 0}
                            aria-invalid={!r.valid || r.exceeds ? true : undefined}
                            onChange={(e) =>
                              setTyped((prev) => ({ ...prev, [r.line.id]: e.target.value }))
                            }
                          />
                          <span className="muted">{r.line.purchaseUnit.symbol}</span>
                        </div>
                        {!r.valid && (
                          <span className="form__error">Escribí una cantidad (0 si no llegó).</span>
                        )}
                        {r.exceeds && (
                          <span className="form__error">
                            Supera lo pendiente (
                            {formatQuantity(r.line.pendingQuantity, r.line.purchaseUnit.symbol)}).
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form__field form__field--full" style={{ marginTop: "1rem" }}>
              <label htmlFor="receipt-notes">Observaciones</label>
              <textarea
                id="receipt-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className="form__footer">
              <button
                type="submit"
                className="button button--primary"
                disabled={invalid || !warehouseId}
              >
                Revisar recepción
              </button>
              <Link className="button button--tertiary" href={`${PURCHASES_BASE}/${purchaseId}`}>
                Cancelar
              </Link>
              {receiving.length === 0 && (
                <span className="form__hint">
                  Indicá la cantidad recibida de al menos una línea.
                </span>
              )}
            </div>
          </section>
        </form>
      ) : (
        <section className="panel" aria-labelledby="receipt-review" aria-live="polite">
          <h2 id="receipt-review">Resumen antes de confirmar</h2>
          <p className="muted">
            Ingresa al depósito <strong>{warehouse?.name}</strong>. Al confirmar, el stock
            {showCosts ? " y el costo promedio se actualizan" : " se actualiza"} y la recepción ya
            no se puede modificar.
          </p>
          <div className="receipt-summary">
            {receiving.map((r) => (
              <article key={r.line.id} className="card">
                <h3 className="card__title">{r.line.rawMaterial.name}</h3>
                <dl className="details">
                  <div>
                    <dt>Recibido</dt>
                    <dd>{commercialQuantity(r.line, r.qty!.toString())}</dd>
                  </div>
                  <div>
                    <dt>Ingresa al stock</dt>
                    <dd>
                      {formatQuantity(r.baseQty!.toString(), r.line.rawMaterial.baseUnit.symbol)}
                    </dd>
                  </div>
                  {showCosts && (
                    <>
                      <div>
                        <dt>Costo neto</dt>
                        <dd>{formatMoney(r.value!.toString(), currency)}</dd>
                      </div>
                      <div>
                        <dt>Costo de adquisición</dt>
                        <dd>
                          {formatUnitCost(
                            r.line.acquisitionUnitCost,
                            currency,
                            r.line.rawMaterial.baseUnit.symbol,
                          )}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </article>
            ))}
          </div>
          {showCosts && (
            <p>
              Valor que ingresa al inventario:{" "}
              <strong>{formatMoney(totalValue.toString(), currency)}</strong>
            </p>
          )}
          <p className="muted small">
            Recepción del {formatWallClock(receivedAt)} (hora de la empresa).
          </p>
          <div className="form__footer">
            <button
              type="button"
              className="button button--primary"
              disabled={pending}
              onClick={confirm}
            >
              {pending ? "Confirmando…" : "Confirmar recepción"}
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
