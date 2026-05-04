-- Migración 001: Corregir columna estado en pedidos
--
-- PROBLEMA: Si la columna estado es ENUM('pendiente','en_preparacion','listo'),
-- los valores 'confirmado' y 'entregado' no se guardan correctamente en MySQL
-- (modo no-estricto los convierte a cadena vacía), haciendo que los pedidos
-- desaparezcan del panel de cocina al confirmarlos.
--
-- SOLUCIÓN: Convertir la columna a VARCHAR(20) para admitir todos los estados.
--
-- Ejecutar en phpMyAdmin > pestaña SQL, o en MySQL CLI:
--   USE scanorder_db;
--   source /ruta/a/este/archivo.sql;

USE scanorder_db;

ALTER TABLE pedidos
  MODIFY COLUMN estado VARCHAR(20) NOT NULL DEFAULT 'pendiente';

-- Verificación: debe mostrar la columna estado como varchar(20)
-- SHOW COLUMNS FROM pedidos LIKE 'estado';
