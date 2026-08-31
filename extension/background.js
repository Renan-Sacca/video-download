// Service worker (Manifest V3).
//
// IMPORTANTE sobre o ciclo de vida do service worker em MV3: o Chrome
// encerra o service worker apos ~30s de inatividade (ou por pressao de
// memoria, ex: ao minimizar a janela). Isso significa que QUALQUER estado
// guardado apenas em variavel de modulo (let/const no topo do arquivo) e
// perdido quando o worker reinicia, mesmo que a extensao continue instalada.
//
// Por isso, todo estado que precisa sobreviver a esses reinicios (jobs de
// download em andamento e a midia de rede detectada por aba) e persistido em
// chrome.storage.session: uma area de armazenamento em memoria (nao vai pro
// disco), mas que sobrevive a reinicios do service worker e so e limpa
// quando o navegador fecha de fato. Um chrome.alarms garante que o worker
// seja acordado periodicamente para continuar o polling de jobs ativos
// mesmo se nenhuma outra atividade (popup aberto, etc.) o mantiver vivo.
//
// Referencia: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

importScripts("config.js");

const STORAGE_KEY_JOBS = "videodl_jobs"; // { [jobId]: {status, progress, error, downloadUrl, filename, sourceUrl, startedAt} }
const STORAGE_KEY_MEDIA = "videodl_media"; // { [tabId]: [{url, contentType, size, timestamp}] }
const KEEPALIVE_ALARM = "videodl-keepalive";

// Numero maximo de jobs mantidos no historico. Downloads sao uma lista
// global da extensao (nao amarrados a nenhuma aba especifica), visivel em
// qualquer pagina, para que trocar de aba ou fechar a aba de origem do
// video nao faca o progresso "desaparecer" do popup.
const MAX_JOBS_HISTORY = 15;

// ---------------------------------------------------------------------------
// Estado de jobs (persistido em chrome.storage.session)
// ---------------------------------------------------------------------------

async function getJobs() {
  const data = await chrome.storage.session.get(STORAGE_KEY_JOBS);
  return data[STORAGE_KEY_JOBS] || {};
}

async function getJob(jobId) {
  const jobs = await getJobs();
  return jobs[jobId] || null;
}

async function setJob(jobId, state) {
  const jobs = await getJobs();
  jobs[jobId] = { ...jobs[jobId], ...state };
  await trimJobHistory(jobs);
  await chrome.storage.session.set({ [STORAGE_KEY_JOBS]: jobs });
  return jobs[jobId];
}

// Mantem a lista de jobs num tamanho razoavel: quando excede o limite,
// remove primeiro os jobs mais antigos que ja terminaram (finished/error),
// preservando sempre os que ainda estao em andamento.
async function trimJobHistory(jobs) {
  const entries = Object.entries(jobs);
  if (entries.length <= MAX_JOBS_HISTORY) return;

  const removable = entries
    .filter(([, s]) => ["finished", "error"].includes(s.status))
    .sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0));

  let excess = entries.length - MAX_JOBS_HISTORY;
  for (const [id] of removable) {
    if (excess <= 0) break;
    delete jobs[id];
    excess--;
  }
}

async function removeJob(jobId) {
  const jobs = await getJobs();
  delete jobs[jobId];
  await chrome.storage.session.set({ [STORAGE_KEY_JOBS]: jobs });
}

async function listActiveJobIds() {
  const jobs = await getJobs();
  return Object.entries(jobs)
    .filter(([, s]) => s.status && !["finished", "error"].includes(s.status))
    .map(([id]) => id);
}

