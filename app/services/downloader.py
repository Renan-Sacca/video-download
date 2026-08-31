"""
Camada de integracao com yt-dlp + FFmpeg.

Responsavel por:
- extrair informacoes do video (titulo, thumbnail, formatos disponiveis)
- executar o download/merge (video+audio) ou a conversao para audio (mp3/m4a)
- reportar progresso para o job armazenado no Redis
- mover o arquivo finalizado para o diretorio publico de downloads
"""
import asyncio
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

import yt_dlp

from app.config import (
    DOWNLOAD_DIR,
    FFMPEG_LOCATION,
    MAX_FILESIZE_MB,
    TMP_DIR,
)
from app.schemas import FormatItem, InfoResponse
from app.services import job_store

logger = logging.getLogger("videodl.downloader")


class DownloadError(Exception):
    pass


def _base_ydl_opts(extra: Optional[dict] = None) -> dict:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "nocheckcertificate": False,
        # Nao seguir para o disco arbitrario: sempre relativo ao outtmpl.
        "restrictfilenames": True,
        "ffmpeg_location": FFMPEG_LOCATION,
        "socket_timeout": 30,
        # Evita que yt-dlp tente abrir players externos, escrever cookies, etc.
        "no_playlist": True,
    }
    if MAX_FILESIZE_MB > 0:
        opts["max_filesize"] = MAX_FILESIZE_MB * 1024 * 1024
    if extra:
        opts.update(extra)
    return opts


def _format_to_item(fmt: dict) -> FormatItem:
    height = fmt.get("height")
    resolution = fmt.get("resolution")
    if not resolution and height:
        width = fmt.get("width")
        resolution = f"{width}x{height}" if width else f"{height}p"

    vcodec = fmt.get("vcodec")
    acodec = fmt.get("acodec")
    has_video = bool(vcodec) and vcodec != "none"
    has_audio = bool(acodec) and acodec != "none"

    return FormatItem(
        format_id=fmt.get("format_id", ""),
        ext=fmt.get("ext", ""),
        resolution=resolution,
        height=height,
        fps=fmt.get("fps"),
        filesize_approx=fmt.get("filesize") or fmt.get("filesize_approx"),
        vcodec=vcodec,
        acodec=acodec,
        format_note=fmt.get("format_note"),
        has_audio=has_audio,
        has_video=has_video,
    )


def _extract_info_sync(url: str) -> dict:
    opts = _base_ydl_opts({"skip_download": True})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise DownloadError("Nao foi possivel extrair informacoes do video.")
    # Playlists: pegamos apenas o primeiro item para manter o fluxo simples
    # (a extensao foi desenhada para baixar um video por vez).
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        if not entries:
            raise DownloadError("A URL informada e uma playlist vazia.")
        info = entries[0]
    return info


async def get_video_info(url: str) -> InfoResponse:
    info = await asyncio.to_thread(_extract_info_sync, url)

    raw_formats = info.get("formats") or []
    formats = [_format_to_item(f) for f in raw_formats if f.get("format_id")]

    heights = sorted(
        {f.height for f in formats if f.height and f.has_video}, reverse=True
    )
    available_qualities = [str(h) for h in heights]

    return InfoResponse(
        title=info.get("title") or "video",
        thumbnail=info.get("thumbnail"),
        duration=info.get("duration"),
        webpage_url=info.get("webpage_url") or url,
        extractor=info.get("extractor"),
        formats=formats,
        available_qualities=available_qualities,
    )


def _build_format_selector(quality: str, target_format: str) -> str:
    if target_format in ("mp3", "m4a") or quality == "audio":
        return "bestaudio/best"

    if quality == "best":
        return "bestvideo+bestaudio/best"

    # quality e uma altura numerica, ex: "1080"
    try:
        height = int(quality)
    except ValueError:
        return "bestvideo+bestaudio/best"

    return (
        f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        f"/best[height<={height}]"
    )


