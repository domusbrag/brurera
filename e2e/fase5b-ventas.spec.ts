import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/*
 * Fase 5B: ventas, entrega, cobros, cuenta corriente y margen contra la
 * aplicación construida y la base de desarrollo con seed.
 * - Pedido: precio de la lista del cliente congelado al confirmar, seña,
 *   entrega parcial desde la reserva (vista previa + «Confirmar entrega y
 *   venta»), seña aplicada sola, cobro, entrega del resto y cuenta corriente
 *   con Debe / Haber / Saldo.
 * - Mostrador: Consumidor Final por defecto, lotes FEFO en la vista previa,
 *   precio cambiado con motivo, margen negativo avisado y cobro en el momento.
 * - Listas de precios: alta, precio por producto y asignación al cliente.
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

async function call<T = { id: string }>(
  request: APIRequestContext,
  method: "get" | "post" | "put" | "patch",
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
 * Producto por kg (receta 100 kg → 75 kg de harina a 1.000 = 750/kg de costo
 * material), precio 1.500, conservación fresco 2 días y un cliente.
 */
async function apiWorld(request: APIRequestContext, run: string) {
  const { user } = await call<{ user: { company: { timezone: string } } }>(
    request,
    "get",
    "/api/auth/me",
  );
  const timezone = user.company.timezone;
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
    name: `Secos V${run}`,
  });
  const pr = await call(request, "post", "/api/categories", {
    type: "PRODUCT",
    name: `Panes V${run}`,
  });
  const harina = await call(request, "post", "/api/raw-materials", {
    name: `Harina V${run}`,
    categoryId: mp.id,
    baseUnitId: units.kg,
    referenceCost: "1000",
  });
  const productName = `Pan V${run}`;
  const product = await call(request, "post", "/api/products", {
    name: productName,
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
  await call(request, "put", `/api/products/${product.id}/conservation`, {
    defaultInitialState: "FRESH",
    nearExpiryMinutes: 1440,
    states: [{ state: "FRESH", enabled: true, shelfLifeMinutes: 2880, allowedAsInitial: true, notes: null }],
  });
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
  const customerName = `Hotel Central V${run}`;
  const customer = await call(request, "post", "/api/customers", {
    type: "RETAILER",
    legalName: customerName,
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(Date.now() + 86_400_000),
  );
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
  const readyOrder = async (quantity: string) => {
    const created = await call<{ id: string; code: string }>(request, "post", "/api/orders", {
      customerId: customer.id,
      requestedAt: `${tomorrow}T10:00`,
      lines: [{ productId: product.id, quantity }],
    });
    await call(request, "post", `/api/orders/${created.id}/confirm`, {
      operationId: randomUUID(),
    });
    await call(request, "post", `/api/orders/${created.id}/start-preparation`, {});
    await call(request, "post", `/api/orders/${created.id}/mark-ready`, {});
    return created;
  };
  const priceList = async (name: string, unitPrice: string) => {
    const list = await call(request, "post", "/api/price-lists", { name });
    await call(request, "put", `/api/price-lists/${list.id}/items/${product.id}`, { unitPrice });
    return list;
  };
  return {
    productId: product.id,
    productName,
    customerId: customer.id,
    customerName,
    produce,
    readyOrder,
    priceList,
    assignList: (listId: string) =>
      call(request, "patch", `/api/customers/${customer.id}`, { defaultPriceListId: listId }),
  };
}

test("Fase 5B: pedido con seña, entrega parcial, cobro, entrega final y cuenta corriente", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  const lot = await world.produce("100");
  const list = await world.priceList(`Mayorista V${run}`, "1200");
  await world.assignList(list.id);
  const order = await world.readyOrder("80");
  const heading = page.getByRole("heading", { level: 1 });

  // Pedido listo con precio acordado de la lista del cliente.
  await page.goto(`/pedidos/${order.id}`);
  await expect(heading).toContainText("Listo");
  const commercial = page.getByTestId("order-commercial");
  await expect(commercial).toContainText("Precio acordado");
  await expect(commercial).toContainText(`Mayorista V${run}`);
  await expect(commercial).toContainText("$96.000,00");

  // Seña de $20.000.
  await page.getByRole("button", { name: "Registrar seña" }).click();
  const advanceDialog = page.getByRole("dialog");
  await advanceDialog.getByLabel("Monto").fill("20000");
  await advanceDialog.getByLabel("Medio de pago").selectOption("TRANSFER");
  await advanceDialog.getByRole("button", { name: "Registrar cobro" }).click();
  await expect(page.getByTestId("advance-available")).toHaveText("$20.000,00");

  // Entrega parcial: 50 de 80 kg.
  await page.getByRole("link", { name: "Entregar y vender" }).click();
  await expect(heading).toHaveText(`Entregar pedido ${order.code}`);
  await expect(page.getByRole("table", { name: "Productos de la venta" })).toContainText(
    "Pendiente: 80 kg",
  );
  await page.getByLabel("Cantidad 1").fill("50");
  await expect(page.getByTestId("draft-total")).toContainText("$60.000,00");
  await page.getByRole("button", { name: "Guardar y ver la entrega" }).click();
  await expect(heading).toContainText("Borrador");
  const saleCode = (await heading.textContent())!.match(/VTA-\d+/)![0];

  // Vista previa: sale del lote reservado, costo 750/kg, margen y seña a aplicar.
  const preview = page.getByTestId("sale-preview");
  await expect(preview).toContainText(lot.code);
  await expect(preview).toContainText("reservado");
  await expect(summaryValue(preview, "Total de la venta")).toHaveText("$60.000,00");
  await expect(summaryValue(preview, "Costo material")).toHaveText("$37.500,00");
  await expect(summaryValue(preview, "Margen sobre materiales")).toContainText("$22.500,00");
  await expect(summaryValue(preview, "Margen sobre materiales")).toContainText("37,5 %");
  await expect(summaryValue(preview, "Seña que se aplica")).toHaveText("$20.000,00");

  await page.getByRole("button", { name: "Confirmar entrega y venta" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar entrega y venta" })
    .click();
  await expect(heading).toContainText("Entregada");
  await expect(heading).toContainText("Cobro parcial");
  await expect(page.getByTestId("sale-pending")).toHaveText("$40.000,00");
  await expect(section(page, "Cobros aplicados")).toContainText("Seña aplicada");
  await expect(page.getByRole("button", { name: "Editar" })).toHaveCount(0);

  // Cobro del resto de esta venta.
  await page.getByRole("button", { name: "Registrar cobro" }).click();
  const payDialog = page.getByRole("dialog");
  await expect(payDialog.getByLabel("Monto")).toHaveValue("40000.00");
  await payDialog.getByLabel("Monto").fill("40000.01");
  await expect(payDialog.getByRole("alert")).toContainText("Supera el pendiente");
  await payDialog.getByLabel("Monto").fill("40000");
  await payDialog.getByRole("button", { name: "Registrar cobro" }).click();
  await expect(heading).toContainText("Cobrada");

  // El pedido queda entregado parcialmente; se entrega el resto.
  await page.getByRole("link", { name: order.code }).click();
  await expect(heading).toContainText("Entregado parcialmente");
  await expect(page.getByRole("table", { name: "Cobertura por producto" })).toContainText("30 kg");
  await page.getByRole("link", { name: "Entregar el resto" }).click();
  await expect(page.getByLabel("Cantidad 1")).toHaveValue("30");
  await page.getByRole("button", { name: "Guardar y ver la entrega" }).click();
  await expect(heading).toContainText("Borrador");
  await page.getByRole("button", { name: "Confirmar entrega y venta" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar entrega y venta" })
    .click();
  await expect(heading).toContainText("Entregada");
  await expect(heading).toContainText("Sin cobrar");
  await page.getByRole("link", { name: order.code }).click();
  await expect(heading).toContainText("Entregado");
  await expect(heading).not.toContainText("parcialmente");
  await expect(page.getByRole("link", { name: /^Entregar/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancelar pedido" })).toHaveCount(0);
  await expect(commercial).toContainText(saleCode);

  // Cuenta corriente: Debe / Haber / Saldo; le queda la segunda venta (30 × 1.200).
  await openSection(page, "Cuentas a cobrar");
  await expect(page.getByRole("heading", { level: 1, name: "Cuentas a cobrar" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Buscar" }).fill(world.customerName);
  const receivable = page.getByRole("row").filter({ hasText: world.customerName });
  await expect(receivable).toContainText("Debe $36.000,00");
  await receivable.getByRole("link").click();
  await expect(heading).toContainText(`Cuenta corriente · ${world.customerName}`);
  await expect(page.getByTestId("account-balance")).toHaveText("Debe $36.000,00");
  const movements = page.getByRole("table", { name: "Movimientos de la cuenta corriente" });
  await expect(movements.locator("thead")).toContainText("Debe");
  await expect(movements.locator("thead")).toContainText("Haber");
  await expect(movements.locator("thead")).toContainText("Saldo");
  await expect(movements.locator("tbody tr")).toHaveCount(4);
  await expect(section(page, "Ventas pendientes de cobro")).toContainText("$36.000,00");

  // Cobro a cuenta + imputación manual.
  await page.getByRole("button", { name: "Registrar cobro a cuenta" }).click();
  const onAccount = page.getByRole("dialog");
  await onAccount.getByLabel("Monto").fill("36000");
  await onAccount.getByRole("button", { name: "Registrar cobro" }).click();
  await expect(page.getByTestId("account-balance")).toHaveText("Sin saldo");
  await section(page, "Cobros con crédito sin imputar").getByRole("button", { name: "Imputar" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Imputar", exact: true }).click();
  await expect(page.getByText("Ventas pendientes de cobro")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});

test("Fase 5B: venta de mostrador con FEFO, precio cambiado, margen negativo y cobro en el momento", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}m`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  const older = await world.produce("20");
  const newer = await world.produce("100");
  const heading = page.getByRole("heading", { level: 1 });

  await openSection(page, "Ventas");
  await expect(page.getByRole("heading", { level: 1, name: "Ventas" })).toBeVisible();
  await page.getByRole("link", { name: "Nueva venta" }).click();
  await expect(heading).toHaveText("Nueva venta directa");
  await expect(page.getByRole("combobox", { name: "Cliente" })).toHaveValue(/.+/);
  await expect(
    page.getByRole("combobox", { name: "Cliente" }).locator("option:checked"),
  ).toHaveText("Consumidor Final");
  await selectByText(page.getByRole("combobox", { name: "Producto 1" }), world.productName);
  await page.getByLabel("Cantidad 1").fill("30");
  await expect(page.getByRole("table", { name: "Productos de la venta" })).toContainText(
    "Precio del producto",
  );
  await expect(page.getByTestId("draft-total")).toContainText("$45.000,00");

  // Precio por debajo del costo: exige motivo.
  await page.getByLabel("Precio 1").fill("500");
  await page.getByRole("button", { name: "Guardar y ver la entrega" }).click();
  await expect(page.getByText("Indicá el motivo del cambio de precio.")).toBeVisible();
  await page.getByLabel("Motivo del cambio de precio 1").fill("Producto del día anterior");
  await page.getByRole("button", { name: "Guardar y ver la entrega" }).click();
  await expect(heading).toContainText("Borrador");

  // FEFO: primero los 20 kg del lote más viejo, después 10 del nuevo.
  const preview = page.getByTestId("sale-preview");
  await expect(preview).toContainText("Se utilizarán los lotes más próximos a vencer");
  const lots = preview.getByRole("table", { name: "Lotes a entregar" }).locator("li");
  await expect(lots.nth(0)).toContainText(older.code);
  await expect(lots.nth(0)).toContainText("20 kg");
  await expect(lots.nth(1)).toContainText(newer.code);
  await expect(lots.nth(1)).toContainText("10 kg");
  await expect(page.getByTestId("preview-warnings")).toContainText(
    "Precio inferior al costo material de los lotes seleccionados.",
  );
  await expect(summaryValue(preview, "Margen sobre materiales")).toContainText("-$7.500,00");

  // Confirmar cobrando en el momento.
  await page.getByRole("button", { name: "Confirmar entrega y venta" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Cobrar ahora").check();
  await expect(dialog.getByLabel("Monto cobrado")).toHaveValue("15000.00");
  await dialog.getByRole("button", { name: "Confirmar entrega y venta" }).click();
  await expect(heading).toContainText("Entregada");
  await expect(heading).toContainText("Cobrada");
  await expect(page.getByTestId("sale-margin")).toContainText("-$7.500,00");
  await expect(page.locator("main")).toContainText(
    "Precio inferior al costo material de los lotes seleccionados.",
  );
  const lines = page.getByRole("table", { name: "Productos de la venta" });
  await expect(lines).toContainText("Precio modificado");
  await expect(lines).toContainText("Producto del día anterior");
  await expect(section(page, /^Historial$/)).toContainText("Precio modificado");

  // Stock: quedan 90 kg.
  await page.goto(`/stock/productos/${world.productId}`);
  await expect(summaryValue(section(page, "Existencias"), "Stock físico")).toHaveText("90 kg");

  expect(consoleErrors).toEqual([]);
});

test("Fase 5B: lista de precios, asignación al cliente y ajuste de cuenta", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}l`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  await world.produce("50");
  const heading = page.getByRole("heading", { level: 1 });
  const listName = `Distribuidores V${run}`;

  await openSection(page, "Listas de precios");
  await expect(page.getByRole("heading", { level: 1, name: "Listas de precios" })).toBeVisible();
  await page.getByRole("link", { name: "Nueva lista" }).click();
  await page.getByLabel("Nombre").fill(listName);
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(heading).toContainText(listName);
  const price = page.getByLabel(`Precio de ${world.productName}`);
  await price.fill("1100");
  await page
    .getByRole("row", { name: new RegExp(world.productName) })
    .getByRole("button", { name: "Guardar" })
    .click();
  await expect(section(page, /^Historial$/)).toContainText("Precio de lista");

  // Asignar la lista desde la ficha del cliente.
  await page.goto(`/clientes/${world.customerId}/editar`);
  await selectByText(page.getByLabel("Lista de precios"), listName);
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("dl.details")).toContainText(listName);

  // Una venta directa al cliente toma el precio de su lista.
  await page.goto("/ventas/nueva");
  await selectByText(page.getByRole("combobox", { name: "Cliente" }), world.customerName);
  await selectByText(page.getByRole("combobox", { name: "Producto 1" }), world.productName);
  await page.getByLabel("Cantidad 1").fill("10");
  await expect(page.getByRole("table", { name: "Productos de la venta" })).toContainText(
    "Lista del cliente",
  );
  await expect(page.getByTestId("draft-total")).toContainText("$11.000,00");
  await page.getByRole("button", { name: "Guardar y ver la entrega" }).click();
  await page.getByRole("button", { name: "Confirmar entrega y venta" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar entrega y venta" }).click();
  await expect(heading).toContainText("Entregada");

  // Ajuste a favor con motivo.
  await page.goto(`/cuentas-a-cobrar/${world.customerId}`);
  await expect(page.getByTestId("account-balance")).toHaveText("Debe $11.000,00");
  await page.getByRole("button", { name: "Ajustar saldo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Monto/).fill("1000");
  await dialog.getByLabel("Motivo").fill("Bonificación por demora");
  await dialog.getByRole("button", { name: "Registrar ajuste" }).click();
  await expect(page.getByTestId("account-balance")).toHaveText("Debe $10.000,00");
  await expect(
    page.getByRole("table", { name: "Movimientos de la cuenta corriente" }),
  ).toContainText("Bonificación por demora");

  expect(consoleErrors).toEqual([]);
});
