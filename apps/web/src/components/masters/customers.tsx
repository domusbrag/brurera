"use client";

import {
  COMMERCIAL_CONDITION_LABELS,
  COMMERCIAL_CONDITIONS,
  CUSTOMER_TYPE_LABELS,
  CUSTOMER_TYPES,
  PERMISSIONS as P,
  type CustomerAccountDto,
  type CustomerDto,
  type PriceListDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, fetchOptions } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import { useFlash } from "../ui/flash";
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
      subtitle="Mayoristas, minoristas y eventos. «Consumidor Final» es el cliente de las ventas de mostrador."
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre, código, CUIT o email"
      createLabel="Nuevo cliente"
      canCreate={can(P.CUSTOMERS_CREATE)}
      emptyText="Todavía no hay clientes cargados."
      columns={[
        {
          header: "Cliente",
          cell: (c) => <Link href={`${BASE}/${c.id}`}>{c.tradeName ?? c.legalName}</Link>,
        },
        {
          header: "Código",
          cell: (c) => <span className="code">{c.code}</span>,
          className: "hide-md",
        },
        { header: "Tipo", cell: (c) => CUSTOMER_TYPE_LABELS[c.type], className: "hide-md" },
        { header: "CUIT / DNI", cell: (c) => c.taxId ?? "", className: "hide-md" },
        { header: "Teléfono", cell: (c) => c.phone ?? "" },
        { header: "Estado", cell: (c) => <StatusBadge active={c.active} /> },
      ]}
    />
  );
}

const fields = (
  creating: boolean,
  priceLists: { value: string; label: string }[] | null,
): FieldDef[] => [
  {
    name: "type",
    label: "Tipo de cliente",
    kind: "select",
    required: true,
    section: "Identificación",
    options: CUSTOMER_TYPES.map((t) => ({ value: t, label: CUSTOMER_TYPE_LABELS[t] })),
  },
  {
    name: "legalName",
    label: "Razón social / Nombre",
    required: true,
    hint: "Para un particular, nombre y apellido.",
  },
  {
    name: "tradeName",
    label: "Nombre comercial",
    hint: "Es el nombre que se muestra en ventas y pedidos, si lo cargás.",
  },
  { name: "taxId", label: "CUIT / DNI", placeholder: "30-12345678-9" },
  ...(creating
    ? [
        {
          name: "code",
          label: "Código",
          placeholder: "CLI-0001",
          hint: "Opcional: si lo dejás vacío se genera solo.",
        },
      ]
    : []),
  { name: "phone", label: "Teléfono", section: "Contacto", autoComplete: "off" },
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
    section: "Condiciones comerciales",
    options: COMMERCIAL_CONDITIONS.map((c) => ({
      value: c,
      label: COMMERCIAL_CONDITION_LABELS[c],
    })),
  },
  {
    name: "creditLimit",
    label: "Límite de crédito",
    kind: "decimal",
    placeholder: "Ej.: 150000",
    hint: "Vacío = sin límite. Sólo avisa al vender: no bloquea la venta.",
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
  const flash = useFlash();
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
        title={id ? `Editar cliente` : "Nuevo cliente"}
        breadcrumb={
          id && data
            ? [
                { href: BASE, label: "Clientes" },
                { href: `${BASE}/${id}`, label: data.tradeName ?? data.legalName },
              ]
            : { href: BASE, label: "Clientes" }
        }
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
          flash(id ? "Cambios guardados." : `Cliente ${saved.code} creado.`, {
            afterNavigation: true,
          });
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
  const canAccount = can(P.CUSTOMER_ACCOUNTS_READ);
  const account = useResource<CustomerAccountDto>(
    canAccount ? `/api/customers/${id}/account?page=1&v=${version}` : null,
  );
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando el cliente…" />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const currency = user.company.currencyCode;
  const acc = account.data;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Clientes" }}
        title={data.tradeName ?? data.legalName}
        status={<StatusBadge active={data.active} />}
        subtitle={
          <>
            <span className="code">{data.code}</span> · {CUSTOMER_TYPE_LABELS[data.type]}
          </>
        }
        actions={
          <>
            {data.active && can(P.SALES_CREATE) && (
              <Link className="button button--primary" href={`/ventas/nueva?clienteId=${id}`}>
                Nueva venta
              </Link>
            )}
            {data.active && !data.walkIn && can(P.ORDERS_CREATE) && (
              <Link className="button" href={`/pedidos/nuevo?clienteId=${id}`}>
                Nuevo pedido
              </Link>
            )}
            {can(P.CUSTOMERS_UPDATE) && (
              <Link className="button" href={`${BASE}/${id}/editar`}>
                Editar
              </Link>
            )}
            {can(P.CUSTOMERS_DEACTIVATE) && !data.walkIn && (
              <ActiveToggle
                active={data.active}
                endpoint={`${API}/${id}`}
                noun="este cliente"
                deactivateMessage="Deja de aparecer al elegir cliente en ventas y pedidos. Su cuenta corriente, ventas e historial se conservan, y se puede reactivar."
                onChange={refresh}
              />
            )}
          </>
        }
      />
      {canAccount && (
        <section className="panel" aria-labelledby="customer-account">
          <h2 id="customer-account" className="section-title">
            Cuenta
          </h2>
          {acc ? (
            <dl className="metrics" aria-label="Resumen de la cuenta">
              <div
                className={`metric ${acc.balanceKind === "DEBT" ? "metric--danger" : acc.balanceKind === "CREDIT" ? "metric--success" : ""}`}
              >
                <dt className="metric__label">Saldo</dt>
                <dd className="metric__value">
                  {acc.balanceKind === "NONE"
                    ? "Sin saldo"
                    : acc.balanceKind === "DEBT"
                      ? `Debe ${formatMoney(acc.balanceAmount, acc.currency)}`
                      : `A favor ${formatMoney(acc.balanceAmount, acc.currency)}`}
                </dd>
              </div>
              <div className="metric">
                <dt className="metric__label">Ventas sin cobrar</dt>
                <dd className="metric__value">{acc.pendingSales.length}</dd>
              </div>
            </dl>
          ) : account.error ? (
            <p className="muted">No se pudo cargar el saldo.</p>
          ) : (
            <Loading label="Cargando el saldo…" />
          )}
          <p>
            <Link className="button button--tertiary" href={`/cuentas-a-cobrar/${id}`}>
              Ver cuenta corriente
            </Link>
          </p>
        </section>
      )}
      <section className="panel" aria-labelledby="customer-data">
        <h2 id="customer-data" className="section-title">
          Datos del cliente
        </h2>
        <Details
          hideEmpty
          items={[
            ["Razón social", data.legalName],
            ["Nombre comercial", data.tradeName],
            ["CUIT / DNI", data.taxId],
            ["Teléfono", data.phone && <a href={`tel:${data.phone}`}>{data.phone}</a>],
            ["Email", data.email && <a href={`mailto:${data.email}`}>{data.email}</a>],
            ["Dirección", data.address],
            ["Localidad", [data.city, data.province, data.postalCode].filter(Boolean).join(", ")],
            ["Condición comercial", COMMERCIAL_CONDITION_LABELS[data.commercialCondition]],
            [
              "Límite de crédito",
              data.creditLimit ? formatMoney(data.creditLimit, currency) : "Sin límite",
            ],
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
