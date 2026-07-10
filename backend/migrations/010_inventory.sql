-- Migración 010: control de inventario
-- Agrega columnas de stock a productos y crea tabla de auditoría movimientos_stock.
-- Requiere que docs/database.sql ya esté cargado.
-- Idempotente (MySQL 8.0.29+): IF NOT EXISTS en columnas y constraint permite
-- reaplicarla sin error, para que init_app.sh pueda correrla en cada arranque.

-- 1. Columnas de stock en productos
ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS stock_actual INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_minimo INT NOT NULL DEFAULT 0;

-- 2. Constraint: impide que stock_actual quede negativo (MySQL 8.0.16+;
-- IF NOT EXISTS sobre ADD CONSTRAINT requiere MySQL 8.0.29+)
ALTER TABLE productos
  ADD CONSTRAINT IF NOT EXISTS chk_stock_no_negativo CHECK (stock_actual >= 0);

-- 3. Tabla de auditoría de movimientos de stock
CREATE TABLE IF NOT EXISTS movimientos_stock (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    id_producto  INT  NOT NULL,
    cantidad     INT  NOT NULL,
    tipo         ENUM('entrada', 'salida', 'ajuste') NOT NULL,
    id_pedido    INT  DEFAULT NULL,
    motivo       TEXT DEFAULT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by   INT  NOT NULL,

    CONSTRAINT chk_mov_cantidad_no_cero CHECK (cantidad != 0),

    INDEX idx_mov_producto_fecha (id_producto, created_at),
    INDEX idx_mov_pedido (id_pedido),

    CONSTRAINT fk_mov_producto
        FOREIGN KEY (id_producto) REFERENCES productos(id_producto)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT fk_mov_pedido
        FOREIGN KEY (id_pedido) REFERENCES pedidos(id_pedido)
        ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT fk_mov_usuario
        FOREIGN KEY (created_by) REFERENCES usuarios(id_usuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;
