import { expect, test, type Locator, type Page } from "@playwright/test";
import { openSection, selectByText, summaryValue } from "./support";

/*
 * Fase 3: compras + inventario contra la aplicación construida y la base de
 * desarrollo con seed. Flujo principal de 21 pasos (§67) y stock mínimo (§68).
 * Cada corrida usa nombres únicos, así puede repetirse.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

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

async function createSupplier(page: Page, name: string) {
  await openSection(page, "Proveedores");
  await page.getByRole("link", { name: "Nuevo proveedor" }).click();
  await page.getByLabel("Razón social").fill(name);
  await page.getByRole("button", { name: "Crear proveedor" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function createRawMaterial(
  page: Page,
  opts: { name: string; category: string; cost?: string; minimum?: string },
) {
  await openSection(page, "Materias primas");
  await page.getByRole("link", { name: "Nueva materia prima" }).click();
  await page.getByLabel("Nombre").fill(opts.name);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), opts.category);
  await selectByText(page.getByRole("combobox", { name: "Unidad base" }), "Kilogramo");
  if (opts.minimum) await page.getByLabel("Stock mínimo").fill(opts.minimum);
  if (opts.cost) await page.getByLabel("Costo de referencia (ARS por unidad base)").fill(opts.cost);
  await page.getByRole("button", { name: "Crear materia prima" }).click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();
}

async function openStock(page: Page, material: string) {
  await openSection(page, "Stock de materias primas");
  await expect(page.getByRole("heading", { level: 1, name: "Stock" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(material);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(material);
  await page.getByRole("link", { name: material, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(material) })).toBeVisible();
}

async function initialStock(page: Page, quantity: string, cost: string) {
  await page.getByRole("link", { name: "Cargar stock inicial" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cargar stock inicial" })).toBeVisible();
  await page.getByLabel(/^Cantidad/).fill(quantity);
  await page.getByLabel(/^Costo unitario/).fill(cost);
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar stock inicial" }).click();
}

/** Crea y confirma una compra de una línea desde el menú. */
async function createOrderedPurchase(
  page: Page,
  opts: { supplier: string; material: string; option?: string; quantity: string; price: string },
) {
  await openSection(page, "Compras");
  await page.getByRole("link", { name: "Nueva compra" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nueva compra" })).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Proveedor" }), opts.supplier);
  await selectByText(page.getByRole("combobox", { name: "Materia prima 1" }), opts.material);
  const presentation = page.getByRole("combobox", { name: "Presentación 1" });
  if (opts.option) await selectByText(presentation, opts.option);
  else await expect(presentation).not.toHaveValue("");
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill(opts.quantity);
  await page.getByRole("textbox", { name: "Precio unitario 1" }).fill(opts.price);
  return presentation;
}

