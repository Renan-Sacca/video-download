// Armazena os vídeos detectados por aba
const detectedVideos = new Map();

// Padrões de URL de vídeo comuns
const videoPatterns = [
  /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v)(\?.*)?$/i,
  /\/video\//i,
  /\/videos\//i,
  /videoplayback/i,
  /\.m3u8/i,
  /\.mpd/i,
  /\.ts$/i,
  /stream/i,
  /cdn.*\.(mp4|m3u8)/i
];

// Padrões para ignorar (anúncios, thumbnails, etc.)
// IMPORTANTE: usa \b (word boundary) e checa segmentos de path/domínio,
// nunca "ad" como substring livre - isso daria falso positivo em qualquer
// URL com base64 ou palavras como "download", "load", "adventure", etc.
const ignorePatterns = [
  /[/?&._-](ads?|advert(s|ising)?)[/?&._-]/i,
  /\bbanner\b/i,
  /\bthumb(nail)?\b/i,
  /\bpreview\b/i,
  /\/logo[/.]/i,
  /\bpixel\b/i,
  /\banalytics\b/i,
  /\bbeacon\b/i,
  /\bvast\b/i,
  /\bvpaid\b/i
];

// Domínios conhecidos de redes de anúncio/analytics que costumam servir
// vídeo dentro de players (ex: anúncios em vídeo VAST/VPAID)
const ignoreDomains = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adnxs.com',
  'adsrvr.org',
  'taboola.com',
  'outbrain.com',
  'moatads.com',
  'scorecardresearch.com',
  'imasdk.googleapis.com',
  'vast',
  'trafficbass.com',
  'acscdn.com'
];

function isIgnoredDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ignoreDomains.some(d => host.includes(d));
  } catch (e) {
    return false;
  }
}

// Tipos MIME de vídeo
const videoMimeTypes = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/x-flv',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/dash+xml'
];

// Resolve o tabId real quando o Chrome reporta -1 (comum em requisições
// feitas de dentro de iframes cross-origin). Usa a aba ativa como destino.
async function resolveTabId(tabId) {
  if (tabId !== -1) return tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tab.id : -1;
  } catch (e) {
    return -1;
  }
}

// Monitora requisições de rede para detectar vídeos
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    // Ignora redes de anúncio/analytics conhecidas antes de qualquer outra checagem
    if (isIgnoredDomain(url)) return;

    resolveTabId(details.tabId).then((tabId) => {
      if (tabId === -1) return;

      // Sinal mais confiável: o Chrome marca como "media" qualquer requisição
      // feita por um elemento <video>/<audio>, independente da URL ter ou não
      // extensão de vídeo. Funciona mesmo em iframes cross-origin, pois o
      // webRequest escuta a nível de rede (não de DOM).
      if (details.type === 'media') {
        addVideo(tabId, url, details);
        return;
      }

      // Ignora URLs de anúncios e thumbnails
      const shouldIgnore = ignorePatterns.some(pattern => pattern.test(url));
      if (shouldIgnore) return;

      // Verifica se é um vídeo baseado na URL
      const isVideoUrl = videoPatterns.some(pattern => pattern.test(url));

      if (isVideoUrl && details.type !== 'main_frame') {
        addVideo(tabId, url, details);
      }
    });
  },
  { urls: ["<all_urls>"] }
);

// Extrai o tamanho total do vídeo dos headers de resposta.
// Players de vídeo costumam pedir o arquivo em partes (Range requests),
// então o Content-Length de uma única resposta pode ser só um pedaço.
// O header Content-Range (ex: "bytes 0-1023/52428800") tem o tamanho total.
function getTotalSize(headers) {
  const contentRange = headers?.find(h => h.name.toLowerCase() === 'content-range')?.value;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) return parseInt(match[1]);
  }
  const contentLength = headers?.find(h => h.name.toLowerCase() === 'content-length')?.value;
  return contentLength ? parseInt(contentLength) : null;
}

