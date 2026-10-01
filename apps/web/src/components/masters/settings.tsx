"use client";

import {
  CATEGORY_TYPE_LABELS,
  CATEGORY_TYPES,
  PERMISSION_CATALOG,
  PERMISSION_MODULE_LABELS,
  PERMISSIONS as P,
  UNIT_DIMENSION_LABELS,
  UNIT_DIMENSIONS,
  type CategoryDto,
  type CompanyDto,
  type RoleDto,
  type UnitDto,
  type WarehouseDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiFetch, fetchOptions, listPath } from "@/lib/api-client";
import { formatDecimal } from "@/lib/format";
import { CONFIG_SECTIONS } from "@/lib/navigation";
import { useCan } from "../user-context";
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

const CONFIG = { href: "/configuracion", label: "Configuración" };

export function SettingsHub() {
  const can = useCan();
  const sections = CONFIG_SECTIONS.filter((s) => can(s.permission));
  return (
    <div className="page">
      <PageHeader
        title="Configuración"
        subtitle="Datos de la empresa y catálogos que usan los demás módulos."
      />
      <div className="cards">
        {sections.map((s) => (
          <Link key={s.slug} className="card" href={`/configuracion/${s.slug}`}>
            <span className="card__title">{s.label}</span>
            <span className="muted">{s.description}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ---------- Empresa ---------- */

const companyFields: FieldDef[] = [
  { name: "legalName", label: "Razón social", required: true },
  {
    name: "tradeName",
    label: "Nombre comercial",
    required: true,
    hint: "Es el nombre que se muestra en el sistema.",
  },
  { name: "taxId", label: "CUIT" },
  { name: "phone", label: "Teléfono" },
  { name: "email", label: "Email", kind: "email" },
  { name: "address", label: "Dirección" },
  { name: "city", label: "Localidad" },
  { name: "province", label: "Provincia" },
  { name: "postalCode", label: "Código postal" },
  { name: "currencyCode", label: "Moneda", required: true, hint: "Código ISO de 3 letras (ARS)." },
  {
    name: "timezone",
    label: "Zona horaria",
    required: true,
    hint: "Define el “hoy” de la empresa para fechas y cierres.",
  },
  { name: "logoUrl", label: "URL del logo", kind: "url", full: true },
];

export function CompanySettings() {
  const can = useCan();
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const { data, error, setData } = useResource<CompanyDto>("/api/company");
  const [formKey, setFormKey] = useState(0);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const editable = can(P.COMPANY_UPDATE);
  return (
    <div className="page">
      <PageHeader
        title="Empresa"
        breadcrumb={CONFIG}
        subtitle={
          editable ? undefined : "Solo lectura: no tenés permiso para modificar la empresa."
        }
      />
      {saved && (
        <p className="notice" role="status">
          Cambios guardados.
        </p>
      )}
      {editable ? (
        <EntityForm
          key={formKey}
          fields={companyFields}
          initial={toFormValues(companyFields, data)}
          submitLabel="Guardar cambios"
          cancelHref="/configuracion"
          onSubmit={async (values) => {
            const updated = await apiFetch<CompanyDto>("/api/company", {
              method: "PATCH",
              body: toPayload(companyFields, values),
            });
            setData(updated);
            setSaved(true);
            setFormKey((k) => k + 1);
            // El nombre comercial se muestra en el encabezado (layout del servidor).
            router.refresh();
          }}
        />
      ) : (
        <section className="panel">
          <Details
            items={companyFields.map((f) => [
              f.label,
              (data as unknown as Record<string, string | null>)[f.name],
            ])}
          />
        </section>
      )}
    </div>
  );
}

/* ---------- Unidades de medida ---------- */

const UNITS = "/configuracion/unidades";

export function UnitList() {
  const can = useCan();
  return (
    <MasterList<UnitDto>
      title="Unidades de medida"
      subtitle="Solo se convierte entre unidades de la misma magnitud: masa con masa, volumen con volumen. Nunca kilos a litros."
      endpoint="/api/units"
      basePath={UNITS}
      searchPlaceholder="Buscar por código o nombre"
      createLabel="Nueva unidad"
      canCreate={can(P.UNITS_MANAGE)}
      emptyText="No hay unidades."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      columns={[
        { header: "Código", cell: (u) => <Link href={`${UNITS}/${u.id}`}>{u.code}</Link> },
        { header: "Nombre", cell: (u) => u.name },
        {
          header: "Magnitud",
          cell: (u) => UNIT_DIMENSION_LABELS[u.dimension],
          className: "hide-sm",
        },
        {
          header: "Equivale a",
          cell: (u) =>
            u.baseUnit
              ? `${formatDecimal(u.conversionFactor)} ${u.baseUnit.symbol}`
              : "Unidad base",
        },
        {
          header: "Estado",
          cell: (u) => <StatusBadge active={u.active} on="Activa" off="Inactiva" />,
        },
      ]}
    />
  );
}

export function UnitForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<UnitDto>(id ? `/api/units/${id}` : null);
  const [roots, setRoots] = useState<UnitDto[] | null>(null);
  useEffect(() => {
    fetchOptions<UnitDto>("/api/units")
      .then((items) => setRoots(items.filter((u) => u.baseUnit === null)))
      .catch(() => setRoots([]));
  }, []);
  if (id && error) return <ErrorState error={error} />;
  if ((id && !data) || !roots) return <Loading />;

  const defs: FieldDef[] = id
    ? [
        { name: "name", label: "Nombre", required: true },
        { name: "symbol", label: "Símbolo", required: true },
        {
          name: "decimals",
          label: "Decimales",
          kind: "number",
          required: true,
          hint: "Cantidad de decimales con que se expresan cantidades (0 a 6).",
        },
      ]
    : [
        {
          name: "code",
          label: "Código",
          required: true,
          hint: "Corto y sin espacios (p. ej. bolsa25).",
        },
        { name: "name", label: "Nombre", required: true },
        { name: "symbol", label: "Símbolo", required: true },
        {
          name: "dimension",
          label: "Magnitud",
          kind: "select",
          required: true,
          options: UNIT_DIMENSIONS.map((d) => ({ value: d, label: UNIT_DIMENSION_LABELS[d] })),
        },
        {
          name: "baseUnitId",
          label: "Equivale a (unidad base)",
          kind: "select",
          emptyOption: "Ninguna: es una unidad base",
          options: roots.map((u) => ({
            value: u.id,
            label: `${u.name} (${u.symbol}) · ${UNIT_DIMENSION_LABELS[u.dimension]}`,
          })),
          hint: "Debe ser de la misma magnitud.",
        },
        {
          name: "conversionFactor",
          label: "Factor",
          kind: "decimal",
          placeholder: "Ej.: 25",
          hint: "1 de esta unidad = factor × unidad base.",
        },
        { name: "decimals", label: "Decimales", kind: "number", required: true },
      ];
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.name}` : "Nueva unidad"}
        breadcrumb={{
          href: id ? `${UNITS}/${id}` : UNITS,
          label: id ? "Volver a la unidad" : "Unidades de medida",
        }}
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? { decimals: 2 })}
        submitLabel={id ? "Guardar cambios" : "Crear unidad"}
        cancelHref={id ? `${UNITS}/${id}` : UNITS}
        intro={
          id ? (
            <p className="notice" style={{ marginBottom: "0.9rem" }}>
              La magnitud y la conversión no se modifican una vez creada la unidad, para no cambiar
              el significado de cantidades ya cargadas.
            </p>
          ) : undefined
        }
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<UnitDto>(`/api/units/${id}`, { method: "PATCH", body })
            : await apiFetch<UnitDto>("/api/units", { method: "POST", body });
          router.push(`${UNITS}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function UnitDetail({ id }: { id: string }) {
  const can = useCan();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<UnitDto>(`/api/units/${id}`);
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [target, setTarget] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    fetchOptions<UnitDto>("/api/units")
      .then(setUnits)
      .catch(() => setUnits([]));
  }, []);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  async function toggle(active: boolean) {
    await apiFetch(`/api/units/${id}`, { method: "PATCH", body: { active } });
    reload();
    setVersion((v) => v + 1);
  }

  async function convert() {
    const to = units.find((u) => u.id === target);
    try {
      const res = await apiFetch<{ result: string }>(
        listPath("/api/units/convert", { from: id, to: target, quantity }),
      );
      setResult(
        `${formatDecimal(quantity)} ${data!.symbol} = ${formatDecimal(res.result, 0, 10)} ${to?.symbol ?? ""}`,
      );
    } catch (err) {
      setResult(err instanceof ApiError ? err.message : "No se pudo convertir.");
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: UNITS, label: "Unidades de medida" }}
        title={`${data.name} (${data.symbol})`}
        subtitle={
          <>
            <span className="code">{data.code}</span> · {UNIT_DIMENSION_LABELS[data.dimension]} ·{" "}
            <StatusBadge active={data.active} on="Activa" off="Inactiva" />
            {data.isSystem && " · Estándar"}
          </>
        }
        actions={
          can(P.UNITS_MANAGE) ? (
            <>
              <Link className="button" href={`${UNITS}/${id}/editar`}>
                Editar
              </Link>
              <button
                type="button"
                className={`button ${data.active ? "button--danger" : ""}`}
                onClick={() => toggle(!data.active)}
              >
                {data.active ? "Desactivar" : "Reactivar"}
              </button>
            </>
          ) : undefined
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Magnitud", UNIT_DIMENSION_LABELS[data.dimension]],
            [
              "Equivale a",
              data.baseUnit
                ? `${formatDecimal(data.conversionFactor)} ${data.baseUnit.symbol}`
                : "Es una unidad base",
            ],
            ["Decimales", String(data.decimals)],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="convert-title">
        <h2 id="convert-title">Probar conversión</h2>
        <div className="filters">
          <input
            type="text"
            inputMode="decimal"
            aria-label="Cantidad"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            style={{ maxWidth: 140 }}
          />
          <span>{data.symbol} a</span>
          <select
            aria-label="Unidad de destino"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Elegí una unidad</option>
            {units
              .filter((u) => u.id !== id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.symbol})
                </option>
              ))}
          </select>
          <button type="button" className="button" disabled={!target} onClick={convert}>
            Convertir
          </button>
        </div>
        {result && (
          <p role="status" data-testid="conversion-result">
            {result}
          </p>
        )}
      </section>
      <AuditHistory entityType="unit" entityId={id} version={version} />
    </div>
  );
}

