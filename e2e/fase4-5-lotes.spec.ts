import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/*
 * Fase 4.5: lotes, conservación y vida útil contra la aplicación construida y la
 * base de desarrollo con seed.
 * - Principal: configurar la conservación, producir, ver el lote, congelar,
 *   descongelar (sin poder recongelar), registrar merma y consultar la
 *   disponibilidad a una fecha.
 * - Producto no congelable: el lote no ofrece congelar.
 * - Vencimiento: un lote de vida corta aparece en "Próximos a vencer" y no cuenta
 *   como disponible después de vencer.
 * Los datos de partida de los dos últimos se crean por la API (lo que se prueba
 * es la pantalla de lotes); cada corrida usa nombres únicos.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
const WEB_ORIGIN = "http://localhost:3000";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

async function openSection(page: Page, name: string) {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

async function selectByText(select: Locator, text: string) {
  await expect(select.locator("option", { hasText: text }).first()).toBeAttached();
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value ?? "");
}

function summaryValue(scope: Locator, label: string | RegExp): Locator {
  return scope
    .locator("dl.cost-summary > div")
    .filter({ has: scope.page().locator("dt", { hasText: label }) })
    .locator("dd");
}

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

/* ---------- Datos de partida por la API (con la sesión del navegador) ---------- */

