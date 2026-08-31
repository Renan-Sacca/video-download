from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import assert_public_http_url, is_safe_id, require_api_key
from app.schemas import DownloadRequest, DownloadStartResponse, JobStatusResponse
from app.services import job_store
from app.services.queue_manager import enqueue_download

router = APIRouter(tags=["download"], dependencies=[Depends(require_api_key)])


@router.post("/api/download", response_model=DownloadStartResponse)
async def start_download(payload: DownloadRequest) -> DownloadStartResponse:
    assert_public_http_url(payload.url)

    job_id = job_store.new_job_id()
    await job_store.create_job(job_id, payload.url, payload.quality, payload.format)
    enqueue_download(job_id, payload.url, payload.quality, payload.format)

    return DownloadStartResponse(job_id=job_id)


@router.get("/api/download/{job_id}", response_model=JobStatusResponse)
async def get_download_status(job_id: str) -> JobStatusResponse:
    if not is_safe_id(job_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="job_id invalido.")

    job = await job_store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job nao encontrado.")

    return JobStatusResponse(
        status=job["status"],
        progress=job.get("progress", 0),
        error=job.get("error"),
        download_url=job.get("download_url"),
        filename=job.get("filename"),
    )
