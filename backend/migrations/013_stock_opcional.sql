-- 013_stock_opcional.sql
-- Control de stock: se puede desactivar por producto.
--
-- Por defecto TODOS los productos llevan seguimiento de stock (igual que antes
-- de esta migración): aparecen en el panel de Inventario, bloquean la creación
-- de pedidos por falta de stock y se les descuenta al entregar.
--
-- El admin puede EXCLUIR un producto puntual desmarcando el checkbox
-- "Controlar el stock de este producto" en el modal de Productos — útil para
-- ítems que no vale la pena inventariar (agua, servilletas, etc.).
--
-- Idempotente: se reaplica en cada arranque del contenedor sin efectos.
-- No hay UPDATE de datos a propósito — así el flag nunca pisa lo que el admin
-- decidió. Para instalaciones que ya tenían la 013 con default FALSE, correr
-- una vez a mano:  UPDATE productos SET controla_stock = TRUE;

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS controla_stock BOOLEAN NOT NULL DEFAULT TRUE;
