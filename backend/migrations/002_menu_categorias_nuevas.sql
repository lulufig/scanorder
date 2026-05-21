-- Alinear categorias reales de la base con las categorias visuales del menu QR.
-- Mapeo:
-- - Hamburguesas + Acompañamientos -> Comidas
-- - Bebidas -> Cocteleria
-- - Acompañamientos queda reutilizada como Cervezas
-- - Postres se mantiene

UPDATE productos
SET id_categoria = 1
WHERE id_categoria = 2;

UPDATE categorias
SET nombre = 'Comidas',
    descripcion = 'Hamburguesas, combos y principales',
    orden = 1,
    activa = TRUE
WHERE id_categoria = 1;

UPDATE categorias
SET nombre = 'Cervezas',
    descripcion = 'Rubias, rojas, negras y tiradas',
    orden = 2,
    activa = TRUE
WHERE id_categoria = 2;

UPDATE categorias
SET nombre = 'Cocteleria',
    descripcion = 'Tragos, aperitivos y bebidas de autor',
    orden = 3,
    activa = TRUE
WHERE id_categoria = 3;

UPDATE categorias
SET nombre = 'Postres',
    descripcion = 'Opciones dulces para cerrar la mesa',
    orden = 4,
    activa = TRUE
WHERE id_categoria = 4;
