import { expect, test, type Locator, type Page } from "@playwright/test";
import { openSection, selectByText, summaryValue } from "./support";

/*
 * Fase 4: producción contra la aplicación construida y la base de desarrollo
 * con seed. Flujo principal (§75: crear, planificar, iniciar, cargar consumo
 * real con un extra, revisar, completar y ver stock/costo del producto) y flujo
 * de faltante (§76: la orden se planifica con faltante, no puede iniciarse, una
 * recepción de compra repone y recién entonces se inicia).
 * Cada corrida usa nombres únicos, así puede repetirse.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function section(page: Page, heading: string | RegExp): Locator {
  return page.locator("section", { has: page.getByRole("heading", { name: heading }) });
}

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      errors.push(`${msg.type()} ${msg.location().url}: ${msg.text()}`);
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

async function createRawMaterial(page: Page, name: string, category: string, cost: string) {
  await page.goto("/materias-primas/nuevo");
  await page.getByLabel("Nombre").fill(name);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), category);
  await selectByText(page.getByRole("combobox", { name: "Unidad base" }), "Kilogramo");
  await page.getByLabel("Costo de referencia (ARS por unidad base)").fill(cost);
  await page.getByRole("button", { name: "Crear materia prima" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/** Producto por kg con una receta publicada que rinde 100 kg. */
async function createProductWithRecipe(
  page: Page,
  opts: { name: string; category: string; price: string; ingredients: [string, string][] },
) {
  await page.goto("/productos/nuevo");
  await page.getByLabel("Nombre").fill(opts.name);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), opts.category);
  await selectByText(page.getByRole("combobox", { name: "Unidad de venta" }), "Kilogramo");
  await page.getByLabel("Precio de venta").fill(opts.price);
  await page.getByRole("button", { name: "Crear producto" }).click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();

  await openSection(page, "Recetas");
  await page.getByRole("link", { name: "Nueva receta" }).click();
  await selectByText(page.getByRole("combobox", { name: "Producto" }), opts.name);
  await page.getByRole("textbox", { name: "Rendimiento" }).fill("100");
  for (const [index, [material, quantity]] of opts.ingredients.entries()) {
    const n = index + 1;
    if (n > 1) await page.getByRole("button", { name: "Agregar ingrediente" }).click();
    await selectByText(page.getByRole("combobox", { name: `Materia prima ${n}` }), material);
    await page.getByRole("textbox", { name: `Cantidad ${n}` }).fill(quantity);
  }
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("heading", { name: /Borrador · versión 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Publicar", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publicar versión" }).click();
  await expect(page.getByRole("heading", { name: /Versión vigente · v1/ })).toBeVisible();
}

async function initialStock(page: Page, material: string, quantity: string, cost: string) {
  await openSection(page, "Stock de materias primas");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(material);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(material);
  await page.getByRole("link", { name: material, exact: true }).click();
  await page.getByRole("link", { name: "Cargar stock inicial" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cargar stock inicial" })).toBeVisible();
  await page.getByLabel(/^Cantidad/).fill(quantity);
  await page.getByLabel(/^Costo unitario/).fill(cost);
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar stock inicial" }).click();
  await expect(summaryValue(section(page, "Existencias"), "Stock total")).toBeVisible();
}

/** Nueva orden desde el menú Producción → Órdenes (depósitos por defecto). */
async function newOrder(page: Page, product: string, quantity: string) {
  await openSection(page, "Órdenes de producción");
  await expect(
    page.getByRole("heading", { level: 1, name: "Órdenes de producción" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Nueva orden" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Nueva orden de producción" }),
  ).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Producto", exact: true }), product);
  await page.getByLabel("Cantidad a producir").fill(quantity);
  await expect(page.getByRole("combobox", { name: "Unidad de la cantidad" })).toHaveValue(/.+/);
}

async function confirmIn(page: Page, button: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: button, exact: true }).click();
}

