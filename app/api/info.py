import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import assert_public_http_url, require_api_key
from app.schemas import InfoRequest, InfoResponse
from app.services.downloader import DownloadError, get_video_info

logger = logging.getLogger("videodl.api.info")

router = APIRouter(tags=["info"], dependencies=[Depends(require_api_key)])


@router.post("/api/info", response_model=InfoResponse)
async def post_info(payload: InfoRequest) -> InfoResponse:
    assert_public_http_url(payload.url)
    try:
        return await get_video_info(payload.url)
    except DownloadError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception:  # noqa: BLE001
        logger.exception("Falha ao extrair informacoes de %s", payload.url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Nao foi possivel obter informacoes deste video.",
        )
