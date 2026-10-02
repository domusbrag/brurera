"use client";

import {
  COMMERCIAL_CONDITION_LABELS,
  COMMERCIAL_CONDITIONS,
  CUSTOMER_TYPE_LABELS,
  CUSTOMER_TYPES,
  PERMISSIONS as P,
  type CustomerDto,
  type PriceListDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
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

const BASE = "/clientes";
const API = "/api/customers";

export function CustomerList() {
  const can = useCan();
  return (
    <MasterList<CustomerDto>
      title="Clientes"
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre, código, CUIT o email"
      createLabel="Nuevo cliente"
      canCreate={can(P.CUSTOMERS_CREATE)}
      emptyText="Todavía no hay clientes cargados."
      extraFilters={[]}
      columns={[
        { header: "Código", cell: (c) => <span className="code">{c.code}</span> },
        {
          header: "Cliente",
          cell: (c) => <Link href={`${BASE}/${c.id}`}>{c.tradeName ?? c.legalName}</Link>,
        },
        { header: "Tipo", cell: (c) => CUSTOMER_TYPE_LABELS[c.type], className: "hide-sm" },
        { header: "CUIT", cell: (c) => c.taxId ?? "—", className: "hide-sm" },
        { header: "Teléfono", cell: (c) => c.phone ?? "—", className: "hide-sm" },
        { header: "Estado", cell: (c) => <StatusBadge active={c.active} /> },
      ]}
    />
  );
}

const fields = (
  creating: boolean,
  priceLists: { value: string; label: string }[] | null,
): FieldDef[] => [
  ...(creating
    ? [
        {
          name: "code",
          label: "Código",
          placeholder: "Automático (CLI-0001…)",
          hint: "Dejalo vacío para generarlo solo.",
        },
      ]
    : []),
  {
    name: "type",
    label: "Tipo de cliente",
    kind: "select",
    required: true,
    options: CUSTOMER_TYPES.map((t) => ({ value: t, label: CUSTOMER_TYPE_LABELS[t] })),
  },
  { name: "legalName", label: "Razón social / Nombre", required: true },
  { name: "tradeName", label: "Nombre comercial" },
  { name: "taxId", label: "CUIT / DNI" },
  { name: "phone", label: "Teléfono" },
  { name: "email", label: "Email", kind: "email" },
  { name: "address", label: "Dirección", full: true },
  { name: "city", label: "Localidad" },
  { name: "province", label: "Provincia" },
  { name: "postalCode", label: "Código postal" },
  {
    name: "commercialCondition",
    label: "Condición comercial",
    kind: "select",
    required: true,
    options: COMMERCIAL_CONDITIONS.map((c) => ({
      value: c,
      label: COMMERCIAL_CONDITION_LABELS[c],
    })),
  },
  {
    name: "creditLimit",
    label: "Límite de crédito",
    kind: "decimal",
    placeholder: "0,00",
    hint: "Sólo avisa al vender: no bloquea la venta.",
  },
  ...(priceLists
    ? [
        {
          name: "defaultPriceListId",
          label: "Lista de precios",
          kind: "select" as const,
          options: priceLists,
          emptyOption: "Lista general de la empresa",
          hint: "Sin lista propia se usa la lista general y, si no hay, el precio de cada producto.",
        },
      ]
    : []),
  { name: "notes", label: "Observaciones", kind: "textarea" },
];

export function CustomerForm({ id }: { id?: string }) {
  const router = useRouter();
  const can = useCan();
  const { data, error } = useResource<CustomerDto>(id ? `${API}/${id}` : null);
  const [priceLists, setPriceLists] = useState<{ value: string; label: string }[] | null>(null);
  const [listsLoaded, setListsLoaded] = useState(!can(P.PRICE_LISTS_READ));
  useEffect(() => {
    if (!can(P.PRICE_LISTS_READ)) return;
    fetchOptions<PriceListDto>("/api/price-lists")
      .then((items) => setPriceLists(items.map((l) => ({ value: l.id, label: l.name }))))
      .catch(() => setPriceLists(null))
      .finally(() => setListsLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (id && error) return <ErrorState error={error} />;
  if ((id && !data) || !listsLoaded) return <Loading />;
  const defs = fields(!id, priceLists);
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.legalName}` : "Nuevo cliente"}
        breadcrumb={{
          href: id ? `${BASE}/${id}` : BASE,
          label: id ? "Volver al cliente" : "Clientes",
        }}
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(
          defs,
          data
            ? { ...data, defaultPriceListId: data.defaultPriceList?.id ?? null }
            : { type: "RETAILER", commercialCondition: "CASH" },
        )}
        submitLabel={id ? "Guardar cambios" : "Crear cliente"}
        cancelHref={id ? `${BASE}/${id}` : BASE}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<CustomerDto>(`${API}/${id}`, { method: "PATCH", body })
            : await apiFetch<CustomerDto>(API, { method: "POST", body });
          router.push(`${BASE}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function CustomerDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<CustomerDto>(`${API}/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Clientes" }}
        title={data.tradeName ?? data.legalName}
        subtitle={
          <>
            <span className="code">{data.code}</span> · {CUSTOMER_TYPE_LABELS[data.type]} ·{" "}
            <StatusBadge active={data.active} />
          </>
        }
        actions={
          <>
            {can(P.CUSTOMERS_UPDATE) && (
              <Link className="button" href={`${BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.CUSTOMER_ACCOUNTS_READ) && (
              <Link className="button" href={`/cuentas-a-cobrar/${id}`}>
                Cuenta corriente
              </Link>
            )}
            {can(P.CUSTOMERS_DEACTIVATE) && !data.walkIn && (
              <ActiveToggle
                active={data.active}
                endpoint={`${API}/${id}`}
                noun="este cliente"
                onChange={refresh}
              />
            )}
          </>
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Razón social", data.legalName],
            ["Nombre comercial", data.tradeName],
            ["CUIT / DNI", data.taxId],
            ["Teléfono", data.phone],
            ["Email", data.email],
            ["Dirección", data.address],
            ["Localidad", [data.city, data.province, data.postalCode].filter(Boolean).join(", ")],
            ["Condición comercial", COMMERCIAL_CONDITION_LABELS[data.commercialCondition]],
            ["Límite de crédito", formatMoney(data.creditLimit, user.company.currencyCode)],
            ["Lista de precios", data.defaultPriceList?.name ?? "Lista general de la empresa"],
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      {data.walkIn && (
        <p className="notice">
          Consumidor Final: el cliente de las ventas de mostrador. No se puede desactivar.
        </p>
      )}
      <AuditHistory entityType="customer" entityId={id} version={version} />
    </div>
  );
}
