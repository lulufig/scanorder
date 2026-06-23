-- 009_fix_rol_vacio.sql
-- Corrige usuarios que quedaron con rol='' (valor ENUM inválido) luego de la
-- migración 008. Ocurrió porque esos usuarios ya tenían rol inválido antes de
-- que se corriera el UPDATE WHERE rol='cocina', por lo que 008 no los tocó.
UPDATE usuarios SET rol = 'mozo' WHERE rol = '';
