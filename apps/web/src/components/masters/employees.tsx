"use client";

import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  PERMISSIONS as P,
  type EmployeeDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { useFlash } from "../ui/flash";
import { useCan } from "../user-context";
import { EntityForm, toFormValues, toPayload, type FieldDef } from "./entity-form";
import { MasterList } from "./master-list";
import {
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
 * Empleado = persona que trabaja en la empresa. Usuario = acceso al sistema.
 * Son cosas distintas: un empleado puede no tener usuario y viceversa.
 */

const BASE = "/empleados";
const API = "/api/employees";

export function EmployeeList() {
  const can = useCan();
  return (
    <MasterList<EmployeeDto>
      title="Empleados"
      subtitle="Personas que trabajan en la empresa. Tener acceso al sistema es opcional."
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre, legajo o documento"
      createLabel="Nuevo empleado"
      canCreate={can(P.EMPLOYEES_CREATE)}
      emptyText="Todavía no hay empleados cargados."
      statusLabels={{ active: "Activos", inactive: "Dados de baja" }}
      columns={[
        {
          header: "Nombre",
          cell: (e) => <Link href={`${BASE}/${e.id}`}>{`${e.lastName}, ${e.firstName}`}</Link>,
        },
        {
          header: "Legajo",
          cell: (e) => <span className="code">{e.code}</span>,
          className: "hide-md",
        },
        { header: "Puesto", cell: (e) => e.position ?? "" },
        {
          header: "Acceso al sistema",
          cell: (e) =>
            e.access ? (e.access.status === "ACTIVE" ? "Sí" : "Sí, desactivado") : "No",
          className: "hide-md",
        },
        {
          header: "Estado",
          cell: (e) => <StatusBadge active={e.status === "ACTIVE"} off="Dado de baja" />,
        },
      ]}
    />
  );
}

const fields = (creating: boolean): FieldDef[] => [
  { name: "firstName", label: "Nombre", required: true, section: "Datos personales" },
  { name: "lastName", label: "Apellido", required: true },
  {
    name: "documentType",
    label: "Tipo de documento",
    kind: "select",
    options: DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] })),
  },
  { name: "documentNumber", label: "Número de documento", hint: "Sin puntos ni guiones." },
  {
    name: "position",
    label: "Puesto",
    section: "Trabajo",
    hint: "Ej.: Panadero, Cajera, Repartidor.",
  },
  { name: "hireDate", label: "Fecha de ingreso", kind: "date" },
  ...(creating
    ? [
        {
          name: "code",
          label: "Legajo",
          placeholder: "EMP-0001",
          hint: "Opcional: si lo dejás vacío se genera solo.",
        },
      ]
    : []),
  { name: "phone", label: "Teléfono", section: "Contacto" },
  {
    name: "email",
    label: "Email",
    kind: "email",
    hint: "Para contactarlo. El email para ingresar al sistema se define al crear su acceso.",
  },
  { name: "address", label: "Dirección" },
  { name: "city", label: "Localidad" },
  { name: "notes", label: "Observaciones", kind: "textarea" },
];

