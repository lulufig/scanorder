ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS confirmado_at DATETIME NULL AFTER created_at,
  ADD COLUMN IF NOT EXISTS preparacion_at DATETIME NULL AFTER confirmado_at,
  ADD COLUMN IF NOT EXISTS listo_at DATETIME NULL AFTER preparacion_at,
  ADD COLUMN IF NOT EXISTS entregado_at DATETIME NULL AFTER listo_at;

UPDATE pedidos
SET confirmado_at = COALESCE(confirmado_at, created_at)
WHERE estado IN ('confirmado', 'en_preparacion', 'listo', 'entregado');

UPDATE pedidos
SET preparacion_at = COALESCE(preparacion_at, confirmado_at, created_at)
WHERE estado IN ('en_preparacion', 'listo', 'entregado');

UPDATE pedidos
SET listo_at = COALESCE(listo_at, preparacion_at, confirmado_at, created_at)
WHERE estado IN ('listo', 'entregado');

UPDATE pedidos
SET entregado_at = COALESCE(entregado_at, listo_at, preparacion_at, confirmado_at, created_at)
WHERE estado = 'entregado';
