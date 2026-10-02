"use client";

import {
  AUDIT_ACTION_LABELS,
  PERMISSIONS,
  STOCK_MOVEMENT_TYPE_LABELS,
  type AuditLogItemDto,
  type Page,
} from "@bakery/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatReferenceCost,
} from "@/lib/format";
import { useCan, useCurrentUser } from "../user-context";

/** Carga un recurso de la API con estado de carga/error y recarga manual. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    apiFetch<T>(path)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Error"));
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  return { data, error, reload, setData };
}

export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumb?: { href: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <header className="page__header">
      <div className="page__title">
        {breadcrumb && (
          <nav className="breadcrumb" aria-label="Ubicación">
            <Link href={breadcrumb.href}>← {breadcrumb.label}</Link>
          </nav>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function StatusBadge({
  active,
  on = "Activo",
  off = "Inactivo",
}: {
  active: boolean;
  on?: string;
  off?: string;
}) {
  return <span className={`badge ${active ? "" : "badge--off"}`}>{active ? on : off}</span>;
}

export function Loading() {
  return (
    <p className="loading" role="status">
      Cargando…
    </p>
  );
}

export function ErrorState({ error }: { error: ApiError }) {
  return (
    <section className="panel panel--empty">
      <p className="upcoming">{error.status === 404 ? "No encontrado" : "No se pudo cargar"}</p>
      <p className="muted">{error.message}</p>
    </section>
  );
}

export function Details({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="details">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === "" ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Botón que pide confirmación en un diálogo antes de ejecutar una acción
 * (desactivar, dar de baja…). Muestra el error de la API si falla.
 */
export function ConfirmAction({
  label,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  children,
}: {
  label: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo completar la operación.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`button ${danger ? "button--danger" : ""}`}
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog ref={dialogRef} className="dialog" aria-labelledby={`${label}-title`}>
        <h2 id={`${label}-title`}>{title}</h2>
        <div className="muted">{message}</div>
        {children}
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button
            type="button"
            className={`button ${danger ? "button--danger" : "button--primary"}`}
            onClick={confirm}
            disabled={pending}
          >
            {pending ? "Procesando…" : confirmLabel}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Cancelar
          </button>
        </div>
      </dialog>
    </>
  );
}

/** Acciones estándar de estado (desactivar / reactivar) de un maestro. */
export function ActiveToggle({
  active,
  endpoint,
  noun,
  onChange,
  deactivateMessage,
}: {
  active: boolean;
  endpoint: string;
  noun: string;
  onChange: () => void;
  deactivateMessage?: ReactNode;
}) {
  return active ? (
    <ConfirmAction
      label="Desactivar"
      title={`¿Desactivar ${noun}?`}
      message={
        deactivateMessage ??
        "Deja de aparecer en listados y selectores. No se borra: su historial se conserva y se puede reactivar."
      }
      confirmLabel="Desactivar"
      danger
      onConfirm={async () => {
        await apiFetch(`${endpoint}/deactivate`, { method: "POST" });
        onChange();
      }}
    />
  ) : (
    <ConfirmAction
      label="Reactivar"
      title={`¿Reactivar ${noun}?`}
      message="Vuelve a estar disponible en listados y selectores."
      confirmLabel="Reactivar"
      onConfirm={async () => {
        await apiFetch(`${endpoint}/activate`, { method: "POST" });
        onChange();
      }}
    />
  );
}

