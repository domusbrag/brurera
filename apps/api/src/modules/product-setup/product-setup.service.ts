import { categories, type Database, type Transaction } from "@bakery/database";
import {
  PERMISSIONS as P,
  type PermissionCode,
  type ProductSetupInput,
  type ProductSetupResultDto,
} from "@bakery/shared";
import { and, eq, sql } from "drizzle-orm";
import type { OperationContext } from "../../lib/context.js";
import { AppError } from "../../lib/errors.js";
import { createCategory } from "../categories/categories.service.js";
import { setPriceListItem } from "../price-lists/price-lists.service.js";
import { createProduct } from "../products/products.service.js";
import { createRawMaterial, setReferenceCost } from "../raw-materials/raw-materials.service.js";
import { createRecipe, publishVersion } from "../recipes/recipes.service.js";

/*
 * Alta de producto de corrido: categoría → insumos nuevos → producto → receta
 * (publicada) → precios en listas, en UNA transacción. Reutiliza los servicios
 * de cada módulo (mismas validaciones, mismos códigos automáticos y la misma
 * auditoría que si se cargara pantalla por pantalla); cada uno corre como
 * savepoint dentro de la transacción de afuera, así que cualquier error revierte
 * todo y no quedan productos sin receta ni insumos huérfanos.
 */

const PERMISSION_LABELS: Partial<Record<PermissionCode, string>> = {
  [P.CATEGORIES_MANAGE]: "crear categorías",
  [P.RAW_MATERIALS_CREATE]: "crear materias primas",
  [P.RAW_MATERIALS_UPDATE_COST]: "cargar costos de materias primas",
  [P.RECIPES_CREATE]: "crear recetas",
  [P.RECIPES_PUBLISH]: "publicar recetas",
  [P.PRICE_LISTS_MANAGE]: "modificar listas de precios",
};

/** Permisos que exige este alta en particular (además de products.create). */
export function requiredPermissions(input: ProductSetupInput): PermissionCode[] {
  const needed = new Set<PermissionCode>();
  if (input.product.categoryId === null || input.newMaterials.some((m) => m.categoryId === null)) {
    needed.add(P.CATEGORIES_MANAGE);
  }
  if (input.newMaterials.length > 0) needed.add(P.RAW_MATERIALS_CREATE);
  if (input.newMaterials.some((m) => m.referenceCost !== null) || input.materialCosts.length > 0) {
    needed.add(P.RAW_MATERIALS_UPDATE_COST);
  }
  if (input.recipe) {
    needed.add(P.RECIPES_CREATE);
    if (input.recipe.publish) needed.add(P.RECIPES_PUBLISH);
  }
  if (input.prices.length > 0) needed.add(P.PRICE_LISTS_MANAGE);
  return [...needed];
}

export function assertSetupPermissions(input: ProductSetupInput, granted: Iterable<string>) {
  const have = new Set(granted);
  const missing = requiredPermissions(input).filter((p) => !have.has(p));
  if (missing.length > 0) {
    throw new AppError(
      403,
      "FORBIDDEN",
      `Tu rol no permite ${missing.map((p) => PERMISSION_LABELS[p] ?? p).join(", ")}.`,
    );
  }
}

/** Reescribe las rutas de error de un servicio para que apunten al campo de esta pantalla. */
async function scoped<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError && Array.isArray(err.details)) {
      throw new AppError(
        err.statusCode,
        err.code,
        err.message,
        (err.details as { path?: string; message: string }[]).map((d) => ({
          ...d,
          path: d.path ? `${prefix}.${d.path}` : prefix,
        })),
      );
    }
    throw err;
  }
}

const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ");

/**
 * Categoría por nombre: si ya existe una con ese nombre (sin distinguir
 * mayúsculas) se usa esa; si no, se crea. Una categoría desactivada no se
 * reutiliza en silencio: se avisa.
 */
