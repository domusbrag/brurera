"use client";

import { areUnitsCompatible } from "@bakery/domain";
import {
  PERMISSIONS as P,
  type PresentationDto,
  type UnitDto,
  type UnitRefDto,
} from "@bakery/shared";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatDecimal } from "@/lib/format";
import { ConfirmAction, ErrorState, Loading, StatusBadge, useResource } from "../masters/ui";
import { toCostingUnit } from "../recipes/cost-views";
import { useCan } from "../user-context";

/*
 * Presentaciones de compra de UNA materia prima ("Bolsa 25 kg" de esta harina).
 * La equivalencia pertenece a la materia prima, no a la unidad "bolsa": otra
 * harina puede venir en bolsas de 50 kg. La conversión no se edita una vez
 * creada (cambiaría compras ya hechas); sólo el nombre y el estado.
 */

export function PresentationsPanel({
  rawMaterialId,
  baseUnit,
}: {
  rawMaterialId: string;
  baseUnit: Pick<UnitRefDto, "id" | "symbol">;
}) {
  const can = useCan();
  const { data, error, reload } = useResource<PresentationDto[]>(
    can(P.PRESENTATIONS_READ) ? `/api/raw-materials/${rawMaterialId}/presentations` : null,
  );
  const [adding, setAdding] = useState(false);
  if (!can(P.PRESENTATIONS_READ)) return null;
  const manage = can(P.PRESENTATIONS_MANAGE);
  return (
    <section className="panel" aria-labelledby="presentations-title">
      <div className="panel__header">
        <h2 id="presentations-title">Presentaciones de compra</h2>
        {manage && !adding && (
          <button type="button" className="button" onClick={() => setAdding(true)}>
            Nueva presentación
          </button>
        )}
      </div>
      <p className="muted small">
        Cómo se compra esta materia prima y cuánto trae cada envase. Al recibir una compra, la
        cantidad se convierte a {baseUnit.symbol}.
      </p>
      {adding && (
        <PresentationForm
          rawMaterialId={rawMaterialId}
          baseUnitId={baseUnit.id}
          onDone={() => {
            setAdding(false);
            reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="muted">Sin presentaciones. Se puede comprar igual por {baseUnit.symbol}.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Presentación</th>
                <th scope="col">Equivale a</th>
                <th scope="col">Estado</th>
                {manage && (
                  <th scope="col">
                    <span className="sr-only">Acciones</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    1 {p.purchaseUnit.symbol} = {formatDecimal(p.containedQuantity)}{" "}
                    {p.containedUnit.symbol}
                    {p.containedUnit.id !== p.baseUnit.id &&
                      ` (${formatDecimal(p.baseQuantity)} ${p.baseUnit.symbol})`}
                  </td>
                  <td>
                    <StatusBadge active={p.active} on="Activa" off="Inactiva" />
                  </td>
                  {manage && (
                    <td>
                      <div className="actions">
                        <RenamePresentation presentation={p} onDone={reload} />
                        <ConfirmAction
                          label={p.active ? "Desactivar" : "Reactivar"}
                          title={p.active ? `¿Desactivar ${p.name}?` : `¿Reactivar ${p.name}?`}
                          message={
                            p.active
                              ? "No se ofrece en compras nuevas. Las compras ya hechas la conservan."
                              : "Vuelve a ofrecerse en compras nuevas."
                          }
                          confirmLabel={p.active ? "Desactivar" : "Reactivar"}
                          danger={p.active}
                          onConfirm={async () => {
                            await apiFetch(
                              `/api/raw-material-presentations/${p.id}/${p.active ? "deactivate" : "activate"}`,
                              { method: "POST" },
                            );
                            reload();
                          }}
                        />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RenamePresentation({
  presentation,
  onDone,
}: {
  presentation: PresentationDto;
  onDone: () => void;
}) {
  const [name, setName] = useState(presentation.name);
  return (
    <ConfirmAction
      label="Renombrar"
      title="Renombrar presentación"
      message="La equivalencia no cambia: sólo el nombre."
      confirmLabel="Guardar"
      onConfirm={async () => {
        await apiFetch(`/api/raw-material-presentations/${presentation.id}`, {
          method: "PATCH",
          body: { name },
        });
        onDone();
      }}
    >
      <div className="form__field" style={{ marginTop: "0.8rem" }}>
        <label htmlFor={`rename-${presentation.id}`}>Nombre</label>
        <input
          id={`rename-${presentation.id}`}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
    </ConfirmAction>
  );
}

function PresentationForm({
  rawMaterialId,
  baseUnitId,
  onDone,
  onCancel,
}: {
  rawMaterialId: string;
  baseUnitId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [units, setUnits] = useState<UnitDto[] | null>(null);
  const [name, setName] = useState("");
  const [purchaseUnitId, setPurchaseUnitId] = useState("");
  const [containedQuantity, setContainedQuantity] = useState("");
  const [containedUnitId, setContainedUnitId] = useState(baseUnitId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchOptions<UnitDto>("/api/units")
      .then(setUnits)
      .catch(() => setUnits([]));
  }, []);
  if (!units) return <Loading />;
  const base = units.find((u) => u.id === baseUnitId);
  const containedOptions = base
    ? units.filter((u) => areUnitsCompatible(toCostingUnit(u), toCostingUnit(base)))
    : [];
  const purchaseOptions = [...units].sort(
    (a, b) => Number(b.dimension === "PACKAGING") - Number(a.dimension === "PACKAGING"),
  );
  const purchaseUnit = units.find((u) => u.id === purchaseUnitId);
  const containedUnit = units.find((u) => u.id === containedUnitId);
  const suggestion =
    purchaseUnit && containedUnit && isPositive(containedQuantity)
      ? `${purchaseUnit.name} ${formatDecimal(toDecimal(containedQuantity))} ${containedUnit.symbol}`
      : "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/api/raw-materials/${rawMaterialId}/presentations`, {
        method: "POST",
        body: {
          name: name.trim() || suggestion,
          purchaseUnitId,
          containedQuantity: toDecimal(containedQuantity),
          containedUnitId,
        },
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setFormError(Object.keys(err.fieldErrors).length > 0 ? null : describeError(err));
      } else setFormError("No se pudo crear la presentación.");
      setPending(false);
    }
  }

  return (
    <form className="form presentation-form" onSubmit={submit} noValidate>
      {formError && (
        <p className="alert" role="alert">
          {formError}
        </p>
      )}
      <div className="form-grid">
        <div className="form__field">
          <label htmlFor="purchaseUnitId">Se compra por</label>
          <select
            id="purchaseUnitId"
            value={purchaseUnitId}
            aria-invalid={errors.purchaseUnitId ? true : undefined}
            onChange={(e) => setPurchaseUnitId(e.target.value)}
          >
            <option value="">Elegí la unidad de compra</option>
            {purchaseOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.symbol})
              </option>
            ))}
          </select>
          {errors.purchaseUnitId && <span className="form__error">{errors.purchaseUnitId}</span>}
        </div>
        <div className="form__field">
          <label htmlFor="containedQuantity">Cada una trae</label>
          <input
            id="containedQuantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Ej.: 25"
            value={containedQuantity}
            aria-invalid={errors.containedQuantity ? true : undefined}
            onChange={(e) => setContainedQuantity(e.target.value)}
          />
          {errors.containedQuantity && (
            <span className="form__error">{errors.containedQuantity}</span>
          )}
        </div>
        <div className="form__field">
          <label htmlFor="containedUnitId">Unidad del contenido</label>
          <select
            id="containedUnitId"
            value={containedUnitId}
            aria-invalid={errors.containedUnitId ? true : undefined}
            onChange={(e) => setContainedUnitId(e.target.value)}
          >
            {containedOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.symbol}
              </option>
            ))}
          </select>
          {errors.containedUnitId && <span className="form__error">{errors.containedUnitId}</span>}
        </div>
        <div className="form__field">
          <label htmlFor="presentationName">Nombre</label>
          <input
            id="presentationName"
            autoComplete="off"
            placeholder={suggestion || "Ej.: Bolsa 25 kg"}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name && <span className="form__error">{errors.name}</span>}
        </div>
      </div>
      <div className="form__footer">
        <button type="submit" className="button button--primary" disabled={pending}>
          {pending ? "Guardando…" : "Crear presentación"}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={pending}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
