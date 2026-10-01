"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api-client";

export type FieldKind =
  | "text"
  | "email"
  | "textarea"
  | "select"
  | "decimal"
  | "date"
  | "number"
  | "checkbox"
  | "password"
  | "url";

export interface FieldDef {
  name: string;
  label: string;
  kind?: FieldKind;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Texto de la opción vacía en selects opcionales. */
  emptyOption?: string;
  hint?: ReactNode;
  placeholder?: string;
  full?: boolean;
  disabled?: boolean;
  autoComplete?: string;
}

export type FormValues = Record<string, string | boolean>;

/** Valores iniciales de un formulario a partir de un registro (null → ""). */
export function toFormValues(fields: FieldDef[], source: object = {}): FormValues {
  const values: FormValues = {};
  const record = source as Record<string, unknown>;
  for (const f of fields) {
    const v = record[f.name];
    values[f.name] =
      f.kind === "checkbox" ? v === true : v === null || v === undefined ? "" : String(v);
  }
  return values;
}

/**
 * Formulario genérico: renderiza los campos, envía los valores y muestra los
 * errores por campo que devuelve la API (la validación real es del servidor,
 * con los mismos esquemas zod que @bakery/shared).
 */
export function EntityForm({
  fields,
  initial,
  submitLabel,
  cancelHref,
  onSubmit,
  intro,
}: {
  fields: FieldDef[];
  initial: FormValues;
  submitLabel: string;
  cancelHref: string;
  onSubmit: (values: FormValues) => Promise<void>;
  intro?: ReactNode;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (name: string, value: string | boolean) =>
    setValues((v) => ({ ...v, [name]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const missing = Object.fromEntries(
      fields
        .filter((f) => f.required && f.kind !== "checkbox" && !String(values[f.name] ?? "").trim())
        .map((f) => [f.name, "Obligatorio"]),
    );
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setError("Completá los campos obligatorios.");
      return;
    }
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else {
        setError("No se pudo guardar.");
      }
      setPending(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit} noValidate>
      {intro}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="form-grid">
        {fields.map((f) => (
          <Field
            key={f.name}
            def={f}
            value={values[f.name] ?? ""}
            error={fieldErrors[f.name]}
            onChange={(v) => set(f.name, v)}
          />
        ))}
      </div>
      <div className="form__footer">
        <button type="submit" className="button button--primary" disabled={pending}>
          {pending ? "Guardando…" : submitLabel}
        </button>
        <Link className="button" href={cancelHref}>
          Cancelar
        </Link>
      </div>
    </form>
  );
}

function Field({
  def,
  value,
  error,
  onChange,
}: {
  def: FieldDef;
  value: string | boolean;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const id = `field-${def.name}`;
  const kind = def.kind ?? "text";
  const common = {
    id,
    name: def.name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
    disabled: def.disabled,
  } as const;

  if (kind === "checkbox") {
    return (
      <div className={`form__field ${def.full ? "form__field--full" : ""}`}>
        <label className="form__field--check" htmlFor={id}>
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{def.label}</span>
        </label>
        {def.hint && <span className="form__hint">{def.hint}</span>}
      </div>
    );
  }

  let control: ReactNode;
  if (kind === "select") {
    control = (
      <select {...common} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {(!def.required || !value) && (
          <option value="">
            {def.emptyOption ?? (def.required ? "Elegí una opción" : "Ninguno")}
          </option>
        )}
        {def.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (kind === "textarea") {
    control = (
      <textarea {...common} value={String(value)} onChange={(e) => onChange(e.target.value)} />
    );
  } else {
    const type =
      kind === "decimal"
        ? "text"
        : kind === "number"
          ? "number"
          : kind === "date"
            ? "date"
            : kind === "email"
              ? "email"
              : kind === "password"
                ? "password"
                : kind === "url"
                  ? "url"
                  : "text";
    control = (
      <input
        {...common}
        type={type}
        inputMode={kind === "decimal" ? "decimal" : undefined}
        placeholder={def.placeholder}
        autoComplete={def.autoComplete ?? (kind === "password" ? "new-password" : "off")}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className={`form__field ${def.full || kind === "textarea" ? "form__field--full" : ""}`}>
      <label htmlFor={id}>
        {def.label}{" "}
        {def.required && (
          <span className="form__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {control}
      {def.hint && <span className="form__hint">{def.hint}</span>}
      {error && (
        <span className="form__error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Payload para la API: textos recortados; opcionales vacíos → null; números → number. */
export function toPayload(
  fields: FieldDef[],
  values: FormValues,
  only?: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    if (only && !only.includes(f.name)) continue;
    if (f.disabled) continue;
    const v = values[f.name];
    if (f.kind === "checkbox") payload[f.name] = v === true;
    else if (f.kind === "number") payload[f.name] = v === "" ? undefined : Number(v);
    else {
      const text = String(v ?? "").trim();
      payload[f.name] = text === "" ? (f.required ? "" : null) : text;
    }
  }
  return payload;
}
