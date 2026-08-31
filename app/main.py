import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import download, file, health, info
from app.config import CORS_ALLOW_ORIGIN_REGEX, LOG_LEVEL
from app.services import downloader
from app.services.cleanup import cleanup_loop

logging.basicConfig(level=LOG_LEVEL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    downloader.bind_main_loop(asyncio.get_running_loop())
    cleanup_task = asyncio.create_task(cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()


app = FastAPI(title="Video Downloader API", version="1.0.0", lifespan=lifespan)

# CORS: a extensao Chrome roda em origem "chrome-extension://<id>". A API key
# (header X-API-Key) e o mecanismo real de autorizacao; o CORS aqui apenas
# permite que o navegador execute a chamada a partir do popup da extensao.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)

app.include_router(health.router)
app.include_router(info.router)
app.include_router(download.router)
app.include_router(file.router)
