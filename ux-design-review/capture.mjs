// Capturas de revisión visual (UX/DESIGN OPTIMIZATION). No forma parte del runtime.
// Uso: node ux-design-review/capture.mjs <carpeta-salida>  (con API en :4000 y web en :3000)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = process.argv[2] ?? "ux-design-review/after";
const BASE = "http://localhost:3000";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
const VIEWPORTS = {
  1440: { width: 1440, height: 900 },
  1366: { width: 1366, height: 768 },
  768: { width: 768, height: 1024 },
};

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${BASE}/login`);
await page.getByLabel("Email").fill(EMAIL);
await page.getByLabel("Contraseña").fill(PASSWORD);
await page.getByRole("button", { name: "Ingresar" }).click();
await page.waitForURL(`${BASE}/`);

const api = async (path) => {
  const res = await context.request.get(`${BASE}${path}`);
  return res.ok() ? res.json() : null;
};
const first = async (path, pick = (items) => items[0]) => {
  const body = await api(path);
  return body?.items?.length ? pick(body.items) : null;
};

const order =
  (await first("/api/orders?status=CONFIRMED&pageSize=50")) ??
  (await first("/api/orders?pageSize=50"));
const sale = await first("/api/sales?status=POSTED&pageSize=50");
const production =
  (await first("/api/production-orders?status=COMPLETED&pageSize=50")) ??
  (await first("/api/production-orders?pageSize=50"));
const productStock = await first(
  "/api/inventory/products?pageSize=50",
  (items) => items.find((i) => Number(i.quantity) > 0) ?? items[0],
);
const account = null;
const receivable = account ?? (await first("/api/customer-accounts?pageSize=50"));
const purchase = await first("/api/purchases?pageSize=50");

const routes = [
  ["inicio", "/"],
  ["pedidos", "/pedidos"],
  ["pedido", order && `/pedidos/${order.id}`],
  ["pedido-nuevo", "/pedidos/nuevo"],
  ["ventas", "/ventas"],
  ["venta-nueva", "/ventas/nueva"],
  ["venta", sale && `/ventas/${sale.id}`],
  ["produccion", "/produccion"],
  ["orden", production && `/produccion/${production.id}`],
  ["necesidades", "/necesidades"],
  ["stock", "/stock"],
  ["productos-terminados", "/stock/productos"],
  ["stock-producto", productStock && `/stock/productos/${productStock.product.id}`],
  ["por-vencer", "/stock/productos/por-vencer"],
  ["compras", "/compras"],
  ["compra", purchase && `/compras/${purchase.id}`],
  ["cuentas", "/cuentas-a-cobrar"],
  ["cuenta", receivable && `/cuentas-a-cobrar/${receivable.customer?.id ?? receivable.id}`],
];

// Las mismas fichas antes y después: la primera corrida fija las rutas.
const ROUTES_FILE = "ux-design-review/routes.json";
const fixed = existsSync(ROUTES_FILE) ? JSON.parse(readFileSync(ROUTES_FILE, "utf8")) : null;
if (!fixed) writeFileSync(ROUTES_FILE, JSON.stringify(routes, null, 2));

for (const [name, path] of fixed ?? routes) {
  if (!path) {
    console.warn(`(sin datos) ${name}`);
    continue;
  }
  for (const [vw, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${name}-${vw}.png`, fullPage: true });
  }
  console.warn(`ok ${name} → ${path}`);
}
await browser.close();
