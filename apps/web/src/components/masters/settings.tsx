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
  type PermissionCode,
  type CompanyDto,
  type RoleDto,
  type UnitDto,
  type WarehouseDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiFetch, fetchOptions, listPath } from "@/lib/api-client";
import { describeError } from "@/lib/errors";
import { formatDecimal } from "@/lib/format";
import { CONFIG_SECTIONS } from "@/lib/navigation";
import { useCan } from "../user-context";
import { EntityForm, toFormValues, toPayload, type FieldDef } from "./entity-form";
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

const CONFIG = { href: "/configuracion", label: "Configuración" };

export function SettingsHub() {
  const can = useCan();
  const sections = CONFIG_SECTIONS.filter((s) => can(s.permission));
  const EDIT: Record<string, PermissionCode | null> = {
    empresa: P.COMPANY_UPDATE,
    unidades: P.UNITS_MANAGE,
    categorias: P.CATEGORIES_MANAGE,
    depositos: P.WAREHOUSES_MANAGE,
    roles: null,
  };
  const canEdit = (slug: string) => {
    const code = EDIT[slug];
    return code === undefined || code === null ? true : can(code);
  };
  return (
    <div className="page">
      <PageHeader
        title="Configuración"
        subtitle="Datos de la panadería y las listas base que se eligen al cargar materias primas, productos, stock y usuarios."
      />
      <div className="cards">
        {sections.map((s) => (
          <Link key={s.slug} className="card" href={`/configuracion/${s.slug}`}>
            <span className="card__title">{s.label}</span>
            <span className="muted">{s.description}</span>
            {!canEdit(s.slug) && <span className="muted small">Sólo lectura</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ---------- Empresa ---------- */

/** Zonas horarias de Argentina (definen el "hoy" de la empresa). */
const TIMEZONES: { value: string; label: string }[] = [
  ["Buenos_Aires", "Buenos Aires (CABA y la mayor parte del país)"],
  ["Cordoba", "Córdoba"],
  ["Salta", "Salta"],
  ["Jujuy", "Jujuy"],
  ["Tucuman", "Tucumán"],
  ["Catamarca", "Catamarca"],
  ["La_Rioja", "La Rioja"],
  ["San_Juan", "San Juan"],
  ["Mendoza", "Mendoza"],
  ["San_Luis", "San Luis"],
  ["Rio_Gallegos", "Santa Cruz"],
  ["Ushuaia", "Tierra del Fuego"],
].map(([zone, label]) => ({ value: `America/Argentina/${zone}`, label: `Argentina · ${label}` }));

const CURRENCIES = [
  { value: "ARS", label: "Peso argentino ($)" },
  { value: "USD", label: "Dólar estadounidense (US$)" },
];

/** Agrega el valor actual si no está entre las opciones (para no perderlo). */
function withCurrent(options: { value: string; label: string }[], current?: string | null) {
  return !current || options.some((o) => o.value === current)
    ? options
    : [...options, { value: current, label: current }];
}

const labelOf = (options: { value: string; label: string }[], value: string | null) =>
  options.find((o) => o.value === value)?.label ?? value;

const companyFields = (company: CompanyDto): FieldDef[] => [
  { name: "legalName", label: "Razón social", required: true, section: "Datos fiscales" },
  {
    name: "tradeName",
    label: "Nombre comercial",
    required: true,
    hint: "Es el nombre que se muestra en el sistema.",
  },
  { name: "taxId", label: "CUIT", placeholder: "30-12345678-9" },
  { name: "phone", label: "Teléfono", section: "Contacto" },
  { name: "email", label: "Email", kind: "email" },
  { name: "address", label: "Dirección" },
  { name: "city", label: "Localidad" },
  { name: "province", label: "Provincia" },
  { name: "postalCode", label: "Código postal" },
  {
    name: "currencyCode",
    label: "Moneda",
    kind: "select",
    required: true,
    section: "Funcionamiento",
    options: withCurrent(CURRENCIES, company.currencyCode),
    hint: "La moneda de precios, costos y cobros.",
  },
  {
    name: "timezone",
    label: "Zona horaria",
    kind: "select",
    required: true,
    options: withCurrent(TIMEZONES, company.timezone),
    hint: "Define el “hoy” de la empresa: fechas de pedidos, vencimientos y cierres.",
  },
  {
    name: "logoUrl",
    label: "Dirección web del logo",
    kind: "url",
    full: true,
    placeholder: "https://…",
    hint: "Opcional: el enlace a una imagen del logo ya publicada en internet.",
  },
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
  const fields = companyFields(data);
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
        <p className="alert alert--success" role="status">
          Cambios guardados.
        </p>
      )}
      {editable ? (
        <EntityForm
          key={formKey}
          fields={fields}
          initial={toFormValues(fields, data)}
          submitLabel="Guardar cambios"
          cancelHref="/configuracion"
          onSubmit={async (values) => {
            const updated = await apiFetch<CompanyDto>("/api/company", {
              method: "PATCH",
              body: toPayload(fields, values),
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
            hideEmpty
            items={fields.map((f) => {
              const value = (data as unknown as Record<string, string | null>)[f.name] ?? null;
              return [f.label, f.options ? labelOf(f.options, value) : value];
            })}
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
      subtitle="Kilos, litros, unidades y sus equivalencias (p. ej. bolsa de 25 kg). Sólo se convierte dentro del mismo tipo de medida."
      endpoint="/api/units"
      basePath={UNITS}
      searchPlaceholder="Buscar por código o nombre"
      createLabel="Nueva unidad"
      canCreate={can(P.UNITS_MANAGE)}
      emptyText="No hay unidades en este filtro."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      columns={[
        { header: "Unidad", cell: (u) => <Link href={`${UNITS}/${u.id}`}>{u.name}</Link> },
        { header: "Símbolo", cell: (u) => <span className="code">{u.symbol}</span> },
        {
          header: "Tipo de medida",
          cell: (u) => UNIT_DIMENSION_LABELS[u.dimension],
          className: "hide-md",
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
          hint: "Con cuántos decimales se cargan cantidades (0 a 6): 0 para unidades enteras.",
        },
      ]
    : [
        { name: "name", label: "Nombre", required: true, placeholder: "Ej.: Bolsa de 25 kg" },
        {
          name: "symbol",
          label: "Símbolo",
          required: true,
          placeholder: "Ej.: bolsa",
          hint: "Se muestra junto a las cantidades.",
        },
        {
          name: "code",
          label: "Código",
          required: true,
          placeholder: "Ej.: bolsa25",
          hint: "Identificador corto, sin espacios. No se puede cambiar después.",
        },
        {
          name: "dimension",
          label: "Magnitud",
          kind: "select",
          required: true,
          section: "Equivalencia",
          options: UNIT_DIMENSIONS.map((d) => ({ value: d, label: UNIT_DIMENSION_LABELS[d] })),
          hint: "El tipo de medida: masa, volumen o unidades. No se puede cambiar después.",
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
          hint: "Elegí una del mismo tipo de medida (p. ej. Kilogramo para una bolsa).",
        },
        {
          name: "conversionFactor",
          label: "Factor",
          kind: "decimal",
          placeholder: "Ej.: 25",
          hint: "Cuántas unidades base tiene 1 de esta unidad: una bolsa de 25 kg → 25.",
        },
        {
          name: "decimals",
          label: "Decimales",
          kind: "number",
          required: true,
          hint: "Con cuántos decimales se cargan cantidades: 0 para unidades enteras, 2 o 3 para kilos.",
        },
      ];
  return (
    <div className="page">
      <PageHeader
        title={id ? "Editar unidad" : "Nueva unidad"}
        breadcrumb={
          id && data
            ? [
                CONFIG,
                { href: UNITS, label: "Unidades de medida" },
                { href: `${UNITS}/${id}`, label: data.name },
              ]
            : [CONFIG, { href: UNITS, label: "Unidades de medida" }]
        }
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? { decimals: 2 })}
        submitLabel={id ? "Guardar cambios" : "Crear unidad"}
        cancelHref={id ? `${UNITS}/${id}` : UNITS}
        intro={
          id && data ? (
            <div className="alert alert--info">
              <p>
                {UNIT_DIMENSION_LABELS[data.dimension]} ·{" "}
                {data.baseUnit
                  ? `1 ${data.symbol} = ${formatDecimal(data.conversionFactor)} ${data.baseUnit.symbol}`
                  : "Es una unidad base"}
                . El tipo de medida y la equivalencia no se modifican una vez creada la unidad, para
                no cambiar el significado de cantidades ya cargadas.
              </p>
            </div>
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
  const [failed, setFailed] = useState(false);
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
    setFailed(false);
    const to = units.find((u) => u.id === target);
    try {
      const res = await apiFetch<{ result: string }>(
        listPath("/api/units/convert", { from: id, to: target, quantity }),
      );
      setResult(
        `${formatDecimal(quantity)} ${data!.symbol} = ${formatDecimal(res.result, 0, 10)} ${to?.symbol ?? ""}`,
      );
    } catch (err) {
      setFailed(true);
      setResult(err instanceof ApiError ? describeError(err) : "No se pudo convertir.");
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[CONFIG, { href: UNITS, label: "Unidades de medida" }]}
        title={`${data.name} (${data.symbol})`}
        status={<StatusBadge active={data.active} on="Activa" off="Inactiva" />}
        subtitle={
          <>
            {UNIT_DIMENSION_LABELS[data.dimension]}
            {data.isSystem && " · Unidad estándar del sistema"}
          </>
        }
        actions={
          can(P.UNITS_MANAGE) ? (
            <>
              <Link className="button" href={`${UNITS}/${id}/editar`}>
                Editar
              </Link>
              <StateToggle
                active={data.active}
                noun="esta unidad"
                deactivateMessage="Deja de aparecer al elegir unidad en materias primas, productos y recetas. Lo ya cargado con esta unidad no cambia, y se puede reactivar."
                onToggle={toggle}
              />
            </>
          ) : undefined
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Tipo de medida", UNIT_DIMENSION_LABELS[data.dimension]],
            [
              "Equivale a",
              data.baseUnit
                ? `${formatDecimal(data.conversionFactor)} ${data.baseUnit.symbol}`
                : "Es una unidad base",
            ],
            ["Decimales", String(data.decimals)],
            [
              "Código",
              <span key="code" className="code">
                {data.code}
              </span>,
            ],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="convert-title">
        <h2 id="convert-title">Probar conversión</h2>
        <p className="muted small">Para verificar la equivalencia antes de usar la unidad.</p>
        <div className="inline-fields">
          <div className="form__field">
            <label htmlFor="convert-quantity">Cantidad ({data.symbol})</label>
            <input
              id="convert-quantity"
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="form__field">
            <label htmlFor="convert-target">Unidad de destino</label>
            <select id="convert-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Elegí una unidad</option>
              {units
                .filter((u) => u.id !== id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.symbol})
                  </option>
                ))}
            </select>
          </div>
          <button type="button" className="button" disabled={!target} onClick={convert}>
            Convertir
          </button>
        </div>
        {result && (
          <p
            role="status"
            data-testid="conversion-result"
            className={failed ? "form__error" : undefined}
          >
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
          allLabel: "Todos los tipos",
          options: CATEGORY_TYPES.map((t) => ({ value: t, label: CATEGORY_TYPE_LABELS[t] })),
        },
      ]}
      columns={[
        { header: "Categoría", cell: (c) => <Link href={`${CATEGORIES}/${c.id}`}>{c.name}</Link> },
        { header: "Para", cell: (c) => CATEGORY_TYPE_LABELS[c.type] },
        { header: "Orden", cell: (c) => c.sortOrder, className: "num hide-md" },
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
            hint: "Si agrupa materias primas o productos. No se puede cambiar después.",
          },
        ]
      : []),
    { name: "name", label: "Nombre", required: true },
    {
      name: "sortOrder",
      label: "Orden",
      kind: "number",
      hint: "Posición en las listas: 1 aparece antes que 2. Dejá 0 si no importa.",
    },
    { name: "description", label: "Descripción", kind: "textarea" },
  ];
  return (
    <div className="page">
      <PageHeader
        title={id ? "Editar categoría" : "Nueva categoría"}
        subtitle={
          id && data
            ? `Categoría de ${CATEGORY_TYPE_LABELS[data.type].toLowerCase()} (el tipo no se cambia).`
            : undefined
        }
        breadcrumb={
          id && data
            ? [
                CONFIG,
                { href: CATEGORIES, label: "Categorías" },
                { href: `${CATEGORIES}/${id}`, label: data.name },
              ]
            : [CONFIG, { href: CATEGORIES, label: "Categorías" }]
        }
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
        breadcrumb={[CONFIG, { href: CATEGORIES, label: "Categorías" }]}
        title={data.name}
        status={<StatusBadge active={data.active} on="Activa" off="Inactiva" />}
        subtitle={`Categoría de ${CATEGORY_TYPE_LABELS[data.type].toLowerCase()}`}
        actions={
          can(P.CATEGORIES_MANAGE) ? (
            <>
              <Link className="button" href={`${CATEGORIES}/${id}/editar`}>
                Editar
              </Link>
              <StateToggle
                active={data.active}
                noun="esta categoría"
                deactivateMessage="Deja de aparecer al elegir categoría. Las materias primas y productos que ya la tienen la conservan, y se puede reactivar."
                onToggle={toggle}
              />
            </>
          ) : undefined
        }
      />
      <section className="panel">
        <Details
          hideEmpty
          items={[
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
      subtitle="Lugares físicos donde se guarda el stock: cámara, freezer, depósito de harinas."
      endpoint="/api/warehouses"
      basePath={WAREHOUSES}
      searchPlaceholder="Buscar por código o nombre"
      createLabel="Nuevo depósito"
      canCreate={can(P.WAREHOUSES_MANAGE)}
      emptyText="No hay depósitos en este filtro."
      columns={[
        { header: "Depósito", cell: (w) => <Link href={`${WAREHOUSES}/${w.id}`}>{w.name}</Link> },
        {
          header: "Código",
          cell: (w) => <span className="code">{w.code}</span>,
          className: "hide-md",
        },
        { header: "Dirección", cell: (w) => w.address ?? "", className: "hide-md" },
        { header: "Estado", cell: (w) => <StatusBadge active={w.active} /> },
      ]}
    />
  );
}

const warehouseFields = (creating: boolean): FieldDef[] => [
  { name: "name", label: "Nombre", required: true, placeholder: "Ej.: Cámara de frío" },
  ...(creating
    ? [
        {
          name: "code",
          label: "Código",
          placeholder: "DEP-0001",
          hint: "Opcional: si lo dejás vacío se genera solo.",
        },
      ]
    : []),
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
        title={id ? "Editar depósito" : "Nuevo depósito"}
        subtitle={id && data ? <span className="code">{data.code}</span> : undefined}
        breadcrumb={
          id && data
            ? [
                CONFIG,
                { href: WAREHOUSES, label: "Depósitos" },
                { href: `${WAREHOUSES}/${id}`, label: data.name },
              ]
            : [CONFIG, { href: WAREHOUSES, label: "Depósitos" }]
        }
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
        breadcrumb={[CONFIG, { href: WAREHOUSES, label: "Depósitos" }]}
        title={data.name}
        status={<StatusBadge active={data.active} />}
        subtitle={<span className="code">{data.code}</span>}
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
                deactivateMessage="Deja de aparecer al elegir depósito en compras, stock y producción. Si todavía tiene stock, ese stock no se mueve solo: revisalo antes. Se puede reactivar."
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
          hideEmpty
          items={[
            ["Dirección", data.address],
            ["Descripción", data.description],
          ]}
        />
        {!data.address && !data.description && (
          <p className="muted">Sin dirección ni descripción cargadas.</p>
        )}
        {can(P.INVENTORY_READ) && (
          <p className="actions">
            <Link className="button button--tertiary" href={`/stock?warehouseId=${id}`}>
              Ver stock de materias primas
            </Link>
            <Link className="button button--tertiary" href={`/stock/productos?warehouseId=${id}`}>
              Ver stock de productos
            </Link>
          </p>
        )}
      </section>
      <AuditHistory entityType="warehouse" entityId={id} version={version} />
    </div>
  );
}

/* ---------- Roles (solo lectura) ---------- */

export function RolesMatrix() {
  const { data, error } = useResource<RoleDto[]>("/api/roles");
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const modules: { module: string; permissions: (typeof PERMISSION_CATALOG)[number][] }[] = [];
  for (const p of PERMISSION_CATALOG) {
    const group = modules.find((m) => m.module === p.module);
    if (group) group.permissions.push(p);
    else modules.push({ module: p.module, permissions: [p] });
  }
  return (
    <div className="page">
      <PageHeader
        title="Roles y permisos"
        breadcrumb={CONFIG}
        subtitle="Qué puede hacer cada rol. Los roles se asignan a cada persona desde Usuarios; no se editan desde acá."
      />
      <section className="panel" aria-labelledby="roles-list">
        <h2 id="roles-list" className="section-title">
          Roles
        </h2>
        <dl className="details">
          {data.map((r) => (
            <div key={r.id}>
              <dt>{r.name}</dt>
              <dd>{r.description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel" aria-labelledby="roles-matrix">
        <h2 id="roles-matrix" className="section-title">
          Permisos por rol
        </h2>
        <div className="table-wrap">
          <table className="table table--compact matrix" aria-labelledby="roles-matrix">
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
            {modules.map((m) => (
              <tbody key={m.module}>
                <tr>
                  <th scope="rowgroup" colSpan={data.length + 1}>
                    {PERMISSION_MODULE_LABELS[m.module] ?? "Otros"}
                  </th>
                </tr>
                {m.permissions.map((p) => (
                  <tr key={p.code}>
                    <th scope="row" className="mx-matrix__permission">
                      {p.description}
                    </th>
                    {data.map((r) => {
                      const has = r.permissions.includes(p.code);
                      return (
                        <td key={r.id}>
                          <span aria-hidden="true">{has ? "✓" : "—"}</span>
                          <span className="sr-only">{has ? "Sí" : "No"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </section>
    </div>
  );
}

/** Desactivar / reactivar con confirmación (unidades y categorías se cambian con PATCH). */
function StateToggle({
  active,
  noun,
  deactivateMessage,
  onToggle,
}: {
  active: boolean;
  noun: string;
  deactivateMessage: string;
  onToggle: (active: boolean) => Promise<void>;
}) {
  return active ? (
    <ConfirmAction
      label="Desactivar"
      title={`¿Desactivar ${noun}?`}
      message={deactivateMessage}
      confirmLabel="Desactivar"
      danger
      onConfirm={() => onToggle(false)}
    />
  ) : (
    <ConfirmAction
      label="Reactivar"
      title={`¿Reactivar ${noun}?`}
      message="Vuelve a estar disponible en listados y selectores."
      confirmLabel="Reactivar"
      onConfirm={() => onToggle(true)}
    />
  );
}
