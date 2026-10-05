"use client";

import { PERMISSIONS as P, type SupplierDto } from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { useFlash } from "../ui/flash";
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
      subtitle="A quién le comprás materias primas e insumos, y cómo contactarlo."
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre, código, CUIT o contacto"
      createLabel="Nuevo proveedor"
      canCreate={can(P.SUPPLIERS_CREATE)}
      emptyText="Todavía no hay proveedores cargados."
      columns={[
        {
          header: "Proveedor",
          cell: (s) => <Link href={`${BASE}/${s.id}`}>{s.tradeName ?? s.legalName}</Link>,
        },
        {
          header: "Código",
          cell: (s) => <span className="code">{s.code}</span>,
          className: "hide-md",
        },
        { header: "Contacto", cell: (s) => s.contactName ?? "", className: "hide-md" },
        { header: "Teléfono", cell: (s) => s.phone ?? "" },
        { header: "Estado", cell: (s) => <StatusBadge active={s.active} /> },
      ]}
    />
  );
}

const fields = (creating: boolean): FieldDef[] => [
  { name: "legalName", label: "Razón social", required: true, section: "Identificación" },
  {
    name: "tradeName",
    label: "Nombre comercial",
    hint: "Si lo cargás, es el nombre que se muestra en compras y listados.",
  },
  { name: "taxId", label: "CUIT", placeholder: "30-12345678-9" },
  ...(creating
    ? [
        {
          name: "code",
          label: "Código",
          placeholder: "PROV-0001",
          hint: "Opcional: si lo dejás vacío se genera solo.",
        },
      ]
    : []),
  { name: "contactName", label: "Persona de contacto", section: "Contacto" },
  { name: "phone", label: "Teléfono" },
  { name: "email", label: "Email", kind: "email" },
  { name: "address", label: "Dirección", full: true },
  { name: "city", label: "Localidad" },
  { name: "province", label: "Provincia" },
  {
    name: "paymentTerms",
    label: "Condiciones de pago",
    placeholder: "Ej.: 30 días",
    full: true,
    section: "Condiciones",
    hint: "Texto de referencia para quien compra.",
  },
  { name: "notes", label: "Observaciones", kind: "textarea" },
];

export function SupplierForm({ id }: { id?: string }) {
  const router = useRouter();
  const flash = useFlash();
  const { data, error } = useResource<SupplierDto>(id ? `${API}/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs = fields(!id);
  return (
    <div className="page">
      <PageHeader
        title={id ? "Editar proveedor" : "Nuevo proveedor"}
        subtitle={id && data ? <span className="code">{data.code}</span> : undefined}
        breadcrumb={
          id && data
            ? [
                { href: BASE, label: "Proveedores" },
                { href: `${BASE}/${id}`, label: data.tradeName ?? data.legalName },
              ]
            : { href: BASE, label: "Proveedores" }
        }
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
          flash(id ? "Cambios guardados." : `Proveedor ${saved.code} creado.`, {
            afterNavigation: true,
          });
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
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando el proveedor…" />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Proveedores" }}
        title={data.tradeName ?? data.legalName}
        status={<StatusBadge active={data.active} />}
        subtitle={<span className="code">{data.code}</span>}
        actions={
          <>
            {data.active && can(P.PURCHASES_CREATE) && (
              <Link className="button button--primary" href={`/compras/nueva?supplierId=${id}`}>
                Nueva compra
              </Link>
            )}
            {can(P.PURCHASES_READ) && (
              <Link className="button" href={`/compras?supplierId=${id}`}>
                Ver compras
              </Link>
            )}
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
                deactivateMessage="Deja de aparecer al elegir proveedor en compras nuevas y como proveedor preferido. Las compras ya hechas y su historial se conservan, y se puede reactivar."
                onChange={refresh}
              />
            )}
          </>
        }
      />
      <section className="panel">
        <Details
          hideEmpty
          items={[
            ["Razón social", data.legalName],
            ["Nombre comercial", data.tradeName],
            ["CUIT", data.taxId],
            ["Contacto", data.contactName],
            ["Teléfono", data.phone && <a href={`tel:${data.phone}`}>{data.phone}</a>],
            ["Email", data.email && <a href={`mailto:${data.email}`}>{data.email}</a>],
            ["Dirección", data.address],
            ["Localidad", [data.city, data.province].filter(Boolean).join(", ")],
            ["Condiciones de pago", data.paymentTerms],
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      <AuditHistory entityType="supplier" entityId={id} version={version} />
    </div>
  );
}
