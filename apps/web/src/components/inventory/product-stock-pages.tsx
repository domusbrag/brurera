"use client";

import { D } from "@bakery/domain";
import {
  CONSERVATION_STATE_LABELS,
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
  formatReferenceCost,
} from "@/lib/format";
import { MasterList } from "../masters/master-list";
import { Details, ErrorState, Loading, PageHeader, StatusBadge, useResource } from "../masters/ui";
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

export function ProductStockList() {
  const user = useCurrentUser();
  const can = useCan();
  const warehouses = useWarehouseOptions();
  const showCosts = can(P.INVENTORY_COST_READ);
  const currency = user.company.currencyCode;
  return (
    <MasterList<ProductStockItemDto>
      title="Stock de productos terminados"
      subtitle="Existencias de lo que se produjo, por lote y conservación. Entran al completar una producción; salen por merma."
      endpoint="/api/inventory/products"
      basePath={PRODUCT_STOCK_BASE}
      searchPlaceholder="Buscar producto"
      emptyText="No hay productos que controlen stock."
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
        <div className="toolbar">
          <StockTabs />
        </div>
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
          cell: (i) => i.warehouse?.name ?? "Todos",
          className: "hide-sm",
        },
        {
          header: "Físico",
          cell: (i) => <strong>{formatQuantity(i.quantity, i.saleUnit.symbol)}</strong>,
          className: "num",
        },
        ...(["FRESH", "REFRIGERATED", "FROZEN"] as const).map((state) => ({
          header: CONSERVATION_STATE_LABELS[state],
          cell: (i: ProductStockItemDto) =>
            new D(i.lots.byState[state]).isZero()
              ? "—"
              : formatQuantity(i.lots.byState[state], i.saleUnit.symbol),
          className: "num hide-md",
        })),
        {
          header: "Utilizable ahora",
          cell: (i: ProductStockItemDto) => formatQuantity(i.lots.usableNow, i.saleUnit.symbol),
          className: "num",
        },
        {
          header: "Próximo a vencer",
          cell: (i: ProductStockItemDto) =>
            new D(i.lots.nearExpiry).isZero() ? (
              "—"
            ) : (
              <span className="badge badge--warn">
                {formatQuantity(i.lots.nearExpiry, i.saleUnit.symbol)}
              </span>
            ),
          className: "num",
        },
        ...(showCosts
          ? [
              {
                header: "Costo promedio",
                cell: (i: ProductStockItemDto) =>
                  formatReferenceCost(i.movingAverageCost, currency, i.saleUnit.symbol),
                className: "num hide-sm",
              },
              {
                header: "Valor",
                cell: (i: ProductStockItemDto) => formatMoney(i.inventoryValue, currency),
                className: "num",
              },
            ]
          : []),
        {
          header: "Última producción",
          cell: (i) =>
            i.lastProduction ? (
              <>
                <Link href={`/produccion/${i.lastProduction.id}`}>{i.lastProduction.code}</Link>
                <span className="cost-source">
                  {formatDateTime(i.lastProduction.completedAt, user.company.timezone)}
                </span>
              </>
            ) : (
              "—"
            ),
          className: "hide-sm",
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
        title={
          <>
            {data.product.name} {!data.product.active && <StatusBadge active={false} />}
          </>
        }
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
          <div>
            <dt>Stock físico</dt>
            <dd>{formatQuantity(data.quantity, unit)}</dd>
          </div>
          <div>
            <dt>Utilizable ahora</dt>
            <dd>{formatQuantity(data.lots.usableNow, unit)}</dd>
          </div>
          <div>
            <dt>Próximo a vencer</dt>
            <dd className={new D(data.lots.nearExpiry).gt(0) ? "text-negative" : undefined}>
              {formatQuantity(data.lots.nearExpiry, unit)}
            </dd>
          </div>
          {data.canSeeCosts && (
            <>
              <div>
                <dt>Costo promedio de inventario</dt>
                <dd>
                  {data.movingAverageCost === null
                    ? "Sin producciones"
                    : formatReferenceCost(data.movingAverageCost, currency, unit)}
                </dd>
              </div>
              <div>
                <dt>Valor de inventario</dt>
                <dd>{formatMoney(data.inventoryValue, currency)}</dd>
              </div>
            </>
          )}
        </dl>
        <p className="muted small">
          Por conservación: <StateBreakdown byState={data.lots.byState} unit={unit} />
          {new D(data.lots.expired).gt(0) &&
            ` · vencido ${formatQuantity(data.lots.expired, unit)}`}
          {new D(data.lots.blocked).gt(0) &&
            ` · bloqueado ${formatQuantity(data.lots.blocked, unit)}`}
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
            <dd>{formatReferenceCost(data.product.salePrice, currency, unit)}</dd>
          </div>
          {data.canSeeCosts && (
            <div>
              <dt>Margen teórico sobre el costo promedio</dt>
              <dd>
                {data.theoreticalMargin === null ? (
                  "Sin costo promedio todavía"
                ) : (
                  <>
                    {formatReferenceCost(data.theoreticalMargin.amount, currency, unit)}
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
          <p className="muted">Todavía no se produjo.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Orden</th>
                  <th scope="col" className="hide-sm">
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
                    <td className="hide-sm">{p.batchCode ?? "—"}</td>
                    <td>{formatDateTime(p.completedAt, tz)}</td>
                    <td className="num">{formatQuantity(p.quantity, unit)}</td>
                    {data.canSeeCosts && (
                      <td className="num">{formatReferenceCost(p.unitCost, currency, unit)}</td>
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
        <p className="muted">{error.message}</p>
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
                        <Link href={`/produccion/${h.productionOrder.id}`}>
                          {h.productionOrder.code}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {formatQuantity(h.batchQuantity, unit)}
                      <span className="cost-source">
                        {formatReferenceCost(h.batchUnitCost, currency, unit)}
                      </span>
                    </td>
                    <td className="num">
                      {h.averageBefore === null
                        ? "—"
                        : formatReferenceCost(h.averageBefore, currency, unit)}
                    </td>
                    <td className="num">
                      {h.averageAfter === null
                        ? "—"
                        : formatReferenceCost(h.averageAfter, currency, unit)}
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
