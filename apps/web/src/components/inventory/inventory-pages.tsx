"use client";

import {
  ADJUSTMENT_REASON_LABELS,
  COST_SOURCE_LABELS,
  PERMISSIONS as P,
  STOCK_ITEM_TYPE_LABELS,
  STOCK_ITEM_TYPES,
  STOCK_MOVEMENT_TYPE_LABELS,
  STOCK_MOVEMENT_TYPES_DTO,
  STOCK_STATUS_LABELS,
  WASTE_REASON_LABELS,
  type CostHistoryEntryDto,
  type InventoryCostDto,
  type InventoryDetailDto,
  type InventoryItemDto,
  type LowStockItemDto,
  type Page,
  type StockMovementDto,
  type StockStatusDto,
  type WarehouseDto,
} from "@bakery/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchOptions, listPath } from "@/lib/api-client";
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatReferenceCost,
  formatUnitCost,
} from "@/lib/format";
import { STOCK_STATUS_TONE } from "@/lib/status";
import { StatusBadge } from "../ui/status";
import { MasterList } from "../masters/master-list";
import { Details, EmptyState, ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import { PresentationsPanel } from "./presentations";

/*
 * Inventario de materias primas (Fase 3) y piezas comunes con el stock de
 * productos terminados (Fase 4). Todo lo que se ve acá se deriva de los
 * movimientos: no hay ninguna pantalla que edite un saldo.
 */

export const STOCK_BASE = "/stock";

export function StockStatusBadge({ status }: { status: StockStatusDto }) {
  return <StatusBadge tone={STOCK_STATUS_TONE[status]}>{STOCK_STATUS_LABELS[status]}</StatusBadge>;
}

export const PRODUCT_STOCK_BASE = `${STOCK_BASE}/productos`;

/** Pestañas de Inventario: Materias primas | Productos terminados | Movimientos | Bajo mínimo. */
export function StockTabs() {
  const pathname = usePathname();
  const can = useCan();
  const tabs = [
    { href: STOCK_BASE, label: "Materias primas" },
    { href: PRODUCT_STOCK_BASE, label: "Productos terminados" },
    ...(can(P.INVENTORY_EXPIRY_READ)
      ? [{ href: `${PRODUCT_STOCK_BASE}/por-vencer`, label: "Próximos a vencer" }]
      : []),
    { href: `${STOCK_BASE}/movimientos`, label: "Movimientos" },
    { href: `${STOCK_BASE}/bajo-minimo`, label: "Bajo mínimo" },
  ];
  return (
    <nav className="tabs" aria-label="Inventario">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`tabs__link ${pathname === t.href ? "tabs__link--active" : ""}`}
          aria-current={pathname === t.href ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Acciones de inventario (cada una es una operación explícita que genera un movimiento). */
export function StockActions({ rawMaterialId }: { rawMaterialId?: string }) {
  const can = useCan();
  const qs = rawMaterialId ? `?rawMaterialId=${rawMaterialId}` : "";
  return (
    <>
      {can(P.INVENTORY_ADJUST) && (
        <Link className="button" href={`${STOCK_BASE}/ajuste${qs}`}>
          Ajustar stock
        </Link>
      )}
      {can(P.INVENTORY_WASTE) && (
        <Link className="button" href={`${STOCK_BASE}/merma${qs}`}>
          Registrar merma
        </Link>
      )}
      {can(P.INVENTORY_INITIAL_STOCK) && (
        <Link className="button button--tertiary" href={`${STOCK_BASE}/inicial${qs}`}>
          Cargar stock inicial
        </Link>
      )}
    </>
  );
}

export function useWarehouseOptions() {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    fetchOptions<WarehouseDto>("/api/warehouses")
      .then((items) => setOptions(items.map((w) => ({ value: w.id, label: w.name }))))
      .catch(() => setOptions([]));
  }, []);
  return options;
}

export function StockList() {
  const user = useCurrentUser();
  const can = useCan();
  const warehouses = useWarehouseOptions();
  const showCosts = can(P.INVENTORY_COST_READ);
  const currency = user.company.currencyCode;
  return (
    <MasterList<InventoryItemDto>
      title="Stock de materias primas"
      subtitle="Existencias de materias primas, calculadas desde los movimientos de inventario."
      endpoint="/api/inventory"
      basePath={STOCK_BASE}
      searchPlaceholder="Buscar materia prima"
      emptyText="Todavía no hay materias primas con stock para mostrar. Se dan de alta en Materias primas y entran al stock con una compra recibida o con el stock inicial."
      statusParam="stockStatus"
      defaultStatus="all"
      statusOptions={[
        { value: "all", label: "Todos los estados" },
        { value: "below_minimum", label: "Bajo mínimo o sin stock" },
        { value: "OUT_OF_STOCK", label: "Sin stock" },
        { value: "LOW", label: "Bajo mínimo" },
        { value: "OK", label: "OK" },
      ]}
      extraFilters={[
        {
          name: "warehouseId",
          label: "Depósito",
          allLabel: "Todos los depósitos",
          options: warehouses,
        },
      ]}
      headerExtra={
        <div className="toolbar">
          <StockTabs />
          <div className="actions">
            <StockActions />
          </div>
        </div>
      }
      columns={[
        {
          header: "Materia prima",
          cell: (i) => <Link href={`${STOCK_BASE}/${i.id}`}>{i.rawMaterial.name}</Link>,
        },
        {
          header: "Depósito",
          cell: (i) => i.warehouse?.name ?? <span className="muted">Todos los depósitos</span>,
          className: "hide-md",
        },
        {
          header: "Stock actual",
          cell: (i) => <strong>{formatQuantity(i.quantity, i.baseUnit.symbol)}</strong>,
          className: "num",
        },
        {
          header: "Stock mínimo",
          cell: (i) =>
            Number(i.minimumStock) > 0 ? (
              formatQuantity(i.minimumStock, i.baseUnit.symbol)
            ) : (
              <span className="muted">Sin mínimo</span>
            ),
          className: "num hide-md",
        },
        { header: "Estado", cell: (i) => <StockStatusBadge status={i.status} /> },
        ...(showCosts
          ? [
              {
                header: "Costo promedio",
                cell: (i: InventoryItemDto) =>
                  formatUnitCost(i.movingAverageCost, currency, i.baseUnit.symbol),
                className: "num hide-md",
              },
              {
                header: "Valor estimado",
                cell: (i: InventoryItemDto) => formatMoney(i.inventoryValue, currency),
                className: "num hide-md",
              },
            ]
          : []),
      ]}
    />
  );
}

/* ---------- Movimientos ---------- */

function reasonLabel(m: Pick<StockMovementDto, "movementType" | "reason">): string | null {
  if (!m.reason) return null;
  if (m.movementType === "WASTE")
    return WASTE_REASON_LABELS[m.reason as keyof typeof WASTE_REASON_LABELS] ?? "Otro motivo";
  return (
    ADJUSTMENT_REASON_LABELS[m.reason as keyof typeof ADJUSTMENT_REASON_LABELS] ?? "Otro motivo"
  );
}

function SignedQuantity({ m }: { m: StockMovementDto }) {
  const negative = m.quantity.startsWith("-");
  return (
    <span className={negative ? "text-negative" : "text-positive"}>
      {negative ? "" : "+"}
      {formatQuantity(m.quantity, m.baseUnit.symbol)}
    </span>
  );
}

/** Enlace al documento que originó un movimiento o un cambio de costo. */
export function ReferenceLink({
  reference,
}: {
  reference: { type: string; id: string; label: string } | null;
}) {
  const can = useCan();
  // Sin permiso para abrir el documento, se muestra el código sin enlace (nunca un 403).
  if (reference?.type === "PURCHASE")
    return can(P.PURCHASES_READ) ? (
      <Link href={`/compras/${reference.id}`}>{reference.label}</Link>
    ) : (
      <>{reference.label}</>
    );
  if (reference?.type === "PRODUCTION_ORDER")
    return can(P.PRODUCTION_ORDERS_READ) ? (
      <Link href={`/produccion/${reference.id}`}>Producción {reference.label}</Link>
    ) : (
      <>Producción {reference.label}</>
    );
  if (reference?.type === "PRODUCT_LOT_TRANSFORMATION")
    return can(P.PRODUCT_LOTS_READ) ? (
      <Link href={`${STOCK_BASE}/lotes/${reference.id}`}>{reference.label}</Link>
    ) : (
      <>{reference.label}</>
    );
  return null;
}

/** Código de lote enlazado a su detalle sólo si el usuario puede ver lotes. */
function LotRef({ lot }: { lot: { id: string; code: string } }) {
  const can = useCan();
  return can(P.PRODUCT_LOTS_READ) ? (
    <Link href={`${STOCK_BASE}/lotes/${lot.id}`}>{lot.code}</Link>
  ) : (
    <>{lot.code}</>
  );
}

function MovementReference({ m }: { m: StockMovementDto }) {
  if (
    m.reference?.type === "PURCHASE" ||
    m.reference?.type === "PRODUCTION_ORDER" ||
    m.reference?.type === "PRODUCT_LOT_TRANSFORMATION"
  )
    return <ReferenceLink reference={m.reference} />;
  return <>{reasonLabel(m) ?? "—"}</>;
}

/** Ruta del stock de un artículo (materia prima o producto terminado). */
export function itemStockHref(m: Pick<StockMovementDto, "itemType" | "item">): string {
  return m.itemType === "PRODUCT"
    ? `${PRODUCT_STOCK_BASE}/${m.item.id}`
    : `${STOCK_BASE}/${m.item.id}`;
}

export function movementColumns(
  timezone: string,
  currency: string,
  showCosts: boolean,
  withItem: boolean,
) {
  return [
    {
      header: "Fecha",
      cell: (m: StockMovementDto) => formatDateTime(m.occurredAt, timezone),
    },
    ...(withItem
      ? [
          {
            header: "Artículo",
            cell: (m: StockMovementDto) => (
              <>
                <Link href={itemStockHref(m)}>{m.item.name}</Link>
                <span className="cost-source">{STOCK_ITEM_TYPE_LABELS[m.itemType]}</span>
              </>
            ),
          },
        ]
      : []),
    {
      header: "Tipo",
      cell: (m: StockMovementDto) => (
        <>
          {STOCK_MOVEMENT_TYPE_LABELS[m.movementType]}
          {m.productLot && (
            <span className="cost-source">
              Lote <LotRef lot={m.productLot} />
            </span>
          )}
        </>
      ),
    },
    { header: "Depósito", cell: (m: StockMovementDto) => m.warehouse.name, className: "hide-md" },
    {
      header: "Cantidad",
      cell: (m: StockMovementDto) => <SignedQuantity m={m} />,
      className: "num",
    },
    {
      header: "Saldo",
      cell: (m: StockMovementDto) => formatQuantity(m.balanceAfter, m.baseUnit.symbol),
      className: "num hide-md",
    },
    ...(showCosts
      ? [
          {
            header: "Costo unitario",
            cell: (m: StockMovementDto) => formatUnitCost(m.unitCost, currency, m.baseUnit.symbol),
            className: "num hide-md",
          },
        ]
      : []),
    {
      header: "Origen / motivo",
      cell: (m: StockMovementDto) => <MovementReference m={m} />,
    },
    {
      header: "Usuario",
      cell: (m: StockMovementDto) => m.actor?.displayName ?? "—",
      className: "hide-md",
    },
  ];
}

export function MovementList() {
  const user = useCurrentUser();
  const can = useCan();
  const warehouses = useWarehouseOptions();
  return (
    <MasterList<StockMovementDto>
      title="Movimientos de inventario"
      subtitle="Historial completo e inalterable: cada entrada y salida de stock, quién la hizo y por qué."
      endpoint="/api/inventory/movements"
      basePath={`${STOCK_BASE}/movimientos`}
      searchPlaceholder="Buscar materia prima o producto"
      emptyText="Todavía no hay movimientos. Aparecen al recibir compras, completar producciones, vender o registrar ajustes y mermas."
      statusParam="movementType"
      defaultStatus=""
      statusOptions={[
        { value: "", label: "Todos los tipos" },
        ...STOCK_MOVEMENT_TYPES_DTO.map((t) => ({
          value: t,
          label: STOCK_MOVEMENT_TYPE_LABELS[t],
        })),
      ]}
      extraFilters={[
        {
          name: "itemType",
          label: "Artículo",
          allLabel: "Materias primas y productos",
          options: STOCK_ITEM_TYPES.map((t) => ({ value: t, label: STOCK_ITEM_TYPE_LABELS[t] })),
        },
        {
          name: "warehouseId",
          label: "Depósito",
          allLabel: "Todos los depósitos",
          options: warehouses,
        },
      ]}
      dateFilters={[
        { name: "from", label: "Desde" },
        { name: "to", label: "Hasta" },
      ]}
      headerExtra={
        <div className="toolbar">
          <StockTabs />
        </div>
      }
      columns={movementColumns(
        user.company.timezone,
        user.company.currencyCode,
        can(P.INVENTORY_COST_READ),
        true,
      )}
    />
  );
}

export function LowStockList() {
  const can = useCan();
  return (
    <MasterList<LowStockItemDto>
      title="Stock bajo mínimo"
      subtitle="Materias primas cuyo stock total está por debajo del mínimo configurado."
      endpoint="/api/inventory/low-stock"
      basePath={`${STOCK_BASE}/bajo-minimo`}
      searchPlaceholder="Buscar materia prima"
      emptyText="Ninguna materia prima está por debajo de su mínimo."
      hideStatusFilter
      headerExtra={
        <div className="toolbar">
          <StockTabs />
        </div>
      }
      columns={[
        {
          header: "Materia prima",
          cell: (i) => <Link href={`${STOCK_BASE}/${i.id}`}>{i.rawMaterial.name}</Link>,
        },
        {
          header: "Stock actual",
          cell: (i) => formatQuantity(i.quantity, i.baseUnit.symbol),
          className: "num",
        },
        {
          header: "Mínimo",
          cell: (i) => formatQuantity(i.minimumStock, i.baseUnit.symbol),
          className: "num",
        },
        {
          header: "Faltante",
          cell: (i) => <strong>{formatQuantity(i.shortage, i.baseUnit.symbol)}</strong>,
          className: "num",
        },
        { header: "Estado", cell: (i) => <StockStatusBadge status={i.status} /> },
        {
          header: "Proveedor preferido",
          cell: (i) => i.preferredSupplier?.name ?? <span className="muted">Sin proveedor</span>,
          className: "hide-md",
        },
        ...(can(P.PURCHASES_CREATE)
          ? [
              {
                header: "Acción",
                cell: (i: LowStockItemDto) => (
                  <Link
                    className="button button--small"
                    href={listPath("/compras/nueva", {
                      rawMaterialId: i.rawMaterial.id,
                      supplierId: i.preferredSupplier?.id,
                    })}
                  >
                    Crear compra
                  </Link>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/* ---------- Detalle ---------- */

export function StockDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error } = useResource<InventoryDetailDto>(`/api/inventory/raw-materials/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const currency = data.currency;
  const unit = data.baseUnit.symbol;
  const tz = user.company.timezone;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: STOCK_BASE, label: "Stock de materias primas" }}
        title={data.rawMaterial.name}
        status={<StockStatusBadge status={data.status} />}
        subtitle={
          <>
            Código <span className="code">{data.rawMaterial.code}</span> · Unidad base {unit}
            {data.rawMaterial.preferredSupplier
              ? ` · Proveedor preferido: ${data.rawMaterial.preferredSupplier.name}`
              : ""}
          </>
        }
        actions={
          <>
            <StockActions rawMaterialId={id} />
            {can(P.PURCHASES_CREATE) && (
              <Link
                className="button button--primary"
                href={listPath("/compras/nueva", {
                  rawMaterialId: id,
                  supplierId: data.rawMaterial.preferredSupplier?.id,
                })}
              >
                Nueva compra
              </Link>
            )}
          </>
        }
      />

      <section className="panel" aria-labelledby="stock-title">
        <h2 id="stock-title">Existencias</h2>
        <dl className="cost-summary">
          <div
            className={`metric ${data.status === "OUT_OF_STOCK" ? "metric--danger" : data.status === "LOW" ? "metric--warning" : "metric--emphasis"}`}
          >
            <dt>Stock total</dt>
            <dd className="metric__value">{formatQuantity(data.quantity, unit)}</dd>
          </div>
          <div>
            <dt>Stock mínimo</dt>
            <dd>
              {Number(data.rawMaterial.minimumStock) > 0
                ? formatQuantity(data.rawMaterial.minimumStock, unit)
                : "Sin mínimo"}
            </dd>
          </div>
          <div>
            <dt>Faltante</dt>
            <dd>
              {Number(data.shortage) > 0 ? formatQuantity(data.shortage, unit) : "Sin faltante"}
            </dd>
          </div>
        </dl>
        {data.byWarehouse.length > 0 && (
          <div className="table-wrap" style={{ marginTop: "1rem" }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Depósito</th>
                  <th scope="col" className="num">
                    Stock
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.byWarehouse.map((b) => (
                  <tr key={b.warehouse.id}>
                    <td>{b.warehouse.name}</td>
                    <td className="num">{formatQuantity(b.quantity, unit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="num">
                    <strong>{formatQuantity(data.quantity, unit)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="costs-title">
        <h2 id="costs-title">Costos</h2>
        <dl className="cost-summary cost-summary--costs">
          {data.canSeeCosts && (
            <div>
              <dt>Costo promedio de inventario</dt>
              <dd>
                {data.movingAverageCost === null
                  ? "Sin compras ni stock valorizado"
                  : formatUnitCost(data.movingAverageCost, currency, unit)}
              </dd>
            </div>
          )}
          <div>
            <dt>Costo de referencia manual</dt>
            <dd>
              {data.referenceCost === null
                ? "Sin cargar"
                : formatReferenceCost(data.referenceCost, currency, unit)}
            </dd>
          </div>
          <div>
            <dt>Costo usado por recetas</dt>
            <dd>
              {data.effectiveCost === null
                ? "Sin costo"
                : data.effectiveCostSource === "PURCHASE_MOVING_AVERAGE"
                  ? formatUnitCost(data.effectiveCost, currency, unit)
                  : formatReferenceCost(data.effectiveCost, currency, unit)}
              {data.effectiveCostSource && (
                <span className="cost-summary__note">
                  {" "}
                  Origen:{" "}
                  {data.effectiveCostSource === "PURCHASE_MOVING_AVERAGE"
                    ? "compras (promedio ponderado)"
                    : COST_SOURCE_LABELS[data.effectiveCostSource].toLowerCase()}
                </span>
              )}
            </dd>
          </div>
          {data.canSeeCosts && (
            <div>
              <dt>Valor de inventario</dt>
              <dd>{formatMoney(data.inventoryValue, currency)}</dd>
            </div>
          )}
        </dl>
        <Details
          items={[
            [
              "Última compra",
              data.lastPurchase ? (
                <>
                  {can(P.PURCHASES_READ) ? (
                    <Link href={`/compras/${data.lastPurchase.purchaseId}`}>
                      {data.lastPurchase.purchaseNumber}
                    </Link>
                  ) : (
                    data.lastPurchase.purchaseNumber
                  )}{" "}
                  · {data.lastPurchase.supplierName} ·{" "}
                  {formatDateTime(data.lastPurchase.receivedAt, tz)}
                  {data.lastPurchase.unitCost !== null &&
                    ` · ${formatUnitCost(data.lastPurchase.unitCost, currency, unit)}`}
                </>
              ) : null,
            ],
          ]}
        />
        <p className="muted small">
          Las recetas usan el promedio ponderado de compras cuando existe; si no, el costo de
          referencia manual. El costo de referencia se conserva aunque deje de usarse.
        </p>
      </section>

      <PresentationsPanel rawMaterialId={id} baseUnit={data.baseUnit} />
      <ItemMovements filter={{ rawMaterialId: id }} name={data.rawMaterial.name} />
      {can(P.INVENTORY_COST_READ) && <CostHistory rawMaterialId={id} unit={unit} />}
    </div>
  );
}

export function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <span>
        Página {page} de {pages}
      </span>
      <div className="actions">
        <button
          type="button"
          className="button button--small"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Anterior
        </button>
        <button
          type="button"
          className="button button--small"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

/** Últimos movimientos de un artículo (materia prima o producto terminado). */
export function ItemMovements({
  filter,
  name,
}: {
  filter: { rawMaterialId: string } | { productId: string };
  name: string;
}) {
  const user = useCurrentUser();
  const can = useCan();
  const [page, setPage] = useState(1);
  const { data, error } = useResource<Page<StockMovementDto>>(
    listPath("/api/inventory/movements", { ...filter, page, pageSize: 10 }),
  );
  const columns = movementColumns(
    user.company.timezone,
    user.company.currencyCode,
    can(P.INVENTORY_COST_READ),
    false,
  );
  return (
    <section className="panel" aria-labelledby="movements-title">
      <div className="panel__header">
        <h2 id="movements-title">Movimientos</h2>
        <Link href={listPath(`${STOCK_BASE}/movimientos`, { q: name })}>Ver todos</Link>
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <EmptyState compact title="Sin movimientos todavía." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.header} scope="col" className={c.className}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    {columns.map((c) => (
                      <td key={c.header} className={c.className}>
                        {c.cell(m)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </section>
  );
}

function CostHistory({ rawMaterialId, unit }: { rawMaterialId: string; unit: string }) {
  const user = useCurrentUser();
  const [page, setPage] = useState(1);
  const { data, error } = useResource<{
    cost: InventoryCostDto;
    history: Page<CostHistoryEntryDto>;
  }>(listPath(`/api/inventory/costs/${rawMaterialId}`, { page, pageSize: 10 }));
  const currency = user.company.currencyCode;
  return (
    <section className="panel" aria-labelledby="cost-history-title">
      <h2 id="cost-history-title">Historial de costo promedio</h2>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : data.history.items.length === 0 ? (
        <p className="muted">Sin cambios todavía.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Origen</th>
                  <th scope="col" className="num">
                    Promedio anterior
                  </th>
                  <th scope="col" className="num">
                    Promedio nuevo
                  </th>
                  <th scope="col" className="num hide-sm">
                    Stock después
                  </th>
                  <th scope="col" className="num hide-sm">
                    Valor después
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.history.items.map((h) => (
                  <tr key={h.id}>
                    <td>{formatDateTime(h.createdAt, user.company.timezone)}</td>
                    <td>
                      {STOCK_MOVEMENT_TYPE_LABELS[h.movementType]}
                      {h.reference && (
                        <>
                          {" · "}
                          <ReferenceLink reference={h.reference} />
                        </>
                      )}
                    </td>
                    <td className="num">
                      {h.averageBefore === null
                        ? "—"
                        : formatUnitCost(h.averageBefore, currency, unit)}
                    </td>
                    <td className="num">
                      {h.averageAfter === null
                        ? "—"
                        : formatUnitCost(h.averageAfter, currency, unit)}
                      {!h.averageChanged && <span className="cost-source">sin cambio</span>}
                    </td>
                    <td className="num hide-sm">{formatQuantity(h.quantityAfter, unit)}</td>
                    <td className="num hide-sm">{formatMoney(h.valueAfter, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page}
            total={data.history.total}
            pageSize={data.history.pageSize}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
