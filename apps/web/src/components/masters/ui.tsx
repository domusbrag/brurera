"use client";

import {
  AUDIT_ACTION_LABELS,
  PERMISSIONS,
  STOCK_MOVEMENT_TYPE_LABELS,
  SYSTEM_ROLES,
  type AuditLogItemDto,
  type Page,
} from "@bakery/shared";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { describeError } from "@/lib/errors";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatReferenceCost,
} from "@/lib/format";
import { Icon } from "../ui/icons";
import { StatusBadge as Badge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";

/** Carga un recurso de la API con estado de carga/error y recarga manual. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    apiFetch<T>(path)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoadedPath(path);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Error"));
          setLoadedPath(path);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  /** Hay datos, pero corresponden a una consulta anterior (cambió el filtro o la página). */
  const stale = data !== null && loadedPath !== path;
  return { data, error, reload, setData, stale };
}

type Crumb = { href: string; label: string };

/**
 * Encabezado único de página: migas (en jerarquías profundas), título con
 * estado, subtítulo y acciones. Por pantalla, una sola acción primaria.
 * `breadcrumb` acepta un nivel o la ruta completa; el último nivel es la página.
 */
export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  status,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumb?: Crumb | Crumb[];
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const crumbs = breadcrumb ? (Array.isArray(breadcrumb) ? breadcrumb : [breadcrumb]) : [];
  return (
    <header className="page__header">
      <div className="page__title">
        {crumbs.length > 0 && (
          <nav className="breadcrumb" aria-label="Ubicación">
            <ol>
              {crumbs.map((c) => (
                <li key={c.href}>
                  <Link href={c.href}>{c.label}</Link>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {/* El estado va dentro del h1: se anuncia junto con el título. */}
        <h1 className="page__heading">
          <span>{title}</span>
          {status && <span className="page__status">{status}</span>}
        </h1>
        {subtitle && <p className="page__subtitle">{subtitle}</p>}
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
  return <Badge tone={active ? "success" : "neutral"}>{active ? on : off}</Badge>;
}

/** Carga: esqueleto de líneas que reserva lugar (sin saltos ni bloquear la página). */
export function Loading({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <span className="skeleton__line" aria-hidden="true" />
      <span className="skeleton__line" aria-hidden="true" />
      <span className="skeleton__line" aria-hidden="true" />
    </div>
  );
}

/** Error al cargar: qué pasó en lenguaje simple y cómo seguir (nunca un código interno). */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const notFound = error.status === 404;
  return (
    <section className="panel panel--empty" role="alert">
      <p className="upcoming">{notFound ? "No encontrado" : "No se pudo cargar"}</p>
      <p className="muted">{describeError(error)}</p>
      <div className="alert__actions" style={{ justifyContent: "center" }}>
        {onRetry && !notFound && (
          <button type="button" className="button" onClick={onRetry}>
            Reintentar
          </button>
        )}
        <Link className="button button--tertiary" href="/">
          Ir al inicio
        </Link>
      </div>
    </section>
  );
}

/**
 * Estado vacío útil: dice qué falta y ofrece la acción para resolverlo sólo si
 * el usuario puede ejecutarla.
 */
export function EmptyState({
  title,
  description,
  action,
  compact,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "empty-state--compact" : ""}`}>
      <p className="empty-state__title">{title}</p>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/**
 * Datos de un registro. Con `hideEmpty` los vacíos no se muestran (evita la
 * pared de "—"); sin él, un vacío se muestra como "—".
 */
export function Details({
  items,
  hideEmpty,
}: {
  items: [string, ReactNode][];
  hideEmpty?: boolean;
}) {
  const empty = (v: ReactNode) => v === null || v === undefined || v === "" || v === false;
  return (
    <dl className="details">
      {items
        .filter(([, value]) => !hideEmpty || !empty(value))
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{empty(value) ? "—" : value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Código de negocio (PED-0001, VTA-0001, OP-0001, LOT-…) con botón para copiarlo. */
export function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="code-chip">
      <span className="code">{code}</span>
      <button
        type="button"
        className="copy-button"
        aria-label={copied ? `${code} copiado` : `Copiar ${code}`}
        title={copied ? "Copiado" : "Copiar código"}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size="sm" />
      </button>
    </span>
  );
}

/**
 * Botón que abre un diálogo de confirmación antes de ejecutar una acción.
 * - `variant="primary"`: el paso que hace avanzar el flujo (confirmar, planificar…).
 * - `danger`: acción destructiva; el diálogo explica la consecuencia y el botón
 *   de confirmación es rojo.
 * `validate` permite exigir datos del diálogo (p. ej. un motivo) antes de llamar a la API.
 * El foco vuelve al botón que abrió el diálogo al cerrarlo.
 */
export function ConfirmAction({
  label,
  title,
  message,
  confirmLabel,
  danger,
  variant,
  small,
  disabled,
  disabledReason,
  validate,
  onConfirm,
  children,
}: {
  label: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  variant?: "primary" | "default";
  small?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  validate?: () => string | null;
  onConfirm: () => Promise<void>;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    const invalid = validate?.() ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    try {
      await onConfirm();
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err) : "No se pudo completar la operación.");
    } finally {
      setPending(false);
    }
  }

  const openerClass = danger ? "button--danger" : variant === "primary" ? "button--primary" : "";
  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className={`button ${openerClass} ${small ? "button--small" : ""}`}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby={titleId}
        onClose={() => openerRef.current?.focus()}
      >
        <h2 id={titleId}>{title}</h2>
        <div className={danger ? "dialog__consequence" : "muted"}>{message}</div>
        {children}
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button
            type="button"
            className="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Volver
          </button>
          <button
            type="button"
            className={`button ${danger ? "button--danger-solid" : "button--primary"}`}
            onClick={confirm}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Procesando…" : confirmLabel}
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
  fulfillmentType: "Modalidad",
  deliveryAddress: "Dirección de entrega",
  contactPhone: "Teléfono de contacto",
  eventName: "Evento",
  priority: "Prioridad",
  customerId: "Cliente",
  requestedAt: "Fecha de entrega",
  warehouseId: "Depósito",
  isDefault: "Lista general",
  code: "Código",
  currency: "Moneda",
  unitPrice: "Precio",
  defaultInitialState: "Estado inicial",
  nearExpiryMinutes: "Aviso de vencimiento",
  baseUnitId: "Unidad base",
  magnitude: "Magnitud",
  factor: "Factor",
  terminationDate: "Fecha de egreso",
};

const ROLE_NAMES: Record<string, string> = Object.fromEntries(
  SYSTEM_ROLES.map((r) => [r.code, r.name]),
);

/** Clave sin rótulo ("deliveryAddress" → "delivery address"): nunca mostrar camelCase crudo. */
function humanizeKey(key: string): string {
  return key
    .replace(/Id$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

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
    const fields = Object.keys(changes).map((k) => FIELD_LABELS[k] ?? humanizeKey(k));
    if (typeof metadata.lines === "number" && typeof metadata.number === "string")
      fields.push("líneas");
    if (fields.length > 0) return `Cambió: ${[...new Set(fields)].join(", ")}`;
  }
  if (typeof metadata.number === "string") {
    const total =
      typeof metadata.total === "string" ? ` · ${formatMoney(metadata.total, currency)}` : "";
    return `Compra ${metadata.number}${total}`;
  }
  if (Array.isArray(metadata.to))
    return `Roles: ${(metadata.to as string[]).map((code) => ROLE_NAMES[code] ?? code).join(", ")}`;
  if (typeof metadata.terminationDate === "string")
    return `Egreso: ${formatDate(metadata.terminationDate)}`;
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
