"use client";

import {
  COMMERCIAL_CONDITION_LABELS,
  COMMERCIAL_CONDITIONS,
  CUSTOMER_TYPE_LABELS,
  CUSTOMER_TYPES,
  PERMISSIONS as P,
  type CustomerDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
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

const fields = (creating: boolean): FieldDef[] => [
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
    hint: "La cuenta corriente se habilita en una fase posterior; hoy queda registrada.",
  },
  { name: "creditLimit", label: "Límite de crédito", kind: "decimal", placeholder: "0,00" },
  { name: "notes", label: "Observaciones", kind: "textarea" },
];

export function CustomerForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<CustomerDto>(id ? `${API}/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs = fields(!id);
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
        initial={toFormValues(defs, data ?? { type: "RETAILER", commercialCondition: "CASH" })}
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
            {can(P.CUSTOMERS_DEACTIVATE) && (
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
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      <p className="notice">Ventas y cuenta corriente estarán disponibles en una fase posterior.</p>
      <AuditHistory entityType="customer" entityId={id} version={version} />
    </div>
  );
}
