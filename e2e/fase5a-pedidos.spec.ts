import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/*
 * Fase 5A: pedidos, demanda comprometida y necesidades contra la aplicación
 * construida y la base de desarrollo con seed.
 * - Principal: alta con vista previa explicada, confirmar (reserva por lote),
 *   crear la orden de producción desde la necesidad, comprometido/libre en el
 *   lote y en el stock, y Necesidades.
 * - Replanificación: un pedido cancelado libera stock, el otro avisa "Hay nuevo
 *   stock disponible", se modifica con comparación antes/después, pasa a listo y
 *   cancelarlo listo exige confirmación explícita.
 * - Calidad: lo reservado no se transforma; bloquear el lote deja el pedido para
 *   recalcular.
 * El navegador corre en otra zona horaria (Tokio) que la empresa: la fecha de
 * entrega se carga y se muestra en la hora de la empresa.
 */

test.use({ timezoneId: "Asia/Tokyo" });

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

async function confirmDialog(page: Page, trigger: string, confirm = trigger) {
  await page.getByRole("button", { name: trigger, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
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

const DAY = 24 * 60;

/**
 * Producto por kg (receta 100 kg → 75 kg de harina) con conservación fresco 2
 * días / congelado 30 días, stock de harina y un cliente. `produce` completa una
 * orden de N kg (lote fresco); `order` crea y confirma un pedido para mañana.
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
    name: `Secos P${run}`,
  });
  const pr = await call(request, "post", "/api/categories", {
    type: "PRODUCT",
    name: `Panes P${run}`,
  });
  const harinaName = `Harina P${run}`;
  const harina = await call(request, "post", "/api/raw-materials", {
    name: harinaName,
    categoryId: mp.id,
    baseUnitId: units.kg,
    referenceCost: "1000",
  });
  const productName = `Medialuna P${run}`;
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
    nearExpiryMinutes: DAY,
    states: [
      ["FRESH", 2 * DAY, true],
      ["FROZEN", 30 * DAY, false],
    ].map(([state, shelfLifeMinutes, allowedAsInitial]) => ({
      state,
      enabled: true,
      shelfLifeMinutes,
      allowedAsInitial,
      notes: null,
    })),
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
  const customerName = `Hotel Central P${run}`;
  const customer = await call(request, "post", "/api/customers", {
    type: "RETAILER",
    legalName: customerName,
    phone: "11-5555-0000",
  });
  // Mañana en el calendario de la EMPRESA (no del navegador).
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(Date.now() + 86_400_000),
  );
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

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
  const order = async (quantity: string) => {
    const created = await call<{ id: string; code: string }>(request, "post", "/api/orders", {
      customerId: customer.id,
      requestedAt: `${tomorrow}T10:00`,
      lines: [{ productId: product.id, quantity }],
    });
    await call(request, "post", `/api/orders/${created.id}/confirm`, {
      operationId: randomUUID(),
    });
    return created;
  };
  return {
    productId: product.id,
    productName,
    harinaName,
    customerName,
    tomorrow,
    produce,
    order,
  };
}

/** "2026-10-03" → "03/10/2026" (como lo muestra la pantalla). */
const shown = (isoDate: string) => isoDate.split("-").reverse().join("/");

test("Fase 5A: alta con vista previa, confirmar, producir desde la necesidad, comprometido y necesidades", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  const lot = await world.produce("300");
  const heading = page.getByRole("heading", { level: 1 });

  // Alta: cliente, entrega mañana 10:00 (hora de la empresa) y 500 kg.
  await openSection(page, "Pedidos");
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
  await page.getByRole("link", { name: "Nuevo pedido" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nuevo pedido" })).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Cliente" }), world.customerName);
  await page.getByLabel("Entrega o retiro").fill(world.tomorrow);
  await page.getByLabel("Hora", { exact: true }).fill("10:00");
  await selectByText(page.getByRole("combobox", { name: "Producto 1" }), world.productName);
  await page.getByLabel("Cantidad 1").fill("500");

  // Vista previa explicada: hay 300 kg, se reservarían 300 y faltan producir 200.
  const preview = section(page, /^Cobertura para el/);
  await expect(preview.getByRole("heading", { level: 2 })).toContainText(
    `${shown(world.tomorrow)} 10:00`,
  );
  await expect(preview.getByRole("heading", { level: 2 })).toContainText("Cobertura parcial");
  const line = preview.getByTestId("line-coverage");
  await expect(summaryValue(line, "Stock físico")).toHaveText("300 kg");
  await expect(summaryValue(line, "Se reserva")).toHaveText("300 kg");
  await expect(summaryValue(line, "Falta producir")).toHaveText("200 kg");
  await expect(preview).toContainText("no reserva nada");
  await expect(preview).toContainText(world.harinaName);

  // Borrador: no reserva.
  await page.getByRole("button", { name: "Guardar borrador" }).click();
  await expect(heading).toContainText("Borrador");
  const orderCode = (await heading.textContent())!.match(/PED-\d+/)![0];
  await expect(page.getByText("Borrador: todavía no reserva stock")).toBeVisible();
  await expect(page.locator("main")).toContainText(`Retira el ${shown(world.tomorrow)} 10:00`);

  // Confirmar: reserva el lote y registra lo que falta producir.
  await confirmDialog(page, "Confirmar pedido");
  await expect(heading).toContainText("Confirmado");
  await expect(heading).toContainText("Cobertura parcial");
  const reservations = section(page, "Lotes reservados").locator("tbody tr");
  await expect(reservations).toHaveCount(1);
  await expect(reservations.first()).toContainText(lot.code);
  await expect(reservations.first()).toContainText("300 kg");
  const requirement = section(page, "Producción necesaria").locator("tbody tr");
  await expect(requirement).toContainText("200 kg");
  await expect(requirement).toContainText("Pendiente");
  await expect(section(page, "Materias primas para lo que falta producir")).toContainText(
    world.harinaName,
  );
  await expect(
    section(page, "Materias primas para lo que falta producir").getByRole("row", {
      name: new RegExp(world.harinaName),
    }),
  ).toContainText("150 kg");

  // Orden de producción prellenada desde la necesidad, vinculada al pedido.
  await requirement.getByRole("link", { name: "Crear orden de producción" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Nueva orden de producción" }),
  ).toBeVisible();
  await expect(page.getByTestId("from-order")).toContainText(orderCode);
  await expect(page.getByTestId("from-order")).toContainText("200 kg");
  await expect(page.getByLabel("Cantidad a producir")).toHaveValue("200");
  await page.getByRole("button", { name: "Crear borrador" }).click();
  await expect(heading).toContainText("Borrador");
  await expect(page.locator("dl.details")).toContainText(`Creada para ${orderCode}`);
  await page.locator("dl.details").getByRole("link", { name: orderCode }).click();
  await expect(heading).toContainText(orderCode);
  await expect(section(page, "Producción necesaria").locator("tbody tr")).toContainText(
    "Orden de producción creada",
  );

  // Lote: comprometido, libre y el pedido que lo reserva.
  await section(page, "Lotes reservados").getByRole("link", { name: lot.code }).click();
  await expect(heading).toContainText(`Lote ${lot.code}`);
  const lotData = section(page, "Datos del lote");
  await expect(summaryValue(lotData, "Comprometido con pedidos")).toHaveText("300 kg");
  await expect(summaryValue(lotData, /^Libre$/)).toHaveText("0 kg");
  await expect(section(page, "Reservado para pedidos")).toContainText(orderCode);

  // Stock del producto: comprometido y disponible ahora.
  await page.getByRole("link", { name: `← ${world.productName}` }).click();
  const stock = section(page, "Existencias");
  await expect(summaryValue(stock, "Stock físico")).toHaveText("300 kg");
  await expect(summaryValue(stock, "Comprometido con pedidos")).toHaveText("300 kg");
  await expect(summaryValue(stock, "Disponible ahora")).toHaveText("0 kg");

  // Necesidades: producción y materia prima del pedido.
  await openSection(page, "Necesidades");
  await expect(page.getByRole("heading", { level: 1, name: "Necesidades" })).toBeVisible();
  const need = page.getByRole("row").filter({ hasText: world.productName });
  await expect(need).toContainText("200 kg");
  await expect(need).toContainText(orderCode);
  await page
    .getByRole("navigation", { name: "Necesidades" })
    .getByRole("link", { name: "Materias primas", exact: true })
    .click();
  const material = page.getByRole("row").filter({ hasText: world.harinaName });
  await expect(material).toContainText("150 kg");

  // Listado de pedidos.
  await openSection(page, "Pedidos");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(orderCode);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(orderCode);
  const row = page.getByRole("row").filter({ hasText: orderCode });
  await expect(row).toContainText("Cobertura parcial");
  await expect(row).toContainText(`${shown(world.tomorrow)} 10:00`);
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});

test("Fase 5A: stock liberado, modificar con antes/después, listo y cancelar listo", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}r`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  await world.produce("300");
  const first = await world.order("200");
  const second = await world.order("200");
  const heading = page.getByRole("heading", { level: 1 });

  // Cancelar el primero libera 200 kg; el segundo no se reescribe solo.
  await page.goto(`/pedidos/${first.id}`);
  await expect(heading).toContainText(first.code);
  await page.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
  const cancelDialog = page.getByRole("dialog");
  await cancelDialog.getByLabel("Motivo").fill("Lo pidió el cliente");
  await cancelDialog.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
  await expect(heading).toContainText("Cancelado");

  await page.goto(`/pedidos/${second.id}`);
  await expect(heading).toContainText("Cobertura parcial");
  await expect(page.getByTestId("order-issues")).toContainText(
    "Hay nuevo stock disponible — recalcular cobertura",
  );

  // Modificar: 150 kg. La comparación muestra que ya no hace falta producir.
  await page.getByRole("link", { name: "Modificar pedido" }).click();
  await expect(heading).toContainText(`Modificar pedido ${second.code}`);
  await page.getByLabel("Cantidad 1").fill("150");
  const comparison = page.getByTestId("replan-comparison");
  await expect(summaryValue(comparison, /^Cobertura nueva/)).toHaveText("Cubierto");
  const production = comparison.getByRole("table", { name: "Producción" });
  await expect(production.getByRole("row", { name: new RegExp(world.productName) })).toContainText(
    "100 kg",
  );
  await expect(comparison).toContainText("Reservas que se liberan");
  await expect(comparison).toContainText("Reservas nuevas");
  await page.getByRole("button", { name: "Aplicar cambios" }).click();
  await expect(heading).toContainText("Cubierto");
  await expect(page.locator("dl.details")).toContainText("Revisión 2");
  await expect(section(page, "Producción necesaria")).toContainText("No hace falta producir");

  // Listo (todo reservado) y cancelar un pedido listo pide confirmación explícita.
  await confirmDialog(page, "Marcar listo");
  await expect(heading).toContainText("Listo");
  await page.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
  const readyDialog = page.getByRole("dialog");
  await expect(readyDialog).toContainText("El pedido ya está listo");
  await readyDialog.getByLabel("Motivo").fill("Se suspendió el evento");
  await readyDialog.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
  await expect(readyDialog.getByRole("alert").last()).toContainText(
    "confirmá que querés cancelarlo",
  );
  await readyDialog.getByLabel("Entiendo: cancelar igual").check();
  await readyDialog.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
  await expect(heading).toContainText("Cancelado");
  const history = section(page, /^Historial$/);
  await expect(history).toContainText("Cobertura del pedido recalculada");
  await expect(history).toContainText("Pedido listo");
  await expect(history).toContainText("Pedido cancelado");
  await expect(page.locator("main")).not.toContainText(UUID);

  // El único error esperado es el 409 del primer intento de cancelar el pedido listo.
  expect(consoleErrors.filter((e) => !/\/cancel: .*409/.test(e))).toEqual([]);
});

test("Fase 5A: lo reservado no se transforma y bloquear el lote deja el pedido para recalcular", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}q`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const world = await apiWorld(page.request, run);
  const lot = await world.produce("100");
  const order = await world.order("80");
  const heading = page.getByRole("heading", { level: 1 });

  // Congelar: sólo lo libre (20 kg); 50 kg se marca inválido.
  await page.goto(`/stock/lotes/${lot.id}`);
  await expect(summaryValue(section(page, "Datos del lote"), /^Libre$/)).toHaveText("20 kg");
  await page.getByRole("link", { name: "Congelar", exact: true }).click();
  await expect(page.locator(".form__hint")).toContainText(
    "Libre: 20 kg (80 kg reservados para pedidos, no se pueden congelar)",
  );
  await page.getByLabel(/^Cantidad a/).fill("50");
  await expect(page.getByLabel(/^Cantidad a/)).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("link", { name: `← Lote ${lot.code}` }).click();

  // Bloquear por calidad: avisa que invalida reservas.
  await page.getByRole("button", { name: "Bloquear", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("esas reservas se invalidan");
  await dialog.getByLabel("Motivo").fill("Control de calidad");
  await dialog.getByRole("button", { name: "Bloquear lote" }).click();
  await expect(page.getByText("Bloqueado por calidad: Control de calidad")).toBeVisible();

  // El pedido queda para recalcular y no puede pasar a listo.
  await page.goto(`/pedidos/${order.id}`);
  await expect(heading).toContainText("Necesita recalcular");
  await expect(page.getByTestId("order-issues")).toContainText(lot.code);
  await expect(page.getByRole("button", { name: "Marcar listo" })).toBeDisabled();
  const reservations = section(page, "Lotes reservados");
  await reservations.getByRole("button", { name: "Ver historial de reservas" }).click();
  await expect(reservations.locator("tbody tr").first()).toContainText("Invalidado");

  // Recalcular: sin el lote bloqueado, hay que producir los 80 kg.
  await confirmDialog(page, "Recalcular cobertura");
  await expect(heading).toContainText("Sin cobertura");
  await expect(section(page, "Producción necesaria").locator("tbody tr")).toContainText("80 kg");
  await expect(page.locator("main")).not.toContainText(UUID);

  expect(consoleErrors).toEqual([]);
});
