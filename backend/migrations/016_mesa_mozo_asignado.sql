-- 016_mesa_mozo_asignado.sql
-- Asignación simple de mesa → mozo responsable. SIN sistema de turnos.
--
-- El mozo "toma" la mesa desde el panel (POST /mesas/{id}/asignarme). Es un
-- AVISO, no un bloqueo: si otro mozo cobra una mesa que no es la suya, el
-- frontend le pide confirmación pero lo deja hacerlo (la atribución real del
-- cobro sigue siendo cierres_mesa.id_usuario_cierre). Se limpia al cerrar o
-- liberar la mesa → una asignación por ciclo.
--
-- Sin FK a usuarios (igual que mozo_llamados): un id colgado simplemente no
-- muestra nombre (LEFT JOIN). Idempotente.

ALTER TABLE mesas
  ADD COLUMN IF NOT EXISTS id_mozo_asignado INT NULL;
