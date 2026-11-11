import { z } from "zod";
import { createProductSchema } from "./masters";
import { recipeQuantitySchema, wastePercentageSchema, MAX_RECIPE_INGREDIENTS } from "./recipes";
import {
  moneySchema,
  optionalText,
  optionalUnitCostSchema,
  decimalString,
  optionalUuid,
  requiredText,
  uuid,
} from "./validation";

/*
 * Alta de producto "de corrido" (rediseño de la carga diaria). En una sola
 * operación atómica se puede: crear la categoría si no existe, dar de alta los
 * insumos nuevos, crear el producto, su receta (y publicarla) y fijar su precio
 * en las listas de precios. Pensado para quien viene del papel o de un Excel:
 * una pantalla, un botón, y si algo falla no queda nada a medias.
 *
 * Cada parte exige su propio permiso (la API lo verifica): crear categorías,
 * insumos, recetas, publicarlas y tocar listas de precios.
 */

/** Categoría existente (`categoryId`) o nueva por nombre (se reutiliza si ya existe). */
const categoryChoice = {
  categoryId: optionalUuid(),
  newCategoryName: optionalText(80),
};

const needsCategory = (v: { categoryId: string | null; newCategoryName: string | null }) =>
  v.categoryId !== null || v.newCategoryName !== null;

export const MAX_SETUP_NEW_MATERIALS = 50;

/** Costo por unidad base (numeric(18,6)), obligatorio. */
const unitCostSchema = () => decimalString({ integers: 12, scale: 6 });

export const productSetupNewMaterialSchema = z
  .object({
    /** Referencia local (de la pantalla) para usarlo en los ingredientes. */
    ref: z.string().trim().min(1).max(40),
    name: requiredText(),
    baseUnitId: uuid(),
    ...categoryChoice,
    referenceCost: optionalUnitCostSchema(),
  })
  .refine(needsCategory, { message: "Elegí o escribí una categoría", path: ["categoryId"] });

export const productSetupIngredientSchema = z
  .object({
    rawMaterialId: optionalUuid(),
    newMaterialRef: optionalText(40),
    quantity: recipeQuantitySchema(),
    unitId: uuid(),
  })
  .refine((v) => (v.rawMaterialId === null) !== (v.newMaterialRef === null), {
    message: "Elegí un insumo",
    path: ["rawMaterialId"],
  });

export const productSetupSchema = z.object({
  product: createProductSchema
    .omit({ categoryId: true })
    .extend(categoryChoice)
    .refine(needsCategory, { message: "Elegí o escribí una categoría", path: ["categoryId"] }),
  newMaterials: z.array(productSetupNewMaterialSchema).max(MAX_SETUP_NEW_MATERIALS).default([]),
  /** Costo para insumos que ya existen y no tenían costo (o se corrige en el momento). */
  materialCosts: z
    .array(z.object({ rawMaterialId: uuid(), referenceCost: unitCostSchema() }))
    .max(MAX_RECIPE_INGREDIENTS)
    .default([]),
  /** Sin receta: el producto se crea igual (p. ej. reventa o receta para después). */
  recipe: z
    .object({
      yieldQuantity: recipeQuantitySchema(),
      yieldUnitId: uuid(),
      wastePercentage: wastePercentageSchema(),
      instructions: optionalText(10_000),
      ingredients: z
        .array(productSetupIngredientSchema)
        .min(1, "Agregá al menos un ingrediente")
        .max(MAX_RECIPE_INGREDIENTS),
      /** Publicar = la receta queda vigente y lista para producir. */
      publish: z.boolean().default(true),
      acknowledgeIncompleteCost: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  /** Precio en cada lista de precios elegida. */
  prices: z
    .array(z.object({ priceListId: uuid(), unitPrice: moneySchema() }))
    .max(50)
    .default([]),
});
export type ProductSetupInput = z.infer<typeof productSetupSchema>;

export interface ProductSetupResultDto {
  product: { id: string; code: string; name: string };
  category: { id: string; name: string; created: boolean };
  newMaterials: { ref: string; id: string; code: string; name: string }[];
  recipe: {
    id: string;
    versionId: string;
    published: boolean;
    costStatus: "COMPLETE" | "INCOMPLETE" | null;
  } | null;
  prices: { priceListId: string; unitPrice: string }[];
}
