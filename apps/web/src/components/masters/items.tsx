"use client";

import {
  COST_SOURCE_LABELS,
  PERMISSIONS as P,
  type CategoryDto,
  type Page,
  type ProductDto,
  type RawMaterialDto,
  type RecipeListItemDto,
  type RecipeVersionCostDto,
  type SupplierDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import {
  formatDateTime,
  formatDecimal,
  formatMoney,
  formatPercent,
  formatReferenceCost,
  formatUnitCost,
} from "@/lib/format";
import { useCan, useCurrentUser } from "../user-context";
import { EntityForm, toFormValues, toPayload, type FieldDef } from "./entity-form";
import { PresentationsPanel } from "../inventory/presentations";
import { MasterList } from "./master-list";
import {
  ActiveToggle,
  AuditHistory,
  ConfirmAction,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "./ui";

/*
 * Materias primas (lo que se compra y se consume) y productos terminados (lo
 * que se vende). Son maestros distintos, con categorías de tipo distinto.
 */

type Option = { value: string; label: string };

/** Agrega el valor actual si no está entre las opciones (p. ej. categoría ya inactiva). */
function withCurrent(
  options: Option[],
  current: { id: string; name: string } | null | undefined,
): Option[] {
  if (!current || options.some((o) => o.value === current.id)) return options;
  return [...options, { value: current.id, label: `${current.name} (inactiva)` }];
}

function useCategoryOptions(type: "RAW_MATERIAL" | "PRODUCT") {
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    fetchOptions<CategoryDto>("/api/categories", { type })
      .then((items) => setOptions(items.map((c) => ({ value: c.id, label: c.name }))))
      .catch(() => setOptions([]));
  }, [type]);
  return options;
}

function useUnitOptions(rootsOnly: boolean) {
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    fetchOptions<UnitDto>("/api/units")
      .then((items) =>
        setOptions(
          items
            .filter((u) => !rootsOnly || u.baseUnit === null)
            .map((u) => ({ value: u.id, label: `${u.name} (${u.symbol})` })),
        ),
      )
      .catch(() => setOptions([]));
  }, [rootsOnly]);
  return options;
}

/* ---------- Materias primas ---------- */

const MP_BASE = "/materias-primas";
const MP_API = "/api/raw-materials";

export function RawMaterialList() {
  const can = useCan();
  const user = useCurrentUser();
  const categories = useCategoryOptions("RAW_MATERIAL");
  return (
    <MasterList<RawMaterialDto>
      title="Materias primas"
      subtitle="Insumos que se compran y se consumen en producción (harina, levadura, envases…)."
      endpoint={MP_API}
      basePath={MP_BASE}
      searchPlaceholder="Buscar por nombre o código"
      createLabel="Nueva materia prima"
      canCreate={can(P.RAW_MATERIALS_CREATE)}
      emptyText="Todavía no hay materias primas cargadas."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      extraFilters={[{ name: "categoryId", label: "Categoría", options: categories ?? [] }]}
      columns={[
        { header: "Código", cell: (m) => <span className="code">{m.code}</span> },
        { header: "Materia prima", cell: (m) => <Link href={`${MP_BASE}/${m.id}`}>{m.name}</Link> },
        { header: "Categoría", cell: (m) => m.category.name, className: "hide-sm" },
        { header: "Unidad base", cell: (m) => m.baseUnit.symbol, className: "hide-sm" },
        {
          header: "Costo usado",
          cell: (m) =>
            m.effectiveCost === null ? (
              <span className="badge badge--warn">Sin costo</span>
            ) : (
              <>
                {formatReferenceCost(m.effectiveCost, user.company.currencyCode, m.baseUnit.symbol)}
                <span className="cost-source">
                  {m.effectiveCostSource === "PURCHASE_MOVING_AVERAGE"
                    ? "Promedio de compras"
                    : "Referencia manual"}
                </span>
              </>
            ),
          className: "num",
        },
        {
          header: "Estado",
          cell: (m) => <StatusBadge active={m.active} on="Activa" off="Inactiva" />,
        },
      ]}
    />
  );
}