/* ---------- Categorías ---------- */

const CATEGORIES = "/configuracion/categorias";

export function CategoryList() {
  const can = useCan();
  return (
    <MasterList<CategoryDto>
      title="Categorías"
      subtitle="Las categorías de materias primas y de productos son independientes."
      endpoint="/api/categories"
      basePath={CATEGORIES}
      searchPlaceholder="Buscar por nombre"
      createLabel="Nueva categoría"
      canCreate={can(P.CATEGORIES_MANAGE)}
      emptyText="Todavía no hay categorías."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      extraFilters={[
        {
          name: "type",
          label: "Tipo",
          options: CATEGORY_TYPES.map((t) => ({ value: t, label: CATEGORY_TYPE_LABELS[t] })),
        },
      ]}
      columns={[
        { header: "Categoría", cell: (c) => <Link href={`${CATEGORIES}/${c.id}`}>{c.name}</Link> },
        { header: "Tipo", cell: (c) => CATEGORY_TYPE_LABELS[c.type] },
        { header: "Orden", cell: (c) => c.sortOrder, className: "hide-sm" },
        {
          header: "Estado",
          cell: (c) => <StatusBadge active={c.active} on="Activa" off="Inactiva" />,
        },
      ]}
    />
  );
}

export function CategoryForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<CategoryDto>(id ? `/api/categories/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs: FieldDef[] = [
    ...(!id
      ? [
          {
            name: "type",
            label: "Tipo",
            kind: "select" as const,
            required: true,
            options: CATEGORY_TYPES.map((t) => ({ value: t, label: CATEGORY_TYPE_LABELS[t] })),
          },
        ]
      : []),
    { name: "name", label: "Nombre", required: true },
    { name: "sortOrder", label: "Orden", kind: "number", hint: "Menor número aparece primero." },
    { name: "description", label: "Descripción", kind: "textarea" },
  ];
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.name}` : "Nueva categoría"}
        breadcrumb={{
          href: id ? `${CATEGORIES}/${id}` : CATEGORIES,
          label: id ? "Volver a la categoría" : "Categorías",
        }}
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? { type: "RAW_MATERIAL", sortOrder: 0 })}
        submitLabel={id ? "Guardar cambios" : "Crear categoría"}
        cancelHref={id ? `${CATEGORIES}/${id}` : CATEGORIES}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<CategoryDto>(`/api/categories/${id}`, { method: "PATCH", body })
            : await apiFetch<CategoryDto>("/api/categories", { method: "POST", body });
          router.push(`${CATEGORIES}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function CategoryDetail({ id }: { id: string }) {
  const can = useCan();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<CategoryDto>(`/api/categories/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  async function toggle(active: boolean) {
    await apiFetch(`/api/categories/${id}`, { method: "PATCH", body: { active } });
    reload();
    setVersion((v) => v + 1);
  }
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: CATEGORIES, label: "Categorías" }}
        title={data.name}
        subtitle={
          <>
            {CATEGORY_TYPE_LABELS[data.type]} ·{" "}
            <StatusBadge active={data.active} on="Activa" off="Inactiva" />
          </>
        }
        actions={
          can(P.CATEGORIES_MANAGE) ? (
            <>
              <Link className="button" href={`${CATEGORIES}/${id}/editar`}>
                Editar
              </Link>
              <button
                type="button"
                className={`button ${data.active ? "button--danger" : ""}`}
                onClick={() => toggle(!data.active)}
              >
                {data.active ? "Desactivar" : "Reactivar"}
              </button>
            </>
          ) : undefined
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Tipo", CATEGORY_TYPE_LABELS[data.type]],
            ["Orden", String(data.sortOrder)],
            ["Descripción", data.description],
          ]}
        />
      </section>
      <AuditHistory entityType="category" entityId={id} version={version} />
    </div>
  );
}

