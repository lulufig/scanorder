-- Migración 011: flujo completo de autenticación.
-- Agrega tabla password_reset_tokens para recuperación de contraseña por email.
-- email y must_change_password ya existen (schema base + migración 007).
-- Idempotente: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          INT          AUTO_INCREMENT PRIMARY KEY,
    id_usuario  INT          NOT NULL,
    token       VARCHAR(255) NOT NULL UNIQUE,
    expira_en   DATETIME     NOT NULL,
    usado       BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_prt_token      (token),
    INDEX idx_prt_usr_usado  (id_usuario, usado),

    CONSTRAINT fk_prt_usuario
        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
