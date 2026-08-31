FROM python:3.12-slim

# ffmpeg: necessario para o yt-dlp juntar video+audio e converter para mp3.
# ca-certificates: necessario para requisicoes HTTPS confiaveis do yt-dlp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Usuario nao-root: reduz o impacto de uma eventual falha de seguranca no
# processo que executa yt-dlp/ffmpeg contra conteudo de terceiros.
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /data/downloads /data/tmp \
    && chown -R appuser:appuser /app /data

USER appuser

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
