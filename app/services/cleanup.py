"""
Rotina de limpeza automatica dos arquivos finalizados.

Roda periodicamente em background (task asyncio criada no startup da app) e
remove do DOWNLOAD_DIR qualquer arquivo mais antigo que FILE_TTL_MINUTES,
independente do estado guardado no Redis (defesa em profundidade: mesmo que
o Redis perca o registro do job, o arquivo em disco continua sendo removido
apos o TTL).
"""
import asyncio
import logging
import time

from app.config import CLEANUP_INTERVAL_SECONDS, DOWNLOAD_DIR, FILE_TTL_MINUTES

logger = logging.getLogger("videodl.cleanup")


def _cleanup_once() -> int:
    cutoff = time.time() - (FILE_TTL_MINUTES * 60)
    removed = 0
    if not DOWNLOAD_DIR.exists():
        return removed
    for path in DOWNLOAD_DIR.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
        except OSError:
            logger.warning("Falha ao remover arquivo expirado: %s", path, exc_info=True)
    return removed


async def cleanup_loop() -> None:
    while True:
        try:
            removed = await asyncio.to_thread(_cleanup_once)
            if removed:
                logger.info("Limpeza automatica removeu %d arquivo(s) expirado(s).", removed)
        except Exception:  # noqa: BLE001
            logger.exception("Erro na rotina de limpeza automatica.")
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
