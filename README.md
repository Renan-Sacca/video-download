# Video Downloader

Downloader de vídeos composto por:

- **Backend** (`app/`): API em Python + FastAPI que usa **yt-dlp** e **FFmpeg**
  para extrair informações e baixar vídeos/áudios, com Redis para
  acompanhar o progresso dos jobs. Roda em Docker atrás do Traefik.
- **Extensão Chrome** (`extension/`): Manifest V3 em JavaScript puro (sem
  frameworks), que consome essa API a partir do navegador.

```
Chrome Extension → HTTPS → API (FastAPI) → yt-dlp + FFmpeg → arquivo temporário
                                                                     ↓
Chrome baixa o arquivo ← URL de download ← ─────────────────────────┘
```

Este projeto **não** implementa nem facilita bypass de DRM ou qualquer
mecanismo para contornar proteções de conteúdo. Use apenas com vídeos que
você tem direito de baixar.

## Estrutura

```
video-downloader/
├── app/                    # backend FastAPI
│   ├── main.py
│   ├── config.py
│   ├── schemas.py
│   ├── api/                 # rotas: health, info, download, file
│   ├── core/security.py     # API key, SSRF, path traversal
│   └── services/             # yt-dlp/ffmpeg, job_store (Redis), fila, limpeza
├── extension/                # extensão Chrome (Manifest V3, JS puro)
│   ├── manifest.json
│   ├── config.js             # API_BASE_URL e API_KEY configuráveis aqui
│   ├── popup.html / popup.css / popup.js
│   ├── background.js
│   └── icons/
├── scripts/gen_icons.py      # gera os ícones da extensão (já executado)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── requirements.txt
```

## 1. Deploy do backend na VPS

### 1.1. Pré-requisitos

- Docker + Docker Compose já instalados na VPS (verificado nesta máquina:
  Docker 29.1.3 / Compose v2.40.3).
- Traefik já rodando na VPS com uma rede Docker externa chamada `proxy`
  (o mesmo padrão usado pelos outros projetos desta máquina) e um
  `certresolver` chamado `letsencrypt` configurado. Se o nome da rede ou do
  resolver forem diferentes no seu Traefik, ajuste em `docker-compose.yml`.
- Um domínio/subdomínio (ex: `ytdl.seudominio.com`) apontando para a VPS.

### 1.2. Configurar variáveis de ambiente

```bash
cp .env.example .env
nano .env
```

Preencha pelo menos:

- `API_DOMAIN`: subdomínio público da API (usado pelo Traefik), ex.
  `ytdl.seudominio.com`.
- `PUBLIC_BASE_URL`: `https://` + o mesmo domínio.
- `API_KEY`: gere uma chave forte, por exemplo:
  ```bash
  openssl rand -hex 32
  ```

Os demais valores têm defaults razoáveis (TTL de arquivos de 1h, limpeza a
cada 5 min, limite de 2 downloads simultâneos, etc.) e podem ser ajustados
conforme necessário — veja os comentários em `.env.example`.

### 1.3. Subir a stack

```bash
docker compose up -d --build
```

Isso inicia dois serviços:

- `api`: a aplicação FastAPI (porta interna 8000, exposta ao Traefik via
  labels, sem publicar porta diretamente no host).
- `redis`: usado apenas internamente (rede `internal`, sem acesso do
  Traefik) para guardar o estado dos jobs de download.

Verifique os logs:

```bash
docker compose logs -f api
```

Teste local (sem depender do Traefik/DNS ainda):

```bash
docker compose exec api curl -s http://localhost:8000/api/health
```

Depois que o DNS e o Traefik estiverem propagados, teste pelo domínio público:

```bash
curl https://ytdl.seudominio.com/api/health
```

### 1.4. Rotas da API

| Rota                        | Auth (X-API-Key) | Descrição |
|-----------------------------|-------------------|-----------|
| `GET  /api/health`          | não               | health check |
| `POST /api/info`            | sim               | recebe `{"url": "..."}`, retorna título, thumbnail, duração e formatos disponíveis |
| `POST /api/download`        | sim               | recebe `{"url", "quality", "format"}`, retorna `{"job_id": "..."}` |
| `GET  /api/download/{id}`   | sim               | retorna `{"status", "progress", "download_url"?, "error"?}` |
| `GET  /api/file/{token}`    | não*              | serve o arquivo finalizado para download |

`*` `/api/file/{token}` é pública de propósito: a API `chrome.downloads.download()`
do Chrome não permite anexar headers customizados à requisição de download.
A autorização nessa rota é o próprio `token`, um valor aleatório de 24 bytes
gerado pelo servidor **somente após** um download autenticado (via
`/api/download`) ter sido concluído com sucesso. O token não expõe o
`job_id` nem o caminho real do arquivo em disco, e o arquivo é apagado
automaticamente após `FILE_TTL_MINUTES`.

Valores aceitos:
- `quality`: `"best"`, `"2160"`, `"1440"`, `"1080"`, `"720"`, `"480"`, `"360"`, `"audio"`
- `format`: `"mp4"`, `"webm"`, `"mp3"`, `"m4a"`

### 1.5. Segurança implementada

- **API key** obrigatória (header `X-API-Key`) em `/api/info` e
  `/api/download*`. Se `API_KEY` não estiver configurada no `.env`, a API
  se recusa a autorizar qualquer requisição (falha fechada, não aberta).
- **Proteção SSRF** (`app/core/security.py::assert_public_http_url`):
  apenas URLs `http`/`https`; resolve o hostname via DNS e bloqueia
  qualquer IP privado, loopback, link-local, multicast ou reservado (isso
  impede usar a API para acessar `127.0.0.1`, `169.254.169.254` — endpoint
  de metadados de nuvem — ou redes internas `10.x/172.16.x/192.168.x`).