export function RawMaterialForm({ id }: { id?: string }) {
  const router = useRouter();
  const can = useCan();
  const user = useCurrentUser();
  const { data, error } = useResource<RawMaterialDto>(id ? `${MP_API}/${id}` : null);
  const categories = useCategoryOptions("RAW_MATERIAL");
  const units = useUnitOptions(true);
  const [suppliers, setSuppliers] = useState<Option[] | null>(null);
  useEffect(() => {
    fetchOptions<SupplierDto>("/api/suppliers")
      .then((items) =>
        setSuppliers(items.map((s) => ({ value: s.id, label: s.tradeName ?? s.legalName }))),
      )
      .catch(() => setSuppliers([]));
  }, []);

  if (id && error) return <ErrorState error={error} />;
  if ((id && !data) || !categories || !units || !suppliers) return <Loading />;

  const defs: FieldDef[] = [
    ...(!id
      ? [
          {
            name: "code",
            label: "Código",
            placeholder: "Automático (MP-0001…)",
            hint: "Dejalo vacío para generarlo solo.",
          },
        ]
      : []),
    { name: "name", label: "Nombre", required: true },
    {
      name: "categoryId",
      label: "Categoría",
      kind: "select",
      required: true,
      options: withCurrent(categories, data?.category),
      hint:
        categories.length === 0
          ? "Primero creá una categoría de materias primas en Configuración."
          : undefined,
    },
    {
      name: "baseUnitId",
      label: "Unidad base",
      kind: "select",
      required: true,
      options: units,
      hint: "Unidad en la que se medirá el stock y el costo (kg, l, unidad…).",
    },
    {
      name: "minimumStock",
      label: "Stock mínimo",
      kind: "decimal",
      placeholder: "0",
      hint: "En la unidad base. Se usará para alertas desde la fase de inventario.",
    },
    {
      name: "preferredSupplierId",
      label: "Proveedor preferido",
      kind: "select",
      options: withCurrent(
        suppliers,
        data?.preferredSupplier
          ? { id: data.preferredSupplier.id, name: data.preferredSupplier.legalName }
          : null,
      ),
    },
    // El costo inicial sólo se carga al crear y con permiso de costos; después se
    // cambia desde el detalle ("Cambiar costo"), con su propia auditoría.
    ...(!id && can(P.RAW_MATERIALS_UPDATE_COST)
      ? [
          {
            name: "referenceCost",
            label: `Costo de referencia (${user.company.currencyCode} por unidad base)`,
            kind: "decimal" as const,
            placeholder: "Sin costo",
            hint: "Precio por kg, litro o unidad (la unidad base), no por bolsa ni caja. Es una referencia manual hasta que las compras (Fase 3) lo calculen.",
          },
        ]
      : []),
    { name: "description", label: "Descripción", kind: "textarea" },
  ];
  const initial = toFormValues(
    defs,
    data
      ? {
          ...data,
          categoryId: data.category.id,
          baseUnitId: data.baseUnit.id,
          preferredSupplierId: data.preferredSupplier?.id,
        }
      : { minimumStock: "0" },
  );
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.name}` : "Nueva materia prima"}
        breadcrumb={{
          href: id ? `${MP_BASE}/${id}` : MP_BASE,
          label: id ? "Volver a la materia prima" : "Materias primas",
        }}
      />
      <EntityForm
        fields={defs}
        initial={initial}
        submitLabel={id ? "Guardar cambios" : "Crear materia prima"}
        cancelHref={id ? `${MP_BASE}/${id}` : MP_BASE}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          if (body.minimumStock === null) body.minimumStock = "0";
          const saved = id
            ? await apiFetch<RawMaterialDto>(`${MP_API}/${id}`, { method: "PATCH", body })
            : await apiFetch<RawMaterialDto>(MP_API, { method: "POST", body });
          router.push(`${MP_BASE}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function RawMaterialDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<RawMaterialDto>(`${MP_API}/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: MP_BASE, label: "Materias primas" }}
        title={data.name}
        subtitle={
          <>
            <span className="code">{data.code}</span> ·{" "}
            <span className="badge badge--info">Materia prima</span> ·{" "}
            <StatusBadge active={data.active} on="Activa" off="Inactiva" />
          </>
        }
        actions={
          <>
            {can(P.RAW_MATERIALS_UPDATE) && (
              <Link className="button" href={`${MP_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.RAW_MATERIALS_DEACTIVATE) && (
              <ActiveToggle
                active={data.active}
                endpoint={`${MP_API}/${id}`}
                noun="esta materia prima"
                onChange={refresh}
              />
            )}
          </>
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Categoría", data.category.name],
            ["Unidad base", `${data.baseUnit.symbol}`],
            ["Stock mínimo", `${formatDecimal(data.minimumStock)} ${data.baseUnit.symbol}`],
            ["Proveedor preferido", data.preferredSupplier?.legalName],
            ["Descripción", data.description],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="cost-title">
        <div className="panel__header">
          <h2 id="cost-title">Costo de referencia</h2>
          {can(P.RAW_MATERIALS_UPDATE_COST) && (
            <ReferenceCostAction material={data} onChange={refresh} />
          )}
        </div>
        <Details
          items={[
            [
              "Costo de referencia",
              data.referenceCost === null ? (
                <span className="badge badge--warn">Sin costo cargado</span>
              ) : (
                <strong>
                  {formatReferenceCost(
                    data.referenceCost,
                    user.company.currencyCode,
                    data.baseUnit.symbol,
                  )}
                </strong>
              ),
            ],
            ["Procedencia", COST_SOURCE_LABELS[data.referenceCostSource]],
            [
              "Actualizado",
              data.referenceCostUpdatedAt
                ? formatDateTime(data.referenceCostUpdatedAt, user.company.timezone)
                : null,
            ],
          ]}
        />
        <p className="muted small">
          Es el costo por {data.baseUnit.symbol} (la unidad base), no el precio de un envase ni la
          última factura. Las recetas usan el costo promedio de compras cuando existe; si no, este
          costo de referencia, que se conserva igual.
        </p>
        <Details
          items={[
            [
              "Costo usado por recetas",
              data.effectiveCost === null ? (
                <span className="badge badge--warn">Sin costo</span>
              ) : (
                <>
                  {formatReferenceCost(
                    data.effectiveCost,
                    user.company.currencyCode,
                    data.baseUnit.symbol,
                  )}
                  <span className="cost-source">
                    {data.effectiveCostSource === "PURCHASE_MOVING_AVERAGE"
                      ? "Promedio ponderado de compras"
                      : "Costo de referencia manual"}
                  </span>
                </>
              ),
            ],
          ]}
        />
      </section>
      {can(P.INVENTORY_READ) && (
        <p className="notice">
          Existencias, movimientos y costo promedio en{" "}
          <Link href={`/stock/${id}`}>Inventario → Stock</Link>.
        </p>
      )}
      <PresentationsPanel rawMaterialId={id} baseUnit={data.baseUnit} />
      <AuditHistory entityType="raw_material" entityId={id} version={version} />
    </div>
  );
}