const FIELD_LABELS: Record<string, string> = {
  legalName: "Razón social",
  tradeName: "Nombre comercial",
  taxId: "CUIT",
  phone: "Teléfono",
  email: "Email",
  address: "Dirección",
  city: "Localidad",
  province: "Provincia",
  postalCode: "Código postal",
  notes: "Observaciones",
  name: "Nombre",
  description: "Descripción",
  salePrice: "Precio de venta",
  referenceCost: "Costo de referencia",
  minimumStock: "Stock mínimo",
  categoryId: "Categoría",
  saleUnitId: "Unidad de venta",
  preferredSupplierId: "Proveedor preferido",
  creditLimit: "Límite de crédito",
  defaultPriceListId: "Lista de precios",
  commercialCondition: "Condición comercial",
  type: "Tipo",
  firstName: "Nombre",
  lastName: "Apellido",
  position: "Puesto",
  displayName: "Nombre visible",
  employeeId: "Empleado vinculado",
  contactName: "Contacto",
  paymentTerms: "Condiciones de pago",
  symbol: "Símbolo",
  decimals: "Decimales",
  sortOrder: "Orden",
  active: "Activo",
  controlsStock: "Controla stock",
  timezone: "Zona horaria",
  currencyCode: "Moneda",
  logoUrl: "Logo",
  documentType: "Tipo de documento",
  documentNumber: "Documento",
  hireDate: "Fecha de ingreso",
  imageUrl: "Imagen",
  supplierId: "Proveedor",
  purchaseDate: "Fecha",
  expectedDate: "Fecha esperada",
  supplierDocumentNumber: "Documento del proveedor",
  taxTotal: "Impuestos",
  lines: "Líneas",
  productId: "Producto",
  scheduledFor: "Fecha programada",
  plannedOutputQuantity: "Cantidad a producir",
  plannedOutputUnitId: "Unidad",
  recipeVersionId: "Versión de receta",
  sourceWarehouseId: "Depósito de materias primas",
  outputWarehouseId: "Depósito de producto terminado",
  responsibleEmployeeId: "Responsable",
  batchCode: "Lote",
  actualOutput: "Salida real",
};

