"use client";

import {
  PERMISSIONS as P,
  type PriceListDetailDto,
  type PriceListDto,
  type PriceListItemDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { D } from "@bakery/domain";
import { ApiError, apiFetch } from "@/lib/api-client";
import { isDecimal, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatDateTime, formatMoney, formatPercent } from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  ConfirmAction,
  Details,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "../masters/ui";
import { useFlash } from "../ui/flash";
import { StatusBadge as UiStatusBadge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";
import { PRICE_LISTS_BASE } from "./sale-shared";

/*
 * Listas de precios. Prioridad del precio de una venta o pedido:
 * precio acordado del pedido → lista del cliente → lista general de la empresa
 * → precio del producto. Cambiar una lista no cambia pedidos ya confirmados
 * (su precio quedó acordado) ni ventas ya entregadas.
 */

export function PriceListList() {
  const can = useCan();
  return (
    <MasterList<PriceListDto>
      title="Listas de precios"
      subtitle="Precios por cliente o generales. Lo que no está en la lista se vende al precio del producto."
      endpoint="/api/price-lists"
      basePath={PRICE_LISTS_BASE}
      searchPlaceholder="Buscar por código o nombre"
      createLabel="Nueva lista"
      canCreate={can(P.PRICE_LISTS_MANAGE)}
      emptyText="Todavía no hay listas de precios: se usa el precio de cada producto."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      columns={[
        {
          header: "Lista",
          cell: (l) => <Link href={`${PRICE_LISTS_BASE}/${l.id}`}>{l.name}</Link>,
        },
        {
          header: "Código",
          cell: (l) => <span className="code">{l.code}</span>,
          className: "hide-md",
        },
        {
          header: "Tipo",
          cell: (l) => (l.isDefault ? <StatusTag>General</StatusTag> : "Por cliente"),
        },
        { header: "Productos", cell: (l) => l.itemCount, className: "num" },
        {
          header: "Clientes",
          cell: (l) => (l.isDefault ? "Todos sin lista" : l.customerCount),
          className: "num hide-md",
        },
        {
          header: "Actualizada",
          cell: (l) => <UpdatedAt iso={l.updatedAt} />,
          className: "hide-md",
        },
        {
          header: "Estado",
          cell: (l) => <StatusBadge active={l.active} on="Activa" off="Inactiva" />,
        },
      ]}
    />
  );
}

function StatusTag({ children }: { children: ReactNode }) {
  return <UiStatusBadge tone="tag">{children}</UiStatusBadge>;
}

function UpdatedAt({ iso }: { iso: string }) {
  const tz = useCurrentUser().company.timezone;
  return <>{formatDateTime(iso, tz).slice(0, 10)}</>;
}

export function PriceListDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const { data, error, reload } = useResource<PriceListDetailDto>(`/api/price-lists/${id}`);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyListed, setOnlyListed] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando la lista de precios…" />;
  const currency = user.company.currencyCode;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const q = query.trim().toLocaleLowerCase("es");
  const items = data.items.filter(
    (i) =>
      (!q ||
        i.product.name.toLocaleLowerCase("es").includes(q) ||
        i.product.code.toLocaleLowerCase("es").includes(q)) &&
      (!onlyListed || (i.unitPrice !== null && i.active)),
  );
  const listed = data.items.filter((i) => i.unitPrice !== null && i.active).length;
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PRICE_LISTS_BASE, label: "Listas de precios" }}
        title={data.name}
        status={
          <>
            <StatusBadge active={data.active} on="Activa" off="Inactiva" />
            {data.isDefault && (
              <>
                {" "}
                <StatusTag>General</StatusTag>
              </>
            )}
          </>
        }
        subtitle={
          data.isDefault
            ? "Lista general: aplica a los clientes que no tienen una lista propia."
            : `Asignada a ${data.customerCount} ${data.customerCount === 1 ? "cliente" : "clientes"}. Se asigna desde la ficha de cada cliente.`
        }
        actions={
          data.canManage && (
            <Link className="button" href={`${PRICE_LISTS_BASE}/${id}/editar`}>
              Editar datos
            </Link>
          )
        }
      />
      <section className="panel" aria-labelledby="pl-data">
        <h2 id="pl-data">Datos</h2>
        <Details
          hideEmpty
          items={[
            [
              "Código",
              <span key="c" className="code">
                {data.code}
              </span>,
            ],
            ["Productos con precio propio", `${listed} de ${data.items.length}`],
            ["Actualizada", formatDateTime(data.updatedAt, user.company.timezone)],
            ["Notas", data.notes],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="pl-items">
        <h2 id="pl-items">Precios</h2>
        <p className="muted small">
          Precio por unidad de venta. Si un producto no tiene precio en esta lista, se vende al
          precio de la lista general o, si no hay, al del producto. Los pedidos ya confirmados
          conservan su precio acordado.
          {data.canManage && " Escribí el precio y apretá Enter o «Guardar» en esa fila."}
        </p>
        <div className="toolbar">
          <div className="form__field">
            <label htmlFor="pl-search">Buscar producto</label>
            <input
              id="pl-search"
              type="search"
              value={query}
              placeholder="Nombre o código"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={onlyListed}
              onChange={(e) => setOnlyListed(e.target.checked)}
            />{" "}
            Sólo los que tienen precio en la lista
          </label>
        </div>
        {data.items.length === 0 ? (
          <EmptyState
            compact
            title="No hay productos activos"
            description="Cuando cargues productos vas a poder ponerles precio en esta lista."
          />
        ) : items.length === 0 ? (
          <EmptyState compact title="Ningún producto coincide con la búsqueda." />
        ) : (
          <div className="table-wrap">
            <table
              className={`table ${data.canManage ? "line-editor" : ""}`}
              aria-label="Precios de la lista"
            >
              <thead>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col" className="num hide-md">
                    Precio del producto
                  </th>
                  <th scope="col">Precio en la lista</th>
                  <th scope="col" className="num hide-md">
                    Diferencia
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <PriceRow
                    key={item.product.id}
                    listId={id}
                    item={item}
                    currency={currency}
                    canManage={data.canManage}
                    onSaved={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <AuditHistory entityType="price_list" entityId={id} version={version} />
    </div>
  );
}

function PriceRow({
  listId,
  item,
  currency,
  canManage,
  onSaved,
}: {
  listId: string;
  item: PriceListItemDto;
  currency: string;
  canManage: boolean;
  onSaved: () => void;
}) {
  const current = item.unitPrice && item.active ? item.unitPrice.replace(/\.00$/, "") : "";
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value.trim() !== current;
  const inputId = `pl-price-${item.product.id}`;
  const listed = item.unitPrice !== null && item.active;
  const diff =
    listed && new D(item.productPrice).gt(0)
      ? new D(item.unitPrice!).minus(item.productPrice).div(item.productPrice).times(100)
      : null;

  async function save(active: boolean) {
    setError(null);
    setSaved(false);
    if (active && !isDecimal(value)) {
      setError("Ingresá un precio válido (por ejemplo, 1250,50).");
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/price-lists/${listId}/items/${item.product.id}`, {
        method: "PUT",
        body: { unitPrice: active ? toDecimal(value) : (item.unitPrice ?? "0"), active },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err) : "No se pudo guardar el precio.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td>
        {item.product.name}
        <span className="muted small"> · {item.saleUnit.symbol}</span>
      </td>
      <td className="num hide-md">{formatMoney(item.productPrice, currency)}</td>
      <td>
        {canManage ? (
          <form
            className="inline-fields"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void save(true);
            }}
          >
            <input
              id={inputId}
              inputMode="decimal"
              aria-label={`Precio de ${item.product.name}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              value={value}
              placeholder="Sin precio en la lista"
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
            {dirty && value.trim() !== "" && (
              <button
                type="submit"
                className="button button--small"
                disabled={saving}
                aria-busy={saving || undefined}
              >
                {saving ? "Guardando…" : "Guardar"}
              </button>
            )}
            {current && !dirty && (
              <ConfirmAction
                label="Quitar"
                small
                title={`¿Quitar ${item.product.name} de la lista?`}
                message={`Deja de tener precio propio en esta lista: se va a vender al precio de la lista general o al del producto (${formatMoney(item.productPrice, currency)}). Los pedidos ya confirmados no cambian.`}
                confirmLabel="Quitar de la lista"
                danger
                onConfirm={async () => {
                  await apiFetch(`/api/price-lists/${listId}/items/${item.product.id}`, {
                    method: "PUT",
                    body: { unitPrice: item.unitPrice ?? "0", active: false },
                  });
                  setValue("");
                  onSaved();
                }}
              />
            )}
            <span role="status" className="small text-positive">
              {saved && !dirty ? "Guardado" : ""}
            </span>
            {error && (
              <span className="form__error" id={`${inputId}-error`}>
                {error}
              </span>
            )}
          </form>
        ) : current ? (
          formatMoney(item.unitPrice, currency)
        ) : (
          <span className="muted">Usa el precio del producto</span>
        )}
      </td>
      <td className="num hide-md">
        {diff ? (
          <span className={diff.lt(0) ? "text-negative" : ""}>
            {diff.gt(0) ? "+" : ""}
            {formatPercent(diff.toFixed(2))}
          </span>
        ) : (
          ""
        )}
      </td>
    </tr>
  );
}

export function PriceListForm({ id }: { id?: string }) {
  const { data, error } = useResource<PriceListDetailDto>(id ? `/api/price-lists/${id}` : null);
  if (error) return <ErrorState error={error} />;
  if (id && !data) return <Loading />;
  return <PriceListFormInner list={data ?? null} />;
}

function PriceListFormInner({ list }: { list: PriceListDetailDto | null }) {
  const router = useRouter();
  const flash = useFlash();
  const [name, setName] = useState(list?.name ?? "");
  const [code, setCode] = useState(list?.code ?? "");
  const [isDefault, setIsDefault] = useState(list?.isDefault ?? false);
  const [active, setActive] = useState(list?.active ?? true);
  const [notes, setNotes] = useState(list?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!name.trim()) {
      setFieldErrors({ name: "Completá el nombre de la lista." });
      document.getElementById("pl-name")?.focus();
      return;
    }
    setPending(true);
    const body = {
      name: name.trim(),
      ...(list ? {} : { code: code.trim() || null }),
      isDefault,
      active,
      notes: notes.trim() || null,
    };
    try {
      const saved = list
        ? await apiFetch<PriceListDto>(`/api/price-lists/${list.id}`, { method: "PATCH", body })
        : await apiFetch<PriceListDto>("/api/price-lists", { method: "POST", body });
      flash(list ? "Cambios guardados." : "Lista creada. Cargá los precios de cada producto.", {
        afterNavigation: true,
      });
      router.push(`${PRICE_LISTS_BASE}/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(describeError(err));
        setFieldErrors(err.fieldErrors);
      } else setError("No se pudo guardar la lista.");
      setPending(false);
    }
  }

  const becomesDefault = isDefault && !list?.isDefault;
  const deactivates = !!list && list.active && !active;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          list
            ? [
                { href: PRICE_LISTS_BASE, label: "Listas de precios" },
                { href: `${PRICE_LISTS_BASE}/${list.id}`, label: list.name },
              ]
            : { href: PRICE_LISTS_BASE, label: "Listas de precios" }
        }
        title={list ? "Editar lista de precios" : "Nueva lista de precios"}
        subtitle={
          list ? undefined : "Después de guardarla cargás los precios producto por producto."
        }
      />
      <form className="form panel" onSubmit={submit} noValidate>
        <p className="form__hint">
          Los campos con <span className="form__required">*</span> son obligatorios.
        </p>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="pl-name">
              Nombre{" "}
              <span className="form__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="pl-name"
              value={name}
              maxLength={120}
              aria-required
              placeholder="Ej.: Mayoristas"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "pl-name-error" : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {fieldErrors.name && (
              <span className="form__error" id="pl-name-error">
                {fieldErrors.name}
              </span>
            )}
          </div>
          {list ? (
            <div className="form__field">
              <span className="form__label">Código</span>
              <p className="code">{list.code}</p>
            </div>
          ) : (
            <div className="form__field">
              <label htmlFor="pl-code">Código</label>
              <input
                id="pl-code"
                value={code}
                maxLength={32}
                placeholder="LP-0001"
                aria-invalid={fieldErrors.code ? true : undefined}
                aria-describedby={fieldErrors.code ? "pl-code-hint pl-code-error" : "pl-code-hint"}
                onChange={(e) => setCode(e.target.value)}
              />
              <span className="form__hint" id="pl-code-hint">
                Opcional: si lo dejás vacío se genera solo.
              </span>
              {fieldErrors.code && (
                <span className="form__error" id="pl-code-error">
                  {fieldErrors.code}
                </span>
              )}
            </div>
          )}
        </div>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />{" "}
          Lista general (para los clientes sin lista propia)
        </label>
        {becomesDefault && (
          <p className="alert alert--warn" role="status">
            Si ya hay una lista general, deja de serlo: los clientes sin lista propia pasan a
            venderse con esta.
          </p>
        )}
        <label className="inline-check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{" "}
          Activa
        </label>
        {deactivates && (
          <p className="alert alert--warn" role="status">
            Inactiva no se aplica en ventas ni pedidos nuevos
            {list.customerCount > 0 &&
              `: sus ${list.customerCount} ${list.customerCount === 1 ? "cliente pasa" : "clientes pasan"} a la lista general o al precio del producto`}
            .
          </p>
        )}
        <div className="form__field">
          <label htmlFor="pl-notes">Notas</label>
          <textarea
            id="pl-notes"
            value={notes}
            rows={2}
            maxLength={1000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button
            type="submit"
            className="button button--primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Guardando…" : "Guardar"}
          </button>
          <Link
            className="button"
            href={list ? `${PRICE_LISTS_BASE}/${list.id}` : PRICE_LISTS_BASE}
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
