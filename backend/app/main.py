from dotenv import load_dotenv
load_dotenv()  # debe ejecutarse antes de cualquier import que lea variables de entorno

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from pathlib import Path

# Importar rutas
from app.routes import auth, productos, mesas

# Crear instancia de FastAPI
app = FastAPI(
    title=os.getenv("APP_NAME", "ScanOrder"),
    description="Sistema de gestión de pedidos con QR para Maven Burger",
    version="1.0.0"
)

# Configurar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Registrar rutas
app.include_router(auth.router)
app.include_router(productos.router)
app.include_router(mesas.router)

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