/** Detalle de un evento de una orden de producción (OP-0001…). */
function describeProduction(metadata: Record<string, unknown>): string | null {
  const str = (key: string) =>
    typeof metadata[key] === "string" ? (metadata[key] as string) : null;
  const currency = str("currency") ?? "ARS";
  if (str("actualMaterialCost") !== null && str("actualOutput") !== null) {
    const unit = str("unit") ?? "";
    return [
      `Salida ${formatQuantity(str("actualOutput"), unit)}`,
      str("batchCode") ? `lote ${str("batchCode")}` : null,
      `costo material ${formatMoney(str("actualMaterialCost"), currency)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if ("plannedCostStatus" in metadata) {
    const shortages = Array.isArray(metadata.shortages) ? (metadata.shortages as string[]) : [];
    return [
      `Versión ${String(metadata.versionNumber)}`,
      str("batchCode") ? `lote ${str("batchCode")}` : null,
      str("plannedMaterialCost")
        ? `costo esperado ${formatMoney(str("plannedMaterialCost"), currency)}`
        : "costo esperado incompleto",
      shortages.length > 0 ? `faltante: ${shortages.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if ("previousStatus" in metadata) return str("reason") ? `Motivo: ${str("reason")}` : null;
  if (str("rawMaterial") !== null && "lineId" in metadata) {
    const qty = str("quantity");
    return [
      str("rawMaterial"),
      qty && str("unit") ? formatQuantity(qty, str("unit")!) : null,
      str("notes"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof metadata.versionNumber === "number" && str("scheduledFor") !== null) {
    return `${str("product") ?? ""} · versión ${metadata.versionNumber} · para el ${formatDate(str("scheduledFor"))}`;
  }
  if (str("batchCode") !== null && !("changes" in metadata)) return `Lote ${str("batchCode")}`;
  return null;
}

function describeChanges(metadata: Record<string, unknown>): string | null {
  if (typeof metadata.code === "string" && metadata.code.startsWith("OP-")) {
    const production = describeProduction(metadata);
    if (production) return production;
  }
  const version =
    typeof metadata.versionNumber === "number" ? `Versión ${metadata.versionNumber}` : null;
  if (version) {
    const extra: string[] = [];
    if (typeof metadata.copiedFromVersion === "number")
      extra.push(`copia de la versión ${metadata.copiedFromVersion}`);
    if (typeof metadata.replacedByVersion === "number")
      extra.push(`reemplazada por la versión ${metadata.replacedByVersion}`);
    if (metadata.costStatus === "INCOMPLETE") extra.push("costo incompleto");
    for (const key of ["added", "removed", "changed"] as const) {
      const names = metadata[key];
      if (Array.isArray(names) && names.length > 0)
        extra.push(
          `${{ added: "agregó", removed: "quitó", changed: "cambió" }[key]} ${names.join(", ")}`,
        );
    }
    return [version, ...extra].join(" · ");
  }
  const changes = metadata.changes as Record<string, unknown> | undefined;
  const currency = typeof metadata.currency === "string" ? metadata.currency : "ARS";
  for (const [key, label] of [
    ["referenceCost", "Costo de referencia"],
    ["movingAverageCost", "Costo promedio"],
  ] as const) {
    const cost = changes?.[key] as { from: string | null; to: string | null } | undefined;
    if (cost && typeof metadata.perUnit === "string") {
      const show = (v: string | null) =>
        v === null ? "sin costo" : formatReferenceCost(v, currency, metadata.perUnit as string);
      return `${label}: ${show(cost.from)} → ${show(cost.to)}`;
    }
  }
  // Operación de inventario: "Merma · Depósito Principal: 50 kg → 47 kg".
  const movementType = metadata.movementType as keyof typeof STOCK_MOVEMENT_TYPE_LABELS;
  if (
    STOCK_MOVEMENT_TYPE_LABELS[movementType] &&
    typeof metadata.unit === "string" &&
    typeof metadata.before === "string" &&
    typeof metadata.after === "string"
  ) {
    const unit = metadata.unit;
    return `${STOCK_MOVEMENT_TYPE_LABELS[movementType]} · ${String(metadata.warehouse ?? "")}: ${formatQuantity(metadata.before, unit)} → ${formatQuantity(metadata.after, unit)}`;
  }
  if (typeof metadata.receipt === "string") {
    const value =
      typeof metadata.inventoryValue === "string"
        ? ` · ${formatMoney(metadata.inventoryValue, currency)}`
        : "";
    return `Recepción ${metadata.receipt}${value}`;
  }
  if (typeof metadata.presentation === "string") {
    return `Presentación “${metadata.presentation}”`;
  }
  if (changes && typeof changes === "object") {
    const fields = Object.keys(changes).map((k) => FIELD_LABELS[k] ?? k);
    if (typeof metadata.lines === "number" && typeof metadata.number === "string")
      fields.push("líneas");
    if (fields.length > 0) return `Cambió: ${[...new Set(fields)].join(", ")}`;
  }
  if (typeof metadata.number === "string") {
    const total =
      typeof metadata.total === "string" ? ` · ${formatMoney(metadata.total, currency)}` : "";
    return `Compra ${metadata.number}${total}`;
  }
  if (Array.isArray(metadata.to)) return `Roles: ${(metadata.to as string[]).join(", ")}`;
  if (typeof metadata.terminationDate === "string") return `Egreso: ${metadata.terminationDate}`;
  return null;
}

/** Historial de auditoría de un registro (requiere audit.read). */
export function AuditHistory({
  entityType,
  entityId,
  version,
}: {
  entityType: string;
  entityId: string;
  version?: number;
}) {
  const can = useCan();
  const user = useCurrentUser();
  const allowed = can(PERMISSIONS.AUDIT_READ);
  const path = allowed
    ? `/api/audit-logs?entityType=${entityType}&entityId=${entityId}&pageSize=20&v=${version ?? 0}`
    : null;
  const { data, error } = useResource<Page<AuditLogItemDto>>(path);
  if (!allowed) return null;
  return (
    <section className="panel" aria-labelledby="history-title">
      <h2 id="history-title">Historial</h2>
      {error ? (
        <p className="muted">{error.message}</p>
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">Sin movimientos registrados.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Acción</th>
                <th scope="col">Usuario</th>
                <th scope="col" className="hide-sm">
                  Detalle
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>{formatDateTime(item.createdAt, user.company.timezone)}</td>
                  <td>
                    {AUDIT_ACTION_LABELS[item.action as keyof typeof AUDIT_ACTION_LABELS] ??
                      item.action}
                  </td>
                  <td>{item.actor?.displayName ?? "—"}</td>
                  <td className="hide-sm">{describeChanges(item.metadata) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