async function listAllJobs() {
  const jobs = await getJobs();
  return Object.entries(jobs)
    .map(([jobId, state]) => ({ jobId, ...state }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function broadcastUpdate(jobId, state) {
  chrome.runtime.sendMessage({ type: "JOB_UPDATE", jobId, ...state }).catch(() => {
    // Nenhum popup aberto para receber a mensagem agora; sem problema, o
    // estado ja foi persistido e o popup le via GET_JOB_STATE ao reabrir.
  });
}

// Evita que dois loops de polling do mesmo job rodem ao mesmo tempo dentro
// da mesma instancia do worker (pode acontecer se o alarme de keepalive
// disparar enquanto um loop via setTimeout ja esta ativo para esse job).
// So precisa viver na memoria desta instancia: se o worker reiniciar, esse
// Set comeca vazio de novo, o que e o comportamento correto (o loop antigo
// nao existe mais, pode/deve iniciar um novo).
const activePollLoops = new Set();

// Ponto de entrada: garante que exista no maximo um loop de polling ativo
// por job nesta instancia do worker, e entao delega para pollJobStep.
function pollJob(jobId) {
  if (activePollLoops.has(jobId)) return;
  activePollLoops.add(jobId);
  pollJobStep(jobId);
}

async function pollJobStep(jobId) {
  const { API_BASE_URL, POLL_INTERVAL_MS } = globalThis.VIDEODL_CONFIG;

  try {
    const res = await fetch(`${API_BASE_URL}/api/download/${jobId}`, {
      method: "GET",
      headers: apiHeaders(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const state = { status: "error", progress: 0, error: body.detail || `Erro HTTP ${res.status}` };
      await setJob(jobId, state);
      broadcastUpdate(jobId, state);
      activePollLoops.delete(jobId);
      return;
    }

    const data = await res.json();
    const state = {
      status: data.status,
      progress: data.progress || 0,
      error: data.error || null,
      downloadUrl: data.download_url || null,
      filename: data.filename || null,
    };
    await setJob(jobId, state);
    broadcastUpdate(jobId, state);

    if (state.status === "finished" && state.downloadUrl) {
      triggerBrowserDownload(jobId, API_BASE_URL + state.downloadUrl, state.filename);
      activePollLoops.delete(jobId);
      return;
    }

    if (state.status === "error") {
      activePollLoops.delete(jobId);
      return;
    }

    // setTimeout aqui so funciona enquanto o worker estiver vivo nesta
    // execucao; o alarme periodico (ver mais abaixo) e quem garante que o
    // polling seja retomado caso o worker seja encerrado entre uma consulta
    // e outra (ex: usuario minimizou a janela por mais de 30s de
    // inatividade) - quando isso acontece, activePollLoops simplesmente
    // deixa de existir junto com o resto da memoria do worker, e o alarme
    // chama pollJob() de novo livremente.
    setTimeout(() => pollJobStep(jobId), POLL_INTERVAL_MS);
  } catch (err) {
    const state = {
      status: "error",
      progress: 0,
      error: err && err.message ? err.message : "Falha de rede ao consultar o job.",
    };
    await setJob(jobId, state);
    broadcastUpdate(jobId, state);
    activePollLoops.delete(jobId);
  }
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": globalThis.VIDEODL_CONFIG.API_KEY,
  };
}

function triggerBrowserDownload(jobId, fileUrl, filename) {
  chrome.downloads.download(
    {
      url: fileUrl,
      filename: filename || undefined,
      saveAs: false,
    },
    async () => {
      if (chrome.runtime.lastError) {
        const state = { status: "error", error: chrome.runtime.lastError.message };
        await setJob(jobId, state);
        broadcastUpdate(jobId, state);
      }
    }
  );
}

// Ao iniciar (instalacao, atualizacao, navegador aberto ou worker
// "acordado" por qualquer evento), retoma o polling de qualquer job que
// ainda estivesse em andamento antes do worker ser encerrado.
async function resumeActiveJobs() {
  const activeIds = await listActiveJobIds();
  for (const jobId of activeIds) {
    pollJob(jobId);
  }
}

chrome.runtime.onStartup.addListener(resumeActiveJobs);
chrome.runtime.onInstalled.addListener(resumeActiveJobs);
resumeActiveJobs();

// Mantem um alarme periodico (minimo permitido pelo Chrome: 1 minuto). Cada
// disparo acorda o worker se ele tiver sido encerrado, e retoma o polling de
// jobs ainda ativos - rede de seguranca contra a janela minimizada matar o
// worker no meio de um download.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    resumeActiveJobs();
  }
});

// ---------------------------------------------------------------------------
// Deteccao de midia via trafego de rede (fallback para sites nao suportados
// pelos extratores do yt-dlp, ex: paginas que embutem o player em iframe de
// terceiros como blogger.com com extrator desatualizado).
//
// Isso NAO contorna DRM: apenas observa requisicoes de rede que o proprio
// navegador ja faz em texto claro (URLs .mp4/.m3u8/.mpd ou respostas com
// Content-Type de video) e guarda o endereco para o usuario escolher baixar.
// Um stream com DRM real (Widevine/FairPlay) vem cifrado e nao pode ser
// baixado e reproduzido apenas com a URL - essa tecnica nao muda isso.
//
// O resultado e persistido em chrome.storage.session (por tabId) pelo mesmo
// motivo do estado de jobs: sobreviver a reinicios do service worker.
// ---------------------------------------------------------------------------

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

// Fila de escritas em storage.session para evitar corrida entre requisicoes
// de rede simultaneas (varias podem chegar quase ao mesmo tempo).
let mediaWriteQueue = Promise.resolve();

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

  mediaWriteQueue = mediaWriteQueue.then(async () => {
    const data = await chrome.storage.session.get(STORAGE_KEY_MEDIA);
    const byTab = data[STORAGE_KEY_MEDIA] || {};
    const list = byTab[tabId] || [];

    const existingIndex = list.findIndex((m) => m.url === url);
    const entry = {
      url,
      contentType: extra.contentType || (existingIndex >= 0 ? list[existingIndex].contentType : null),
      size: extra.size || (existingIndex >= 0 ? list[existingIndex].size : null),
      timestamp: existingIndex >= 0 ? list[existingIndex].timestamp : Date.now(),
    };

    if (existingIndex >= 0) {
      list[existingIndex] = entry;
    } else {
      list.push(entry);
    }

    byTab[tabId] = list;
    await chrome.storage.session.set({ [STORAGE_KEY_MEDIA]: byTab });

    // Avisa o popup (se estiver aberto) para atualizar a lista em tempo real.
    chrome.runtime.sendMessage({ type: "MEDIA_UPDATE", tabId }).catch(() => {});
  });
}

