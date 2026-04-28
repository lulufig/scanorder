import mysql.connector
from mysql.connector import Error
import os
from dotenv import load_dotenv

# Cargar variables de entorno
load_dotenv()

def get_db_connection():
    """
    Crea y retorna una conexión a la base de datos MySQL.
    """
    try:
        connection = mysql.connector.connect(
            host=os.getenv("DB_HOST"),
            port=int(os.getenv("DB_PORT", 3306)),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
            database=os.getenv("DB_NAME")
        )
        
        if connection.is_connected():
            return connection
            
    except Error as e:
        print(f"Error al conectar a MySQL: {e}")
        return None

def close_db_connection(connection):
    """
    Cierra la conexión a la base de datos.
    """
    if connection and connection.is_connected():
        connection.close()