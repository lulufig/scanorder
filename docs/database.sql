-- ============================================
-- ScanOrder - Base de datos relacional (3FN)
-- Sistema de gestión de pedidos con QR
-- Maven Burger
-- ============================================

CREATE DATABASE IF NOT EXISTS scanorder_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE scanorder_db;

-- ──────────────────────────────────────────────
-- TABLA: usuarios
-- Usuarios del sistema (admin y mozo)
-- ──────────────────────────────────────────────
CREATE TABLE usuarios (
    id_usuario  INT AUTO_INCREMENT PRIMARY KEY,
    nombre      VARCHAR(100)    NOT NULL,
    email       VARCHAR(150)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)  NOT NULL,
    rol         ENUM('admin', 'mozo') NOT NULL DEFAULT 'mozo',
    activo      BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_usuario_email (email),
    INDEX idx_usuario_rol (rol)
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: mesas
-- Mesas físicas del local, cada una con su QR
-- ──────────────────────────────────────────────
CREATE TABLE mesas (
    id_mesa     INT AUTO_INCREMENT PRIMARY KEY,
    numero      INT             NOT NULL UNIQUE,
    qr_url      VARCHAR(255)    DEFAULT NULL,
    qr_token    VARCHAR(255)    DEFAULT NULL,
    estado      ENUM('disponible', 'ocupada') NOT NULL DEFAULT 'disponible',
    activa      BOOLEAN         NOT NULL DEFAULT TRUE,

    INDEX idx_mesa_estado (estado)
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: categorias
-- Agrupación de productos del menú
-- ──────────────────────────────────────────────
CREATE TABLE categorias (
    id_categoria INT AUTO_INCREMENT PRIMARY KEY,
    nombre       VARCHAR(100)   NOT NULL UNIQUE,
    descripcion  VARCHAR(255)   DEFAULT NULL,
    orden        INT            NOT NULL DEFAULT 0,  -- para ordenar en el menú
    activa       BOOLEAN        NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: productos
-- Ítems del menú vinculados a una categoría
-- ──────────────────────────────────────────────
CREATE TABLE productos (
    id_producto  INT AUTO_INCREMENT PRIMARY KEY,
    id_categoria INT             NOT NULL,
    nombre       VARCHAR(150)    NOT NULL,
    descripcion  TEXT            DEFAULT NULL,
    precio       DECIMAL(10, 2)  NOT NULL,
    subcategoria VARCHAR(100)    DEFAULT NULL,
    imagen_url   VARCHAR(500)    DEFAULT NULL,
    disponible   BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_producto_categoria (id_categoria),
    INDEX idx_producto_disponible (disponible),

    CONSTRAINT fk_producto_categoria
        FOREIGN KEY (id_categoria) REFERENCES categorias(id_categoria)
        ON UPDATE CASCADE
        ON DELETE RESTRICT  -- no borrar categoría si tiene productos
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: mesa_estado_operativo
-- Estado liviano persistente para el mapa del salón
-- ──────────────────────────────────────────────
CREATE TABLE mesa_estado_operativo (
    id_mesa            INT PRIMARY KEY,
    ocupada            BOOLEAN NOT NULL DEFAULT FALSE,
    cuenta_solicitada  BOOLEAN NOT NULL DEFAULT FALSE,
    mozo_solicitado    BOOLEAN NOT NULL DEFAULT FALSE,
    last_activity_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_estado_operativo_mesa
        FOREIGN KEY (id_mesa) REFERENCES mesas(id_mesa)
        ON UPDATE CASCADE
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: mesa_sesiones_snapshot
-- Snapshot persistente de carritos colaborativos activos
-- ──────────────────────────────────────────────
CREATE TABLE mesa_sesiones_snapshot (
    session_key       VARCHAR(300) PRIMARY KEY,
    numero_mesa       INT NOT NULL,
    host_client_id    VARCHAR(100) DEFAULT NULL,
    participantes     INT NOT NULL DEFAULT 0,
    carrito_json      JSON NOT NULL,
    observaciones     TEXT DEFAULT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_mesa_sesion_numero (numero_mesa)
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: pedidos
-- Cabecera del pedido (uno por mesa por sesión)
-- ──────────────────────────────────────────────
CREATE TABLE pedidos (
    id_pedido    INT AUTO_INCREMENT PRIMARY KEY,
    id_mesa      INT             NOT NULL,
    id_usuario   INT             DEFAULT NULL,  -- NULL = creado por cliente vía QR
    estado       VARCHAR(20)      NOT NULL DEFAULT 'pendiente',
    total        DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    observaciones TEXT           DEFAULT NULL,
    confirmado_at DATETIME       DEFAULT NULL,
    preparacion_at DATETIME      DEFAULT NULL,
    listo_at      DATETIME       DEFAULT NULL,
    entregado_at  DATETIME       DEFAULT NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_pedido_mesa (id_mesa),
    INDEX idx_pedido_estado (estado),
    INDEX idx_pedido_fecha (created_at),

    CONSTRAINT chk_pedido_estado
        CHECK (estado IN ('pendiente', 'confirmado', 'en_preparacion', 'listo', 'entregado', 'cancelado')),

    CONSTRAINT fk_pedido_mesa
        FOREIGN KEY (id_mesa) REFERENCES mesas(id_mesa)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,  -- no borrar mesa con pedidos

    CONSTRAINT fk_pedido_usuario
        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE SET NULL   -- si se elimina el usuario, el pedido queda sin asignar
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: cierres_mesa
-- Cabecera de cobros/cierres de cuenta por mesa
-- ──────────────────────────────────────────────
CREATE TABLE cierres_mesa (
    id_cierre           INT             AUTO_INCREMENT PRIMARY KEY,
    id_mesa             INT             NOT NULL,
    numero_mesa         INT             NOT NULL,
    metodo_pago         ENUM('efectivo', 'tarjeta', 'qr', 'otro')
                                      NOT NULL DEFAULT 'efectivo',
    total_consumido     DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    monto_cobrado       DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    vuelto              DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    id_usuario_cierre   INT             DEFAULT NULL,
    observaciones       VARCHAR(255)    DEFAULT NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_cierre_fecha (created_at),
    INDEX idx_cierre_mesa (id_mesa),
    INDEX idx_cierre_usuario (id_usuario_cierre),

    CONSTRAINT fk_cierre_mesa
        FOREIGN KEY (id_mesa) REFERENCES mesas(id_mesa)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_cierre_usuario
        FOREIGN KEY (id_usuario_cierre) REFERENCES usuarios(id_usuario)
        ON UPDATE CASCADE
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: cierre_pedidos
-- Relación normalizada entre cierres y pedidos cobrados
-- ──────────────────────────────────────────────
CREATE TABLE cierre_pedidos (
    id_cierre_pedido INT            AUTO_INCREMENT PRIMARY KEY,
    id_cierre        INT            NOT NULL,
    id_pedido        INT            NOT NULL,
    total_pedido     DECIMAL(10, 2) NOT NULL,

    UNIQUE KEY uq_pedido_unico (id_pedido),
    INDEX idx_cp_cierre (id_cierre),

    CONSTRAINT fk_cp_cierre
        FOREIGN KEY (id_cierre) REFERENCES cierres_mesa(id_cierre)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT fk_cp_pedido
        FOREIGN KEY (id_pedido) REFERENCES pedidos(id_pedido)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ──────────────────────────────────────────────
-- TABLA: detalle_pedidos
-- Líneas individuales de cada pedido
-- ──────────────────────────────────────────────
CREATE TABLE detalle_pedidos (
    id_detalle      INT AUTO_INCREMENT PRIMARY KEY,
    id_pedido       INT             NOT NULL,
    id_producto     INT             NOT NULL,
    cantidad        INT             NOT NULL DEFAULT 1,
    precio_unitario DECIMAL(10, 2)  NOT NULL,  -- precio capturado al momento del pedido
    subtotal        DECIMAL(10, 2)  NOT NULL,  -- cantidad * precio_unitario
    notas           TEXT            DEFAULT NULL,  -- "sin cebolla", "extra queso", etc.

    INDEX idx_detalle_pedido (id_pedido),

    CONSTRAINT fk_detalle_pedido
        FOREIGN KEY (id_pedido) REFERENCES pedidos(id_pedido)
        ON UPDATE CASCADE
        ON DELETE CASCADE,  -- si se borra el pedido, se borran sus líneas

    CONSTRAINT fk_detalle_producto
        FOREIGN KEY (id_producto) REFERENCES productos(id_producto)
        ON UPDATE CASCADE
        ON DELETE RESTRICT  -- no borrar producto si está en un pedido
) ENGINE=InnoDB;
