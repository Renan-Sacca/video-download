"""
Funcoes de seguranca da API:

- API key simples via header "X-API-Key".
- Protecao basica contra SSRF: bloqueia URLs que resolvem para IPs privados,
  loopback, link-local, multicast ou reservados, e restringe os esquemas
  aceitos a http/https.
- Protecao contra path traversal: valida tokens/ids usados para montar
  caminhos de arquivo, garantindo que o caminho final resolvido continue
  dentro do diretorio esperado.
"""
import ipaddress
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Header, HTTPException, status

from app.config import API_KEY, SSRF_PROTECTION_ENABLED

# Apenas identificadores alfanumericos (+ hifen/underscore) sao aceitos para
# job_id e token de download. Isso, combinado com a resolucao de caminho
# abaixo, elimina qualquer possibilidade de path traversal (ex: "../../etc").
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")

_ALLOWED_SCHEMES = {"http", "https"}


def require_api_key(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    """Dependency do FastAPI que exige uma API key valida em todas as rotas protegidas."""
    if not API_KEY:
        # Se o operador nao configurou nenhuma API key, recusamos iniciar em
        # modo "aberto" -- isso evita expor a VPS por descuido de configuracao.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="API_KEY nao configurada no servidor.",
        )
    if not x_api_key or x_api_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key invalida ou ausente.",
        )


def is_safe_id(value: str) -> bool:
    """Valida job_id / token de download (usados para montar caminhos de arquivo)."""
    return bool(_SAFE_ID_RE.match(value))


def resolve_safe_path(base_dir: Path, filename: str) -> Path:
    """
    Resolve `filename` dentro de `base_dir` e garante que o resultado nao
    escapa do diretorio base (protecao contra path traversal).

    Levanta HTTPException(400) se o caminho resultante ficar fora de base_dir.
    """
    base_dir = base_dir.resolve()
    candidate = (base_dir / filename).resolve()
    try:
        candidate.relative_to(base_dir)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Caminho invalido.")
    return candidate


def _is_ip_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # nao parseavel -> trata como bloqueado, por seguranca

    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def assert_public_http_url(url: str) -> None:
    """
    Protecao basica contra SSRF para as URLs de video informadas pelo cliente.

    Bloqueia:
    - esquemas diferentes de http/https (file://, ftp://, gopher://, etc)
    - hosts que resolvem para IPs privados/loopback/link-local/reservados
    - URLs sem host

    Isso impede que a API seja usada para fazer a VPS acessar
    `http://127.0.0.1:<porta>` ou redes internas (169.254.x.x, 10.x.x.x, etc).
    """
    if not SSRF_PROTECTION_ENABLED:
        return

    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL invalida.")

    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Apenas URLs http/https sao permitidas.",
        )

    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL sem host.")

    if host.lower() in ("localhost",):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Host nao permitido.")

    try:
        addr_infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Nao foi possivel resolver o host."
        )

    resolved_ips = {info[4][0] for info in addr_infos}
    if not resolved_ips:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Nao foi possivel resolver o host."
        )

    for ip_str in resolved_ips:
        if _is_ip_blocked(ip_str):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL aponta para um endereco de rede nao permitido.",
            )
