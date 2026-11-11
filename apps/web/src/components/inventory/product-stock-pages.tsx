"use client";

import { D } from "@bakery/domain";
import {
  PERMISSIONS as P,
  type Page,
  type ProductCostDto,
  type ProductCostHistoryEntryDto,
  type ProductStockDetailDto,
  type ProductStockItemDto,
} from "@bakery/shared";
import Link from "next/link";
import { useState } from "react";
import { listPath } from "@/lib/api-client";
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatUnitCost,
} from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  Details,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "../masters/ui";
import { StatusBadge as ToneBadge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";
import { AvailabilityAtDate, ProductLotsPanel, StateBreakdown } from "../lots/lot-pages";
import { EXPIRING_PATH } from "../lots/lot-shared";
import {
  ItemMovements,
  PRODUCT_STOCK_BASE,
  Pager,
  StockTabs,
  useWarehouseOptions,
} from "./inventory-pages";

/*
 * Stock de productos terminados (Fase 4 y 4.5). Entra sólo al completar una orden
 * de producción, en un lote con su conservación y vencimiento; su costo promedio
 * es el costo material de los lotes producidos.
 */

const isZero = (v: string) => new D(v).isZero();

/** Lo que pide atención en el stock de un producto: vencido, bloqueado, próximo a vencer. */
function StockAlerts({ lots, unit }: { lots: ProductStockItemDto["lots"]; unit: string }) {
  const items: { tone: "danger" | "warning"; label: string; qty: string }[] = [];
  if (!isZero(lots.expired)) items.push({ tone: "danger", label: "Vencido", qty: lots.expired });
  if (!isZero(lots.blocked)) items.push({ tone: "danger", label: "Bloqueado", qty: lots.blocked });
  if (!isZero(lots.nearExpiry))
    items.push({ tone: "warning", label: "Próximo a vencer", qty: lots.nearExpiry });
  if (items.length === 0) return <span className="muted">Sin alertas</span>;
  return (
    <span className="chips">
      {items.map((i) => (
        <ToneBadge key={i.label} tone={i.tone}>
          {i.label} {formatQuantity(i.qty, unit)}
        </ToneBadge>
      ))}
    </span>
  );
}

/**
 * Resumen de vencimientos de la empresa (total de lotes, no sólo la página):
 * se cuenta con el listado de próximos a vencer que ya existe.
 */
function ExpiryAttention() {
  const can = useCan();
  const allowed = can(P.INVENTORY_EXPIRY_READ);
  const { data: near } = useResource<Page<{ id: string }>>(
    allowed ? listPath("/api/inventory/expiring", { status: "near_expiry", pageSize: 1 }) : null,
  );
  const { data: expired } = useResource<Page<{ id: string }>>(
    allowed ? listPath("/api/inventory/expiring", { status: "expired", pageSize: 1 }) : null,
  );
  if (!allowed || !near || !expired) return null;
  const lots = (n: number) => `${n} ${n === 1 ? "lote" : "lotes"}`;
  return (
    <div className="attention" aria-label="Vencimientos">
      <Link
        href={listPath(EXPIRING_PATH, { estado: "expired" })}
        className={`attention__item ${expired.total > 0 ? "attention__item--danger" : "attention__item--ok"}`}
      >
        <span className="attention__count">{expired.total}</span>
        <span className="attention__title">Vencidos</span>
        <span className="attention__hint">
          {expired.total > 0
            ? `${lots(expired.total)} sin usar: registrá la merma.`
            : "Ningún lote vencido con stock."}
        </span>
      </Link>
      <Link
        href={listPath(EXPIRING_PATH, { estado: "near_expiry" })}
        className={`attention__item ${near.total > 0 ? "attention__item--warning" : "attention__item--ok"}`}
      >
        <span className="attention__count">{near.total}</span>
        <span className="attention__title">Próximos a vencer</span>
        <span className="attention__hint">
          {near.total > 0
            ? `${lots(near.total)}: usalos primero o congelalos.`
            : "Nada vence pronto."}
        </span>
      </Link>
    </div>
  );
}

export function ProductStockList() {
  const user = useCurrentUser();
  const can = useCan();
  const warehouses = useWarehouseOptions();
  const showCosts = can(P.INVENTORY_COST_READ);
  const currency = user.company.currencyCode;
  return (
    <MasterList<ProductStockItemDto>
      title="Stock de productos terminados"
      subtitle="Qué hay, qué está reservado para pedidos y qué se puede vender ahora. Entra al completar una producción; sale por venta, entrega o merma."
      endpoint="/api/inventory/products"
      basePath={PRODUCT_STOCK_BASE}
      searchPlaceholder="Buscar producto"
      emptyText="No hay productos que controlen stock. Se configura en la ficha del producto (“Controla stock”)."
      statusParam="stock"
      defaultStatus="all"
      statusOptions={[
        { value: "all", label: "Todos los productos" },
        { value: "in_stock", label: "Sólo con stock" },
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
        <>
          <div className="toolbar">
            <StockTabs />
          </div>
          <ExpiryAttention />
        </>
      }
      columns={[
        {
          header: "Producto",
          cell: (i) => (
            <>
              <Link href={`${PRODUCT_STOCK_BASE}/${i.id}`}>{i.product.name}</Link>
              {!i.product.active && <span className="cost-source">Inactivo</span>}
            </>
          ),
        },
        {
          header: "Depósito",
          cell: (i) => i.warehouse?.name ?? <span className="muted">Todos los depósitos</span>,
          className: "hide-md",
        },
        {
          header: "Stock físico",
          cell: (i) => formatQuantity(i.quantity, i.saleUnit.symbol),
          className: "num",
        },
        {
          header: "Conservación",
          cell: (i: ProductStockItemDto) => (
            <span className="small">
              <StateBreakdown byState={i.lots.byState} unit={i.saleUnit.symbol} />
            </span>
          ),
          className: "hide-md",
        },
        {
          header: "Comprometido",
          cell: (i: ProductStockItemDto) =>
            isZero(i.lots.committed) ? (
              <span className="muted">{formatQuantity("0", i.saleUnit.symbol)}</span>
            ) : (
              formatQuantity(i.lots.committed, i.saleUnit.symbol)
            ),
          className: "num",
        },
        {
          header: "Disponible ahora",
          cell: (i: ProductStockItemDto) => (
            <strong>{formatQuantity(i.lots.availableNow, i.saleUnit.symbol)}</strong>
          ),
          className: "num",
        },
        {
          header: "Vencimientos y bloqueos",
          cell: (i: ProductStockItemDto) => <StockAlerts lots={i.lots} unit={i.saleUnit.symbol} />,
        },
        ...(showCosts
          ? [
              {
                header: "Costo material promedio",
                cell: (i: ProductStockItemDto) =>
                  formatUnitCost(i.averageMaterialCost, currency, i.saleUnit.symbol),
                className: "num hide-md",
              },
              {
                header: "Valor",
                cell: (i: ProductStockItemDto) => formatMoney(i.inventoryValue, currency),
                className: "num hide-md",
              },
            ]
          : []),
        {
          header: "Última producción",
          cell: (i) =>
            i.lastProduction ? (
              <>
                {can(P.PRODUCTION_ORDERS_READ) ? (
                  <Link href={`/produccion/${i.lastProduction.id}`}>{i.lastProduction.code}</Link>
                ) : (
                  i.lastProduction.code
                )}
                <span className="cost-source">
                  {formatDateTime(i.lastProduction.completedAt, user.company.timezone)}
                </span>
              </>
            ) : (
              <span className="muted">Sin producciones</span>
            ),
          className: "hide-md",
        },
      ]}
    />
  );
}

export function ProductStockDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const { data, error } = useResource<ProductStockDetailDto>(`/api/inventory/products/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const currency = data.currency;
  const unit = data.saleUnit.symbol;
  const tz = user.company.timezone;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PRODUCT_STOCK_BASE, label: "Stock de productos terminados" }}
        title={data.product.name}
        status={!data.product.active ? <StatusBadge active={false} /> : undefined}
        subtitle={
          <>
            Código <span className="code">{data.product.code}</span> · Se vende por {unit}
          </>
        }
        actions={
          can(P.PRODUCTION_ORDERS_CREATE) && data.product.active && data.product.controlsStock ? (
            <Link
              className="button button--primary"
              href={listPath("/produccion/nueva", { productId: id })}
            >
              Nueva orden de producción
            </Link>
          ) : undefined
        }
      />

      <section className="panel" aria-labelledby="stock-title">
        <div className="panel__header">
          <h2 id="stock-title">Existencias</h2>
          {can(P.INVENTORY_EXPIRY_READ) && <Link href={EXPIRING_PATH}>Ver próximos a vencer</Link>}
        </div>
        <dl className="cost-summary">
          <div className="metric">
            <dt>Stock físico</dt>
            <dd className="metric__value">{formatQuantity(data.quantity, unit)}</dd>
          </div>
          <div className="metric">
            <dt>Comprometido con pedidos</dt>
            <dd className="metric__value">{formatQuantity(data.lots.committed, unit)}</dd>
          </div>
          <div className="metric metric--emphasis">
            <dt>Disponible ahora</dt>
            <dd className="metric__value">{formatQuantity(data.lots.availableNow, unit)}</dd>
          </div>
          <div className="metric">
            <dt>Utilizable ahora</dt>
            <dd className="metric__value">{formatQuantity(data.lots.usableNow, unit)}</dd>
          </div>
          <div className={`metric ${new D(data.lots.nearExpiry).gt(0) ? "metric--warning" : ""}`}>
            <dt>Próximo a vencer</dt>
            <dd className="metric__value">{formatQuantity(data.lots.nearExpiry, unit)}</dd>
          </div>
          {new D(data.lots.expired).gt(0) && (
            <div className="metric metric--danger">
              <dt>Vencido</dt>
              <dd className="metric__value">{formatQuantity(data.lots.expired, unit)}</dd>
            </div>
          )}
          {new D(data.lots.blocked).gt(0) && (
            <div className="metric metric--danger">
              <dt>Bloqueado</dt>
              <dd className="metric__value">{formatQuantity(data.lots.blocked, unit)}</dd>
            </div>
          )}
          {data.canSeeCosts && (
            <>
              <div className="metric">
                <dt>Costo promedio de inventario</dt>
                <dd className="metric__value">
                  {data.averageMaterialCost === null
                    ? "Sin producciones"
                    : formatUnitCost(data.averageMaterialCost, currency, unit)}
                </dd>
              </div>
              <div className="metric">
                <dt>Valor de inventario</dt>
                <dd className="metric__value">{formatMoney(data.inventoryValue, currency)}</dd>
              </div>
            </>
          )}
        </dl>
        <p className="muted small">
          <strong>Disponible ahora</strong> es lo utilizable (sin vencer ni bloquear) que no está
          reservado para pedidos: lo que se puede vender ya.
          {(new D(data.lots.expired).gt(0) || new D(data.lots.blocked).gt(0)) &&
            " Lo vencido y lo bloqueado siguen en el stock físico hasta registrar la merma o desbloquearlo."}
        </p>
        <p className="muted small">
          Por conservación: <StateBreakdown byState={data.lots.byState} unit={unit} />
          {!data.conservationConfigured &&
            " · Sin conservación configurada: los lotes no tienen vencimiento."}
        </p>
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

      <ProductLotsPanel productId={id} unit={unit} />
      <AvailabilityAtDate productId={id} unit={unit} />

      <section className="panel" aria-labelledby="price-title">
        <h2 id="price-title">Precio y margen</h2>
        <dl className="cost-summary cost-summary--costs">
          <div>
            <dt>Precio de venta</dt>
            <dd>{formatUnitCost(data.product.salePrice, currency, unit)}</dd>
          </div>
          {data.canSeeCosts && (
            <div>
              <dt>Margen teórico sobre el costo promedio</dt>
              <dd>
                {data.theoreticalMargin === null ? (
                  "Sin costo promedio todavía"
                ) : (
                  <>
                    {formatUnitCost(data.theoreticalMargin.amount, currency, unit)}
                    {data.theoreticalMargin.percentage !== null && (
                      <span className="cost-summary__note">
                        {" "}
                        {formatPercent(data.theoreticalMargin.percentage)} del precio
                      </span>
                    )}
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
        <Details
          items={[
            [
              "Receta activa",
              data.activeRecipe ? (
                <Link href={`/recetas/${data.activeRecipe.recipeId}`}>
                  {data.activeRecipe.name}
                  {data.activeRecipe.versionNumber !== null &&
                    ` · versión ${data.activeRecipe.versionNumber}`}
                </Link>
              ) : (
                "Sin receta"
              ),
            ],
          ]}
        />
        {data.canSeeCosts && (
          <p className="muted small">
            El margen teórico compara el precio de venta con el costo material promedio del stock.
            No incluye mano de obra, energía ni gastos indirectos.
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="productions-title">
        <div className="panel__header">
          <h2 id="productions-title">Producciones recientes</h2>
          {can(P.PRODUCTION_ORDERS_READ) && (
            <Link href={listPath("/produccion", { productId: id })}>Ver todas</Link>
          )}
        </div>
        {data.recentProductions.length === 0 ? (
          <EmptyState compact title="Todavía no se produjo." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Orden</th>
                  <th scope="col" className="hide-md">
                    Lote
                  </th>
                  <th scope="col">Completada</th>
                  <th scope="col" className="num">
                    Cantidad
                  </th>
                  {data.canSeeCosts && (
                    <th scope="col" className="num">
                      Costo unitario
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.recentProductions.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {can(P.PRODUCTION_ORDERS_READ) ? (
                        <Link href={`/produccion/${p.id}`}>{p.code}</Link>
                      ) : (
                        p.code
                      )}
                    </td>
                    <td className="hide-md">{p.batchCode ?? "—"}</td>
                    <td>{formatDateTime(p.completedAt, tz)}</td>
                    <td className="num">{formatQuantity(p.quantity, unit)}</td>
                    {data.canSeeCosts && (
                      <td className="num">{formatUnitCost(p.unitCost, currency, unit)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ItemMovements filter={{ productId: id }} name={data.product.name} />
      {data.canSeeCosts && <ProductCostHistory productId={id} unit={unit} />}
    </div>
  );
}

function ProductCostHistory({ productId, unit }: { productId: string; unit: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const [page, setPage] = useState(1);
  const { data, error } = useResource<{
    cost: ProductCostDto;
    history: Page<ProductCostHistoryEntryDto>;
  }>(listPath(`/api/inventory/products/${productId}/cost-history`, { page, pageSize: 10 }));
  const currency = user.company.currencyCode;
  return (
    <section className="panel" aria-labelledby="cost-history-title">
      <h2 id="cost-history-title">Historial de costo promedio</h2>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : data.history.items.length === 0 ? (
        <p className="muted">Sin producciones todavía.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Producción</th>
                  <th scope="col" className="num">
                    Lote producido
                  </th>
                  <th scope="col" className="num">
                    Promedio anterior
                  </th>
                  <th scope="col" className="num">
                    Promedio nuevo
                  </th>
                  <th scope="col" className="num hide-sm">
                    Stock después
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.history.items.map((h) => (
                  <tr key={h.id}>
                    <td>{formatDateTime(h.createdAt, user.company.timezone)}</td>
                    <td>
                      {h.productionOrder ? (
                        can(P.PRODUCTION_ORDERS_READ) ? (
                          <Link href={`/produccion/${h.productionOrder.id}`}>
                            {h.productionOrder.code}
                          </Link>
                        ) : (
                          h.productionOrder.code
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {formatQuantity(h.batchQuantity, unit)}
                      <span className="cost-source">
                        {formatUnitCost(h.batchUnitCost, currency, unit)}
                      </span>
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