/** Diálogo para cargar o cambiar el costo de referencia (permiso raw_materials.update_cost). */
function ReferenceCostAction({
  material,
  onChange,
}: {
  material: RawMaterialDto;
  onChange: () => void;
}) {
  const user = useCurrentUser();
  const [value, setValue] = useState(material.referenceCost ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  return (
    <ConfirmAction
      label="Cambiar costo"
      title="Costo de referencia"
      confirmLabel="Guardar costo"
      message={
        <>
          Costo en {user.company.currencyCode} por {material.baseUnit.symbol}. Las versiones de
          recetas ya publicadas conservan el costo con que se calcularon; el costo teórico actual se
          recalcula con este valor.
        </>
      }
      onConfirm={async () => {
        setFieldError(null);
        try {
          await apiFetch(`${MP_API}/${material.id}/reference-cost`, {
            method: "PUT",
            body: { referenceCost: value.trim() === "" ? null : value.trim() },
          });
          onChange();
        } catch (err) {
          if (err instanceof ApiError) setFieldError(err.fieldErrors.referenceCost ?? null);
          throw err;
        }
      }}
    >
      <div className="form__field" style={{ marginTop: "0.8rem" }}>
        <label htmlFor="reference-cost">
          Costo por {material.baseUnit.symbol} ({user.company.currencyCode})
        </label>
        <input
          id="reference-cost"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Sin costo"
          value={value}
          aria-invalid={fieldError ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {fieldError && <span className="form__error">{fieldError}</span>}
        <span className="form__hint">Dejalo vacío para quitar el costo.</span>
      </div>
    </ConfirmAction>
  );
}

/* ---------- Productos ---------- */

const PR_BASE = "/productos";
const PR_API = "/api/products";

export function ProductList() {
  const can = useCan();
  const user = useCurrentUser();
  const categories = useCategoryOptions("PRODUCT");
  return (
    <MasterList<ProductDto>
      title="Productos"
      subtitle="Productos terminados que se venden (pan, facturas, tortas…)."
      endpoint={PR_API}
      basePath={PR_BASE}
      searchPlaceholder="Buscar por nombre o código"
      createLabel="Nuevo producto"
      canCreate={can(P.PRODUCTS_CREATE)}
      emptyText="Todavía no hay productos cargados."
      extraFilters={[{ name: "categoryId", label: "Categoría", options: categories ?? [] }]}
      columns={[
        { header: "Código", cell: (p) => <span className="code">{p.code}</span> },
        { header: "Producto", cell: (p) => <Link href={`${PR_BASE}/${p.id}`}>{p.name}</Link> },
        { header: "Categoría", cell: (p) => p.category.name, className: "hide-sm" },
        { header: "Unidad", cell: (p) => p.saleUnit.symbol, className: "hide-sm" },
        {
          header: "Precio",
          cell: (p) => formatMoney(p.salePrice, user.company.currencyCode),
          className: "num",
        },
        { header: "Estado", cell: (p) => <StatusBadge active={p.active} /> },
      ]}
    />
  );
}

export function ProductForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<ProductDto>(id ? `${PR_API}/${id}` : null);
  const categories = useCategoryOptions("PRODUCT");
  const units = useUnitOptions(false);
  if (id && error) return <ErrorState error={error} />;
  if ((id && !data) || !categories || !units) return <Loading />;

  const defs: FieldDef[] = [
    ...(!id
      ? [
          {
            name: "code",
            label: "Código",
            placeholder: "Automático (PROD-0001…)",
            hint: "Dejalo vacío para generarlo solo.",
          },
        ]
      : []),
    { name: "name", label: "Nombre", required: true },
    {
      name: "categoryId",
      label: "Categoría",
      kind: "select",
      required: true,
      options: withCurrent(categories, data?.category),
      hint:
        categories.length === 0
          ? "Primero creá una categoría de productos en Configuración."
          : undefined,
    },
    {
      name: "saleUnitId",
      label: "Unidad de venta",
      kind: "select",
      required: true,
      options: units,
    },
    {
      name: "salePrice",
      label: "Precio de venta",
      kind: "decimal",
      required: true,
      placeholder: "0,00",
    },
    {
      name: "controlsStock",
      label: "Controla stock",
      kind: "checkbox",
      hint: "Si está marcado, el producto lleva stock: se produce con órdenes de producción y entra al stock al completarlas.",
    },
    { name: "imageUrl", label: "URL de imagen", kind: "url", full: true },
    { name: "description", label: "Descripción", kind: "textarea" },
  ];
  const initial = toFormValues(
    defs,
    data
      ? { ...data, categoryId: data.category.id, saleUnitId: data.saleUnit.id }
      : { controlsStock: true },
  );
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.name}` : "Nuevo producto"}
        breadcrumb={{
          href: id ? `${PR_BASE}/${id}` : PR_BASE,
          label: id ? "Volver al producto" : "Productos",
        }}
      />
      <EntityForm
        fields={defs}
        initial={initial}
        submitLabel={id ? "Guardar cambios" : "Crear producto"}
        cancelHref={id ? `${PR_BASE}/${id}` : PR_BASE}
        intro={
          <p className="notice" style={{ marginBottom: "0.9rem" }}>
            El costo no se carga a mano: se calcula desde la receta del producto.
          </p>
        }
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<ProductDto>(`${PR_API}/${id}`, { method: "PATCH", body })
            : await apiFetch<ProductDto>(PR_API, { method: "POST", body });
          router.push(`${PR_BASE}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function ProductDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<ProductDto>(`${PR_API}/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PR_BASE, label: "Productos" }}
        title={data.name}
        subtitle={
          <>
            <span className="code">{data.code}</span> ·{" "}
            <span className="badge badge--info">Producto terminado</span> ·{" "}
            <StatusBadge active={data.active} />
          </>
        }
        actions={
          <>
            {can(P.PRODUCTS_UPDATE) && (
              <Link className="button" href={`${PR_BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.PRODUCTS_DEACTIVATE) && (
              <ActiveToggle
                active={data.active}
                endpoint={`${PR_API}/${id}`}
                noun="este producto"
                onChange={refresh}
              />
            )}
          </>
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Categoría", data.category.name],
            ["Unidad de venta", data.saleUnit.symbol],
            ["Precio de venta", formatMoney(data.salePrice, user.company.currencyCode)],
            ["Controla stock", data.controlsStock ? "Sí" : "No"],
            ["Descripción", data.description],
          ]}
        />
      </section>
      {can(P.RECIPES_READ) && <ProductTheoreticalCost product={data} />}
      <AuditHistory entityType="product" entityId={id} version={version} />
    </div>
  );
}

