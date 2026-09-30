"use client";

import {
  PERMISSIONS as P,
  type CategoryDto,
  type ProductDto,
  type RawMaterialDto,
  type SupplierDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { formatDecimal, formatMoney } from "@/lib/format";
import { useCan, useCurrentUser } from "../user-context";
import { EntityForm, toFormValues, toPayload, type FieldDef } from "./entity-form";
import { MasterList } from "./master-list";
import {
  ActiveToggle,
  AuditHistory,
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
        { header: "Unidad base", cell: (m) => m.baseUnit.symbol },
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
    {
      name: "currentCost",
      label: "Costo de referencia por unidad base",
      kind: "decimal",
      placeholder: "0,00",
      hint: "Carga manual hasta que las compras (Fase 3) lo calculen por promedio ponderado.",
    },
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
            [
              "Costo de referencia",
              data.currentCost
                ? `${user.company.currencyCode === "ARS" ? "$" : `${user.company.currencyCode} `}${formatDecimal(data.currentCost, 2, 6)} / ${data.baseUnit.symbol}`
                : "Sin cargar",
            ],
            ["Descripción", data.description],
          ]}
        />
      </section>
      <p className="notice">
        El stock se calculará desde los movimientos de inventario (Fase 3). El costo de referencia
        es manual hasta que las compras lo actualicen.
      </p>
      <AuditHistory entityType="raw_material" entityId={id} version={version} />
    </div>
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
      hint: "Si está marcado, las ventas descontarán stock (desde la Fase 3).",
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
            Costo disponible desde Fase 2: se calculará desde la receta.
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
            ["Costo", "Costo disponible desde Fase 2"],
            ["Controla stock", data.controlsStock ? "Sí" : "No"],
            ["Descripción", data.description],
          ]}
        />
      </section>
      <AuditHistory entityType="product" entityId={id} version={version} />
    </div>
  );
}