async function categoryByName(
  tx: Transaction,
  ctx: OperationContext,
  type: "PRODUCT" | "RAW_MATERIAL",
  rawName: string,
  path: string,
  cache: Map<string, { id: string; name: string; created: boolean }>,
) {
  const name = normalizeName(rawName);
  const key = `${type}:${name.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const [existing] = await tx
    .select({ id: categories.id, name: categories.name, active: categories.active })
    .from(categories)
    .where(
      and(
        eq(categories.companyId, ctx.companyId),
        eq(categories.type, type),
        sql`lower(${categories.name}) = ${name.toLowerCase()}`,
      ),
    );
  if (existing && !existing.active) {
    throw new AppError(
      409,
      "CATEGORY_INACTIVE",
      `La categoría «${existing.name}» está desactivada. Reactivala en Configuración o elegí otra.`,
      [{ path, message: "Categoría desactivada" }],
    );
  }
  const result = existing
    ? { id: existing.id, name: existing.name, created: false }
    : await scoped(path, async () => {
        const row = await createCategory(tx, ctx, { type, name, description: null, sortOrder: 0 });
        return { id: row.id, name: row.name, created: true };
      });
  cache.set(key, result);
  return result;
}

export async function setupProduct(
  db: Database,
  ctx: OperationContext,
  input: ProductSetupInput,
  permissions: Iterable<string>,
): Promise<ProductSetupResultDto> {
  assertSetupPermissions(input, permissions);

  const refs = new Set<string>();
  input.newMaterials.forEach((m, i) => {
    if (refs.has(m.ref)) {
      throw new AppError(400, "VALIDATION_ERROR", "Insumo nuevo repetido", [
        { path: `newMaterials.${i}.ref`, message: "Repetido" },
      ]);
    }
    refs.add(m.ref);
  });
  input.recipe?.ingredients.forEach((line, i) => {
    if (line.newMaterialRef !== null && !refs.has(line.newMaterialRef)) {
      throw new AppError(400, "VALIDATION_ERROR", "Ingrediente sin insumo", [
        { path: `recipe.ingredients.${i}.rawMaterialId`, message: "Elegí un insumo" },
      ]);
    }
  });

  return db.transaction(async (tx) => {
    const categoryCache = new Map<string, { id: string; name: string; created: boolean }>();

    // 1. Categoría del producto.
    const category =
      input.product.categoryId !== null
        ? { id: input.product.categoryId, name: "", created: false }
        : await categoryByName(
            tx,
            ctx,
            "PRODUCT",
            input.product.newCategoryName ?? "",
            "product.categoryId",
            categoryCache,
          );

    // 2. Insumos nuevos (con su categoría, existente o nueva).
    const createdMaterials: ProductSetupResultDto["newMaterials"] = [];
    const materialIdByRef = new Map<string, string>();
    for (const [i, m] of input.newMaterials.entries()) {
      const categoryId =
        m.categoryId ??
        (
          await categoryByName(
            tx,
            ctx,
            "RAW_MATERIAL",
            m.newCategoryName ?? "",
            `newMaterials.${i}.categoryId`,
            categoryCache,
          )
        ).id;
      const row = await scoped(`newMaterials.${i}`, () =>
        createRawMaterial(tx, ctx, {
          code: null,
          name: normalizeName(m.name),
          description: null,
          categoryId,
          baseUnitId: m.baseUnitId,
          minimumStock: "0",
          preferredSupplierId: null,
          referenceCost: m.referenceCost,
        }),
      );
      materialIdByRef.set(m.ref, row.id);
      createdMaterials.push({ ref: m.ref, id: row.id, code: row.code, name: row.name });
    }

    // 2b. Costos cargados en el momento para insumos que ya existían.
    for (const [i, c] of input.materialCosts.entries()) {
      await scoped(`materialCosts.${i}`, () =>
        setReferenceCost(tx, ctx, c.rawMaterialId, { referenceCost: c.referenceCost }),
      );
    }

    // 3. Producto.
    const { categoryId: _c, newCategoryName: _n, ...productFields } = input.product;
    const product = await scoped("product", () =>
      createProduct(tx, ctx, { ...productFields, categoryId: category.id }),
    );

    // 4. Receta (y publicación).
    let recipe: ProductSetupResultDto["recipe"] = null;
    if (input.recipe) {
      const r = input.recipe;
      const created = await scoped("recipe", () =>
        createRecipe(tx, ctx, {
          productId: product.id,
          name: null,
          description: null,
          version: {
            yieldQuantity: r.yieldQuantity,
            yieldUnitId: r.yieldUnitId,
            wastePercentage: r.wastePercentage,
            instructions: r.instructions,
            ingredients: r.ingredients.map((line) => ({
              rawMaterialId: line.rawMaterialId ?? materialIdByRef.get(line.newMaterialRef ?? "")!,
              quantity: line.quantity,
              unitId: line.unitId,
              notes: null,
            })),
          },
        }),
      );
      const versionId = created.draftVersionId;
      if (!versionId) throw new Error("Receta creada sin versión");
      let costStatus: "COMPLETE" | "INCOMPLETE" | null = null;
      if (r.publish) {
        const published = await scoped("recipe", () =>
          publishVersion(tx, ctx, versionId, {
            acknowledgeIncompleteCost: r.acknowledgeIncompleteCost,
          }),
        );
        costStatus = published.snapshot?.status ?? null;
      }
      recipe = { id: created.id, versionId, published: r.publish, costStatus };
    }

    // 5. Precios en listas.
    for (const [i, price] of input.prices.entries()) {
      await scoped(`prices.${i}`, () =>
        setPriceListItem(
          tx,
          ctx,
          price.priceListId,
          product.id,
          { unitPrice: price.unitPrice, active: true },
          permissions,
        ),
      );
    }

    return {
      product: { id: product.id, code: product.code, name: product.name },
      category: {
        id: category.id,
        name: category.name || product.category.name,
        created: category.created,
      },
      newMaterials: createdMaterials,
      recipe,
      prices: input.prices,
    };
  });
}