/** Costo teórico derivado de la receta vigente (nunca una cifra manual del producto). */
function ProductTheoreticalCost({ product }: { product: ProductDto }) {
  const user = useCurrentUser();
  const { data: recipes } = useResource<Page<RecipeListItemDto>>(
    `/api/recipes?productId=${product.id}&status=active&pageSize=1`,
  );
  const recipe = recipes?.items[0];
  const { data: cost } = useResource<RecipeVersionCostDto>(
    recipe?.activeVersion ? `/api/recipes/${recipe.id}/current-cost` : null,
  );
  if (!recipes) return null;
  const currency = user.company.currencyCode;
  const unit = product.saleUnit.symbol;
  return (
    <section className="panel" aria-labelledby="theoretical-cost-title">
      <h2 id="theoretical-cost-title">Costo teórico</h2>
      {!recipe ? (
        <p className="muted">
          Sin receta. El costo teórico se calcula desde la receta del producto.{" "}
          <Link href={`/recetas/nuevo?producto=${product.id}`}>Crear receta</Link>
        </p>
      ) : !recipe.activeVersion ? (
        <p className="muted">
          La receta todavía no tiene una versión vigente.{" "}
          <Link href={`/recetas/${recipe.id}`}>Ver receta</Link>
        </p>
      ) : !cost ? (
        <p className="muted">Calculando…</p>
      ) : (
        <>
          <Details
            items={[
              [
                `Costo por ${unit}`,
                cost.current.unitCost === null ? (
                  <span className="badge badge--warn">Costo incompleto</span>
                ) : (
                  formatUnitCost(cost.current.unitCost, currency, unit)
                ),
              ],
              [
                "Margen bruto teórico",
                cost.current.grossMargin
                  ? `${formatMoney(cost.current.grossMargin.amount, currency)} (${formatPercent(cost.current.grossMargin.percentage)})`
                  : "—",
              ],
              [
                "Receta",
                <Link key="r" href={`/recetas/${recipe.id}`}>
                  {recipe.name} · versión {recipe.activeVersion.versionNumber}
                </Link>,
              ],
            ]}
          />
          <p className="muted small">
            Margen bruto teórico = precio de venta − costo de ingredientes. No incluye mano de obra,
            energía, alquiler, impuestos ni otros costos indirectos.
          </p>
        </>
      )}
    </section>
  );
}