test("Fase 4: crear, planificar, iniciar, cargar real con extra y completar", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  const harina = `Harina P${run}`;
  const sal = `Sal P${run}`;
  const pan = `Pan P${run}`;

  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Secos P${run}`);
  await createCategory(page, "PRODUCT", `Panes P${run}`);
  await createRawMaterial(page, harina, `Secos P${run}`, "900");
  await createRawMaterial(page, sal, `Secos P${run}`, "400");
  await createProductWithRecipe(page, {
    name: pan,
    category: `Panes P${run}`,
    price: "1500",
    ingredients: [
      [harina, "75"],
      [sal, "1"],
    ],
  });
  await initialStock(page, harina, "200", "1000");
  await initialStock(page, sal, "10", "500");

  // Crear: la vista previa sugiere la receta vigente, el plan, la disponibilidad y el costo.
  await newOrder(page, pan, "100");
  const plan = section(page, "Resumen del plan");
  await expect(summaryValue(plan, "Receta")).toContainText("versión 1");
  await expect(summaryValue(plan, "Escala")).toHaveText("×1");
  const availability = plan.getByRole("table", { name: "Disponibilidad de materias primas" });
  await expect(availability.getByRole("row").filter({ hasText: harina })).toContainText("75 kg");
  await expect(availability.getByRole("row").filter({ hasText: harina })).toContainText("Alcanza");
  // 75 kg × $1.000 + 1 kg × $500 = $75.500 → $755/kg
  await expect(summaryValue(plan, "Costo esperado")).toContainText("$75.500,00");
  await expect(summaryValue(plan, "Costo esperado")).toContainText("$755,00 / kg");
  await page.getByRole("button", { name: "Crear borrador" }).click();

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText(/Orden OP-\d+/);
  await expect(heading).toContainText("Borrador");

  // Planificar: fija receta, cantidades, costo esperado y asigna lote.
  await confirmIn(page, "Planificar producción");
  await expect(heading).toContainText("Planificada");
  await expect(page.locator("dl.metrics")).toContainText(/LOT-\d{8}-\d{3}/);
  await expect(summaryValue(section(page, "Costo material"), "Costo esperado")).toContainText(
    "$75.500,00",
  );

  // Iniciar
  await confirmIn(page, "Iniciar producción");
  await expect(heading).toContainText("En curso");

  // Consumo real: harina 76,05 kg (con coma decimal) y sal extra 0,5 kg con motivo.
  const actuals = section(page, "Consumo y salida reales");
  await expect(actuals.getByRole("textbox", { name: `Real ${harina}` })).toHaveValue("75");
  await actuals.getByRole("textbox", { name: `Real ${harina}` }).fill("76,05");
  await actuals.getByRole("button", { name: "Agregar consumo extra" }).click();
  await selectByText(actuals.getByRole("combobox", { name: "Materia prima", exact: true }), sal);
  await actuals.getByLabel("Cantidad", { exact: true }).fill("0,5");
  await actuals.getByLabel("Motivo").fill("Espolvoreado");
  await actuals.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(actuals.getByRole("row").filter({ hasText: "Espolvoreado" })).toBeVisible();
  // Lo tipeado antes de agregar el extra se conserva.
  await expect(actuals.getByRole("textbox", { name: `Real ${harina}` })).toHaveValue("76,05");
  await actuals.getByLabel(`Cantidad obtenida de ${pan}`).fill("96");

  // Revisar: plan contra real y costo estimado (76.050 + 500 + 250 = 76.800 → $800/kg).
  await actuals.getByRole("button", { name: "Revisar y completar" }).click();
  const review = page.getByRole("dialog");
  await expect(review.getByRole("heading", { name: /Revisar antes de completar/ })).toBeVisible();
  await expect(summaryValue(review, "Producido")).toHaveText("96 kg");
  await expect(summaryValue(review, "Rendimiento")).toHaveText("96 %");
  await expect(review.getByRole("row").filter({ hasText: harina })).toContainText("1,05 kg");
  await expect(review).toContainText("$76.800,00");
  await expect(review).toContainText("$800,00 / kg");
  await review.getByRole("button", { name: "Confirmar producción" }).click();

  // Completada: plan contra real, costo real y movimientos.
  await expect(heading).toContainText("Completada");
  await expect(page.getByText(/entraron 96 kg de/)).toBeVisible();
  const costs = section(page, "Costo material");
  await expect(summaryValue(costs, "Costo real")).toContainText("$76.800,00");
  await expect(summaryValue(costs, "Costo real")).toContainText("$800,00 / kg");
  await expect(summaryValue(costs, "Costo esperado")).toContainText("$75.500,00");
  await expect(summaryValue(costs, "Diferencia")).toContainText("$1.300,00");
  const pva = section(page, "Plan contra real");
  await expect(pva.getByRole("row").filter({ hasText: "Espolvoreado" })).toContainText("0,5 kg");
  const movements = section(page, "Movimientos de stock").locator("tbody tr");
  await expect(movements).toHaveCount(4);
  await expect(movements.filter({ hasText: "Producción terminada" })).toContainText("+96 kg");
  await expect(movements.filter({ hasText: "Consumo de producción" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Cancelar orden" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Producción completada" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(UUID);
  const orderUrl = page.url();

  // Stock de producto terminado: 96 kg a $800/kg, margen teórico $700 (46,67 %).
  await openSection(page, "Stock de materias primas");
  await openSection(page, "Productos terminados");
  await expect(
    page.getByRole("heading", { level: 1, name: "Stock de productos terminados" }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(pan);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(pan);
  const row = page.getByRole("row").filter({ hasText: pan });
  await expect(row).toContainText("96 kg");
  await row.getByRole("link", { name: pan }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(pan) })).toBeVisible();
  const stock = section(page, "Existencias");
  await expect(summaryValue(stock, "Stock físico")).toHaveText("96 kg");
  await expect(summaryValue(stock, "Costo promedio")).toHaveText("$800,00 / kg");
  await expect(summaryValue(stock, "Valor de inventario")).toHaveText("$76.800,00");
  const margin = summaryValue(section(page, "Precio y margen"), "Margen teórico");
  await expect(margin).toContainText("$700,00 / kg");
  await expect(margin).toContainText("46,67 %");
  await expect(section(page, "Producciones recientes").getByRole("row")).toHaveCount(2);
  await expect(section(page, "Historial de costo promedio")).toContainText("$800,00 / kg");
  await expect(page.locator("main")).not.toContainText(UUID);

  // Materias primas: 200 − 76,05 = 123,95 kg de harina; 10 − 1,5 = 8,5 kg de sal.
  await openSection(page, "Stock de materias primas");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(harina);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(harina);
  await expect(page.getByRole("row").filter({ hasText: harina })).toContainText("123,95 kg");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(sal);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(sal);
  await expect(page.getByRole("row").filter({ hasText: sal })).toContainText("8,5 kg");

  // Movimientos de inventario: filtro por productos terminados, con enlace a la orden.
  await page
    .getByLabel("Inventario")
    .getByRole("link", { name: "Movimientos", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Artículo" }).selectOption("PRODUCT");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(pan);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(pan);
  const outRow = page.getByRole("row").filter({ hasText: pan });
  await expect(outRow).toContainText("Producción terminada");
  await outRow.getByRole("link", { name: /Producción OP-/ }).click();
  await expect(page).toHaveURL(orderUrl);

  // Listado de órdenes: filtro por estado.
  await openSection(page, "Órdenes de producción");
  await page.getByRole("combobox", { name: "Estado" }).selectOption("COMPLETED");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(pan);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(pan);
  await expect(page.getByRole("row").filter({ hasText: pan })).toContainText("Completada");

  expect(consoleErrors).toEqual([]);
});

test("Fase 4: faltante de materia prima → compra recibida → se puede iniciar", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}f`;
  const consoleErrors = trackConsoleErrors(page);
  const manteca = `Manteca F${run}`;
  const factura = `Factura F${run}`;
  const supplier = `Lácteos F${run}`;

  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Frescos F${run}`);
  await createCategory(page, "PRODUCT", `Facturas F${run}`);
  await createRawMaterial(page, manteca, `Frescos F${run}`, "3000");
  await createProductWithRecipe(page, {
    name: factura,
    category: `Facturas F${run}`,
    price: "6000",
    ingredients: [[manteca, "20"]],
  });
  await initialStock(page, manteca, "5", "3000");
  await page.goto("/proveedores/nuevo");
  await page.getByLabel("Razón social").fill(supplier);
  await page.getByRole("button", { name: "Crear proveedor" }).click();
  await expect(page.getByRole("heading", { name: supplier })).toBeVisible();

  // La vista previa ya avisa el faltante: se necesitan 20 kg y hay 5.
  await newOrder(page, factura, "100");
  const plan = section(page, "Resumen del plan");
  await expect(plan.getByText("Falta materia prima")).toBeVisible();
  await expect(plan).toContainText(`${manteca}: faltan 15 kg`);
  await page.getByRole("button", { name: "Crear borrador" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText("Borrador");

  // Se puede planificar con faltante, pero no iniciar.
  await confirmIn(page, "Planificar producción");
  await expect(heading).toContainText("Planificada");
  const availability = section(page, /^Disponibilidad en/);
  await expect(availability.getByRole("row").filter({ hasText: manteca })).toContainText("Falta");
  await expect(availability.getByRole("row").filter({ hasText: manteca })).toContainText("-15 kg");
  await expect(page.getByRole("button", { name: "Iniciar producción" })).toBeDisabled();
  const orderUrl = page.url();

  // Compra de 20 kg sueltos desde el aviso, pedida y recibida.
  await availability.getByRole("link", { name: "Comprar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nueva compra" })).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Proveedor" }), supplier);
  await expect(page.getByRole("combobox", { name: "Materia prima 1" })).not.toHaveValue("");
  await selectByText(page.getByRole("combobox", { name: "Presentación 1" }), "kg suelto");
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill("20");
  await page.getByRole("textbox", { name: "Precio unitario 1" }).fill("3200");
  await page.getByRole("button", { name: "Guardar y confirmar pedido" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Compra OC-/ })).toBeVisible();
  await page.getByRole("link", { name: "Registrar recepción" }).click();
  await page.getByRole("button", { name: "Revisar recepción" }).click();
  await page.getByRole("button", { name: "Confirmar recepción" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Recibida");

  // De vuelta en la orden: alcanza y se puede iniciar.
  await page.goto(orderUrl);
  await expect(
    section(page, /^Disponibilidad en/)
      .getByRole("row")
      .filter({ hasText: manteca }),
  ).toContainText("Alcanza");
  await expect(page.getByText("Hay stock suficiente")).toBeVisible();
  await confirmIn(page, "Iniciar producción");
  await expect(heading).toContainText("En curso");
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});
