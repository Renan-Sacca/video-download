"""
Configuracoes da aplicacao, lidas a partir de variaveis de ambiente (.env).

Nao usamos pydantic-settings de proposito para manter a lista de dependencias
minima e seguir o mesmo padrao (os.getenv + python-dotenv) usado nos outros
projetos desta VPS (ex: /root/financas/app/config.py).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Seguranca
# ---------------------------------------------------------------------------
# Chave de API simples exigida em todas as rotas (header "X-API-Key").
API_KEY: str = os.getenv("API_KEY", "")

# Origens permitidas por CORS. Paginas de extensao Chrome usam o esquema
# "chrome-extension://<id>". Como cada instalacao/empacotamento gera um ID
# diferente, permitimos o esquema inteiro por padrao; quem protege a API de
# fato e a API key, nao o CORS.
CORS_ALLOW_ORIGIN_REGEX: str = os.getenv(
    "CORS_ALLOW_ORIGIN_REGEX", r"^chrome-extension://.*$"
)

# ---------------------------------------------------------------------------
# Armazenamento de arquivos
# ---------------------------------------------------------------------------
DOWNLOAD_DIR: Path = Path(os.getenv("DOWNLOAD_DIR", "/data/downloads")).resolve()
TMP_DIR: Path = Path(os.getenv("TMP_DIR", "/data/tmp")).resolve()

DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)

# Tempo (minutos) que um arquivo finalizado fica disponivel para download
# antes de ser apagado automaticamente.
FILE_TTL_MINUTES: int = _get_int("FILE_TTL_MINUTES", 60)

# Intervalo (segundos) entre execucoes da rotina de limpeza automatica.
CLEANUP_INTERVAL_SECONDS: int = _get_int("CLEANUP_INTERVAL_SECONDS", 300)

# Tamanho maximo de arquivo permitido por download, em MB. 0 = sem limite.
MAX_FILESIZE_MB: int = _get_int("MAX_FILESIZE_MB", 2048)

# ---------------------------------------------------------------------------
# Downloads / fila
# ---------------------------------------------------------------------------
MAX_CONCURRENT_DOWNLOADS: int = _get_int("MAX_CONCURRENT_DOWNLOADS", 2)

# Tempo (segundos) que o status de um job fica guardado no Redis apos criado.
JOB_TTL_SECONDS: int = _get_int("JOB_TTL_SECONDS", FILE_TTL_MINUTES * 60 + 1800)

# ---------------------------------------------------------------------------
# URL publica da API (usada para montar o download_url retornado ao cliente).
# Deve ser o dominio publico exposto pelo Traefik, ex: https://ytdl.exemplo.com
# ---------------------------------------------------------------------------
PUBLIC_BASE_URL: str = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")

# ---------------------------------------------------------------------------
# Redis (fila/estado dos jobs de download)
# ---------------------------------------------------------------------------
REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")

# ---------------------------------------------------------------------------
# yt-dlp / ffmpeg
# ---------------------------------------------------------------------------
FFMPEG_LOCATION: str = os.getenv("FFMPEG_LOCATION", "/usr/bin/ffmpeg")

# Proteção SSRF: permite desabilitar em ambiente de teste local, mas em
# produção deve permanecer sempre habilitada.
SSRF_PROTECTION_ENABLED: bool = _get_bool("SSRF_PROTECTION_ENABLED", True)

LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
