import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * Fase 2: recetas, versiones y costo teórico (flujo principal de 23 pasos y
 * flujo de costo incompleto) contra la aplicación construida y la base de
 * desarrollo con seed. Cada corrida usa nombres únicos, así puede repetirse.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

async function openSection(page: Page, name: string) {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

/** Elige en un select la opción cuyo texto contiene `text`. */
async function selectByText(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value ?? "");
}

/** Valor (dd) de un rótulo (dt) del resumen de costos dentro de `scope`. */
function costValue(scope: Locator, label: string | RegExp): Locator {
  return scope
    .locator("dl.cost-summary > div")
    .filter({ has: scope.page().locator("dt", { hasText: label }) })
    .locator("dd");
}

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${msg.location().url}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
}

async function createCategory(page: Page, type: "RAW_MATERIAL" | "PRODUCT", name: string) {
  await page.goto("/configuracion/categorias/nuevo");
  await page.getByLabel("Tipo").selectOption(type);
  await page.getByLabel("Nombre").fill(name);
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function createRawMaterial(
  page: Page,
  opts: { name: string; category: string; unit: string; cost?: string },
) {
  await openSection(page, "Materias primas");
  await page.getByRole("link", { name: "Nueva materia prima" }).click();
  await page.getByLabel("Nombre").fill(opts.name);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), opts.category);
  await selectByText(page.getByRole("combobox", { name: "Unidad base" }), opts.unit);
  if (opts.cost) await page.getByLabel("Costo de referencia (ARS por unidad base)").fill(opts.cost);
  await page.getByRole("button", { name: "Crear materia prima" }).click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();
}

async function changeReferenceCost(page: Page, unitSymbol: string, cost: string) {
  await page.getByRole("button", { name: "Cambiar costo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(`Costo por ${unitSymbol} (ARS)`).fill(cost);
  await dialog.getByRole("button", { name: "Guardar costo" }).click();
  await expect(dialog).toBeHidden();
}

async function createProduct(
  page: Page,
  opts: { name: string; category: string; unit: string; price: string },
) {
  await openSection(page, "Productos");
  await page.getByRole("link", { name: "Nuevo producto" }).click();
  await page.getByLabel("Nombre").fill(opts.name);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), opts.category);
  await selectByText(page.getByRole("combobox", { name: "Unidad de venta" }), opts.unit);
  await page.getByLabel("Precio de venta").fill(opts.price);
  await page.getByRole("button", { name: "Crear producto" }).click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();
}

async function openRecipe(page: Page, productName: string, run: string) {
  await openSection(page, "Recetas");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(run);
  await page.getByRole("link", { name: productName }).click();
  await expect(page.getByRole("heading", { name: "Historial de versiones" })).toBeVisible();
}

async function publishFromDetail(page: Page, opts?: { acknowledgeIncomplete?: boolean }) {
  await page.getByRole("button", { name: "Publicar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  if (opts?.acknowledgeIncomplete) {
    await expect(dialog.getByText("Costo teórico incompleto.")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Publicar igual, con el costo incompleto" }).check();
  }
  await dialog.getByRole("button", { name: "Publicar versión" }).click();
  await expect(dialog).toBeHidden();
}

function versionRow(page: Page, versionNumber: number): Locator {
  return page
    .locator("section", { has: page.getByRole("heading", { name: "Historial de versiones" }) })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: `v${versionNumber}`, exact: true }) });
}