async function call<T = { id: string }>(
  request: APIRequestContext,
  method: "get" | "post" | "put",
  url: string,
  data?: unknown,
): Promise<T> {
  const res = await request[method](url, {
    headers: { origin: WEB_ORIGIN },
    ...(data === undefined ? {} : { data }),
  });
  if (!res.ok())
    throw new Error(`${method.toUpperCase()} ${url}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Producto por kg con receta publicada (100 kg → 75 kg de harina) y stock de
 * harina; devuelve una función que produce y completa una orden de N kg.
 */
async function apiWorld(request: APIRequestContext, run: string) {
  const units = Object.fromEntries(
    (
      await call<{ items: { id: string; code: string }[] }>(
        request,
        "get",
        "/api/units?pageSize=100",
      )
    ).items.map((u) => [u.code, u.id]),
  );
  const mp = await call(request, "post", "/api/categories", {
    type: "RAW_MATERIAL",
    name: `Secos L${run}`,
  });
  const pr = await call(request, "post", "/api/categories", {
    type: "PRODUCT",
    name: `Panes L${run}`,
  });
  const harina = await call(request, "post", "/api/raw-materials", {
    name: `Harina L${run}`,
    categoryId: mp.id,
    baseUnitId: units.kg,
    referenceCost: "1000",
  });
  const product = await call(request, "post", "/api/products", {
    name: `Pan L${run}`,
    categoryId: pr.id,
    saleUnitId: units.kg,
    salePrice: "1500",
  });
  const recipe = await call<{ id: string; draftVersionId: string }>(
    request,
    "post",
    "/api/recipes",
    {
      productId: product.id,
      version: {
        yieldQuantity: "100",
        yieldUnitId: units.kg,
        wastePercentage: "0",
        ingredients: [{ rawMaterialId: harina.id, quantity: "75", unitId: units.kg }],
      },
    },
  );
  await call(request, "post", `/api/recipe-versions/${recipe.draftVersionId}/publish`, {});
  const warehouses = await call<{ items: { id: string; name: string }[] }>(
    request,
    "get",
    "/api/warehouses?pageSize=100&status=active",
  );
  const warehouseId = warehouses.items[0]!.id;
  await call(request, "post", "/api/inventory/initial-stock", {
    rawMaterialId: harina.id,
    warehouseId,
    quantity: "1000",
    unitCost: "1000",
  });
  const today = new Date().toISOString().slice(0, 10);
  const produce = async (quantity: string) => {
    const order = await call(request, "post", "/api/production-orders", {
      productId: product.id,
      scheduledFor: today,
      plannedOutputQuantity: quantity,
      sourceWarehouseId: warehouseId,
      outputWarehouseId: warehouseId,
    });
    await call(request, "post", `/api/production-orders/${order.id}/plan`, {});
    await call(request, "post", `/api/production-orders/${order.id}/start`, {});
    await call(request, "put", `/api/production-orders/${order.id}/actuals`, {
      lines: [],
      actualOutputQuantity: quantity,
      actualOutputUnitId: units.kg,
    });
    const done = await call<{ productLot: { id: string; code: string } }>(
      request,
      "post",
      `/api/production-orders/${order.id}/complete`,
      {},
    );
    return done.productLot;
  };
  return { productId: product.id, productName: `Pan L${run}`, produce };
}

/* ---------- Pantallas ---------- */

/** Producto → Configurar conservación. Estados: [estado, vida útil, unidad, inicial]. */
async function configureConservation(
  page: Page,
  productId: string,
  states: [label: string, value: string, unit: "días" | "horas", initial: boolean][],
  nearExpiryHours = "24",
) {
  await page.goto(`/productos/${productId}`);
  await section(page, "Conservación")
    .getByRole("link", { name: "Configurar conservación" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Conservación" })).toBeVisible();
  for (const [label, value, unit, initial] of states) {
    await page.getByRole("checkbox", { name: `${label} habilitado`, exact: true }).check();
    await page.getByRole("textbox", { name: `Vida útil ${label}`, exact: true }).fill(value);
    await page
      .getByRole("combobox", { name: `Unidad de vida útil ${label}`, exact: true })
      .selectOption({ label: unit });
    if (initial)
      await page.getByRole("checkbox", { name: `${label} puede ser inicial`, exact: true }).check();
  }
  await page.getByLabel(/próximo a vencer/).fill(nearExpiryHours);
  await page.getByRole("button", { name: "Guardar conservación" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Pan|Medialuna/ })).toBeVisible();
}

async function lotOperation(page: Page, button: string, quantity: string, confirm: string) {
  await page.getByRole("link", { name: button, exact: true }).click();
  await page.getByLabel(/^Cantidad a/).fill(quantity);
  if (button === "Registrar merma") await page.getByLabel("Motivo").selectOption("DAMAGED");
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: confirm }).click();
}

test("Fase 4.5: conservación, lote al producir, congelar, descongelar, merma y disponibilidad", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  const pan = world.productName;

  // Conservación: fresco 2 días (inicial), congelado 30 días, descongelado 12 horas.
  await configureConservation(page, world.productId, [
    ["Fresco", "2", "días", true],
    ["Congelado", "30", "días", false],
    ["Descongelado", "12", "horas", false],
  ]);
  const conservation = section(page, "Conservación");
  await expect(conservation.getByRole("row", { name: /^Fresco/ })).toContainText("2 días");
  await expect(conservation.getByRole("row", { name: /^Descongelado/ })).toContainText("12 horas");

  // Producir 100 kg desde la pantalla: la revisión anuncia el lote fresco.
  await openSection(page, "Órdenes");
  await expect(
    page.getByRole("heading", { level: 1, name: "Órdenes de producción" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Nueva orden" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Nueva orden de producción" }),
  ).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Producto", exact: true }), pan);
  await page.getByLabel("Cantidad a producir").fill("100");
  await expect(page.getByRole("combobox", { name: "Unidad de la cantidad" })).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Crear borrador" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText("Borrador");
  for (const step of ["Planificar producción", "Iniciar producción"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: step, exact: true }).click();
  }
  await expect(heading).toContainText("En curso");
  const actuals = section(page, "Consumo y salida reales");
  await actuals.getByLabel(`Cantidad obtenida de ${pan}`).fill("100");
  await actuals.getByRole("button", { name: "Revisar y completar" }).click();
  const review = page.getByRole("dialog");
  await expect(review).toContainText("en un lote fresco que dura 2 días");
  await review.getByRole("button", { name: "Confirmar producción" }).click();
  await expect(heading).toContainText("Completada");

  // La orden muestra su lote; el lote, su origen y vencimiento.
  const lotLink = page.locator("dl.details").getByRole("link", { name: /LOT-\d{8}-\d{3}/ });
  const lotCode = (await lotLink.textContent())!.trim();
  await lotLink.click();
  await expect(heading).toContainText(`Lote ${lotCode}`);
  await expect(heading).toContainText("Fresco");
  const lot = section(page, "Datos del lote");
  await expect(summaryValue(lot, "Cantidad actual")).toHaveText("100 kg");
  await expect(summaryValue(lot, "Utilizable hasta")).toContainText("vence en 1 día y 23 h");
  await expect(summaryValue(lot, "Valor del lote")).toContainText("$75.000,00");

  // Congelar 30 kg: lote hijo congelado, el origen queda en 70 kg.
  await lotOperation(page, "Congelar", "30", "Confirmar congelado");
  await expect(heading).toContainText(`Lote ${lotCode}.1`);
  await expect(heading).toContainText("Congelado");
  await expect(summaryValue(section(page, "Datos del lote"), "Utilizable hasta")).toContainText(
    "vence en 29 días",
  );
  await expect(page.locator("dl.details")).toContainText(lotCode);

  // Descongelar 10 kg: avisa que no se puede recongelar; el hijo no ofrece "Congelar".
  await page.getByRole("link", { name: "Descongelar", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("no se puede volver a congelar");
  await page.getByLabel(/^Cantidad a/).fill("10");
  await page.getByRole("button", { name: "Revisar" }).click();
  await expect(page.getByRole("note")).toContainText("no se puede volver a congelar");
  await page.getByRole("button", { name: "Confirmar descongelado" }).click();
  await expect(heading).toContainText(`Lote ${lotCode}.1.1`);
  await expect(heading).toContainText("Descongelado");
  await expect(page.getByRole("link", { name: "Congelar", exact: true })).toHaveCount(0);
  await expect(section(page, "Datos del lote")).toContainText(
    "Un lote descongelado no puede volver a congelarse.",
  );

  // Merma de 5 kg del lote fresco (al costo del lote).
  await page
    .locator("dl.details")
    .getByRole("link", { name: `${lotCode}.1`, exact: true })
    .click();
  await page.locator("dl.details").getByRole("link", { name: lotCode, exact: true }).click();
  await lotOperation(page, "Registrar merma", "5", "Confirmar merma");
  await expect(summaryValue(section(page, "Datos del lote"), "Cantidad actual")).toHaveText(
    "65 kg",
  );
  const lotMovements = section(page, "Movimientos del lote").locator("tbody tr");
  await expect(lotMovements.filter({ hasText: "Merma" })).toContainText("-5 kg");
  await expect(lotMovements.filter({ hasText: "Transformación" })).toContainText(`${lotCode}.1`);
  const history = section(page, /^Historial$/);
  await expect(history).toContainText("Lote de producto creado");
  await expect(history).toContainText("Lote transformado (conservación)");
  await expect(history).toContainText("Merma de lote registrada");

  // Stock del producto: 95 kg físicos por estado, lotes FEFO y disponibilidad a 3 días.
  await page.getByRole("link", { name: `← ${pan}` }).click();
  const stock = section(page, "Existencias");
  await expect(summaryValue(stock, "Stock físico")).toHaveText("95 kg");
  await expect(summaryValue(stock, "Utilizable ahora")).toHaveText("95 kg");
  await expect(stock).toContainText("Fresco 65 kg · Congelado 20 kg · Descongelado 10 kg");
  const lots = section(page, /^Lotes$/).locator("tbody tr");
  await expect(lots).toHaveCount(3);
  await expect(lots.first()).toContainText(`${lotCode}.1.1`);
  // El lote descongelado sólo admite merma; el fresco, congelar o merma.
  await expect(lots.first().getByRole("link", { name: /^Congelar/ })).toHaveCount(0);
  await expect(
    lots.filter({ hasText: "Fresco" }).getByRole("link", { name: `Congelar ${lotCode}` }),
  ).toBeVisible();
  const availability = section(page, "Disponibilidad a una fecha");
  const inThreeDays = new Date(
    Date.now() + 3 * 86_400_000 - new Date().getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 16);
  await availability.getByLabel("Fecha y hora").fill(inThreeDays);
  await expect(summaryValue(availability, /^Utilizable el/)).toHaveText("20 kg");
  await expect(summaryValue(availability, "No utilizable")).toHaveText("75 kg");
  await expect(availability).toContainText("75 kg vencen antes de la fecha");

  // Listado de productos terminados con columnas por conservación.
  await page.getByRole("link", { name: "← Stock de productos terminados" }).click();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(pan);
  const row = page.getByRole("row").filter({ hasText: pan });
  await expect(row).toContainText("95 kg");
  await expect(row).toContainText("65 kg");
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});

test("Fase 4.5: producto sin congelado habilitado no ofrece congelar", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}n`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  await configureConservation(page, world.productId, [["Fresco", "1", "días", true]]);
  const lot = await world.produce("40");

  await page.goto(`/stock/lotes/${lot.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Lote ${lot.code}`);
  await expect(page.getByRole("link", { name: "Congelar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Registrar merma" })).toBeVisible();
  // Aun entrando directo, la operación explica por qué no se puede.
  await page.goto(`/stock/lotes/${lot.id}/congelar`);
  await expect(page.getByRole("status")).toContainText("no tiene habilitado el estado congelado");
  await expect(page.getByRole("button", { name: "Revisar" })).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});

test("Fase 4.5: lote de vida corta en Próximos a vencer y fuera de la disponibilidad futura", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}v`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  await configureConservation(page, world.productId, [["Fresco", "2", "horas", true]]);
  const lot = await world.produce("30");

  await openSection(page, "Stock");
  await page.getByRole("link", { name: "Próximos a vencer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Próximos a vencer" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(lot.code);
  const row = page.getByRole("row").filter({ hasText: lot.code });
  await expect(row).toContainText("Próximo a vencer");
  await expect(row).toContainText("30 kg");
  await expect(row).toContainText(/vence en 1 h 5\d min|vence en 2 h/);

  await row.getByRole("link", { name: lot.code, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Próximo a vencer");
  await page.getByRole("link", { name: `← ${world.productName}` }).click();
  const availability = section(page, "Disponibilidad a una fecha");
  // Por defecto mira dentro de dos días: el lote ya venció para entonces.
  await expect(summaryValue(availability, /^Utilizable el/)).toHaveText("0 kg");
  await expect(availability).toContainText("30 kg vencen antes de la fecha");
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});
