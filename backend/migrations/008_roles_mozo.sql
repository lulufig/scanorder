-- 008_roles_mozo.sql
-- Reemplaza el rol "cocina" por "mozo" en la tabla usuarios.
-- El panel de cocina pasa a autenticarse con COCINA_DEVICE_TOKEN (variable de entorno),
-- no con cuenta de usuario. Los mozos usan el nuevo rol "mozo" para marcar estados
-- de pedido y cerrar mesas.
--
-- Aplicar DESPUÉS de cargar docs/database.sql (o sobre la base existente de producción).
-- Idempotente: si ya no existen filas con rol='cocina', los UPDATE no hacen nada.

-- 1. Migrar usuarios existentes con rol cocina → mozo
UPDATE usuarios SET rol = 'mozo' WHERE rol = 'cocina';

-- 2. Cambiar el ENUM para reflejar los roles válidos
ALTER TABLE usuarios
    MODIFY COLUMN rol ENUM('admin', 'mozo') NOT NULL DEFAULT 'mozo';
