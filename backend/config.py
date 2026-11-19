import os


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY")
    if not SECRET_KEY:
        raise RuntimeError("SECRET_KEY is required. Configure it in backend/.env.")
    DATABASE_URL = os.getenv("DATABASE_URL")
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is required. Configure PostgreSQL in backend/.env."
        )
    if DATABASE_URL.lower().startswith("sqlite"):
        raise RuntimeError("SQLite is not supported. DATABASE_URL must use PostgreSQL.")
    SQLALCHEMY_DATABASE_URI = DATABASE_URL
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