async function receive(page: Page, material: string, quantity?: string) {
  await page.getByRole("link", { name: "Registrar recepción" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Registrar recepción" })).toBeVisible();
  const input = page.getByRole("textbox", { name: `Recibido ahora ${material}` });
  if (quantity !== undefined) await input.fill(quantity);
  await page.getByRole("button", { name: "Revisar recepción" }).click();
  await expect(page.getByRole("heading", { name: "Resumen antes de confirmar" })).toBeVisible();
}

async function confirmReceipt(page: Page) {
  await page.getByRole("button", { name: "Confirmar recepción" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Compra OC-/ })).toBeVisible();
}

test("Fase 3: compra, recepción parcial y total, costo promedio, recetas y merma", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  const supplier = `Molino ${run} S.A.`;
  const harina = `Harina ${run}`;
  const pan = `Pan ${run}`;

  // 1. Login
  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Secos ${run}`);
  await createCategory(page, "PRODUCT", `Panes ${run}`);

  // 2. Proveedor
  await createSupplier(page, supplier);

  // 3. Harina, con costo de referencia manual de $900/kg
  await createRawMaterial(page, { name: harina, category: `Secos ${run}`, cost: "900" });

  // 4. Presentación "Bolsa 25 kg" (específica de esta harina)
  await page.getByRole("button", { name: "Nueva presentación" }).click();
  await page
    .getByRole("combobox", { name: "Se compra por" })
    .selectOption({ label: "Bolsa (bolsa)" });
  await page.getByLabel("Cada una trae").fill("25");
  await expect(page.getByLabel("Nombre", { exact: true })).toHaveAttribute(
    "placeholder",
    "Bolsa 25 kg",
  );
  await page.getByRole("button", { name: "Crear presentación" }).click();
  const presentations = section(page, "Presentaciones de compra");
  await expect(presentations.getByRole("cell", { name: "Bolsa 25 kg" })).toBeVisible();
  await expect(presentations.getByRole("cell", { name: "1 bolsa = 25 kg" })).toBeVisible();

  // Receta asociada, publicada ANTES de tener stock: usa la referencia manual ($900/kg).
  await page.goto("/productos/nuevo");
  await page.getByLabel("Nombre").fill(pan);
  await selectByText(page.getByRole("combobox", { name: "Categoría" }), `Panes ${run}`);
  await selectByText(page.getByRole("combobox", { name: "Unidad de venta" }), "Kilogramo");
  await page.getByLabel("Precio de venta").fill("1500");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await expect(page.getByRole("heading", { name: pan })).toBeVisible();
  await openSection(page, "Recetas");
  await page.getByRole("link", { name: "Nueva receta" }).click();
  await selectByText(page.getByRole("combobox", { name: "Producto" }), pan);
  await page.getByRole("textbox", { name: "Rendimiento" }).fill("100");
  await selectByText(page.getByRole("combobox", { name: "Materia prima 1" }), harina);
  await page.getByRole("textbox", { name: "Cantidad 1" }).fill("75");
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(page.getByRole("heading", { name: /Borrador · versión 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Publicar", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publicar versión" }).click();
  await expect(page.getByRole("heading", { name: /Versión vigente · v1/ })).toBeVisible();
  const recipeUrl = page.url();

  // 5. Stock inicial: 100 kg a $1.000/kg
  await openStock(page, harina);
  await initialStock(page, "100", "1000");

  // 6. Comprobar stock
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(harina) })).toBeVisible();
  const existencias = section(page, "Existencias");
  await expect(summaryValue(existencias, "Stock total")).toHaveText("100 kg");

  // 7–8. Compra: 4 bolsas de 25 kg a $30.000 la bolsa
  await createOrderedPurchase(page, { supplier, material: harina, quantity: "4", price: "30000" });
  await expect(page.getByRole("combobox", { name: "Presentación 1" })).toHaveValue(/^p:/);
  await expect(page.getByText("Equivale a 100 kg · $1.200,00 / kg")).toBeVisible();
  await expect(summaryValue(section(page, "3. Totales"), /^Total$/)).toHaveText("$120.000,00");

  // 9. Confirmar el pedido
  await page.getByRole("button", { name: "Guardar y confirmar pedido" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Compra OC-/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pedida");
  await expect(page.getByRole("cell", { name: "4 × Bolsa 25 kg" })).toBeVisible();

  // 10. Recepción parcial: llegan 2 bolsas
  await receive(page, harina, "2");
  const summary = page.locator(".receipt-summary");
  await expect(summary).toContainText("2 × Bolsa 25 kg");
  await expect(summary).toContainText("50 kg");
  await expect(summary).toContainText("$60.000,00");
  await expect(summary).toContainText("$1.200,00 / kg");
  await confirmReceipt(page);

  // 11. Estado: recibida en parte
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Recibida en parte");
  await expect(summaryValue(page.locator("section").first(), "Pendiente")).toHaveText("$60.000,00");

  // 12. Completar la recepción (se propone lo pendiente: 2 bolsas)
  await receive(page, harina);
  await expect(page.locator(".receipt-summary")).toContainText("2 × Bolsa 25 kg");
  await confirmReceipt(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Recibida");
  await expect(page.getByRole("link", { name: "Registrar recepción" })).toHaveCount(0);

  // 13. Stock: 100 + 100 = 200 kg
  await openStock(page, harina);
  await expect(summaryValue(section(page, "Existencias"), "Stock total")).toHaveText("200 kg");

  // 14. Costo promedio $1.100/kg; la referencia manual sigue en $900; recetas usan $1.100
  const costs = section(page, "Costos");
  await expect(summaryValue(costs, "Costo promedio de inventario")).toHaveText("$1.100,00 / kg");
  await expect(summaryValue(costs, "Costo de referencia manual")).toHaveText("$900,00 / kg");
  await expect(summaryValue(costs, "Costo usado por recetas")).toContainText("$1.100,00 / kg");
  await expect(summaryValue(costs, "Costo usado por recetas")).toContainText("compras");
  await expect(summaryValue(costs, "Valor de inventario")).toHaveText("$220.000,00");

  // 15. Abrir la receta asociada
  await page.goto(recipeUrl);
  const active = section(page, /Versión vigente · v1/);
  // 16. Costo actual: 75 kg × $1.100 / 100 kg = $825/kg
  await expect(summaryValue(active, "Costo por kg (actual)")).toHaveText("$825,00 / kg");
  // 17. El snapshot de la publicación sigue con $900/kg: 75 × 900 / 100 = $675/kg
  await expect(summaryValue(active, "Costo por kg al publicar")).toContainText("$675,00 / kg");

  // 18. Registrar una merma chica: 3 kg
  await openStock(page, harina);
  await page.getByRole("link", { name: "Registrar merma" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Registrar merma" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Materia prima" })).toHaveValue(/.+/);
  await page.getByLabel(/^Cantidad/).fill("3");
  await page.getByRole("combobox", { name: "Motivo" }).selectOption({ label: "Daño" });
  const impact = page.locator("dl.impact");
  await expect(summaryValue(page.locator("main"), "Stock antes")).toHaveText("200 kg");
  await expect(impact).toContainText("−3 kg");
  await expect(summaryValue(page.locator("main"), "Stock después")).toHaveText("197 kg");
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar merma" }).click();

  // 19. Stock: 197 kg; el promedio no cambia
  await expect(summaryValue(section(page, "Existencias"), "Stock total")).toHaveText("197 kg");
  await expect(summaryValue(section(page, "Costos"), "Costo promedio de inventario")).toHaveText(
    "$1.100,00 / kg",
  );

  // 20. Movimientos: merma, dos recepciones y el stock inicial, con signo y saldo
  await page.getByRole("link", { name: "Ver todos" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Movimientos de inventario" }),
  ).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Merma");
  await expect(rows.nth(0)).toContainText("-3 kg");
  await expect(rows.nth(1)).toContainText("Recepción de compra");
  await expect(rows.nth(1)).toContainText("+50 kg");
  await expect(rows.nth(3)).toContainText("Stock inicial");

  // 21. Auditoría: la compra y el inventario dejan rastro
  await openSection(page, "Auditoría");
  await page.getByLabel("Módulo").selectOption("purchase");
  await expect(page.getByRole("cell", { name: "Recepción confirmada" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pedido confirmado" }).first()).toBeVisible();
  await page.getByLabel("Módulo").selectOption("raw_material");
  await expect(page.getByRole("cell", { name: "Costo promedio modificado" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Merma registrada" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Stock inicial cargado" }).first()).toBeVisible();

  // Sin UUIDs a la vista en la ficha de stock.
  await openStock(page, harina);
  await expect(page.locator("main")).not.toContainText(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  );
  expect(consoleErrors).toEqual([]);
});

test("Fase 3: stock mínimo (bajo mínimo → OK al recibir una compra)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}m`;
  const consoleErrors = trackConsoleErrors(page);
  const supplier = `Distribuidora ${run}`;
  const azucar = `Azúcar ${run}`;

  await login(page);
  await createCategory(page, "RAW_MATERIAL", `Dulces ${run}`);
  await createSupplier(page, supplier);
  // Mínimo 50 kg
  await createRawMaterial(page, { name: azucar, category: `Dulces ${run}`, minimum: "50" });

  // Stock en 40 kg → bajo mínimo
  await openStock(page, azucar);
  await initialStock(page, "40", "1000");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Bajo mínimo");
  await expect(summaryValue(section(page, "Existencias"), "Faltante")).toHaveText("10 kg");

  await openSection(page, "Stock de materias primas");
  await page.getByRole("link", { name: "Bajo mínimo", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Stock bajo mínimo" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(azucar);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(azucar);
  const row = page.getByRole("row").filter({ hasText: azucar });
  await expect(row).toContainText("40 kg");
  await expect(row).toContainText("50 kg");
  await expect(row).toContainText("10 kg");
  await expect(row).toContainText("Bajo mínimo");

  // Comprar y recibir 40 kg sueltos → 80 kg
  await createOrderedPurchase(page, {
    supplier,
    material: azucar,
    option: "kg suelto",
    quantity: "40",
    price: "1100",
  });
  await page.getByRole("button", { name: "Guardar y confirmar pedido" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Compra OC-/ })).toBeVisible();
  await receive(page, azucar);
  await confirmReceipt(page);

  await openStock(page, azucar);
  await expect(summaryValue(section(page, "Existencias"), "Stock total")).toHaveText("80 kg");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("OK");
  await openSection(page, "Stock de materias primas");
  await page.getByRole("link", { name: "Bajo mínimo", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Stock bajo mínimo" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(azucar);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(azucar);
  await expect(page.getByText(`Sin resultados para “${azucar}”.`)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