/* ---------- Depósitos ---------- */

const WAREHOUSES = "/configuracion/depositos";

export function WarehouseList() {
  const can = useCan();
  return (
    <MasterList<WarehouseDto>
      title="Depósitos"
      subtitle="Lugares físicos donde se guardará el stock (se usa desde la fase de inventario)."
      endpoint="/api/warehouses"
      basePath={WAREHOUSES}
      searchPlaceholder="Buscar por código o nombre"
      createLabel="Nuevo depósito"
      canCreate={can(P.WAREHOUSES_MANAGE)}
      emptyText="No hay depósitos."
      columns={[
        { header: "Código", cell: (w) => <span className="code">{w.code}</span> },
        { header: "Depósito", cell: (w) => <Link href={`${WAREHOUSES}/${w.id}`}>{w.name}</Link> },
        { header: "Dirección", cell: (w) => w.address ?? "—", className: "hide-sm" },
        { header: "Estado", cell: (w) => <StatusBadge active={w.active} /> },
      ]}
    />
  );
}

const warehouseFields = (creating: boolean): FieldDef[] => [
  ...(creating
    ? [
        {
          name: "code",
          label: "Código",
          placeholder: "Automático (DEP-0001…)",
          hint: "Dejalo vacío para generarlo solo.",
        },
      ]
    : []),
  { name: "name", label: "Nombre", required: true },
  { name: "address", label: "Dirección", full: true },
  { name: "description", label: "Descripción", kind: "textarea" },
];

