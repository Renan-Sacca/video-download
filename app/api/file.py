from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.config import DOWNLOAD_DIR
from app.core.security import is_safe_id, resolve_safe_path
from app.services import job_store

router = APIRouter(tags=["file"])


# Nota: esta rota e intencionalmente publica (sem exigencia de X-API-Key).
# `chrome.downloads.download()` nao permite anexar headers customizados a
# requisicao, entao a autorizacao aqui e o proprio `token`: um valor
# aleatorio de 24 bytes (base64 url-safe) gerado pelo servidor somente apos
# um download ter sido concluido com sucesso via /api/download. O token nao
# revela o job_id nem o caminho real do arquivo em disco.
@router.get("/api/file/{token}")
async def get_file(token: str) -> FileResponse:
    if not is_safe_id(token):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token invalido.")

    job_id = await job_store.get_job_id_by_token(token)
    if job_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo nao encontrado.")

    job = await job_store.get_job(job_id)
    if job is None or job.get("status") != "finished" or not job.get("file_path"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo nao encontrado.")

    # O nome real do arquivo em DOWNLOAD_DIR e sempre "<token>.<ext>" (ver
    # services/downloader.py). Derivamos o nome a partir do file_path
    # guardado no job e validamos que ele continua dentro de DOWNLOAD_DIR.
    stored_name = Path(job["file_path"]).name
    file_path = resolve_safe_path(DOWNLOAD_DIR, stored_name)

    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Arquivo expirado ou removido.",
        )

    download_name = job.get("filename") or file_path.name
    return FileResponse(
        path=file_path,
        filename=download_name,
        media_type="application/octet-stream",
    )
