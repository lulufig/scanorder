-- Migración 007: agregar flag de cambio de contraseña obligatorio al primer login.
-- Idempotente: IF NOT EXISTS no falla si ya existe la columna.

ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS must_change_password
        BOOLEAN NOT NULL DEFAULT FALSE
        COMMENT 'TRUE = el usuario debe cambiar su contraseña en el próximo login';
