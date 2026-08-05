-- Migración 012: elimina la columna redundante cierres_mesa.numero_mesa
-- numero_mesa duplicaba mesas.numero (accesible vía id_mesa, que sí tiene FK).
-- Ningún endpoint ni reporte la lee: se escribía en el INSERT y nunca se
-- volvía a consultar (todo lo que necesita el número de mesa hace
-- JOIN/lookup contra la tabla mesas). Era una violación de 3FN
-- (dependencia transitiva vía id_mesa) sin beneficio funcional real.
-- Idempotente (MySQL 8.0.29+): IF EXISTS permite reaplicarla sin error.

ALTER TABLE cierres_mesa
  DROP COLUMN IF EXISTS numero_mesa;