def _download_sync(job_id: str, url: str, quality: str, target_format: str) -> Path:
    work_dir = TMP_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    outtmpl = str(work_dir / "%(title).100B.%(ext)s")
    format_selector = _build_format_selector(quality, target_format)

    postprocessors = []
    extra: dict[str, Any] = {
        "format": format_selector,
        "outtmpl": outtmpl,
        "progress_hooks": [lambda d: _on_progress(job_id, d)],
    }

    if target_format in ("mp3", "m4a") or quality == "audio":
        codec = "mp3" if target_format == "mp3" else "m4a"
        postprocessors.append(
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": codec,
                "preferredquality": "192",
            }
        )
    else:
        extra["merge_output_format"] = target_format

    if postprocessors:
        extra["postprocessors"] = postprocessors

    opts = _base_ydl_opts(extra)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info.get("_type") == "playlist":
            entries = info.get("entries") or []
            if not entries:
                raise DownloadError("A URL informada e uma playlist vazia.")
            info = entries[0]
        final_path = Path(ydl.prepare_filename(info))

        # Quando ha pos-processamento (ex: extracao de audio ou merge para um
        # container diferente), a extensao final pode mudar.
        if target_format in ("mp3", "m4a") or quality == "audio":
            final_path = final_path.with_suffix(f".{('mp3' if target_format == 'mp3' else 'm4a')}")
        elif extra.get("merge_output_format"):
            final_path = final_path.with_suffix(f".{target_format}")

    if not final_path.exists():
        # fallback: procura qualquer arquivo produzido no diretorio de trabalho
        candidates = [p for p in work_dir.iterdir() if p.is_file()]
        if not candidates:
            raise DownloadError("Arquivo final nao foi encontrado apos o download.")
        final_path = max(candidates, key=lambda p: p.stat().st_mtime)

    return final_path


def _on_progress(job_id: str, d: dict) -> None:
    loop = _MAIN_LOOP
    if loop is None:
        return

    status = d.get("status")
    progress = None
    if status == "downloading":
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        downloaded = d.get("downloaded_bytes") or 0
        if total:
            progress = int(downloaded / total * 100)
        new_status = "downloading"
    elif status == "finished":
        progress = 95
        new_status = "processing"
    else:
        return

    asyncio.run_coroutine_threadsafe(
        _update_progress(job_id, new_status, progress), loop
    )


async def _update_progress(job_id: str, status: str, progress: Optional[int]) -> None:
    job = await job_store.get_job(job_id)
    if job is None or job.get("status") in ("finished", "error"):
        return
    fields: dict[str, Any] = {"status": status}
    if progress is not None:
        fields["progress"] = progress
    await job_store.update_job(job_id, **fields)


_MAIN_LOOP: Optional[asyncio.AbstractEventLoop] = None


def bind_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Chamado no startup da app para que os progress_hooks (sincronos,
    executados em uma thread) possam agendar atualizacoes no loop principal."""
    global _MAIN_LOOP
    _MAIN_LOOP = loop


async def run_download_job(job_id: str, url: str, quality: str, target_format: str) -> None:
    await job_store.update_job(job_id, status="downloading", progress=0)
    try:
        produced_path = await asyncio.to_thread(
            _download_sync, job_id, url, quality, target_format
        )

        token = job_store.new_download_token()
        ext = produced_path.suffix.lstrip(".") or target_format
        final_name = f"{token}.{ext}"
        final_path = DOWNLOAD_DIR / final_name
        shutil.move(str(produced_path), str(final_path))

        download_url = f"/api/file/{token}"
        await job_store.update_job(
            job_id,
            status="finished",
            progress=100,
            download_url=download_url,
            filename=produced_path.name,
            file_path=str(final_path),
            download_token=token,
        )
    except Exception as exc:  # noqa: BLE001 - queremos capturar qualquer erro do yt-dlp/ffmpeg
        logger.exception("Falha no job %s", job_id)
        await job_store.update_job(job_id, status="error", error=str(exc))
    finally:
        work_dir = TMP_DIR / job_id
        shutil.rmtree(work_dir, ignore_errors=True)
