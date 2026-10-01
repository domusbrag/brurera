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
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isDecimal, parseDecimal, toDecimal } from "@/lib/decimal-input";
import {
  formatDateTime,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatUnitCost,
} from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { toCostingUnit } from "../recipes/cost-views";
import { useCan, useCurrentUser } from "../user-context";
import { PURCHASES_BASE, commercialQuantity } from "./purchase-pages";

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

const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

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
      <section className="panel panel--empty">
        <p className="upcoming">Esta compra ya no es un borrador</p>
        <p className="muted">
          Una compra pedida sólo admite cambios de notas, fecha esperada y documento.{" "}
          <Link href={`${PURCHASES_BASE}/${existing.id}`}>Volver</Link>
        </p>
      </section>
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
          purchaseDate: today(),
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

  async function save(order: boolean, event?: FormEvent) {
    event?.preventDefault();
    setPending(true);
    setFieldErrors({});
    setFormError(null);
    const sent = lines.filter((l) => l.rawMaterialId || l.quantity || l.unitPrice);
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
    try {
      const saved = existing
        ? await apiFetch<PurchaseDto>(`/api/purchases/${existing.id}`, { method: "PATCH", body })
        : await apiFetch<PurchaseDto>("/api/purchases", { method: "POST", body });
      if (order) await apiFetch(`/api/purchases/${saved.id}/order`, { method: "POST" });
      router.push(`${PURCHASES_BASE}/${saved.id}`);
      router.refresh();
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
          err.code === "PURCHASE_WITHOUT_LINES"
            ? "Agregá al menos una materia prima antes de confirmar el pedido."
            : Object.keys(mapped).length > 0
              ? "Revisá los datos marcados."
              : err.message,
        );
      } else {
        setFormError("No se pudo guardar la compra.");
      }
      setPending(false);
    }
  }

  const supplierOptions = catalog.suppliers.filter((s) => s.active || s.id === form.supplierId);
  const err = (key: number, f: string) => fieldErrors[`line.${key}.${f}`];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          existing
            ? { href: `${PURCHASES_BASE}/${existing.id}`, label: `Compra ${existing.number}` }
            : { href: PURCHASES_BASE, label: "Compras" }
        }
        title={existing ? `Editar compra ${existing.number}` : "Nueva compra"}
        subtitle="Se guarda como borrador. El stock cambia recién al confirmar una recepción."
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
                Proveedor{" "}
                <span className="form__required" aria-hidden="true">
                  *
                </span>
              </label>
              <select
                id="supplierId"
                value={form.supplierId}
                aria-invalid={fieldErrors.supplierId ? true : undefined}
                onChange={(e) => set("supplierId", e.target.value)}
              >
                <option value="">Elegí un proveedor</option>
                {supplierOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.legalName}
                  </option>
                ))}
              </select>
              {fieldErrors.supplierId && (
                <span className="form__error">{fieldErrors.supplierId}</span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="purchaseDate">
                Fecha{" "}
                <span className="form__required" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="purchaseDate"
                type="date"
                value={form.purchaseDate}
                aria-invalid={fieldErrors.purchaseDate ? true : undefined}
                onChange={(e) => set("purchaseDate", e.target.value)}
              />
              {fieldErrors.purchaseDate && (
                <span className="form__error">{fieldErrors.purchaseDate}</span>
              )}
            </div>
            <div className="form__field">
              <label htmlFor="expectedDate">Fecha esperada de entrega</label>
              <input
                id="expectedDate"
                type="date"
                value={form.expectedDate}
                onChange={(e) => set("expectedDate", e.target.value)}
              />
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
          <div className="table-wrap">
            <table className="table ingredients-editor purchase-editor">
              <thead>
                <tr>
                  <th scope="col" className="col-material">
                    Materia prima
                  </th>
                  <th scope="col" className="col-presentation">
                    Presentación
                  </th>
                  <th scope="col" className="col-qty">
                    Cantidad
                  </th>
                  <th scope="col" className="col-price">
                    Precio unitario
                  </th>
                  <th scope="col" className="col-price">
                    Descuento
                  </th>
                  <th scope="col" className="num">
                    Neto
                  </th>
                  <th scope="col">
                    <span className="sr-only">Quitar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const material = materialById.get(line.rawMaterialId);
                  const c = computed[index];
                  const n = index + 1;
                  return (
                    <tr key={line.key}>
                      <td className="col-material">
                        <select
                          aria-label={`Materia prima ${n}`}
                          value={line.rawMaterialId}
                          aria-invalid={err(line.key, "rawMaterialId") ? true : undefined}
                          onChange={(e) =>
                            setLine(line.key, { rawMaterialId: e.target.value, option: "" })
                          }
                        >
                          <option value="">Elegí…</option>
                          {catalog.materials
                            .filter((m) => m.active || m.id === line.rawMaterialId)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                        </select>
                        {err(line.key, "rawMaterialId") && (
                          <span className="form__error">{err(line.key, "rawMaterialId")}</span>
                        )}
                        {c?.baseQty && c.unitCost && (
                          <span className="cost-source">
                            Equivale a {formatQuantity(c.baseQty.toString(), c.baseSymbol!)} ·{" "}
                            {formatUnitCost(toFixedString(c.unitCost, 6), currency, c.baseSymbol!)}
                          </span>
                        )}
                      </td>
                      <td className="col-presentation">
                        <select
                          aria-label={`Presentación ${n}`}
                          value={line.option}
                          disabled={!material}
                          aria-invalid={
                            err(line.key, "presentationId") || err(line.key, "purchaseUnitId")
                              ? true
                              : undefined
                          }
                          onChange={(e) => setLine(line.key, { option: e.target.value })}
                        >
                          <option value="">—</option>
                          {optionsFor(material).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {(err(line.key, "presentationId") || err(line.key, "purchaseUnitId")) && (
                          <span className="form__error">
                            {err(line.key, "presentationId") ?? err(line.key, "purchaseUnitId")}
                          </span>
                        )}
                      </td>
                      <td className="col-qty">
                        <input
                          aria-label={`Cantidad ${n}`}
                          inputMode="decimal"
                          autoComplete="off"
                          value={line.quantity}
                          aria-invalid={err(line.key, "quantity") ? true : undefined}
                          onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                        />
                        {err(line.key, "quantity") && (
                          <span className="form__error">{err(line.key, "quantity")}</span>
                        )}
                      </td>
                      <td className="col-price">
                        <input
                          aria-label={`Precio unitario ${n}`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder={c?.commercial ? `por ${c.commercial}` : undefined}
                          value={line.unitPrice}
                          aria-invalid={err(line.key, "unitPrice") ? true : undefined}
                          onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                        />
                        {err(line.key, "unitPrice") && (
                          <span className="form__error">{err(line.key, "unitPrice")}</span>
                        )}
                      </td>
                      <td className="col-price">
                        <input
                          aria-label={`Descuento ${n}`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          value={line.discountAmount}
                          aria-invalid={err(line.key, "discountAmount") ? true : undefined}
                          onChange={(e) => setLine(line.key, { discountAmount: e.target.value })}
                        />
                        {err(line.key, "discountAmount") && (
                          <span className="form__error">{err(line.key, "discountAmount")}</span>
                        )}
                      </td>
                      <td className="num">
                        {c?.amounts ? formatMoney(c.amounts.net.toString(), currency) : "—"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button--small"
                          aria-label={`Quitar línea ${n}`}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              lines:
                                f.lines.length > 1
                                  ? f.lines.filter((l) => l.key !== line.key)
                                  : [emptyLine()],
                            }))
                          }
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form__footer">
            <button
              type="button"
              className="button"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              Agregar materia prima
            </button>
            {can(P.PRESENTATIONS_MANAGE) && (
              <span className="form__hint">
                ¿Falta una presentación (bolsa, paquete, bidón)? Se crea desde la ficha de la
                materia prima.
              </span>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="purchase-totals" aria-live="polite">
          <h2 id="purchase-totals">3. Totales</h2>
          <div className="form-grid">
            <div className="form__field">
              <label htmlFor="taxTotal">Impuestos (informativos)</label>
              <input
                id="taxTotal"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={form.taxTotal}
                aria-invalid={fieldErrors.taxTotal ? true : undefined}
                onChange={(e) => set("taxTotal", e.target.value)}
              />
              <span className="form__hint">
                Suman al total a pagar, no al costo del inventario.
              </span>
              {fieldErrors.taxTotal && <span className="form__error">{fieldErrors.taxTotal}</span>}
            </div>
          </div>
          <dl className="cost-summary">
            <div>
              <dt>Subtotal</dt>
              <dd>{formatMoney(totals.subtotal.toString(), currency)}</dd>
            </div>
            <div>
              <dt>Descuentos</dt>
              <dd>{formatMoney(totals.discountTotal.toString(), currency)}</dd>
            </div>
            <div>
              <dt>Impuestos</dt>
              <dd>{formatMoney(totals.taxTotal.toString(), currency)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatMoney(totals.total.toString(), currency)}</dd>
            </div>
          </dl>
          <div className="form__field form__field--full" style={{ marginTop: "1rem" }}>
            <label htmlFor="notes">Observaciones</label>
            <textarea
              id="notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
          <div className="form__footer">
            <button type="submit" className="button" disabled={pending}>
              {pending ? "Guardando…" : "Guardar borrador"}
            </button>
            {can(P.PURCHASES_ORDER) && (
              <button
                type="button"
                className="button button--primary"
                disabled={pending}
                onClick={() => save(true)}
              >
                Guardar y confirmar pedido
              </button>
            )}
            <Link
              className="button"
              href={existing ? `${PURCHASES_BASE}/${existing.id}` : PURCHASES_BASE}
            >
              Cancelar
            </Link>
          </div>
        </section>
      </form>
    </div>
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

const localNow = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};

export function ReceiptForm({ purchaseId }: { purchaseId: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const { data: purchase, error } = useResource<PurchaseDto>(`/api/purchases/${purchaseId}`);
  const { data: warehousePage } = useResource<Page<WarehouseDto>>(
    "/api/warehouses?pageSize=100&status=active",
  );
  const [chosenWarehouseId, setWarehouseId] = useState("");
  const [receivedAt, setReceivedAt] = useState(localNow);
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
      <section className="panel panel--empty">
        <p className="upcoming">Esta compra no admite recepciones</p>
        <p className="muted">
          Sólo se recibe una compra pedida o recibida en parte.{" "}
          <Link href={`${PURCHASES_BASE}/${purchaseId}`}>Volver</Link>
        </p>
      </section>
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
  const invalid = rows.some((r) => !r.valid || r.exceeds) || receiving.length === 0;
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
          receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null,
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
              ? Object.values(err.fieldErrors).join(". ")
              : err.message,
        );
      } else {
        setFormError("No se pudo registrar la recepción.");
      }
      setStep("edit");
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: `${PURCHASES_BASE}/${purchaseId}`, label: `Compra ${purchase.number}` }}
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
                  Depósito{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id="warehouseId"
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
                {fieldErrors.warehouseId && (
                  <span className="form__error">{fieldErrors.warehouseId}</span>
                )}
              </div>
              <div className="form__field">
                <label htmlFor="receivedAt">Fecha y hora de recepción</label>
                <input
                  id="receivedAt"
                  type="datetime-local"
                  value={receivedAt}
                  max={localNow()}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
                {fieldErrors.receivedAt && (
                  <span className="form__error">{fieldErrors.receivedAt}</span>
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
                    <th scope="col" className="num hide-sm">
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
                      <td className="num">{formatDecimal(r.line.orderedQuantity, 0, 4)}</td>
                      <td className="num hide-sm">
                        {formatDecimal(r.line.receivedQuantity, 0, 4)}
                      </td>
                      <td className="num">{formatDecimal(r.line.pendingQuantity, 0, 4)}</td>
                      <td className="col-qty">
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
                        {!r.valid && <span className="form__error">Cantidad inválida</span>}
                        {r.exceeds && <span className="form__error">Supera lo pendiente</span>}
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
              <Link className="button" href={`${PURCHASES_BASE}/${purchaseId}`}>
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
            Ingresa al depósito <strong>{warehouse?.name}</strong>. Al confirmar, el stock y el
            costo promedio se actualizan y la recepción ya no se puede modificar.
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
                </dl>
              </article>
            ))}
          </div>
          <p>
            Valor que ingresa al inventario:{" "}
            <strong>{formatMoney(totalValue.toString(), currency)}</strong>
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
          {receivedAt && (
            <p className="muted small">
              Recepción del{" "}
              {formatDateTime(new Date(receivedAt).toISOString(), user.company.timezone)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
