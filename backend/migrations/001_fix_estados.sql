-- Migracion 001: corregir columna estado en pedidos
--
-- PROBLEMA: si la columna estado es ENUM y no incluye 'confirmado',
-- MySQL puede guardar ese valor como cadena vacia. En cocina el pedido
-- parece desaparecer porque no entra en ninguna columna.
--
-- SOLUCION: convertir la columna a VARCHAR(20) y reparar pedidos vacios.

USE scanorder_db;

ALTER TABLE pedidos
  MODIFY COLUMN estado VARCHAR(20) NOT NULL DEFAULT 'pendiente';

UPDATE pedidos
SET estado = 'confirmado'
WHERE estado = '';

-- Verificacion:
-- SHOW COLUMNS FROM pedidos LIKE 'estado';
-- SELECT estado, COUNT(*) FROM pedidos GROUP BY estado;