// Monitora headers de resposta para detectar vídeos por tipo MIME
// (pega manifests HLS/DASH e vídeos servidos sem extensão na URL)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (isIgnoredDomain(details.url)) return;

    resolveTabId(details.tabId).then((tabId) => {
      if (tabId === -1) return;

      const contentType = details.responseHeaders?.find(
        header => header.name.toLowerCase() === 'content-type'
      );

      if (!contentType) return;

      const ctValue = contentType.value.toLowerCase();
      const isPlaylist = ctValue.includes('mpegurl') || ctValue.includes('dash+xml');

      // Manifests de playlist são sempre pequenos - não ignora por regras de anúncio
      // nem exige tamanho mínimo, pois o header content-length raramente vem neles.
      if (isPlaylist) {
        addVideo(tabId, details.url, details);
        return;
      }

      // Ignora URLs de anúncios para os demais tipos MIME
      const shouldIgnore = ignorePatterns.some(pattern => pattern.test(details.url));
      if (shouldIgnore) return;

      const isVideo = videoMimeTypes.some(type => ctValue.includes(type));
      if (!isVideo) return;

      // Usa o tamanho TOTAL (via Content-Range em requisições parciais),
      // não o tamanho do pedaço que chegou nessa resposta específica.
      const size = getTotalSize(details.responseHeaders) || 0;

      // Só adiciona se tiver tamanho razoável (> 300KB) ou tamanho desconhecido
      if (size > 300000 || size === 0) {
        addVideo(tabId, details.url, details, size);
      }
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Adiciona vídeo à lista de detectados
function addVideo(tabId, url, details, knownSize) {
  if (!detectedVideos.has(tabId)) {
    detectedVideos.set(tabId, []);
  }

  const videos = detectedVideos.get(tabId);
  
  // Evita duplicatas (ignora query string de cache-busting/timestamp na comparação)
  const existingIndex = videos.findIndex(v => v.url === url);
  
  const size = knownSize || getTotalSize(details.responseHeaders);
  const contentType = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value;
  
  if (existingIndex === -1) {
    videos.push({
      url: url,
      timestamp: Date.now(),
      size: size || null,
      duration: null,
      loading: true,
      type: contentType || 'unknown',
      method: details.method || 'GET'
    });

    // Ordena por tamanho (maiores primeiro) - vídeos maiores tendem a ser
    // a qualidade mais alta (HD) e o conteúdo principal, não anúncios
    videos.sort((a, b) => {
      if (a.size && b.size) return b.size - a.size;
      if (a.size) return -1;
      if (b.size) return 1;
      return 0;
    });

    // Atualiza o badge com o número de vídeos
    updateBadge(tabId, videos.length);
  } else if (size && size > (videos[existingIndex].size || 0)) {
    // Atualiza com o tamanho maior encontrado (ex: veio de uma resposta
    // parcial menor antes e agora temos o Content-Range com o total)
    videos[existingIndex].size = size;
    videos[existingIndex].loading = false;
  }
}

// Atualiza o badge do ícone da extensão
function updateBadge(tabId, count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString(), tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId: tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: tabId });
  }
}

// Limpa vídeos quando a aba é fechada
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedVideos.delete(tabId);
});

// Limpa vídeos quando navega para nova URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedVideos.delete(tabId);
    updateBadge(tabId, 0);
  }
});

// Responde a mensagens do popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideos') {
    const videos = detectedVideos.get(request.tabId) || [];
    sendResponse({ videos: videos });
  } else if (request.action === 'videosDetected') {
    // Recebe vídeos do content script com informações de duração
    const tabId = sender.tab.id;
    if (!detectedVideos.has(tabId)) {
      detectedVideos.set(tabId, []);
    }
    
    const existingVideos = detectedVideos.get(tabId);
    
    request.videos.forEach(newVideo => {
      const existingIndex = existingVideos.findIndex(v => v.url === newVideo.url);
      
      if (existingIndex >= 0) {
        // Atualiza vídeo existente com duração
        existingVideos[existingIndex].duration = newVideo.duration;
        existingVideos[existingIndex].loading = false;
      } else {
        // Adiciona novo vídeo
        existingVideos.push({
          url: newVideo.url,
          timestamp: Date.now(),
          size: null,
          duration: newVideo.duration,
          loading: false
        });
      }
    });
    
    updateBadge(tabId, existingVideos.length);
    sendResponse({ success: true });
  } else if (request.action === 'downloadVideo') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename || getFilenameFromUrl(request.url),
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true; // Mantém o canal de mensagem aberto para resposta assíncrona
  } else if (request.action === 'clearVideos') {
    detectedVideos.delete(request.tabId);
    updateBadge(request.tabId, 0);
    sendResponse({ success: true });
  }
});

// Extrai nome do arquivo da URL
function getFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    return filename || 'video.mp4';
  } catch (e) {
    return 'video.mp4';
  }
}