async function clearMediaForTab(tabId) {
  const data = await chrome.storage.session.get(STORAGE_KEY_MEDIA);
  const byTab = data[STORAGE_KEY_MEDIA] || {};
  if (byTab[tabId]) {
    delete byTab[tabId];
    await chrome.storage.session.set({ [STORAGE_KEY_MEDIA]: byTab });
  }
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
    const contentType = details.responseHeaders
      ?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value?.toLowerCase();
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
  clearMediaForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearMediaForTab(tabId);
  }
});

// ---------------------------------------------------------------------------
// Mensagens do popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRACK_JOB") {
    setJob(message.jobId, {
      status: "queued",
      progress: 0,
      sourceUrl: message.sourceUrl || null,
      startedAt: Date.now(),
    }).then(() => {
      pollJob(message.jobId);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_JOB_STATE") {
    getJob(message.jobId).then((state) => sendResponse({ ok: true, state }));
    return true;
  }

  // Retorna TODOS os downloads conhecidos pela extensao (independente da
  // aba/pagina em que o popup foi aberto), do mais recente para o mais
  // antigo. E o que faz o progresso "seguir" o usuario mesmo trocando de
  // aba ou fechando a pagina de origem do video.
  if (message.type === "GET_ALL_JOBS") {
    listAllJobs().then((jobs) => sendResponse({ ok: true, jobs }));
    return true;
  }

  if (message.type === "REMOVE_JOB") {
    removeJob(message.jobId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "GET_DETECTED_MEDIA") {
    chrome.storage.session.get(STORAGE_KEY_MEDIA).then((data) => {
      const byTab = data[STORAGE_KEY_MEDIA] || {};
      const list = byTab[message.tabId] || [];
      const sorted = [...list].sort((a, b) => (b.size || 0) - (a.size || 0));
      sendResponse({ ok: true, media: sorted });
    });
    return true;
  }

  return false;
});
