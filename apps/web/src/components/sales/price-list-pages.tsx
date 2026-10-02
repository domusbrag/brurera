"use client";

import {
  PERMISSIONS as P,
  type PriceListDetailDto,
  type PriceListDto,
  type PriceListItemDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { isDecimal, toDecimal } from "@/lib/decimal-input";
import { formatDateTime, formatMoney } from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import { PRICE_LISTS_BASE } from "./sale-shared";

/*
 * Listas de precios (Fase 5B). Prioridad del precio de una venta o pedido:
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
          cell: (l) => (
            <Link href={`${PRICE_LISTS_BASE}/${l.id}`}>
              <span className="code">{l.code}</span> {l.name}
            </Link>
          ),
        },
        {
          header: "Tipo",
          cell: (l) =>
            l.isDefault ? <span className="badge badge--info">General</span> : "Por cliente",
        },
        { header: "Productos", cell: (l) => l.itemCount, className: "num" },
        { header: "Clientes", cell: (l) => l.customerCount, className: "num hide-sm" },
        {
          header: "Estado",
          cell: (l) => <StatusBadge active={l.active} on="Activa" off="Inactiva" />,
        },
      ]}
    />
  );
}

export function PriceListDetail({ id }: { id: string }) {
  const user = useCurrentUser();
  const { data, error, reload } = useResource<PriceListDetailDto>(`/api/price-lists/${id}`);
  const [version, setVersion] = useState(0);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const currency = user.company.currencyCode;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: PRICE_LISTS_BASE, label: "Listas de precios" }}
        title={
          <>
            {data.name} <StatusBadge active={data.active} on="Activa" off="Inactiva" />{" "}
            {data.isDefault && <span className="badge badge--info">General</span>}
          </>
        }
        subtitle={
          data.isDefault
            ? "Lista general: aplica a los clientes que no tienen una lista propia."
            : `Asignada a ${data.customerCount} ${data.customerCount === 1 ? "cliente" : "clientes"} (se asigna desde la ficha del cliente).`
        }
        actions={
          data.canManage && (
            <Link className="button" href={`${PRICE_LISTS_BASE}/${id}/editar`}>
              Editar
            </Link>
          )
        }
      />
      <section className="panel" aria-labelledby="pl-data">
        <h2 id="pl-data">Datos</h2>
        <Details
          items={[
            ["Código", data.code],
            ["Notas", data.notes],
            ["Actualizada", formatDateTime(data.updatedAt, user.company.timezone)],
          ]}
        />
      </section>
      <section className="panel" aria-labelledby="pl-items">
        <h2 id="pl-items">Precios</h2>
        <p className="muted small">
          Precio por unidad de venta. Los pedidos ya confirmados conservan su precio acordado.
        </p>
        <div className="table-wrap">
          <table className="table" aria-label="Precios de la lista">
            <thead>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col" className="num hide-sm">
                  Precio del producto
                </th>
                <th scope="col">Precio en la lista</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
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
  const [error, setError] = useState<string | null>(null);
  const dirty = value.trim() !== current;

  async function save(active: boolean) {
    setError(null);
    if (active && !isDecimal(value)) {
      setError("Precio inválido");
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/price-lists/${listId}/items/${item.product.id}`, {
        method: "PUT",
        body: { unitPrice: active ? toDecimal(value) : (item.unitPrice ?? "0"), active },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar");
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
      <td className="num hide-sm">{formatMoney(item.productPrice, currency)}</td>
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
              inputMode="decimal"
              aria-label={`Precio de ${item.product.name}`}
              value={value}
              placeholder="Sin precio en la lista"
              onChange={(e) => setValue(e.target.value)}
            />
            {dirty && value.trim() !== "" && (
              <button type="submit" className="button button--small" disabled={saving}>
                Guardar
              </button>
            )}
            {current && !dirty && (
              <button
                type="button"
                className="link-button"
                disabled={saving}
                onClick={() => {
                  setValue("");
                  void save(false);
                }}
              >
                Quitar de la lista
              </button>
            )}
            {error && <span className="form__error">{error}</span>}
          </form>
        ) : current ? (
          formatMoney(item.unitPrice, currency)
        ) : (
          <span className="muted">Usa el precio del producto</span>
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
      router.push(`${PRICE_LISTS_BASE}/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError("No se pudo guardar la lista.");
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          list
            ? { href: `${PRICE_LISTS_BASE}/${list.id}`, label: list.name }
            : { href: PRICE_LISTS_BASE, label: "Listas de precios" }
        }
        title={list ? `Editar ${list.name}` : "Nueva lista de precios"}
        subtitle="Después de guardarla cargás los precios producto por producto."
      />
      <form className="form panel" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="pl-name">
              Nombre <span className="form__required">*</span>
            </label>
            <input
              id="pl-name"
              value={name}
              maxLength={120}
              required
              placeholder="Ej.: Mayoristas"
              aria-invalid={fieldErrors.name ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {fieldErrors.name && <span className="form__error">{fieldErrors.name}</span>}
          </div>
          {!list && (
            <div className="form__field">
              <label htmlFor="pl-code">Código</label>
              <input
                id="pl-code"
                value={code}
                maxLength={32}
                placeholder="Automático (LP-0001)"
                onChange={(e) => setCode(e.target.value)}
              />
              {fieldErrors.code && <span className="form__error">{fieldErrors.code}</span>}
            </div>
          )}
        </div>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />{" "}
          Lista general (para los clientes sin lista propia; reemplaza a la general actual)
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{" "}
          Activa
        </label>
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
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button type="submit" className="button button--primary" disabled={pending}>
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
