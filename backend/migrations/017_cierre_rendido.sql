-- 017_cierre_rendido.sql
-- Rendición del efectivo a caja, por cobro (no por turno).
--
-- La mayoría de los mozos cobran una mesa en efectivo y van a entregar la plata
-- a caja en el momento. Esta columna marca ese cobro puntual como "ya entregué
-- el efectivo": rendido_at (cuándo) + rendido_por (qué usuario lo marcó).
--
-- Solo aplica a cobros en efectivo — tarjeta/QR van directo a la cuenta del
-- local, no se rinden. NULL = pendiente de rendir.
--
-- Idempotente. Sin FK a usuarios (igual que id_mozo_asignado / mozo_llamados).

ALTER TABLE cierres_mesa
  ADD COLUMN IF NOT EXISTS rendido_at  DATETIME NULL,
  ADD COLUMN IF NOT EXISTS rendido_por INT NULL;
