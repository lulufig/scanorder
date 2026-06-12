-- ============================================================
-- Migración 005: Registro de cierres de cuenta por mesa
-- Requiere: tablas mesas, pedidos y usuarios ya existentes.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- TABLA: cierres_mesa
-- Cabecera del evento de cobro.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cierres_mesa (
    id_cierre           INT             AUTO_INCREMENT PRIMARY KEY,
    id_mesa             INT             NOT NULL,
    numero_mesa         INT             NOT NULL,
    metodo_pago         ENUM(
                            'efectivo',
                            'tarjeta',
                            'qr',
                            'otro'
                        )               NOT NULL DEFAULT 'efectivo',
    total_consumido     DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    monto_cobrado       DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    vuelto              DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    id_usuario_cierre   INT             DEFAULT NULL,
    observaciones       VARCHAR(255)    DEFAULT NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_cierre_fecha   (created_at),
    INDEX idx_cierre_mesa    (id_mesa),
    INDEX idx_cierre_usuario (id_usuario_cierre),

    CONSTRAINT fk_cierre_mesa
        FOREIGN KEY (id_mesa)
        REFERENCES mesas (id_mesa)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_cierre_usuario
        FOREIGN KEY (id_usuario_cierre)
        REFERENCES usuarios (id_usuario)
        ON UPDATE CASCADE
        ON DELETE SET NULL

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ──────────────────────────────────────────────────────────
-- TABLA: cierre_pedidos
-- Líneas normalizadas: qué pedidos fueron cobrados en cada cierre.
-- UNIQUE(id_pedido) impide que un pedido aparezca en dos cierres.
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cierre_pedidos (
    id_cierre_pedido    INT             AUTO_INCREMENT PRIMARY KEY,
    id_cierre           INT             NOT NULL,
    id_pedido           INT             NOT NULL,
    total_pedido        DECIMAL(10, 2)  NOT NULL,

    UNIQUE KEY uq_pedido_unico (id_pedido),

    INDEX idx_cp_cierre (id_cierre),

    CONSTRAINT fk_cp_cierre
        FOREIGN KEY (id_cierre)
        REFERENCES cierres_mesa (id_cierre)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_cp_pedido
        FOREIGN KEY (id_pedido)
        REFERENCES pedidos (id_pedido)
        ON UPDATE CASCADE
        ON DELETE RESTRICT

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