- **Proteção contra path traversal**: `job_id` e o `token` de download só
  aceitam `[A-Za-z0-9_-]{8,128}`, e o nome de arquivo final é sempre
  resolvido e validado dentro de `DOWNLOAD_DIR` (`resolve_safe_path`) antes
  de ser servido.
- **Usuário não-root** no container (`appuser`, uid 1000).
- **Limpeza automática**: arquivos em `DOWNLOAD_DIR` mais antigos que
  `FILE_TTL_MINUTES` são apagados por uma rotina em background, a cada
  `CLEANUP_INTERVAL_SECONDS`, independente do estado do Redis (defesa em
  profundidade).
- **Limite de tamanho** (`MAX_FILESIZE_MB`) e de **downloads simultâneos**
  (`MAX_CONCURRENT_DOWNLOADS`, controlado via `asyncio.Semaphore`).

### 1.6. Comandos úteis

```bash
docker compose ps
docker compose logs -f api
docker compose restart api
docker compose down          # remove os containers (mantém os volumes)
```

## 2. Instalar a extensão Chrome

### 2.1. Configurar a API

Copie o arquivo de exemplo e edite com seus dados (`config.js` é ignorado
pelo git de propósito, pois contém sua API key):

```bash
cp extension/config.example.js extension/config.js
```

```js
globalThis.VIDEODL_CONFIG = {
  API_BASE_URL: "https://ytdl.seudominio.com",
  API_KEY: "a-mesma-chave-definida-em-API_KEY-no-.env-do-backend",
  POLL_INTERVAL_MS: 1500,
};
```

### 2.2. Carregar no Chrome

1. Abra `chrome://extensions`.
2. Ative o "Modo do desenvolvedor" (canto superior direito).
3. Clique em "Carregar sem compactação" e selecione a pasta `extension/`.
4. Fixe a extensão na barra de ferramentas.

### 2.3. Uso

1. Abra uma página com um vídeo suportado.
2. Clique no ícone da extensão — a URL da aba atual é preenchida
   automaticamente.
3. Clique em **Analisar**: a extensão chama `POST /api/info` e mostra
   título, thumbnail e qualidades disponíveis.
   - Se a página não for suportada diretamente pelo yt-dlp (comum em sites
     que embutem o player em um iframe de terceiros, ex: Blogger, com
     extrator desatualizado), a extensão mostra uma lista de "Vídeos
     detectados no tráfego da página" — URLs de mídia (.mp4/.m3u8/.mpd) que
     o próprio navegador já carregou em texto claro ao reproduzir o vídeo.
     Clique em "Usar essa URL" para analisar/baixar por ela. Isso só
     funciona para mídia servida sem criptografia (a grande maioria dos
     sites); vídeo com DRM real (Widevine/FairPlay) chega cifrado e uma URL
     sozinha não é suficiente para reproduzi-lo — este projeto não inclui
     nem pretende incluir suporte a esse tipo de conteúdo.
4. Escolha qualidade e formato, clique em **BAIXAR**.
5. A extensão chama `POST /api/download`, recebe um `job_id` e delega o
   acompanhamento ao `background.js` (service worker), que faz polling em
   `GET /api/download/{job_id}` a cada `POLL_INTERVAL_MS`.
6. Quando o job chega a `status: "finished"`, o `background.js` chama
   `chrome.downloads.download()` com a `download_url` retornada, e o Chrome
   salva o arquivo normalmente na pasta de downloads do usuário.

O progresso é refletido na barra de progresso do popup mesmo se ele for
fechado e reaberto durante o download (o estado do job vive no service
worker enquanto ele estiver ativo).

## 3. Formatos e qualidade

- Vídeo (`mp4`/`webm`): yt-dlp seleciona o melhor stream de vídeo e áudio
  disponíveis até a altura escolhida e usa FFmpeg (`merge_output_format`)
  para juntá-los no container escolhido.
- Áudio (`mp3`/`m4a`) ou `quality: "audio"`: yt-dlp baixa o melhor áudio e
  usa o pós-processador `FFmpegExtractAudio` para converter.

## 4. Solução de problemas

- **401 Unauthorized**: confira se `API_KEY` no `.env` do backend é
  idêntica à `API_KEY` em `extension/config.js`.
- **400 "URL aponta para um endereço de rede não permitido"**: a proteção
  SSRF bloqueou a URL (ela resolve para um IP privado/loopback). Isso é
  esperado para URLs internas; para sites públicos de vídeo isso não deve
  ocorrer.
- **410 Gone ao baixar o arquivo**: o arquivo expirou (`FILE_TTL_MINUTES`) e
  já foi removido pela limpeza automática — inicie o download novamente.
- **CORS bloqueado no console do Chrome**: confira `CORS_ALLOW_ORIGIN_REGEX`
  no `.env` do backend; o padrão já aceita qualquer `chrome-extension://`.
- **"Não foi possível obter informações deste vídeo" mas a lista de "vídeos
  detectados" também vem vazia**: o vídeo pode estar atrás de proteção real
  (DRM) ou o player ainda não carregou nenhum stream no momento em que você
  clicou em "Analisar" — dê play no vídeo na aba e tente analisar de novo.

## 5. Permissões da extensão

A extensão pede `<all_urls>` + `webRequest` para poder observar, em
qualquer aba, as requisições de rede que já ocorrem normalmente ao
carregar um player de vídeo (usado apenas no fallback descrito na seção 2.3).
Nenhuma URL de rede é enviada a nenhum lugar além da sua própria API
configurada em `config.js`; a extensão não coleta nem transmite seu
histórico de navegação.
