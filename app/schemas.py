"""Modelos Pydantic usados nas requisicoes/respostas da API."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

Quality = Literal["best", "2160", "1440", "1080", "720", "480", "360", "audio"]
TargetFormat = Literal["mp4", "webm", "mp3", "m4a"]
JobStatus = Literal["queued", "downloading", "processing", "finished", "error"]


class InfoRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)

    @field_validator("url")
    @classmethod
    def strip_url(cls, v: str) -> str:
        return v.strip()


class FormatItem(BaseModel):
    format_id: str
    ext: str
    resolution: Optional[str] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    filesize_approx: Optional[int] = None
    vcodec: Optional[str] = None
    acodec: Optional[str] = None
    format_note: Optional[str] = None
    has_audio: bool = False
    has_video: bool = False


class InfoResponse(BaseModel):
    title: str
    thumbnail: Optional[str] = None
    duration: Optional[float] = None
    webpage_url: str
    extractor: Optional[str] = None
    formats: list[FormatItem] = Field(default_factory=list)
    available_qualities: list[str] = Field(default_factory=list)


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)
    quality: Quality = "best"
    format: TargetFormat = "mp4"

    @field_validator("url")
    @classmethod
    def strip_url(cls, v: str) -> str:
        return v.strip()


class DownloadStartResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    status: JobStatus
    progress: int = 0
    error: Optional[str] = None
    download_url: Optional[str] = None
    filename: Optional[str] = None
