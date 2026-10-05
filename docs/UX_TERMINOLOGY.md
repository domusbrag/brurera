# Terminología de la interfaz

Un término, un significado, en todas las pantallas. Si una pantalla necesita otra palabra, primero se
cambia acá. Los textos de la API que llegan a la pantalla siguen las mismas reglas.

## Stock y lotes

| Término                     | Significado                                                                                       | No usar                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Stock físico**            | Lo que hay en el depósito, se pueda usar o no (incluye vencido y bloqueado).                      | Existencia, cantidad real                                                  |
| **Comprometido**            | Parte del stock reservada para pedidos confirmados. Sigue en el depósito pero ya tiene dueño.     | Reservado (sólo en el detalle de un lote o pedido: "reservado para PED-…") |
| **Disponible**              | Lo que se puede vender o usar hoy: stock utilizable (no vencido ni bloqueado) menos comprometido. | Libre, stock válido                                                        |
| **Falta producir**          | Cantidad de un pedido que no se cubre con stock y hay que hornear.                                | Sin cubrir, faltante (salvo en filtros: "Con faltantes")                   |
| **Lote**                    | Una tanda producida o recibida, con código `LOT-…`, fecha de vencimiento y conservación.          | Partida                                                                    |
| **Vence** / **Vencimiento** | Fecha y hora límite de uso del lote.                                                              | Usable hasta, caducidad                                                    |
| **Próximo a vencer**        | Lote dentro del umbral de aviso del producto.                                                     | Por vencer (se acepta en el menú: "Próximos a vencer")                     |
| **Bloqueado**               | Lote que no se puede usar ni vender hasta que alguien lo libere (control de calidad).             | Retenido                                                                   |
| **Merma**                   | Baja de stock por pérdida, rotura o vencimiento.                                                  | Desperdicio                                                                |
| **Conservación**            | Estado del producto: ambiente, refrigerado, congelado, etc.                                       | Estado de conservación (en tablas basta "Conservación")                    |

## Costos y márgenes (sólo con permiso)

| Término                     | Significado                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Costo material**          | Costo de las materias primas usadas, según los lotes que efectivamente salen. No incluye mano de obra ni gastos.           |
| **Costo promedio**          | Costo promedio ponderado de una materia prima en stock.                                                                    |
| **Margen sobre materiales** | Precio neto menos costo material. Se muestra en monto y porcentaje; en rojo si es negativo. No es la ganancia del negocio. |

Quien no tiene permiso de costos no ve la columna ni el dato: no se muestra "Costo: —".

## Comercial y cobranza

| Término                        | Significado                                                                                                                        | No usar                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Pedido** (`PED-…`)           | Encargo de un cliente para una fecha y hora, que compromete stock o producción.                                                    | Orden de venta                                        |
| **Venta** (`VTA-…`)            | Entrega efectiva a un cliente: descuenta stock y genera la deuda. Puede venir de un pedido o ser directa (mostrador).              | Factura (no hay facturación todavía)                  |
| **Venta de mostrador**         | Venta directa, sin pedido previo, normalmente a Consumidor Final.                                                                  | Venta directa (se acepta como origen en filtros)      |
| **Borrador**                   | Venta o pedido guardado que todavía no movió stock ni generó deuda.                                                                | Pendiente                                             |
| **Cobro** (`COB-…`)            | Dinero recibido de un cliente: de una venta, una seña o a cuenta.                                                                  | Pago (desde el punto de vista del cliente sí: "pagó") |
| **Seña**                       | Cobro anticipado de un pedido; se aplica a la venta cuando se entrega.                                                             | Anticipo (se acepta en textos de ayuda)               |
| **Saldo pendiente** / **Debe** | Lo que el cliente adeuda.                                                                                                          | Deuda (se acepta en ayudas)                           |
| **Crédito a favor**            | Plata del cliente que quedó sin aplicar (cobro mayor que la deuda o seña sobrante).                                                | Saldo negativo                                        |
| **Imputar**                    | Aplicar un crédito a favor a una venta pendiente. Siempre con una ayuda que lo explique la primera vez que aparece en la pantalla. | —                                                     |
| **Cuenta corriente**           | Movimientos y saldo de un cliente.                                                                                                 | Ledger, libro mayor                                   |
| **Consumidor Final**           | Cliente genérico de mostrador. Paga en el momento.                                                                                 | Cliente ocasional                                     |

## Producción y compras

| Término                          | Significado                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Orden de producción** (`OP-…`) | Qué producto hornear, cuánto, para cuándo y, si corresponde, para qué pedido.                            |
| **Planificación**                | Pantalla de necesidades: qué hay que producir y qué materias primas hacen falta para cubrir los pedidos. |
| **Receta** / **Versión vigente** | Ingredientes y rendimiento con que se produce hoy un producto.                                           |
| **Compra** (`OC-…`)              | Pedido a un proveedor. **Recepción** (`REC-…`): lo que efectivamente llegó; es lo que suma stock.        |

## Formatos

- **Plata:** `$ 12.345,67` (separador de miles con punto, decimales con coma, siempre dos decimales).
  Lo formatea `formatMoney`, con la moneda del documento.
- **Cantidades:** siempre con unidad: `20 kg`, `1,5 kg`, `12 un`. Hasta tres decimales, sin ceros de más.
- **Fechas:** `dd/mm/aaaa`. **Fecha y hora:** `dd/mm/aaaa HH:mm`, siempre en la zona horaria de la empresa
  (no la del navegador).
- **Códigos** (`PED-0001`, `VTA-0001`, `OP-0001`, `LOT-…`, `COB-…`, `OC-…`): mismo estilo en todas las
  pantallas, enlazados a su detalle y con botón para copiarlos en el encabezado del detalle.
- **Porcentajes:** `12,5 %`.

## Lenguaje

- Voseo rioplatense e imperativo para acciones: "Guardá", "Revisá", "Elegí".
- Errores: qué pasó y qué hacer, sin códigos internos (`VALIDATION_ERROR`, nombres de tablas, UUIDs).
- Botones con verbo + objeto cuando hay ambigüedad: "Confirmar venta", "Registrar cobro". En los diálogos
  de confirmación, el botón para salir sin hacer nada es **Volver**, para no confundirlo con "Cancelar
  pedido" o "Cancelar orden". En formularios, **Cancelar** sale sin guardar.
- Historial en lenguaje humano: "Venta confirmada por Ana · 05/10/2026 14:30", no "sale.posted".
