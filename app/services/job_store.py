"""
Armazenamento do estado dos jobs de download usando Redis.

Cada job e guardado como uma string JSON na chave `job:<job_id>` com TTL,
para que jobs antigos expirem automaticamente mesmo se a limpeza de arquivos
falhar por algum motivo. O `download_token` (usado na rota publica
GET /api/file/{token}) e mapeado separadamente em `token:<token>` -> job_id,
de forma que o token de download nao revele o job_id nem qualquer caminho de
arquivo real no disco.
"""
import json
import secrets
import time
from typing import Any, Optional

import redis.asyncio as aioredis

from app.config import JOB_TTL_SECONDS, REDIS_URL

_redis: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


def new_job_id() -> str:
    return secrets.token_urlsafe(16)


def new_download_token() -> str:
    return secrets.token_urlsafe(24)


async def create_job(job_id: str, url: str, quality: str, fmt: str) -> dict:
    job = {
        "job_id": job_id,
        "status": "queued",
        "progress": 0,
        "error": None,
        "download_url": None,
        "filename": None,
        "file_path": None,
        "download_token": None,
        "url": url,
        "quality": quality,
        "format": fmt,
        "created_at": time.time(),
    }
    await save_job(job)
    return job


async def save_job(job: dict) -> None:
    r = get_redis()
    await r.set(f"job:{job['job_id']}", json.dumps(job), ex=JOB_TTL_SECONDS)
    token = job.get("download_token")
    if token:
        await r.set(f"token:{token}", job["job_id"], ex=JOB_TTL_SECONDS)


async def get_job(job_id: str) -> Optional[dict]:
    r = get_redis()
    raw = await r.get(f"job:{job_id}")
    if raw is None:
        return None
    return json.loads(raw)


async def get_job_id_by_token(token: str) -> Optional[str]:
    r = get_redis()
    return await r.get(f"token:{token}")


async def update_job(job_id: str, **fields: Any) -> Optional[dict]:
    job = await get_job(job_id)
    if job is None:
        return None
    job.update(fields)
    await save_job(job)
    return job


async def list_active_jobs() -> list[dict]:
    """Usado pela rotina de limpeza para nao apagar arquivos de jobs em andamento."""
    r = get_redis()
    jobs = []
    async for key in r.scan_iter(match="job:*"):
        raw = await r.get(key)
        if raw:
            jobs.append(json.loads(raw))
    return jobs