test("Fase 2: receta, publicación, cambio de costo y nueva versión", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  const harina = `Harina ${run}`;
  const sal = `Sal ${run}`;
  const pan = `Pan francés ${run}`;

  // 1. Login
  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Secos ${run}`);
  await createCategory(page, "PRODUCT", `Panes ${run}`);

  // 2. Materia prima Harina (sin costo al crearla)…
  await createRawMaterial(page, { name: harina, category: `Secos ${run}`, unit: "Kilogramo" });
  await expect(page.getByText("Sin costo cargado")).toBeVisible();
  // 3. …y luego se le asigna el costo de referencia
  await changeReferenceCost(page, "kg", "800");
  await expect(page.getByText("$800,00 / kg", { exact: true })).toBeVisible();

  // 4–5. Materia prima Sal, con costo desde el alta
  await createRawMaterial(page, {
    name: sal,
    category: `Secos ${run}`,
    unit: "Kilogramo",
    cost: "500",
  });
  await expect(page.getByText("$500,00 / kg", { exact: true })).toBeVisible();

  // 6. Producto Pan francés, vendido por kg a $1.200
  await createProduct(page, {
    name: pan,
    category: `Panes ${run}`,
    unit: "Kilogramo",
    price: "1200",
  });

  // 7. Recetas
  await openSection(page, "Recetas");
  await expect(page.getByRole("heading", { level: 1, name: "Recetas" })).toBeVisible();

  // 8. Nueva receta para el producto
  await page.getByRole("link", { name: "Nueva receta" }).click();
  await selectByText(page.getByRole("combobox", { name: "Producto" }), pan);
  // 9. Rendimiento: 100 kg (la unidad se propone igual a la de venta)
  await page.getByRole("textbox", { name: "Rendimiento" }).fill("100");
  await expect(page.getByRole("combobox", { name: "Unidad del rendimiento" })).toHaveValue(/.+/);

  // 10. Ingredientes: 75 kg de harina + 800 g de sal
  await selectByText(page.getByRole("combobox", { name: "Materia prima 1" }), harina);
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill("75");
  await page.getByRole("button", { name: "Agregar ingrediente" }).click();
  await selectByText(page.getByRole("combobox", { name: "Materia prima 2" }), sal);
  await page.getByRole("textbox", { name: "Cantidad 2" }).fill("800");
  await page.getByRole("combobox", { name: "Unidad 2" }).selectOption({ label: "g" });

  // 11. Costo calculado en vivo: 75 × 800 + 0,8 × 500 = 60.400 → 604 $/kg
  const editorCost = page.locator("section", {
    has: page.getByRole("heading", { name: "3. Costo teórico" }),
  });
  await expect(costValue(editorCost, "Costo del lote")).toHaveText("$60.400,00");
  await expect(costValue(editorCost, /^Costo por kg/)).toHaveText("$604,00 / kg");
  await expect(costValue(editorCost, "Margen bruto teórico")).toHaveText("$596,00 (49,67 %)");

  // 12. Guardar como borrador
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("heading", { level: 1, name: pan })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Borrador · versión 1/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sin versión vigente" })).toBeVisible();

  // 13. Publicar
  await publishFromDetail(page);

  // 14. Versión vigente
  await expect(page.getByRole("heading", { name: /Versión vigente · v1/ })).toBeVisible();
  await expect(versionRow(page, 1)).toContainText("Vigente");
  await expect(versionRow(page, 1)).toContainText("$604,00 / kg");

  // 15. Cambiar el costo de la harina: 800 → 1.000
  await openSection(page, "Materias primas");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(harina);
  await page.getByRole("link", { name: harina }).click();
  await changeReferenceCost(page, "kg", "1000");
  await expect(page.getByText("$1.000,00 / kg", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Costo de referencia: $800,00 / kg → $1.000,00 / kg" }),
  ).toBeVisible();

  // 16. El costo guardado al publicar no cambia…
  await openRecipe(page, pan, run);
  const active = page.locator("section", {
    has: page.getByRole("heading", { name: /Versión vigente · v1/ }),
  });
  await expect(costValue(active, "Costo por kg al publicar")).toContainText("$604,00 / kg");
  await expect(versionRow(page, 1)).toContainText("$604,00 / kg");
  // 17. …y el costo actual se recalcula: 75 × 1.000 + 400 = 75.400 → 754 $/kg (+24,83 %)
  await expect(costValue(active, "Costo por kg (actual)")).toHaveText("$754,00 / kg");
  await expect(costValue(active, "Costo por kg al publicar")).toContainText("+24,83 %");

  // 18. Nueva versión (copia de la vigente)
  await page.getByRole("button", { name: "Nueva versión" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Crear borrador" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Editar borrador/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Cantidad 1" })).toHaveValue("75");

  // 19. Modificar cantidades: 80 kg de harina
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill("80");
  await expect(costValue(editorCost, /^Costo por kg/)).toHaveText("$804,00 / kg");
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("heading", { name: /Borrador · versión 2/ })).toBeVisible();

  // 20. Publicar la versión 2
  await publishFromDetail(page);
  await expect(page.getByRole("heading", { name: /Versión vigente · v2/ })).toBeVisible();

  // 21. v1 archivada, 22. v2 vigente
  await expect(versionRow(page, 1)).toContainText("Archivada");
  await expect(versionRow(page, 1)).toContainText("$604,00 / kg");
  await expect(versionRow(page, 2)).toContainText("Vigente");
  await expect(versionRow(page, 2)).toContainText("$804,00 / kg");

  // La versión 1 se puede consultar, en sólo lectura, con sus cambios respecto de v2
  await versionRow(page, 1).getByRole("link", { name: "v1" }).click();
  await expect(page.getByText("Archivada", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publicar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Editar" })).toHaveCount(0);
  await page.goBack();
  await versionRow(page, 2).getByRole("link", { name: "v2" }).click();
  await expect(page.getByText(`Cantidad: ${harina} 75 kg → 80 kg`)).toBeVisible();

  // 23. Auditoría: la receta y el costo de referencia dejan rastro
  await openRecipe(page, pan, run);
  const history = page.locator("section", {
    has: page.getByRole("heading", { name: "Historial", exact: true }),
  });
  await expect(history.getByRole("cell", { name: "Versión publicada" }).first()).toBeVisible();
  await expect(history.getByRole("cell", { name: "Versión archivada" }).first()).toBeVisible();
  await expect(history.getByRole("cell", { name: "Versión creada" }).first()).toBeVisible();
  await expect(history.getByRole("cell", { name: "Receta creada" })).toBeVisible();
  await openSection(page, "Auditoría");
  await page.getByLabel("Módulo").selectOption("raw_material");
  await expect(
    page.getByRole("cell", { name: "Costo de referencia modificado" }).first(),
  ).toBeVisible();

  // Sin errores de consola en todo el recorrido
  expect(consoleErrors).toEqual([]);
});

test("Fase 2: receta con costo incompleto", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  const queso = `Queso ${run}`;
  const pizza = `Prepizza ${run}`;

  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Lácteos ${run}`);
  await createCategory(page, "PRODUCT", `Pizzas ${run}`);
  // Ingrediente sin costo de referencia
  await createRawMaterial(page, { name: queso, category: `Lácteos ${run}`, unit: "Kilogramo" });
  await createProduct(page, {
    name: pizza,
    category: `Pizzas ${run}`,
    unit: "Unidad",
    price: "900",
  });

  await openSection(page, "Recetas");
  await page.getByRole("link", { name: "Nueva receta" }).click();
  await selectByText(page.getByRole("combobox", { name: "Producto" }), pizza);
  await page.getByRole("textbox", { name: "Rendimiento" }).fill("20");
  await selectByText(page.getByRole("combobox", { name: "Materia prima 1" }), queso);
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill("2");

  // La UI lo dice claramente, sin $0 ni margen inventado
  const editorCost = page.locator("section", {
    has: page.getByRole("heading", { name: "3. Costo teórico" }),
  });
  await expect(editorCost.getByText("Costo teórico incompleto.")).toBeVisible();
  await expect(editorCost.getByRole("listitem").filter({ hasText: queso })).toBeVisible();
  await expect(costValue(editorCost, "Costo del lote")).toHaveText("Incompleto");
  await expect(costValue(editorCost, /^Costo por u/)).toHaveText("Incompleto");
  await expect(costValue(editorCost, "Margen bruto teórico")).toHaveText("—");
  await expect(editorCost).not.toContainText("$0");

  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("heading", { name: /Borrador · versión 1/ })).toBeVisible();
  const draft = page.locator("section", {
    has: page.getByRole("heading", { name: /Borrador · versión 1/ }),
  });
  await expect(draft.getByText("Costo teórico incompleto.")).toBeVisible();
  await expect(costValue(draft, "Margen bruto teórico")).toHaveText("—");

  // Se puede publicar, pero sólo con advertencia y confirmación explícita
  await page.getByRole("button", { name: "Publicar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Costo teórico incompleto.")).toBeVisible();
  await dialog.getByRole("button", { name: "Publicar versión" }).click();
  await expect(dialog.getByRole("alert")).toContainText("incompleto");
  await dialog.getByRole("checkbox", { name: "Publicar igual, con el costo incompleto" }).check();
  await dialog.getByRole("button", { name: "Publicar versión" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /Versión vigente · v1/ })).toBeVisible();
  await expect(versionRow(page, 1)).toContainText("Incompleto");
  await expect(page.locator("main")).not.toContainText("$0,00");

  // El listado marca el costo incompleto
  await openSection(page, "Recetas");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(run);
  const row = page.getByRole("row").filter({ hasText: pizza });
  await expect(row).toContainText("Costo incompleto");
  await expect(row).not.toContainText("$0");

  // El único error de red esperado es el 409 del primer intento sin confirmación
  expect(consoleErrors.filter((e) => !(e.includes("/publish") && e.includes("409")))).toEqual([]);
});
