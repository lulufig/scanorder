-- 015_propina.sql
-- Propina registrada en cada cierre de mesa.
--
-- Hasta ahora la propina en efectivo quedaba escondida dentro de `vuelto` (el
-- cliente pagaba de más y le decía al mozo "quedate con el cambio", pero el
-- sistema lo registraba como vuelto que nunca se devolvió). Esta columna la
-- separa: el mozo indica cuánto de lo recibido es propina y
--   vuelto = monto_cobrado - total_consumido - propina
--
-- Idempotente (ADD COLUMN IF NOT EXISTS). DEFAULT 0.00 → los cierres viejos y
-- cualquier INSERT que no la mande quedan en 0. Se reaplica en cada arranque
-- del contenedor sin efecto.

ALTER TABLE cierres_mesa
  ADD COLUMN IF NOT EXISTS propina DECIMAL(10, 2) NOT NULL DEFAULT 0.00;