export function EmployeeForm({ id }: { id?: string }) {
  const router = useRouter();
  const flash = useFlash();
  const { data, error } = useResource<EmployeeDto>(id ? `${API}/${id}` : null);
  if (id && error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  const defs = fields(!id);
  return (
    <div className="page">
      <PageHeader
        title={id ? "Editar empleado" : "Nuevo empleado"}
        subtitle={id && data ? <span className="code">{data.code}</span> : undefined}
        breadcrumb={
          id && data
            ? [
                { href: BASE, label: "Empleados" },
                { href: `${BASE}/${id}`, label: data.fullName },
              ]
            : { href: BASE, label: "Empleados" }
        }
      />
      <EntityForm
        fields={defs}
        initial={toFormValues(defs, data ?? {})}
        submitLabel={id ? "Guardar cambios" : "Crear empleado"}
        cancelHref={id ? `${BASE}/${id}` : BASE}
        onSubmit={async (values) => {
          const body = toPayload(defs, values);
          const saved = id
            ? await apiFetch<EmployeeDto>(`${API}/${id}`, { method: "PATCH", body })
            : await apiFetch<EmployeeDto>(API, { method: "POST", body });
          flash(id ? "Cambios guardados." : `Empleado ${saved.code} creado.`, {
            afterNavigation: true,
          });
          router.push(`${BASE}/${saved.id}`);
        }}
      />
    </div>
  );
}

export function EmployeeDetail({ id }: { id: string }) {
  const can = useCan();
  const [version, setVersion] = useState(0);
  const [terminationDate, setTerminationDate] = useState("");
  const { data, error, reload } = useResource<EmployeeDto>(`${API}/${id}`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando el empleado…" />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const active = data.status === "ACTIVE";
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Empleados" }}
        title={data.fullName}
        status={<StatusBadge active={active} off="Dado de baja" />}
        subtitle={
          <>
            <span className="code">{data.code}</span> · {data.position ?? "Sin puesto"}
          </>
        }
        actions={
          <>
            {can(P.EMPLOYEES_UPDATE) && (
              <Link className="button" href={`${BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.EMPLOYEES_DEACTIVATE) &&
              (active ? (
                <ConfirmAction
                  label="Dar de baja"
                  title="¿Dar de baja a este empleado?"
                  message={
                    <>
                      Queda como inactivo con su fecha de egreso; no se borra.
                      {data.access?.status === "ACTIVE" &&
                        " Su acceso al sistema también se desactiva y se cierran sus sesiones."}
                    </>
                  }
                  confirmLabel="Dar de baja"
                  danger
                  onConfirm={async () => {
                    await apiFetch(`${API}/${id}/deactivate`, {
                      method: "POST",
                      body: terminationDate ? { terminationDate } : {},
                    });
                    setTerminationDate("");
                    refresh();
                  }}
                >
                  <div className="form__field">
                    <label htmlFor="employee-termination">Fecha de egreso</label>
                    <input
                      id="employee-termination"
                      type="date"
                      value={terminationDate}
                      aria-describedby="employee-termination-hint"
                      onChange={(e) => setTerminationDate(e.target.value)}
                    />
                    <span className="form__hint" id="employee-termination-hint">
                      Si la dejás vacía, se usa la fecha de hoy.
                    </span>
                  </div>
                </ConfirmAction>
              ) : (
                <ConfirmAction
                  label="Reactivar"
                  title="¿Reactivar a este empleado?"
                  message="Vuelve a estar activo. Su acceso al sistema, si tenía, no se reactiva solo."
                  confirmLabel="Reactivar"
                  onConfirm={async () => {
                    await apiFetch(`${API}/${id}/activate`, { method: "POST" });
                    refresh();
                  }}
                />
              ))}
          </>
        }
      />
      <section className="panel">
        <Details
          hideEmpty
          items={[
            [
              "Documento",
              data.documentNumber
                ? `${data.documentType ? DOCUMENT_TYPE_LABELS[data.documentType] : ""} ${data.documentNumber}`.trim()
                : null,
            ],
            ["Puesto", data.position],
            ["Fecha de ingreso", data.hireDate ? formatDate(data.hireDate) : null],
            ["Fecha de egreso", data.terminationDate ? formatDate(data.terminationDate) : null],
            ["Teléfono", data.phone && <a href={`tel:${data.phone}`}>{data.phone}</a>],
            ["Email", data.email && <a href={`mailto:${data.email}`}>{data.email}</a>],
            ["Dirección", [data.address, data.city].filter(Boolean).join(", ")],
            ["Observaciones", data.notes],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="access-title">
        <h2 id="access-title">Acceso al sistema</h2>
        <Details
          items={[
            ["Empleado", active ? "Activo" : "Dado de baja"],
            [
              "Usuario del sistema",
              data.access ? (data.access.status === "ACTIVE" ? "Sí" : "Sí, desactivado") : "No",
            ],
            ["Email de ingreso", data.access?.email],
          ]}
        />
        {!data.access && (
          <p className="muted small">
            Sin acceso, la persona no puede ingresar al sistema. Darle acceso es opcional.
          </p>
        )}
        <div className="form__footer">
          {data.access && can(P.USERS_READ) && (
            <Link className="button" href={`/usuarios/${data.access.userId}`}>
              Ver usuario
            </Link>
          )}
          {!data.access && active && can(P.USERS_CREATE, P.USERS_ASSIGN_ROLES) && (
            <Link className="button button--primary" href={`/usuarios/nuevo?empleado=${id}`}>
              Crear acceso
            </Link>
          )}
        </div>
      </section>
      <AuditHistory entityType="employee" entityId={id} version={version} />
    </div>
  );
}
