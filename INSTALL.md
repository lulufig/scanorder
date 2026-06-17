# Guía de instalación — ScanOrder

Instrucciones para instalar ScanOrder en una computadora con Windows, Mac o Linux. No se necesita saber programar.

---

## Requisitos previos

- Computadora conectada a la red local del restaurante (wifi o cable)
- Acceso a internet para descargar Docker

---

## Pasos

### 1. Instalá Docker Desktop

Descargá e instalá Docker Desktop desde **https://www.docker.com/products/docker-desktop**.

Cuando termine, abrí Docker Desktop y esperá hasta que el ícono de la ballena en la barra de tareas esté verde (puede tardar 1-2 minutos).

---

### 2. Descargá el código del sistema

Descargá el archivo ZIP del proyecto y descomprimilo en una carpeta, por ejemplo `C:\scanorder` (Windows) o `~/scanorder` (Mac/Linux).

---

### 3. Creá el archivo de configuración

Dentro de la carpeta `scanorder`, copiá el archivo `.env.example` y renombrá la copia a `.env`.

Abrí `.env` con el Bloc de notas (Windows) o TextEdit (Mac) y completá estas líneas:

```
DB_PASSWORD=UnaContraseñaParaMySQL
MYSQL_ROOT_PASSWORD=UnaContraseñaParaMySQL
SECRET_KEY=PegáAquíUnaClaveSecretaLarga
MENU_URL=http://192.168.1.XXX/frontend/cliente/menu.html
ADMIN_EMAIL=tuEmail@ejemplo.com
```

**Cómo obtener la IP de tu computadora:**
- Windows: abrí el símbolo del sistema (`cmd`) y escribí `ipconfig`. Buscá la línea "Dirección IPv4" bajo tu adaptador de red (ej: `192.168.1.100`).
- Mac: menú Apple → Preferencias → Red → seleccioná tu red → anotá la IP.

**Cómo generar la SECRET_KEY:**
Abrí la terminal de tu sistema y ejecutá:
```
docker run --rm python:3.12-slim python -c "import secrets; print(secrets.token_hex(32))"
```
Copiá el resultado y pegalo en `SECRET_KEY=`.

Guardá el archivo `.env`.

---

### 4. Levantá el sistema

Abrí una terminal (PowerShell en Windows, Terminal en Mac/Linux), navegá hasta la carpeta `scanorder` y ejecutá:

```
docker compose up -d
```

La primera vez puede tardar 5-10 minutos porque descarga las imágenes de MySQL y Python.

---

### 5. Revisá los logs para obtener la contraseña del admin

Ejecutá:

```
docker compose logs app
```

Buscá el bloque con las credenciales:

```
============================================================
  USUARIO ADMIN CREADO
  Email:      admin@scanorder.local
  Contraseña: xxxxxxxxxxxxxxxxxx
  IMPORTANTE: cambiá la contraseña en el primer login.
============================================================
```

Anotá esa contraseña. Aparece solo en el primer arranque.

---

### 6. Abrí el sistema en el navegador

En la computadora donde está corriendo Docker:

```
http://localhost/frontend/login.html
```

Desde otra computadora en la misma red:

```
http://192.168.1.XXX/frontend/login.html
```

(Reemplazá la IP con la de tu computadora.)

---

### 7. Iniciá sesión y cambiá la contraseña

Usá el email y la contraseña que encontraste en los logs. El sistema te va a pedir que elijas una contraseña nueva antes de continuar.

---

### 8. Configurá las mesas y el menú

En el panel de admin:
- **Productos**: cargá las categorías y los productos del menú.
- **Mesas**: creá las mesas del restaurante.
- **QR**: generá y descargá los códigos QR de cada mesa para imprimirlos.

---

### 9. (Opcional) Crear más usuarios

Desde el panel admin podés crear usuarios adicionales con rol `cocina` para los dispositivos de cocina.

---

### 10. Detener y reiniciar el sistema

Para detener:
```
docker compose down
```

Para reiniciar (sin perder datos):
```
docker compose up -d
```

Los datos de MySQL se guardan en un volumen persistente: incluso si apagás la computadora, al volver a levantar Docker los datos siguen ahí.

---

## Preguntas frecuentes

**¿Qué pasa si olvido la contraseña del admin?**
Conectate a la base de datos con un cliente MySQL (ej: DBeaver o TablePlus) y ejecutá:
```sql
UPDATE usuarios SET must_change_password = TRUE WHERE email = 'tu@email.com';
```
Luego generá un nuevo hash con el script `backend/scripts/create_admin.py` o pedile ayuda a quien instaló el sistema.

**¿Puedo actualizar el sistema?**
Descargá la nueva versión del proyecto, detené el sistema con `docker compose down`, reemplazá los archivos (sin borrar tu `.env`) y volvé a ejecutar `docker compose up -d --build`.

**Los QR no funcionan desde los celulares.**
Verificá que `MENU_URL` en `.env` tenga la IP correcta de la computadora (no `localhost`). Luego regenerá los QR desde el panel admin.
