"use client";

import { PERMISSIONS as P, type SupplierDto } from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
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

const BASE = "/proveedores";
const API = "/api/suppliers";

export function SupplierList() {
  const can = useCan();
  return (
    <MasterList<SupplierDto>
      title="Proveedores"
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre, código, CUIT o contacto"
      createLabel="Nuevo proveedor"
      canCreate={can(P.SUPPLIERS_CREATE)}
      emptyText="Todavía no hay proveedores cargados."
      columns={[
        { header: "Código", cell: (s) => <span className="code">{s.code}</span> },
        {
          header: "Proveedor",
          cell: (s) => <Link href={`${BASE}/${s.id}`}>{s.tradeName ?? s.legalName}</Link>,
        },
        { header: "Contacto", cell: (s) => s.contactName ?? "—", className: "hide-sm" },
        { header: "Teléfono", cell: (s) => s.phone ?? "—", className: "hide-sm" },
        { header: "Estado", cell: (s) => <StatusBadge active={s.active} /> },
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
          placeholder: "Automático (PROV-0001…)",
          hint: "Dejalo vacío para generarlo solo.",
        },
      ]
    : []),
  { name: "legalName", label: "Razón social", required: true },
  { name: "tradeName", label: "Nombre comercial" },
  { name: "taxId", label: "CUIT" },
  { name: "contactName", label: "Persona de contacto" },
  { name: "phone", label: "Teléfono" },
  { name: "email", label: "Email", kind: "email" },
  { name: "address", label: "Dirección", full: true },
  { name: "city", label: "Localidad" },
  { name: "province", label: "Provincia" },
  { name: "paymentTerms", label: "Condiciones de pago", placeholder: "Ej.: 30 días", full: true },
  { name: "notes", label: "Observaciones", kind: "textarea" },
];

export function SupplierForm({ id }: { id?: string }) {
  const router = useRouter();
  const { data, error } = useResource<SupplierDto>(id ? `${API}/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs = fields(!id);
  return (
    <div className="page">
      <PageHeader
        title={id ? `Editar ${data?.legalName}` : "Nuevo proveedor"}
        breadcrumb={{
          href: id ? `${BASE}/${id}` : BASE,
          label: id ? "Volver al proveedor" : "Proveedores",
        }}
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? {})}
        submitLabel={id ? "Guardar cambios" : "Crear proveedor"}
        cancelHref={id ? `${BASE}/${id}` : BASE}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<SupplierDto>(`${API}/${id}`, { method: "PATCH", body })
            : await apiFetch<SupplierDto>(API, { method: "POST", body });
          router.push(`${BASE}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function SupplierDetail({ id }: { id: string }) {
  const can = useCan();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<SupplierDto>(`${API}/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Proveedores" }}
        title={data.tradeName ?? data.legalName}
        subtitle={
          <>
            <span className="code">{data.code}</span> · <StatusBadge active={data.active} />
          </>
        }
        actions={
          <>
            {can(P.SUPPLIERS_UPDATE) && (
              <Link className="button" href={`${BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.SUPPLIERS_DEACTIVATE) && (
              <ActiveToggle
                active={data.active}
                endpoint={`${API}/${id}`}
                noun="este proveedor"
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
            ["CUIT", data.taxId],
            ["Contacto", data.contactName],
            ["Teléfono", data.phone],
            ["Email", data.email],
            ["Dirección", data.address],
            ["Localidad", [data.city, data.province].filter(Boolean).join(", ")],
            ["Condiciones de pago", data.paymentTerms],
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      <p className="notice">
        {can(P.PURCHASES_READ) && (
          <>
            <Link href={`/compras?supplierId=${id}`}>Ver las compras a este proveedor</Link>.{" "}
          </>
        )}
        Cuenta corriente y pagos estarán disponibles en una fase posterior.
      </p>
      <AuditHistory entityType="supplier" entityId={id} version={version} />
    </div>
  );
}
