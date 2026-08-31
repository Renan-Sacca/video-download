"""
Controle simples de concorrencia para os downloads em segundo plano.

Usa um asyncio.Semaphore em memoria para limitar quantos downloads (yt-dlp)
rodam ao mesmo tempo neste processo. Isso evita que a VPS fique sobrecarregada
se varias pessoas (ou a mesma pessoa, varias vezes) dispararem downloads
simultaneos.
"""
import asyncio

from app.config import MAX_CONCURRENT_DOWNLOADS
from app.services import job_store
from app.services.downloader import run_download_job

_semaphore = asyncio.Semaphore(max(1, MAX_CONCURRENT_DOWNLOADS))


async def _run_with_limit(job_id: str, url: str, quality: str, fmt: str) -> None:
    async with _semaphore:
        await run_download_job(job_id, url, quality, fmt)


def enqueue_download(job_id: str, url: str, quality: str, fmt: str) -> None:
    """Agenda o job para execucao em background, respeitando o limite de concorrencia."""
    asyncio.create_task(_run_with_limit(job_id, url, quality, fmt))
