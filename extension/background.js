// Service worker (Manifest V3) responsavel por:
// - acompanhar o progresso de jobs de download mesmo que o popup seja
//   fechado pelo usuario;
// - disparar chrome.downloads.download() quando o job terminar.
//
// A extensao usa fetch simples (sem bibliotecas) para falar com a API.
// Cada chamada de rede reinicia o "idle timer" do service worker, o que e
// suficiente para acompanhar downloads de duracao tipica (segundos a poucos
// minutos). Ver README para detalhes/limitacoes desse modelo em MV3.

importScripts("config.js");

const jobs = new Map(); // job_id -> { status, progress, error, downloadUrl, filename }

// ---------------------------------------------------------------------------
// Deteccao de mídia via trafego de rede (fallback para sites nao suportados
// pelos extratores do yt-dlp, ex: paginas que embutem o player em iframe de
// terceiros como blogger.com/vimeo.com com extrator desatualizado).
//
// Isso NAO contorna DRM: apenas observa requisicoes de rede que o proprio
// navegador ja faz em texto claro (URLs .mp4/.m3u8/.mpd ou respostas com
// Content-Type de video) e guarda o endereco para o usuario escolher baixar.
// Um stream com DRM real (Widevine/FairPlay) vem cifrado e nao pode ser
// baixado e reproduzido apenas com a URL - essa tecnica nao muda isso.
// ---------------------------------------------------------------------------
const detectedMedia = new Map(); // tabId -> Map(url -> {url, contentType, size, timestamp})

const MEDIA_URL_PATTERNS = [
  /\.(mp4|webm|mov|mkv|m4v)(\?.*)?$/i,
  /\.m3u8(\?.*)?$/i,
  /\.mpd(\?.*)?$/i,
];

const IGNORE_URL_PATTERNS = [
  /[/?&._-](ads?|advert(s|ising)?)[/?&._-]/i,
  /\bbanner\b/i,
  /\bthumb(nail)?\b/i,
  /\bpixel\b/i,
  /\bvast\b/i,
  /\bvpaid\b/i,
];

const IGNORE_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "adnxs.com",
  "adsrvr.org",
  "taboola.com",
  "outbrain.com",
  "moatads.com",
  "scorecardresearch.com",
  "imasdk.googleapis.com",
];

const MEDIA_CONTENT_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
];

function isIgnoredUrl(url) {
  if (IGNORE_URL_PATTERNS.some((p) => p.test(url))) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return IGNORE_DOMAINS.some((d) => host.includes(d));
  } catch (e) {
    return true;
  }
}

function getContentLength(headers) {
  const contentRange = headers?.find((h) => h.name.toLowerCase() === "content-range")?.value;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) return parseInt(match[1], 10);
  }
  const contentLength = headers?.find((h) => h.name.toLowerCase() === "content-length")?.value;
  return contentLength ? parseInt(contentLength, 10) : null;
}

function registerMedia(tabId, url, extra) {
  if (tabId == null || tabId < 0) return;
  if (isIgnoredUrl(url)) return;

  if (!detectedMedia.has(tabId)) {
    detectedMedia.set(tabId, new Map());
  }
  const tabMedia = detectedMedia.get(tabId);
  const existing = tabMedia.get(url) || {};
  tabMedia.set(url, {
    url,
    contentType: extra.contentType || existing.contentType || null,
    size: extra.size || existing.size || null,
    timestamp: existing.timestamp || Date.now(),
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === "media" || MEDIA_URL_PATTERNS.some((p) => p.test(details.url))) {
      registerMedia(details.tabId, details.url, {});
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-type"
    )?.value?.toLowerCase();
    if (!contentType) return;

    const isMedia = MEDIA_CONTENT_TYPES.some((t) => contentType.includes(t));
    if (!isMedia) return;

    registerMedia(details.tabId, details.url, {
      contentType,
      size: getContentLength(details.responseHeaders),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    detectedMedia.delete(tabId);
  }
});

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": globalThis.VIDEODL_CONFIG.API_KEY,
  };
}

function broadcastUpdate(jobId) {
  const state = jobs.get(jobId);
  if (!state) return;
  chrome.runtime
    .sendMessage({ type: "JOB_UPDATE", jobId, ...state })
    .catch(() => {
      // Nenhum popup aberto para receber a mensagem; sem problema, o estado
      // continua disponivel via GET_JOB_STATE quando o popup for reaberto.
    });
}

async function pollJob(jobId) {
  const { API_BASE_URL, POLL_INTERVAL_MS } = globalThis.VIDEODL_CONFIG;

  try {
    const res = await fetch(`${API_BASE_URL}/api/download/${jobId}`, {
      method: "GET",
      headers: apiHeaders(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      jobs.set(jobId, {
        status: "error",
        progress: 0,
        error: body.detail || `Erro HTTP ${res.status}`,
      });
      broadcastUpdate(jobId);
      return;
    }

    const data = await res.json();
    jobs.set(jobId, {
      status: data.status,
      progress: data.progress || 0,
      error: data.error || null,
      downloadUrl: data.download_url || null,
      filename: data.filename || null,
    });
    broadcastUpdate(jobId);

    if (data.status === "finished" && data.download_url) {
      triggerBrowserDownload(API_BASE_URL + data.download_url, data.filename);
      return;
    }

    if (data.status === "error") {
      return;
    }

    setTimeout(() => pollJob(jobId), POLL_INTERVAL_MS);
  } catch (err) {
    jobs.set(jobId, {
      status: "error",
      progress: 0,
      error: err && err.message ? err.message : "Falha de rede ao consultar o job.",
    });
    broadcastUpdate(jobId);
  }
}

function triggerBrowserDownload(fileUrl, filename) {
  chrome.downloads.download(
    {
      url: fileUrl,
      filename: filename || undefined,
      saveAs: false,
    },
    () => {
      if (chrome.runtime.lastError) {
        const jobEntries = [...jobs.entries()];
        const [jobId] = jobEntries[jobEntries.length - 1] || [];
        if (jobId) {
          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: "error",
            error: chrome.runtime.lastError.message,
          });
          broadcastUpdate(jobId);
        }
      }
    }
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRACK_JOB") {
    jobs.set(message.jobId, { status: "queued", progress: 0 });
    pollJob(message.jobId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_JOB_STATE") {
    const state = jobs.get(message.jobId) || null;
    sendResponse({ ok: true, state });
    return true;
  }

  if (message.type === "GET_DETECTED_MEDIA") {
    const tabMedia = detectedMedia.get(message.tabId);
    const list = tabMedia ? Array.from(tabMedia.values()) : [];
    // Maiores/mais informados primeiro (tende a ser o video principal, nao anuncio)
    list.sort((a, b) => (b.size || 0) - (a.size || 0));
    sendResponse({ ok: true, media: list });
    return true;
  }

  return false;
});
