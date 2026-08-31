-- 014_mozo_llamados.sql
-- Trazabilidad de llamados de mozo / pedidos de cuenta desde el salón.
--
-- COMPLEMENTA (no reemplaza) los flags mozo_solicitado / cuenta_solicitada de
-- mesa_estado_operativo (migración 006), que siguen siendo la fuente de verdad
-- de "hay un llamado abierto en esta mesa". Esta tabla agrega solo dos cosas:
--
--   1. TIMING  — hace cuánto que la mesa llamó, para el cronómetro del panel
--                del mozo y la escalada visual (rojo/pulso pasados N minutos).
--   2. ATRIBUCIÓN — qué mozo "tomó" el llamado ("voy yo", visible en todos los
--                paneles para que no vayan dos o ninguno) y quién lo cerró.
--
-- El panel del mozo sigue pintando el color/alerta de la mesa a partir del
-- booleano de mesa_estado_operativo; mozo_llamados solo alimenta el "· hace
-- X min" y el "Lucía va en camino". Si esta migración no está aplicada, todo
-- degrada en silencio al comportamiento anterior (cartel sin cronómetro).
--
-- Idempotente: CREATE TABLE IF NOT EXISTS. Se reaplica en cada arranque del
-- contenedor sin efectos (init_app.sh recorre migrations/*.sql >= 007).

CREATE TABLE IF NOT EXISTS mozo_llamados (
    id_llamado     INT AUTO_INCREMENT PRIMARY KEY,
    id_mesa        INT NOT NULL,
    tipo           VARCHAR(10) NOT NULL,            -- 'mozo' | 'cuenta'
    solicitado_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tomado_at      DATETIME NULL,                   -- un mozo dijo "voy yo"
    tomado_por     INT NULL,                        -- id_usuario que lo tomó
    atendido_at    DATETIME NULL,                   -- llamado cerrado
    atendido_por   INT NULL,                        -- id_usuario que lo cerró
    CONSTRAINT fk_mozo_llamados_mesa
        FOREIGN KEY (id_mesa) REFERENCES mesas(id_mesa)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    INDEX idx_mozo_llamados_abierto (id_mesa, atendido_at)
) ENGINE=InnoDB;
