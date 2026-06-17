FROM python:3.12-slim

# Cliente MySQL para el init script (mysqladmin ping, mysql cli)
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias Python primero (capa cacheada mientras no cambie requirements.txt)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el código del backend
COPY backend/ ./

# Copiar schema SQL para el init script
COPY docs/database.sql /app/docs/database.sql

RUN chmod +x scripts/init_app.sh

EXPOSE 8000

ENTRYPOINT ["sh", "scripts/init_app.sh"]
