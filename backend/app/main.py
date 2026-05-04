from dotenv import load_dotenv
load_dotenv()  # debe ejecutarse antes de cualquier import que lea variables de entorno

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from pathlib import Path

# Importar rutas
from app.routes import auth, productos, mesas, pedidos, reportes

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
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]


# Configurar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_origin_regex=os.getenv("CORS_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?"),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Registrar rutas
app.include_router(auth.router)
app.include_router(productos.router)
app.include_router(mesas.router)
app.include_router(pedidos.router)
app.include_router(reportes.router)

# Servir archivos estáticos (QR images)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

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
