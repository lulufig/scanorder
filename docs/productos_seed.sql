-- =============================================================
-- Datos de prueba: categorías y productos de Maven Burger
-- Ejecutar en phpMyAdmin o MySQL antes de levantar el backend
-- =============================================================

USE scanorder_db;

-- Categorías
INSERT INTO categorias (nombre, descripcion) VALUES
    ('Hamburguesas', 'Nuestras burgers artesanales'),
    ('Acompañamientos', 'Papas, anillos y más'),
    ('Bebidas', 'Bebidas frías y calientes'),
    ('Postres', 'Para cerrar con dulzura');

-- Productos
-- id_categoria 1 = Hamburguesas
-- id_categoria 2 = Acompañamientos
-- id_categoria 3 = Bebidas
-- id_categoria 4 = Postres

INSERT INTO productos (nombre, descripcion, precio, id_categoria, imagen_url, disponible) VALUES
    ('Maven Classic',       'Medallón de res, lechuga, tomate, cebolla y salsa especial de la casa',          1200.00, 1, NULL, TRUE),
    ('Double Maven',        'Doble medallón de res, doble cheddar, pepinillos y mostaza artesanal',            1700.00, 1, NULL, TRUE),
    ('Crispy Chicken',      'Pechuga de pollo crocante, coleslaw, jalapeños y mayonesa de ajo',               1350.00, 1, NULL, TRUE),
    ('BBQ Smokehouse',      'Medallón de res, panceta crocante, cebolla caramelizada y salsa BBQ ahumada',    1550.00, 1, NULL, TRUE),
    ('Veggie Maven',        'Medallón de lentejas y remolacha, aguacate, rúcula y aderezo de limón',          1250.00, 1, NULL, TRUE),
    ('Papas Fritas Clásicas','Papas cortadas a mano, fritas y saladas al instante',                            450.00,  2, NULL, TRUE),
    ('Papas con Cheddar',   'Papas fritas bañadas en salsa de cheddar derretido',                             600.00,  2, NULL, TRUE),
    ('Aros de Cebolla',     'Aros rebozados y fritos, crujientes por fuera y tiernos por dentro',             500.00,  2, NULL, TRUE),
    ('Gaseosa',             'Coca-Cola, Sprite o Fanta — tamaño mediano 400 ml',                              350.00,  3, NULL, TRUE),
    ('Limonada Artesanal',  'Limón exprimido, menta fresca y agua con gas',                                   450.00,  3, NULL, TRUE),
    ('Milkshake Vainilla',  'Helado artesanal de vainilla batido con leche fría',                             700.00,  4, NULL, TRUE),
    ('Brownie con Helado',  'Brownie de chocolate tibio servido con una bocha de helado de crema',            650.00,  4, NULL, TRUE);