export function WarehouseForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<WarehouseDto>(id ? `/api/warehouses/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs = warehouseFields(!id);
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.name}` : "Nuevo depósito"}
        breadcrumb={{
          href: id ? `${WAREHOUSES}/${id}` : WAREHOUSES,
          label: id ? "Volver al depósito" : "Depósitos",
        }}
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? {})}
        submitLabel={id ? "Guardar cambios" : "Crear depósito"}
        cancelHref={id ? `${WAREHOUSES}/${id}` : WAREHOUSES}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<WarehouseDto>(`/api/warehouses/${id}`, { method: "PATCH", body })
            : await apiFetch<WarehouseDto>("/api/warehouses", { method: "POST", body });
          router.push(`${WAREHOUSES}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function WarehouseDetail({ id }: { id: string }) {
  const can = useCan();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<WarehouseDto>(`/api/warehouses/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: WAREHOUSES, label: "Depósitos" }}
        title={data.name}
        subtitle={
          <>
            <span className="code">{data.code}</span> · <StatusBadge active={data.active} />
          </>
        }
        actions={
          can(P.WAREHOUSES_MANAGE) ? (
            <>
              <Link className="button" href={`${WAREHOUSES}/${id}/editar`}>
                Editar
              </Link>
              <ActiveToggle
                active={data.active}
                endpoint={`/api/warehouses/${id}`}
                noun="este depósito"
                onChange={() => {
                  reload();
                  setVersion((v) => v + 1);
                }}
              />
            </>
          ) : undefined
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Dirección", data.address],
            ["Descripción", data.description],
          ]}
        />
      </section>
      <p className="notice">El stock por depósito estará disponible en la fase de inventario.</p>
      <AuditHistory entityType="warehouse" entityId={id} version={version} />
    </div>
  );
}

/* ---------- Roles (solo lectura) ---------- */

export function RolesMatrix() {
  const { data, error } = useResource<RoleDto[]>("/api/roles");
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page">
      <PageHeader
        title="Roles y permisos"
        breadcrumb={CONFIG}
        subtitle="Qué puede hacer cada rol. Los roles de sistema no se editan en esta versión; se asignan desde Usuarios."
      />
      <section className="panel">
        <div className="cards" style={{ marginBottom: "1rem" }}>
          {data.map((r) => (
            <div key={r.id} className="card">
              <span className="card__title">{r.name}</span>
              <span className="muted">{r.description}</span>
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table className="table matrix">
            <thead>
              <tr>
                <th scope="col">Permiso</th>
                {data.map((r) => (
                  <th key={r.id} scope="col">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_CATALOG.map((p) => (
                <tr key={p.code}>
                  <td>
                    <strong>{PERMISSION_MODULE_LABELS[p.module] ?? p.module}</strong>:{" "}
                    {p.description}
                  </td>
                  {data.map((r) => (
                    <td key={r.id} aria-label={r.permissions.includes(p.code) ? "Sí" : "No"}>
                      {r.permissions.includes(p.code) ? "✓" : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
