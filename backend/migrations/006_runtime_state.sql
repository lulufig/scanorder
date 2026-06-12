CREATE TABLE IF NOT EXISTS mesa_estado_operativo (
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

CREATE TABLE IF NOT EXISTS mesa_sesiones_snapshot (
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
