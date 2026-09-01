from dotenv import load_dotenv
load_dotenv()  # debe ejecutarse antes de cualquier import que lea variables de entorno

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
from pathlib import Path
from urllib.parse import urlparse

# Importar rutas
from app.routes import auth, productos, mesas, pedidos, reportes, caja
from app.routes.admin import router as admin_router
from app.routes.inventario import router as inventario_router, movimientos_router

# Crear instancia de FastAPI
app = FastAPI(
    title=os.getenv("APP_NAME", "ScanOrder"),
    description="Sistema de gestión de pedidos con QR para Maven Burger",
    version="1.0.0"
)

def get_cors_origins() -> list[str]:
    raw_origins = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000"
    )
    origins = [o.strip() for o in raw_origins.split(",") if o.strip()]

    # Agrega automáticamente el origen del frontend configurado en MENU_URL
    menu_url = os.getenv("MENU_URL", "")
    if menu_url:
        parsed = urlparse(menu_url)
        menu_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
        if menu_origin and menu_origin not in origins:
            origins.append(menu_origin)

    return origins


# Configurar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_origin_regex=os.getenv("CORS_ORIGIN_REGEX") or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Registrar rutas
app.include_router(auth.router)
app.include_router(admin_router)
app.include_router(productos.router)
app.include_router(mesas.router)
app.include_router(pedidos.router)
app.include_router(reportes.router)
app.include_router(caja.router)
app.include_router(inventario_router)
app.include_router(movimientos_router)

# Los QR se entregan por /mesas/{id}/qr con autenticación de admin.
# No se monta /static para evitar exponer tokens embebidos en imágenes QR.
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Endpoints base
@app.get("/")
def root():
    return {
        "message": "Bienvenido a ScanOrder API",
        "status": "online",
        "version": "1.0.0"
    }

@app.get("/health")
def health_check():
    return {"status": "ok"}
