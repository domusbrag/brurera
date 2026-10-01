"use client";

import { describeShelfLife, shelfLifeToMinutes } from "@bakery/domain";
import {
  CONSERVATION_STATES,
  CONSERVATION_STATE_LABELS,
  PERMISSIONS as P,
  type ConservationProfileDto,
  type ConservationStateDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import { formatShelfLife } from "./lot-shared";

/*
 * Conservación por producto (Fase 4.5): qué estados admite, cuánto dura en cada
 * uno y en cuál nace al producirse. Cambiarla no toca los lotes existentes.
 */

const PRODUCTS_BASE = "/productos";

/** Resumen en el detalle del producto. */
export function ConservationSummary({ productId }: { productId: string }) {
  const can = useCan();
  const allowed = can(P.PRODUCT_CONSERVATION_READ);
  const { data, error } = useResource<ConservationProfileDto>(
    allowed ? `/api/products/${productId}/conservation` : null,
  );
  if (!allowed) return null;
  return (
    <section className="panel" aria-labelledby="conservation-title">
      <div className="panel__header">
        <h2 id="conservation-title">Conservación</h2>
        {can(P.PRODUCT_CONSERVATION_MANAGE) && (
          <Link href={`${PRODUCTS_BASE}/${productId}/conservacion`}>Configurar conservación</Link>
        )}
      </div>
      {error ? (
        <p className="muted">{error.message}</p>
      ) : !data ? (
        <Loading />
      ) : !data.configured ? (
        <p className="muted">
          Sin configurar: los lotes nacen frescos y sin vencimiento, y no se pueden congelar.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Estado</th>
                <th scope="col">Vida útil</th>
                <th scope="col" className="hide-sm">
                  Puede ser inicial
                </th>
              </tr>
            </thead>
            <tbody>
              {data.states
                .filter((s) => s.enabled)
                .map((s) => (
                  <tr key={s.state}>
                    <td>
                      {CONSERVATION_STATE_LABELS[s.state]}
                      {s.state === data.defaultInitialState && (
                        <span className="cost-source">Estado inicial por defecto</span>
                      )}
                    </td>
                    <td>{formatShelfLife(s.shelfLifeMinutes)}</td>
                    <td className="hide-sm">{s.allowedAsInitial ? "Sí" : "No"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type Unit = "HOURS" | "DAYS";
interface Row {
  state: ConservationStateDto;
  enabled: boolean;
  value: string;
  unit: Unit;
  allowedAsInitial: boolean;
  notes: string;
}

function toRows(profile: ConservationProfileDto): Row[] {
  return profile.states.map((s) => {
    const described = s.shelfLifeMinutes === null ? null : describeShelfLife(s.shelfLifeMinutes);
    return {
      state: s.state,
      enabled: s.enabled,
      value: described?.value ?? "",
      unit: described?.unit ?? (s.state === "THAWED" ? "HOURS" : "DAYS"),
      allowedAsInitial: s.allowedAsInitial,
      notes: s.notes ?? "",
    };
  });
}

function minutesOf(row: Row): number | null {
  try {
    return shelfLifeToMinutes(row.value.replace(",", "."), row.unit);
  } catch {
    return null;
  }
}

export function ConservationForm({ productId }: { productId: string }) {
  const { data, error } = useResource<ConservationProfileDto>(
    `/api/products/${productId}/conservation`,
  );
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return <ConservationEditor profile={data} />;
}

function ConservationEditor({ profile }: { profile: ConservationProfileDto }) {
  const router = useRouter();
  const user = useCurrentUser();
  const [rows, setRows] = useState<Row[]>(() => toRows(profile));
  const [defaultInitialState, setDefault] = useState<ConservationStateDto>(
    profile.defaultInitialState,
  );
  const [nearExpiryHours, setNearExpiry] = useState(String(profile.nearExpiryMinutes / 60));
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const productHref = `${PRODUCTS_BASE}/${profile.product.id}`;

  const update = (state: ConservationStateDto, patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.state !== state) return r;
        const next = { ...r, ...patch };
        if (!next.enabled) next.allowedAsInitial = false;
        return next;
      }),
    );
  const nearMinutes = Number(nearExpiryHours.replace(",", ".")) * 60;
  const problems: string[] = [];
  for (const r of rows) {
    if (r.enabled && minutesOf(r) === null)
      problems.push(`Indicá una vida útil válida para ${CONSERVATION_STATE_LABELS[r.state]}.`);
  }
  const initial = rows.find((r) => r.state === defaultInitialState);
  if (!initial?.enabled || !initial.allowedAsInitial)
    problems.push(
      "El estado inicial por defecto tiene que estar habilitado y permitido como inicial.",
    );
  if (!Number.isInteger(nearMinutes) || nearMinutes <= 0)
    problems.push("El aviso de próximo a vencer tiene que ser un número de horas mayor que cero.");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problems.length > 0) return;
    setPending(true);
    setFormError(null);
    try {
      await apiFetch(`/api/products/${profile.product.id}/conservation`, {
        method: "PUT",
        body: {
          defaultInitialState,
          nearExpiryMinutes: nearMinutes,
          states: rows.map((r) => ({
            state: r.state,
            enabled: r.enabled,
            shelfLifeMinutes: r.enabled ? minutesOf(r) : null,
            allowedAsInitial: r.enabled && r.allowedAsInitial,
            notes: r.notes.trim() || null,
          })),
        },
      });
      router.push(productHref);
      router.refresh();
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? (Object.values(err.fieldErrors)[0] ?? err.message)
          : "No se pudo guardar la conservación.",
      );
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: productHref, label: profile.product.name }}
        title="Conservación"
        subtitle={
          <>
            Estados en los que se guarda {profile.product.name} y cuánto dura en cada uno. Los
            cambios valen para lotes nuevos: los existentes conservan su vencimiento.
          </>
        }
      />
      {formError && (
        <p className="alert" role="alert">
          {formError}
        </p>
      )}
      <form className="form" noValidate onSubmit={submit}>
        <section className="panel" aria-labelledby="states-title">
          <h2 id="states-title">Estados</h2>
          <div className="table-wrap">
            <table className="table conservation-table">
              <thead>
                <tr>
                  <th scope="col">Estado</th>
                  <th scope="col">Habilitado</th>
                  <th scope="col">Vida útil</th>
                  <th scope="col">Puede ser inicial</th>
                  <th scope="col" className="hide-sm">
                    Notas
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const label = CONSERVATION_STATE_LABELS[r.state];
                  const invalid = r.enabled && r.value !== "" && minutesOf(r) === null;
                  return (
                    <tr key={r.state}>
                      <th scope="row">{label}</th>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${label} habilitado`}
                          checked={r.enabled}
                          onChange={(e) => update(r.state, { enabled: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div className="inline-fields">
                          <input
                            aria-label={`Vida útil ${label}`}
                            inputMode="decimal"
                            autoComplete="off"
                            disabled={!r.enabled}
                            value={r.value}
                            aria-invalid={invalid ? true : undefined}
                            onChange={(e) => update(r.state, { value: e.target.value })}
                          />
                          <select
                            aria-label={`Unidad de vida útil ${label}`}
                            disabled={!r.enabled}
                            value={r.unit}
                            onChange={(e) => update(r.state, { unit: e.target.value as Unit })}
                          >
                            <option value="DAYS">días</option>
                            <option value="HOURS">horas</option>
                          </select>
                        </div>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${label} puede ser inicial`}
                          disabled={!r.enabled}
                          checked={r.allowedAsInitial}
                          onChange={(e) => update(r.state, { allowedAsInitial: e.target.checked })}
                        />
                      </td>
                      <td className="hide-sm">
                        <input
                          aria-label={`Notas ${label}`}
                          value={r.notes}
                          disabled={!r.enabled}
                          onChange={(e) => update(r.state, { notes: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Un lote descongelado nunca se vuelve a congelar. Congelar y descongelar sólo se ofrecen
            si el estado destino está habilitado.
          </p>
        </section>
        <section className="panel" aria-labelledby="defaults-title">
          <h2 id="defaults-title">Al producir</h2>
          <div className="form-grid">
            <div className="form__field">
              <label htmlFor="defaultInitialState">Estado inicial por defecto</label>
              <select
                id="defaultInitialState"
                value={defaultInitialState}
                onChange={(e) => setDefault(e.target.value as ConservationStateDto)}
              >
                {CONSERVATION_STATES.map((s) => (
                  <option key={s} value={s}>
                    {CONSERVATION_STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form__field">
              <label htmlFor="nearExpiry">Avisar &quot;próximo a vencer&quot; con (horas)</label>
              <input
                id="nearExpiry"
                inputMode="numeric"
                value={nearExpiryHours}
                onChange={(e) => setNearExpiry(e.target.value)}
              />
              <span className="form__hint">
                Por ejemplo 24: avisa el día anterior al vencimiento.
              </span>
            </div>
          </div>
          {problems.length > 0 && (
            <ul className="form__error" aria-live="polite">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {profile.updatedAt && (
            <p className="muted small">
              Última modificación: {formatDateTime(profile.updatedAt, user.company.timezone)}
              {profile.updatedBy ? ` por ${profile.updatedBy.displayName}` : ""}
            </p>
          )}
          <div className="form__footer">
            <button
              type="submit"
              className="button button--primary"
              disabled={pending || problems.length > 0}
            >
              {pending ? "Guardando…" : "Guardar conservación"}
            </button>
            <Link className="button" href={productHref}>
              Cancelar
            </Link>
          </div>
        </section>
      </form>
    </div>
  );
}
