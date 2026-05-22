-- Permite ubicar cada producto manualmente dentro de una subseccion del menu.
ALTER TABLE productos
ADD COLUMN subcategoria VARCHAR(100) NULL AFTER id_categoria;

UPDATE productos
SET subcategoria = CASE
  WHEN id_categoria = 1 AND LOWER(nombre) LIKE '%papa%' THEN 'Papas Fritas'
  WHEN id_categoria = 1 AND (
    LOWER(nombre) LIKE '%aro%' OR
    LOWER(nombre) LIKE '%crujiente%' OR
    LOWER(nombre) LIKE '%muzzarel%' OR
    LOWER(nombre) LIKE '%raba%' OR
    LOWER(nombre) LIKE '%croqueta%'
  ) THEN 'Entraditas'
  WHEN id_categoria = 1 AND LOWER(nombre) LIKE '%pizza%' THEN 'Pizzas'
  WHEN id_categoria = 1 THEN 'Hamburguesas'
  WHEN id_categoria = 3 AND (
    LOWER(nombre) LIKE '%gin%' OR
    LOWER(nombre) LIKE '%gordon%' OR
    LOWER(nombre) LIKE '%heredero%'
  ) THEN 'Gin Tonic'
  WHEN id_categoria = 3 AND (
    LOWER(nombre) LIKE '%fernet%' OR
    LOWER(nombre) LIKE '%aperol%' OR
    LOWER(nombre) LIKE '%mojito%' OR
    LOWER(nombre) LIKE '%vermut%' OR
    LOWER(nombre) LIKE '%caipi%' OR
    LOWER(nombre) LIKE '%gancia%' OR
    LOWER(nombre) LIKE '%campari%' OR
    LOWER(nombre) LIKE '%tequila%' OR
    LOWER(nombre) LIKE '%tinto%'
  ) THEN 'Super Clasicos'
  WHEN id_categoria = 3 THEN 'Bebida sin alcohol'
  ELSE subcategoria
END
WHERE subcategoria IS NULL;
