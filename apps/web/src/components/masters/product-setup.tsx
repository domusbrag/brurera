"use client";

import {
  areUnitsCompatible,
  calculateRecipeCost,
  recipeCostToWire,
  type IngredientCostInput,
} from "@bakery/domain";
import {
  PERMISSIONS as P,
  type CategoryDto,
  type PriceListDto,
  type ProductSetupResultDto,
  type RawMaterialDto,
  type TheoreticalCostDto,
  type UnitDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { describeError } from "@/lib/errors";
import { formatMoney, formatPercent, formatReferenceCost } from "@/lib/format";
import { toCostingUnit } from "../recipes/cost-views";
import { Combobox, type ComboOption } from "../ui/combobox";
import { useFlash } from "../ui/flash";
import { Icon } from "../ui/icons";
import { useCan, useCurrentUser } from "../user-context";
import { ErrorState, Loading, PageHeader } from "./ui";

/*
 * Nuevo producto "de corrido": en UNA pantalla se carga qué se vende, con qué se
 * hace (receta, creando los insumos que falten en el momento) y a cuánto se
 * vende en cada lista. Mientras se escribe, el resumen de la derecha muestra el
 * costo por unidad y la ganancia, como en una planilla. Al guardar, la API hace
 * todo en una sola operación: si algo falla no queda nada a medias.
 */

interface Line {
  key: number;
  /** Insumo existente (id) o nuevo (ref de NewMaterial). */
  materialId: string;
  newRef: string;
  quantity: string;
  unitId: string;
}

interface NewMaterial {
  ref: string;
  name: string;
  baseUnitId: string;
  cost: string;
  /** Categoría existente o, si está vacía, `newCategoryName`. */
  categoryId: string;
  newCategoryName: string;
}

interface PriceRow {
  checked: boolean;
  price: string;
  /** El usuario escribió otro precio: ya no sigue al precio de venta. */
  touched: boolean;
}

const DECIMAL = /^\d{1,12}([.,]\d{1,6})?$/;
const toDecimal = (value: string) => value.trim().replace(",", ".");
const isPositive = (value: string) => DECIMAL.test(value.trim()) && Number(toDecimal(value)) > 0;
const isAmount = (value: string) => DECIMAL.test(value.trim());

let nextKey = 1;
const emptyLine = (): Line => ({
  key: nextKey++,
  materialId: "",
  newRef: "",
  quantity: "",
  unitId: "",
});

interface Catalog {
  productCategories: CategoryDto[];
  materialCategories: CategoryDto[];
  materials: RawMaterialDto[];
  units: UnitDto[];
  priceLists: PriceListDto[];
}

function useCatalog(canSeeLists: boolean) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchOptions<CategoryDto>("/api/categories", { type: "PRODUCT" }),
      fetchOptions<CategoryDto>("/api/categories", { type: "RAW_MATERIAL" }),
      fetchOptions<RawMaterialDto>("/api/raw-materials").catch(() => []),
      fetchOptions<UnitDto>("/api/units"),
      canSeeLists ? fetchOptions<PriceListDto>("/api/price-lists") : Promise.resolve([]),
    ])
      .then(([productCategories, materialCategories, materials, units, priceLists]) => {
        if (cancelled) return;
        setCatalog({
          productCategories,
          materialCategories,
          materials,
          units: units.filter((u) => u.active),
          priceLists: priceLists.filter((l) => l.active),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Error"));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, canSeeLists]);
  return { catalog, error, retry: () => setAttempt((a) => a + 1) };
}

export function ProductSetup() {
  const can = useCan();
  const { catalog, error, retry } = useCatalog(can(P.PRICE_LISTS_READ));
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (!catalog) return <Loading label="Preparando la carga…" />;
  return <ProductSetupForm catalog={catalog} />;
}

function Step({
  n,
  id,
  title,
  hint,
  children,
  aside,
}: {
  n: number;
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="panel step" aria-labelledby={id}>
      <div className="step__header">
        <span className="step__number" aria-hidden="true">
          {n}
        </span>
        <div className="step__title">
          <h2 id={id}>{title}</h2>
          {hint && <p className="muted small">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ProductSetupForm({ catalog }: { catalog: Catalog }) {
  const router = useRouter();
  const flash = useFlash();
  const can = useCan();
  const user = useCurrentUser();
  const currency = user.company.currencyCode;

  const canNewCategory = can(P.CATEGORIES_MANAGE);
  const canNewMaterial =
    can(P.RAW_MATERIALS_CREATE) && (catalog.materialCategories.length > 0 || canNewCategory);
  const canMaterialCost = can(P.RAW_MATERIALS_UPDATE_COST);
  const canRecipe = can(P.RECIPES_CREATE) && can(P.RAW_MATERIALS_READ);
  const canPublish = can(P.RECIPES_PUBLISH);
  const canPrices = can(P.PRICE_LISTS_MANAGE);

  const unitById = useMemo(() => new Map(catalog.units.map((u) => [u.id, u])), [catalog.units]);
  const materialById = useMemo(
    () => new Map(catalog.materials.filter((m) => m.active).map((m) => [m.id, m])),
    [catalog.materials],
  );
  const defaultSaleUnit =
    catalog.units.find((u) => u.code === "unidad") ??
    catalog.units.find((u) => u.baseUnit === null);
  const rootUnits = catalog.units.filter((u) => u.baseUnit === null);
  const defaultMaterialUnit = catalog.units.find((u) => u.code === "kg") ?? rootUnits[0];

  // Producto
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [saleUnitId, setSaleUnitId] = useState(defaultSaleUnit?.id ?? "");
  const [salePrice, setSalePrice] = useState("");
  const [controlsStock, setControlsStock] = useState(true);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  // Receta
  const [withRecipe, setWithRecipe] = useState(canRecipe);
  const [yieldQuantity, setYieldQuantity] = useState("");
  const [yieldUnitId, setYieldUnitId] = useState(defaultSaleUnit?.id ?? "");
  const [wastePercentage, setWastePercentage] = useState("");
  const [instructions, setInstructions] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [newMaterials, setNewMaterials] = useState<NewMaterial[]>([]);
  /** Costo escrito en el momento para insumos existentes que no tienen costo. */
  const [existingCosts, setExistingCosts] = useState<Record<string, string>>({});
  const [publish, setPublish] = useState(canPublish);
  const [acknowledge, setAcknowledge] = useState(false);

  // Listas de precios: la default ya viene marcada.
  const [prices, setPrices] = useState<Record<string, PriceRow>>(() =>
    Object.fromEntries(
      catalog.priceLists.map((l) => [
        l.id,
        { checked: canPrices && l.isDefault, price: "", touched: false },
      ]),
    ),
  );

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const saleUnit = unitById.get(saleUnitId);
  const compatible = (base: UnitDto | undefined) =>
    base
      ? catalog.units.filter((u) => areUnitsCompatible(toCostingUnit(u), toCostingUnit(base)))
      : [];
  const yieldUnits = compatible(saleUnit);

  function chooseSaleUnit(id: string) {
    setSaleUnitId(id);
    // El rendimiento sigue a la unidad de venta (si ya no es compatible).
    const unit = unitById.get(id);
    const current = unitById.get(yieldUnitId);
    if (!unit || !current || !areUnitsCompatible(toCostingUnit(unit), toCostingUnit(current)))
      setYieldUnitId(id);
  }

  /* ---- Ingredientes ---- */
  const setLine = (key: number, change: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));

  const materialOptions: ComboOption[] = useMemo(
    () => [
      ...[...materialById.values()].map((m) => ({
        value: m.id,
        label: m.name,
        keywords: m.code,
        detail:
          m.effectiveCost === null
            ? "sin costo"
            : formatReferenceCost(m.effectiveCost, currency, m.baseUnit.symbol),
      })),
      ...newMaterials
        .filter((m) => m.name.trim())
        .map((m) => ({ value: `nuevo:${m.ref}`, label: m.name, detail: "nuevo" })),
    ],
    [materialById, newMaterials, currency],
  );

  function lineBase(line: Line): UnitDto | undefined {
    if (line.newRef) {
      const nm = newMaterials.find((m) => m.ref === line.newRef);
      return nm ? unitById.get(nm.baseUnitId) : undefined;
    }
    const m = materialById.get(line.materialId);
    return m ? unitById.get(m.baseUnit.id) : undefined;
  }

  function chooseMaterial(key: number, value: string) {
    if (value.startsWith("nuevo:")) {
      const ref = value.slice(6);
      const nm = newMaterials.find((m) => m.ref === ref);
      setLine(key, { materialId: "", newRef: ref, unitId: nm?.baseUnitId ?? "" });
      return;
    }
    const m = materialById.get(value);
    setLine(key, { materialId: value, newRef: "", unitId: m ? m.baseUnit.id : "" });
  }

  function createMaterial(key: number, text: string) {
    const ref = `n${nextKey++}`;
    const active = catalog.materialCategories.filter((c) => c.active);
    // Una categoría genérica ("Insumos", "Varios", "General") antes que la primera de la lista.
    const firstCategory = active.find((c) => /insumo|vari|general|otro/i.test(c.name)) ?? active[0];
    setNewMaterials((list) => [
      ...list,
      {
        ref,
        name: text.trim(),
        baseUnitId: defaultMaterialUnit?.id ?? "",
        cost: "",
        categoryId: firstCategory?.id ?? "",
        newCategoryName: firstCategory ? "" : "Insumos",
      },
    ]);
    setLine(key, { materialId: "", newRef: ref, unitId: defaultMaterialUnit?.id ?? "" });
  }

  const setNewMaterial = (ref: string, change: Partial<NewMaterial>) => {
    setNewMaterials((list) => list.map((m) => (m.ref === ref ? { ...m, ...change } : m)));
    if (change.baseUnitId) {
      // Las filas que lo usan pasan a la nueva unidad base.
      setLines((ls) =>
        ls.map((l) => (l.newRef === ref ? { ...l, unitId: change.baseUnitId! } : l)),
      );
    }
  };

  function removeLine(key: number) {
    const rest = lines.filter((l) => l.key !== key);
    const left = rest.length > 0 ? rest : [emptyLine()];
    setLines(left);
    // Un insumo nuevo que ya no usa ninguna fila no se crea.
    setNewMaterials((list) => list.filter((m) => left.some((l) => l.newRef === m.ref)));
  }

  const filledLines = lines.filter((l) => l.materialId || l.newRef || l.quantity.trim());
  const usedNewMaterials = newMaterials.filter((m) => filledLines.some((l) => l.newRef === m.ref));
  const recipeOn = canRecipe && withRecipe;
  /** Costos escritos para insumos existentes sin costo que siguen en la receta. */
  const usedExistingCosts = Object.entries(existingCosts).filter(
    ([id, value]) =>
      value.trim() !== "" &&
      materialById.get(id)?.effectiveCost === null &&
      filledLines.some((l) => l.materialId === id),
  );

  /* ---- Costo en vivo (mismas funciones puras que la API) ---- */
  const live = useMemo((): TheoreticalCostDto | null => {
    if (!recipeOn) return null;
    const yieldUnit = unitById.get(yieldUnitId);
    if (!saleUnit || !yieldUnit || !isPositive(yieldQuantity)) return null;
    if (!areUnitsCompatible(toCostingUnit(yieldUnit), toCostingUnit(saleUnit))) return null;
    const inputs: IngredientCostInput[] = [];
    for (const line of lines) {
      const unit = unitById.get(line.unitId);
      const base = lineBase(line);
      if (!unit || !base || !isPositive(line.quantity)) continue;
      if (!areUnitsCompatible(toCostingUnit(unit), toCostingUnit(base))) continue;
      if (line.newRef) {
        const nm = newMaterials.find((m) => m.ref === line.newRef)!;
        inputs.push({
          rawMaterialId: `nuevo:${nm.ref}`,
          rawMaterialCode: "",
          rawMaterialName: nm.name,
          quantity: toDecimal(line.quantity),
          unit: toCostingUnit(unit),
          baseUnit: toCostingUnit(base),
          referenceCost: isPositive(nm.cost) ? toDecimal(nm.cost) : null,
          costSource: "MANUAL_REFERENCE",
        });
      } else {
        const m = materialById.get(line.materialId)!;
        const typed = existingCosts[m.id] ?? "";
        const useTyped = m.effectiveCost === null && isPositive(typed);
        inputs.push({
          rawMaterialId: m.id,
          rawMaterialCode: m.code,
          rawMaterialName: m.name,
          quantity: toDecimal(line.quantity),
          unit: toCostingUnit(unit),
          baseUnit: toCostingUnit(base),
          referenceCost: useTyped ? toDecimal(typed) : m.effectiveCost,
          costSource: useTyped ? "MANUAL_REFERENCE" : m.effectiveCostSource,
        });
      }
    }
    if (inputs.length === 0) return null;
    try {
      return recipeCostToWire(
        calculateRecipeCost({
          currency,
          yieldQuantity: toDecimal(yieldQuantity),
          yieldUnit: toCostingUnit(yieldUnit),
          saleUnit: toCostingUnit(saleUnit),
          salePrice: isAmount(salePrice) ? toDecimal(salePrice) : null,
          ingredients: inputs,
        }),
      );
    } catch {
      return null;
    }
    // lineBase depende de lines/newMaterials/materialById, ya incluidos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    recipeOn,
    unitById,
    yieldUnitId,
    saleUnit,
    yieldQuantity,
    lines,
    newMaterials,
    materialById,
    existingCosts,
    currency,
    salePrice,
  ]);

  const lineCost = (line: Line) =>
    live?.ingredients.find(
      (i) => i.rawMaterialId === (line.newRef ? `nuevo:${line.newRef}` : line.materialId),
    )?.cost ?? null;

  /* ---- Precios ---- */
  const setPrice = (listId: string, change: Partial<PriceRow>) =>
    setPrices((p) => ({ ...p, [listId]: { ...p[listId]!, ...change } }));
  const priceFor = (listId: string) => {
    const row = prices[listId];
    if (!row) return "";
    return row.touched ? row.price : salePrice;
  };
  const chosenLists = catalog.priceLists.filter((l) => prices[l.id]?.checked);

  /* ---- Guardar ---- */
  async function submit(event: FormEvent) {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (!name.trim()) local["product.name"] = "Escribí el nombre";
    if (!categoryId && !newCategory.trim())
      local["product.categoryId"] = "Elegí o escribí una categoría";
    if (!saleUnitId) local["product.saleUnitId"] = "Elegí cómo se vende";
    if (!isAmount(salePrice)) local["product.salePrice"] = "Escribí el precio (puede ser 0)";
    const sentLines = recipeOn ? filledLines : [];
    if (recipeOn && sentLines.length > 0) {
      if (!isPositive(yieldQuantity))
        local["recipe.yieldQuantity"] = "¿Cuántos salen? Mayor que cero";
      if (!yieldUnitId) local["recipe.yieldUnitId"] = "Obligatorio";
      sentLines.forEach((l) => {
        const i = lines.indexOf(l);
        if (!l.materialId && !l.newRef) local[`line.${i}.material`] = "Elegí o escribí el insumo";
        if (!isPositive(l.quantity)) local[`line.${i}.quantity`] = "Mayor que cero";
        if (!l.unitId) local[`line.${i}.unit`] = "Elegí la unidad";
      });
      usedExistingCosts.forEach(([id, value]) => {
        if (!isPositive(value)) local[`cost.${id}`] = "Número inválido";
      });
      usedNewMaterials.forEach((m) => {
        if (m.cost.trim() && !isAmount(m.cost)) local[`new.${m.ref}.cost`] = "Número inválido";
        if (!m.baseUnitId) local[`new.${m.ref}.unit`] = "Elegí la unidad";
      });
    }
    chosenLists.forEach((l) => {
      if (!isAmount(priceFor(l.id))) local[`price.${l.id}`] = "Escribí el precio";
    });
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      setError("Revisá los datos marcados.");
      return;
    }

    const recipe =
      recipeOn && sentLines.length > 0
        ? {
            yieldQuantity: toDecimal(yieldQuantity),
            yieldUnitId,
            wastePercentage: wastePercentage.trim() ? toDecimal(wastePercentage) : null,
            instructions: instructions.trim() || null,
            ingredients: sentLines.map((l) => ({
              rawMaterialId: l.materialId || null,
              newMaterialRef: l.newRef || null,
              quantity: toDecimal(l.quantity),
              unitId: l.unitId,
            })),
            publish: canPublish && publish,
            acknowledgeIncompleteCost: acknowledge,
          }
        : null;
    const body = {
      product: {
        name,
        code: code.trim() || null,
        categoryId: categoryId || null,
        newCategoryName: categoryId ? null : newCategory,
        saleUnitId,
        salePrice: toDecimal(salePrice),
        controlsStock,
        description: description.trim() || null,
        imageUrl: imageUrl.trim() || null,
      },
      newMaterials: recipe
        ? usedNewMaterials.map((m) => ({
            ref: m.ref,
            name: m.name,
            baseUnitId: m.baseUnitId,
            categoryId: m.categoryId || null,
            newCategoryName: m.categoryId ? null : m.newCategoryName || "Insumos",
            referenceCost: canMaterialCost && m.cost.trim() ? toDecimal(m.cost) : null,
          }))
        : [],
      materialCosts:
        recipe && canMaterialCost
          ? usedExistingCosts.map(([id, value]) => ({
              rawMaterialId: id,
              referenceCost: toDecimal(value),
            }))
          : [],
      recipe,
      prices: canPrices
        ? chosenLists.map((l) => ({ priceListId: l.id, unitPrice: toDecimal(priceFor(l.id)) }))
        : [],
    };

    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await apiFetch<ProductSetupResultDto>("/api/product-setup", {
        method: "POST",
        body,
      });
      flash(successMessage(result), { afterNavigation: true });
      router.push(`/productos/${result.product.id}`);
    } catch (err) {
      setPending(false);
      if (!(err instanceof ApiError)) {
        setError("No se pudo guardar. Probá de nuevo.");
        return;
      }
      setFieldErrors(
        mapServerErrors(
          err.fieldErrors,
          sentLines,
          lines,
          usedNewMaterials,
          chosenLists,
          usedExistingCosts,
        ),
      );
      if (err.code === "COST_INCOMPLETE_CONFIRMATION_REQUIRED") {
        setError("Hay insumos sin costo. Escribí cuánto te cuestan o marcá «Dejarla lista igual».");
      } else {
        const details = Object.values(err.fieldErrors);
        setError(
          err.status === 422 && details.length > 0 ? details.join(". ") : describeError(err),
        );
      }
    }
  }

  const err = (key: string) => fieldErrors[key];
  const errProps = (key: string, id: string) => ({
    "aria-invalid": err(key) ? true : undefined,
    "aria-describedby": err(key) ? `${id}-error` : undefined,
  });
  const errorText = (k: string, id: string) =>
    err(k) ? (
      <span className="form__error" id={`${id}-error`}>
        {err(k)}
      </span>
    ) : null;

  const categoryOptions: ComboOption[] = catalog.productCategories
    .filter((c) => c.active)
    .map((c) => ({ value: c.id, label: c.name }));
  const unitLabel = saleUnit?.symbol ?? "unidad";
  const price = isAmount(salePrice) ? Number(toDecimal(salePrice)) : null;
  const unitCost = live?.unitCost ? Number(live.unitCost) : null;
  /** Con costos faltantes: lo que suman los insumos con costo (piso del costo real). */
  const partialUnitCost =
    live && live.unitCost === null && Number(live.normalizedYield) > 0
      ? live.ingredients.reduce((sum, i) => sum + (i.cost ? Number(i.cost) : 0), 0) /
        Number(live.normalizedYield)
      : null;
  const profit = price !== null && unitCost !== null ? price - unitCost : null;
  const marginPct = live?.grossMargin?.percentage ?? null;
  const marginTone =
    profit === null
      ? "neutral"
      : profit <= 0
        ? "danger"
        : Number(marginPct ?? 0) < 30
          ? "warn"
          : "ok";
  const incomplete = live?.status === "INCOMPLETE";

  const willCreate: string[] = [];
  if (!categoryId && newCategory.trim()) willCreate.push(`la categoría «${newCategory.trim()}»`);
  if (recipeOn && usedNewMaterials.length > 0)
    willCreate.push(
      usedNewMaterials.length === 1
        ? `el insumo «${usedNewMaterials[0]!.name}»`
        : `${usedNewMaterials.length} insumos nuevos`,
    );
  if (recipeOn && filledLines.length > 0)
    willCreate.push(
      publish && canPublish ? "la receta, lista para producir" : "la receta como borrador",
    );
  if (canPrices && chosenLists.length > 0)
    willCreate.push(
      chosenLists.length === 1
        ? `el precio en «${chosenLists[0]!.name}»`
        : `el precio en ${chosenLists.length} listas`,
    );

  return (
    <div className="page">
      <PageHeader
        title="Nuevo producto"
        breadcrumb={{ href: "/productos", label: "Productos" }}
        subtitle="Cargalo todo de una vez: qué es, con qué se hace y a cuánto lo vendés. Lo que no sepas ahora lo completás después."
      />
      <form className="setup" onSubmit={submit} noValidate aria-label="Nuevo producto">
        <div className="setup__main">
          <Step
            n={1}
            id="step-what"
            title="¿Qué vas a vender?"
            hint="Como lo escribirías en la pizarra del mostrador."
          >
            <div className="form-grid">
              <div className="form__field form__field--full">
                <label htmlFor="ps-name">
                  Nombre{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <input
                  id="ps-name"
                  className="input--large"
                  autoComplete="off"
                  placeholder="Ej.: Pan de campo, Medialuna de manteca, Torta brownie"
                  value={name}
                  aria-required
                  {...errProps("product.name", "ps-name")}
                  onChange={(e) => setName(e.target.value)}
                />
                {errorText("product.name", "ps-name")}
              </div>
              <div className="form__field">
                <label htmlFor="ps-category">
                  Categoría{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <Combobox
                  id="ps-category"
                  options={categoryOptions}
                  value={categoryId}
                  placeholder={canNewCategory ? "Elegí o escribí una nueva" : "Elegí una categoría"}
                  required
                  invalid={Boolean(err("product.categoryId"))}
                  describedBy={err("product.categoryId") ? "ps-category-error" : "ps-category-hint"}
                  onChange={(v) => {
                    setCategoryId(v);
                    setNewCategory("");
                  }}
                  onCreate={
                    canNewCategory
                      ? (text) => {
                          setCategoryId("");
                          setNewCategory(text);
                        }
                      : undefined
                  }
                  createLabel={(t) => `Crear la categoría «${t}»`}
                />
                {newCategory && !categoryId ? (
                  <span className="form__hint chip-hint" id="ps-category-hint">
                    <Icon name="plus" size="sm" /> Categoría nueva: <strong>{newCategory}</strong>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setNewCategory("")}
                    >
                      Quitar
                    </button>
                  </span>
                ) : (
                  <span className="form__hint" id="ps-category-hint">
                    Panes, Facturas, Tortas…
                    {canNewCategory ? " Si no está, escribila y se crea." : ""}
                  </span>
                )}
                {errorText("product.categoryId", "ps-category")}
              </div>
              <div className="form__field">
                <label htmlFor="ps-unit">
                  Unidad de venta{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <select
                  id="ps-unit"
                  value={saleUnitId}
                  aria-required
                  {...errProps("product.saleUnitId", "ps-unit")}
                  onChange={(e) => chooseSaleUnit(e.target.value)}
                >
                  <option value="">Elegí…</option>
                  {catalog.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.symbol})
                    </option>
                  ))}
                </select>
                <span className="form__hint">¿Lo vendés por unidad, por kilo, por docena?</span>
                {errorText("product.saleUnitId", "ps-unit")}
              </div>
              <div className="form__field">
                <label htmlFor="ps-price">
                  Precio de venta{" "}
                  <span className="form__required" aria-hidden="true">
                    *
                  </span>
                </label>
                <div className="input-affix">
                  <span className="input-affix__text" aria-hidden="true">
                    $
                  </span>
                  <input
                    id="ps-price"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={salePrice}
                    aria-required
                    {...errProps("product.salePrice", "ps-price")}
                    onChange={(e) => setSalePrice(e.target.value)}
                  />
                  <span className="input-affix__text" aria-hidden="true">
                    / {unitLabel}
                  </span>
                </div>
                {errorText("product.salePrice", "ps-price")}
              </div>
              <div className="form__field form__field--check">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={controlsStock}
                    onChange={(e) => setControlsStock(e.target.checked)}
                  />
                  <span>
                    Lleva stock
                    <span className="form__hint">
                      Se produce y se cuenta. Destildalo para servicios o cosas que no se guardan.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <details className="more">
              <summary>Más datos (opcional): código, descripción, foto</summary>
              <div className="form-grid">
                <div className="form__field">
                  <label htmlFor="ps-code">Código</label>
                  <input
                    id="ps-code"
                    autoComplete="off"
                    placeholder="Se genera solo"
                    value={code}
                    {...errProps("product.code", "ps-code")}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  {errorText("product.code", "ps-code")}
                </div>
                <div className="form__field">
                  <label htmlFor="ps-image">Foto (dirección web)</label>
                  <input
                    id="ps-image"
                    type="url"
                    autoComplete="off"
                    placeholder="https://…"
                    value={imageUrl}
                    {...errProps("product.imageUrl", "ps-image")}
                    onChange={(e) => setImageUrl(e.target.value)}
                  />
                  {errorText("product.imageUrl", "ps-image")}
                </div>
                <div className="form__field form__field--full">
                  <label htmlFor="ps-description">Descripción</label>
                  <textarea
                    id="ps-description"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
            </details>
          </Step>

          {canRecipe && (
            <Step
              n={2}
              id="step-recipe"
              title="¿Con qué se hace?"
              hint="La receta de una tanda. Si un insumo no existe, escribilo y se crea acá mismo."
              aside={
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={withRecipe}
                    onChange={(e) => setWithRecipe(e.target.checked)}
                  />
                  <span>Tiene receta</span>
                </label>
              }
            >
              {!withRecipe ? (
                <p className="muted">
                  Sin receta: sirve para productos de reventa. Podés cargarla después desde el
                  producto.
                </p>
              ) : (
                <>
                  <div className="yield-row">
                    <label htmlFor="ps-yield">Con esta receta salen</label>
                    <input
                      id="ps-yield"
                      className="yield-row__qty"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="Ej.: 24"
                      value={yieldQuantity}
                      {...errProps("recipe.yieldQuantity", "ps-yield")}
                      onChange={(e) => setYieldQuantity(e.target.value)}
                    />
                    <select
                      aria-label="Unidad de lo que sale"
                      value={yieldUnitId}
                      disabled={!saleUnit}
                      {...errProps("recipe.yieldUnitId", "ps-yield-unit")}
                      onChange={(e) => setYieldUnitId(e.target.value)}
                    >
                      {yieldUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name.toLowerCase()} ({u.symbol})
                        </option>
                      ))}
                    </select>
                    {errorText("recipe.yieldQuantity", "ps-yield")}
                  </div>

                  <ol className="ingredients" aria-label="Ingredientes">
                    {lines.map((line, index) => {
                      const base = lineBase(line);
                      const nm = line.newRef
                        ? newMaterials.find((m) => m.ref === line.newRef)
                        : undefined;
                      const m = line.materialId ? materialById.get(line.materialId) : undefined;
                      const cost = lineCost(line);
                      const n = index + 1;
                      const value = line.newRef ? `nuevo:${line.newRef}` : line.materialId;
                      return (
                        <li key={line.key} className={`ingredient ${nm ? "ingredient--new" : ""}`}>
                          <div className="ingredient__row">
                            <div className="ingredient__material">
                              <Combobox
                                ariaLabel={`Insumo ${n}`}
                                options={materialOptions}
                                value={value}
                                placeholder="Harina, manteca, huevos…"
                                invalid={Boolean(err(`line.${index}.material`))}
                                onChange={(v) => chooseMaterial(line.key, v)}
                                onCreate={
                                  canNewMaterial ? (t) => createMaterial(line.key, t) : undefined
                                }
                                createLabel={(t) => `Crear el insumo «${t}»`}
                                emptyText={
                                  canNewMaterial
                                    ? "Escribí el nombre para crearlo"
                                    : "Sin coincidencias"
                                }
                              />
                              {err(`line.${index}.material`) && (
                                <span className="form__error">{err(`line.${index}.material`)}</span>
                              )}
                            </div>
                            <input
                              className="ingredient__qty"
                              aria-label={`Cantidad ${n}`}
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="Cant."
                              value={line.quantity}
                              aria-invalid={err(`line.${index}.quantity`) ? true : undefined}
                              onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                            />
                            <select
                              className="ingredient__unit"
                              aria-label={`Unidad ${n}`}
                              value={line.unitId}
                              disabled={!base}
                              aria-invalid={err(`line.${index}.unit`) ? true : undefined}
                              onChange={(e) => setLine(line.key, { unitId: e.target.value })}
                            >
                              <option value="">—</option>
                              {compatible(base).map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.symbol}
                                </option>
                              ))}
                            </select>
                            <span className="ingredient__cost num" aria-label={`Costo ${n}`}>
                              {cost ? (
                                formatMoney(cost, currency)
                              ) : m && m.effectiveCost === null ? (
                                <span className="badge badge--warn">Sin costo</span>
                              ) : (
                                "—"
                              )}
                            </span>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Quitar ingrediente ${n}`}
                              onClick={() => removeLine(line.key)}
                            >
                              <Icon name="close" size="sm" />
                            </button>
                          </div>
                          {(err(`line.${index}.quantity`) || err(`line.${index}.unit`)) && (
                            <span className="form__error">
                              {err(`line.${index}.quantity`) ?? err(`line.${index}.unit`)}
                            </span>
                          )}
                          {m && m.effectiveCost === null && canMaterialCost && (
                            <div
                              className="ingredient__new ingredient__new--cost"
                              role="group"
                              aria-label={`Costo de ${m.name}`}
                            >
                              <span className="ingredient__new-tag ingredient__new-tag--warn">
                                <Icon name="alert" size="sm" /> Sin costo cargado
                              </span>
                              <label>
                                <span>Me cuesta</span>
                                <span className="input-affix input-affix--small">
                                  <span className="input-affix__text" aria-hidden="true">
                                    $
                                  </span>
                                  <input
                                    inputMode="decimal"
                                    autoComplete="off"
                                    placeholder="¿?"
                                    aria-label={`Costo de ${m.name} por ${m.baseUnit.symbol}`}
                                    value={existingCosts[m.id] ?? ""}
                                    aria-invalid={err(`cost.${m.id}`) ? true : undefined}
                                    onChange={(e) =>
                                      setExistingCosts((c) => ({ ...c, [m.id]: e.target.value }))
                                    }
                                  />
                                  <span className="input-affix__text" aria-hidden="true">
                                    / {m.baseUnit.symbol}
                                  </span>
                                </span>
                              </label>
                              <span className="muted small">Se guarda en la materia prima.</span>
                              {err(`cost.${m.id}`) && (
                                <span className="form__error">{err(`cost.${m.id}`)}</span>
                              )}
                            </div>
                          )}
                          {nm && (
                            <div
                              className="ingredient__new"
                              role="group"
                              aria-label={`Insumo nuevo: ${nm.name}`}
                            >
                              <span className="ingredient__new-tag">
                                <Icon name="plus" size="sm" /> Insumo nuevo
                              </span>
                              <label>
                                <span>Se mide en</span>
                                <select
                                  value={nm.baseUnitId}
                                  aria-label={`Unidad de ${nm.name}`}
                                  onChange={(e) =>
                                    setNewMaterial(nm.ref, { baseUnitId: e.target.value })
                                  }
                                >
                                  {rootUnits.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name.toLowerCase()} ({u.symbol})
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {canMaterialCost && (
                                <label>
                                  <span>Me cuesta</span>
                                  <span className="input-affix input-affix--small">
                                    <span className="input-affix__text" aria-hidden="true">
                                      $
                                    </span>
                                    <input
                                      inputMode="decimal"
                                      autoComplete="off"
                                      placeholder="¿?"
                                      aria-label={`Costo de ${nm.name} por ${unitById.get(nm.baseUnitId)?.symbol ?? "unidad"}`}
                                      value={nm.cost}
                                      aria-invalid={err(`new.${nm.ref}.cost`) ? true : undefined}
                                      onChange={(e) =>
                                        setNewMaterial(nm.ref, { cost: e.target.value })
                                      }
                                    />
                                    <span className="input-affix__text" aria-hidden="true">
                                      / {unitById.get(nm.baseUnitId)?.symbol ?? ""}
                                    </span>
                                  </span>
                                </label>
                              )}
                              <label>
                                <span>Categoría</span>
                                <select
                                  aria-label={`Categoría de ${nm.name}`}
                                  value={nm.categoryId || "__new__"}
                                  onChange={(e) =>
                                    setNewMaterial(
                                      nm.ref,
                                      e.target.value === "__new__"
                                        ? {
                                            categoryId: "",
                                            newCategoryName: nm.newCategoryName || "Insumos",
                                          }
                                        : { categoryId: e.target.value },
                                    )
                                  }
                                >
                                  {catalog.materialCategories
                                    .filter((c) => c.active)
                                    .map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}
                                      </option>
                                    ))}
                                  {canNewCategory && (
                                    <option value="__new__">
                                      Nueva: {nm.newCategoryName || "Insumos"}
                                    </option>
                                  )}
                                </select>
                              </label>
                              {err(`new.${nm.ref}.cost`) && (
                                <span className="form__error">{err(`new.${nm.ref}.cost`)}</span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setLines((ls) => [...ls, emptyLine()])}
                  >
                    <Icon name="plus" size="sm" />
                    Agregar ingrediente
                  </button>

                  <details className="more">
                    <summary>Merma e instrucciones (opcional)</summary>
                    <div className="form-grid">
                      <div className="form__field">
                        <label htmlFor="ps-waste">Merma teórica (%)</label>
                        <input
                          id="ps-waste"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="Opcional"
                          value={wastePercentage}
                          {...errProps("recipe.wastePercentage", "ps-waste")}
                          onChange={(e) => setWastePercentage(e.target.value)}
                        />
                        {errorText("recipe.wastePercentage", "ps-waste")}
                      </div>
                      <div className="form__field form__field--full">
                        <label htmlFor="ps-instructions">Cómo se hace</label>
                        <textarea
                          id="ps-instructions"
                          rows={3}
                          value={instructions}
                          onChange={(e) => setInstructions(e.target.value)}
                        />
                      </div>
                    </div>
                  </details>
                  {canPublish && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={publish}
                        onChange={(e) => setPublish(e.target.checked)}
                      />
                      <span>
                        Dejar la receta lista para producir
                        <span className="form__hint">
                          Si la destildás queda como borrador para revisarla después.
                        </span>
                      </span>
                    </label>
                  )}
                </>
              )}
            </Step>
          )}

          {catalog.priceLists.length > 0 && (
            <Step
              n={canRecipe ? 3 : 2}
              id="step-prices"
              title="¿A cuánto lo vendés en cada lista?"
              hint="Por defecto, el mismo precio de venta. Cambialo donde sea distinto (mayoristas, revendedores…)."
            >
              {!canPrices && (
                <p className="muted small">
                  Tu rol no modifica listas de precios: se venderá al precio de venta.
                </p>
              )}
              <ul className="price-rows">
                {catalog.priceLists.map((l) => {
                  const row = prices[l.id]!;
                  return (
                    <li key={l.id} className={`price-row ${row.checked ? "price-row--on" : ""}`}>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={row.checked}
                          disabled={!canPrices}
                          onChange={(e) => setPrice(l.id, { checked: e.target.checked })}
                        />
                        <span>
                          {l.name}
                          {l.isDefault && <span className="badge badge--tag">General</span>}
                        </span>
                      </label>
                      <span className="input-affix input-affix--small">
                        <span className="input-affix__text" aria-hidden="true">
                          $
                        </span>
                        <input
                          inputMode="decimal"
                          autoComplete="off"
                          aria-label={`Precio en ${l.name}`}
                          disabled={!row.checked}
                          placeholder={salePrice || "0"}
                          value={priceFor(l.id)}
                          aria-invalid={err(`price.${l.id}`) ? true : undefined}
                          onChange={(e) => setPrice(l.id, { price: e.target.value, touched: true })}
                        />
                      </span>
                      {err(`price.${l.id}`) && (
                        <span className="form__error">{err(`price.${l.id}`)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Step>
          )}
        </div>

        <aside className="setup__summary" aria-label="Resumen">
          <div className="ticket">
            <div className="ticket__head">
              <span className="ticket__eyebrow">
                {newCategory ||
                  catalog.productCategories.find((c) => c.id === categoryId)?.name ||
                  "Producto nuevo"}
              </span>
              <strong className="ticket__name">{name.trim() || "Sin nombre todavía"}</strong>
            </div>
            <dl className="ticket__figures" aria-live="polite">
              <div>
                <dt>Te cuesta hacerlo</dt>
                <dd>
                  {unitCost !== null ? (
                    <>
                      {formatMoney(live!.unitCost, currency)}
                      <small> / {unitLabel}</small>
                    </>
                  ) : partialUnitCost !== null ? (
                    <span className="ticket__partial">
                      más de {formatMoney(partialUnitCost.toFixed(2), currency)}
                      <small> / {unitLabel}</small>
                    </span>
                  ) : (
                    <span className="muted">{recipeOn ? "Cargá la receta" : "—"}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Lo vendés a</dt>
                <dd>
                  {price !== null ? (
                    <>
                      {formatMoney(String(price), currency)}
                      <small> / {unitLabel}</small>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
              <div className={`ticket__profit ticket__profit--${marginTone}`}>
                <dt>Te queda</dt>
                <dd>
                  {profit !== null ? (
                    <>
                      {formatMoney(String(profit), currency)}
                      {marginPct && <small> ({formatPercent(marginPct)})</small>}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
              </div>
            </dl>
            {profit !== null && price !== null && price > 0 && (
              <div className="margin-bar" aria-hidden="true">
                <span
                  className={`margin-bar__fill margin-bar__fill--${marginTone}`}
                  style={{ width: `${Math.max(0, Math.min(100, (profit / price) * 100))}%` }}
                />
              </div>
            )}
            {incomplete && (
              <div className="ticket__warn" role="status">
                <strong>Falta el costo de:</strong>{" "}
                {live!.missingCosts.map((m) => m.rawMaterialName).join(", ")}. Escribí cuánto te
                cuestan en la receta para ver la ganancia.
                {recipeOn && publish && canPublish && (
                  <label className="check check--small">
                    <input
                      type="checkbox"
                      checked={acknowledge}
                      onChange={(e) => setAcknowledge(e.target.checked)}
                    />
                    <span>Dejarla lista igual (cargo el costo después)</span>
                  </label>
                )}
              </div>
            )}
            {willCreate.length > 0 && (
              <div className="ticket__list">
                <span className="ticket__eyebrow">Al guardar también se crea</span>
                <ul>
                  {willCreate.map((w) => (
                    <li key={w}>
                      <Icon name="check" size="sm" /> {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <div className="alert" role="alert" ref={errorRef} tabIndex={-1}>
                {error}
              </div>
            )}
            <button
              type="submit"
              className="button button--primary button--block button--large"
              disabled={pending}
            >
              {pending ? "Guardando…" : "Crear producto"}
            </button>
            <Link className="button button--tertiary button--block" href="/productos">
              Cancelar
            </Link>
          </div>
        </aside>
      </form>
    </div>
  );
}

function successMessage(r: ProductSetupResultDto): string {
  const parts = [`«${r.product.name}» (${r.product.code}) creado`];
  if (r.recipe)
    parts.push(r.recipe.published ? "con receta lista para producir" : "con receta en borrador");
  if (r.prices.length > 0)
    parts.push(
      r.prices.length === 1 ? "y precio en 1 lista" : `y precio en ${r.prices.length} listas`,
    );
  return `${parts.join(" ")}.`;
}

/** Traduce los errores de la API (rutas del cuerpo enviado) a los campos de la pantalla. */
function mapServerErrors(
  errors: Record<string, string>,
  sent: Line[],
  all: Line[],
  sentMaterials: NewMaterial[],
  lists: PriceListDto[],
  sentCosts: [string, string][],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    let m = /^recipe\.(?:version\.)?ingredients\.(\d+)\.(\w+)/.exec(path);
    if (m) {
      const line = sent[Number(m[1])];
      const i = line ? all.indexOf(line) : -1;
      const field = m[2] === "quantity" ? "quantity" : m[2] === "unitId" ? "unit" : "material";
      out[`line.${i}.${field}`] = message;
      continue;
    }
    m = /^recipe\.(?:version\.)?(\w+)/.exec(path);
    if (m) {
      out[`recipe.${m[1]}`] = message;
      continue;
    }
    m = /^newMaterials\.(\d+)\.(\w+)/.exec(path);
    if (m) {
      const nm = sentMaterials[Number(m[1])];
      if (nm) out[`new.${nm.ref}.${m[2] === "referenceCost" ? "cost" : "unit"}`] = message;
      continue;
    }
    m = /^materialCosts\.(\d+)/.exec(path);
    if (m) {
      const entry = sentCosts[Number(m[1])];
      if (entry) out[`cost.${entry[0]}`] = message;
      continue;
    }
    m = /^prices\.(\d+)/.exec(path);
    if (m) {
      const list = lists[Number(m[1])];
      if (list) out[`price.${list.id}`] = message;
      continue;
    }
    out[path] = message;
  }
  return out;
}
