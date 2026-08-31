// Logica da interface do popup:
// 1. pega a URL da aba atual
// 2. mostra imediatamente qualquer video detectado no trafego de rede da
//    pagina (fallback para sites que o yt-dlp nao suporta diretamente)
// 3. envia para /api/info ao clicar em "Analisar"
// 4. mostra titulo, thumbnail e formatos disponiveis
// 5. ao clicar em "Baixar", envia para /api/download e acompanha o job_id
//
// Downloads sao uma LISTA GLOBAL da extensao (nao amarrados a nenhuma
// aba/pagina especifica): o estado vive em background.js
// (chrome.storage.session), e o popup so pede "todos os jobs conhecidos"
// (GET_ALL_JOBS) sempre que abre ou recebe um JOB_UPDATE. Isso garante que
// trocar de aba, navegar para outra pagina ou fechar a aba de origem do
// video NAO faz o progresso desaparecer - ele so some quando o download
// termina e o usuario o remove da lista, ou quando o navegador fecha.

const { API_BASE_URL, API_KEY } = window.VIDEODL_CONFIG;

const els = {
  url: document.getElementById("video-url"),
  btnAnalyze: document.getElementById("btn-analyze"),
  statusMessage: document.getElementById("status-message"),
  videoInfo: document.getElementById("video-info"),
  thumbnail: document.getElementById("video-thumbnail"),
  title: document.getElementById("video-title"),
  qualitySelect: document.getElementById("quality-select"),
  formatSelect: document.getElementById("format-select"),
  btnDownload: document.getElementById("btn-download"),
  detectedMedia: document.getElementById("detected-media"),
  detectedMediaList: document.getElementById("detected-media-list"),
  downloadsSection: document.getElementById("downloads-section"),
  downloadsList: document.getElementById("downloads-list"),
};

let currentTabId = null;

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
  };
}

function showError(message) {
  els.statusMessage.textContent = message;
  els.statusMessage.hidden = false;
}

function clearError() {
  els.statusMessage.hidden = true;
  els.statusMessage.textContent = "";
}

function setBusy(button, busy, idleLabel) {
  button.disabled = busy;
  if (!busy && idleLabel) {
    button.textContent = idleLabel;
  }
}

function qualityOptionLabel(value) {
  if (value === "best") return "Melhor";
  if (value === "audio") return "Somente audio";
  return `${value}p`;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function analyzeVideo(overrideUrl) {
  clearError();
  const url = (overrideUrl || els.url.value).trim();
  if (!url) {
    showError("Nenhuma URL encontrada na aba atual.");
    return;
  }
  if (overrideUrl) {
    els.url.value = overrideUrl;
  }

  setBusy(els.btnAnalyze, true);
  els.btnAnalyze.textContent = "Analisando...";
  els.videoInfo.hidden = true;

  try {
    const res = await fetch(`${API_BASE_URL}/api/info`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.detail || `Erro ao analisar o video (HTTP ${res.status}).`);
      return;
    }

    renderVideoInfo(data);
  } catch (err) {
    showError("Nao foi possivel conectar a API. Verifique a URL configurada e sua conexao.");
  } finally {
    setBusy(els.btnAnalyze, false, "Analisar URL atual");
  }
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

// Mostra, direto ao abrir o popup (sem precisar clicar em "Analisar"
// antes), os videos que a extensao ja detectou no trafego de rede da aba
// atual. Util para sites que o yt-dlp nao consegue extrair diretamente da
// URL da pagina (player embutido em iframe de terceiros, por exemplo).
async function refreshDetectedMedia() {
  if (!currentTabId) return;

  const response = await chrome.runtime.sendMessage({
    type: "GET_DETECTED_MEDIA",
    tabId: currentTabId,
  });

  const media = (response && response.media) || [];
  els.detectedMediaList.innerHTML = "";

  if (media.length === 0) {
    els.detectedMedia.hidden = true;
    return;
  }

  for (const item of media) {
    const row = document.createElement("div");
    row.className = "detected-media-item";

    const info = document.createElement("span");
    info.className = "detected-media-info";
    const isStream = /\.(m3u8|mpd)(\?|$)/i.test(item.url);
    const sizeLabel = formatBytes(item.size);
    const shortUrl = item.url.length > 42 ? item.url.slice(0, 39) + "..." : item.url;
    info.title = item.url;
    info.textContent = `${isStream ? "Stream" : "Arquivo"}${sizeLabel ? " · " + sizeLabel : ""} · ${shortUrl}`;

    const actions = document.createElement("div");
    actions.className = "detected-media-actions";

    const btnDownload = document.createElement("button");
    btnDownload.className = "btn btn-success";
    btnDownload.textContent = "Baixar";
    btnDownload.title = "Baixa direto na melhor qualidade (MP4)";
    btnDownload.addEventListener("click", () => downloadDetectedMedia(item.url));

    const btnUse = document.createElement("button");
    btnUse.className = "btn btn-primary";
    btnUse.textContent = "Analisar";
    btnUse.title = "Analisa essa URL para escolher qualidade/formato";
    btnUse.addEventListener("click", () => analyzeVideo(item.url));

    actions.appendChild(btnDownload);
    actions.appendChild(btnUse);

    row.appendChild(info);
    row.appendChild(actions);
    els.detectedMediaList.appendChild(row);
  }

  els.detectedMedia.hidden = false;
}

// Baixa diretamente uma URL de midia detectada, sem passar pela tela de
// analise (usa qualidade "best" e formato mp4 como padrao razoavel).
async function downloadDetectedMedia(url) {
  clearError();
  els.url.value = url;
  await startDownload({ quality: "best", format: "mp4" });
}

function renderVideoInfo(info) {
  els.title.textContent = info.title || "Sem titulo";
  if (info.thumbnail) {
    els.thumbnail.src = info.thumbnail;
    els.thumbnail.hidden = false;
  } else {
    els.thumbnail.hidden = true;
  }

  const qualities = ["best", ...(info.available_qualities || []), "audio"];
  els.qualitySelect.innerHTML = "";
  for (const q of qualities) {
    const opt = document.createElement("option");
    opt.value = q;
    opt.textContent = qualityOptionLabel(q);
    els.qualitySelect.appendChild(opt);
  }

  els.videoInfo.hidden = false;
}

async function startDownload(overrides) {
  clearError();
  const url = els.url.value.trim();
  const quality = (overrides && overrides.quality) || els.qualitySelect.value;
  const format = (overrides && overrides.format) || els.formatSelect.value;

  setBusy(els.btnDownload, true);
  els.btnDownload.textContent = "Iniciando...";

  try {
    const res = await fetch(`${API_BASE_URL}/api/download`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ url, quality, format }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.detail || `Erro ao iniciar o download (HTTP ${res.status}).`);
      return;
    }

    chrome.runtime.sendMessage({ type: "TRACK_JOB", jobId: data.job_id, sourceUrl: url });
    await refreshDownloadsList();
  } catch (err) {
    showError("Nao foi possivel conectar a API para iniciar o download.");
  } finally {
    setBusy(els.btnDownload, false, "BAIXAR");
  }
}

function statusLabel(status) {
  const labels = {
    queued: "Na fila...",
    downloading: "Baixando...",
    processing: "Processando (FFmpeg)...",
    finished: "Concluido",
    error: "Erro",
  };
  return labels[status] || status;
}

function shortenUrl(url, max = 46) {
  if (!url) return "";
  return url.length > max ? url.slice(0, max - 3) + "..." : url;
}

// Renderiza a lista completa de downloads conhecidos pela extensao
// (independente de aba/pagina). Chamada ao abrir o popup e sempre que um
// JOB_UPDATE chega do background.js.
function renderDownloadsList(jobs) {
  els.downloadsList.innerHTML = "";

  if (!jobs || jobs.length === 0) {
    els.downloadsSection.hidden = true;
    return;
  }

  for (const job of jobs) {
    const item = document.createElement("div");
    item.className = "download-item";

    const header = document.createElement("div");
    header.className = "download-item-header";

    const title = document.createElement("span");
    title.className = "download-item-title";
    title.title = job.filename || job.sourceUrl || job.jobId;
    title.textContent = job.filename || shortenUrl(job.sourceUrl) || job.jobId;

    const closeBtn = document.createElement("button");
    closeBtn.className = "download-item-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Remover da lista";
    closeBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "REMOVE_JOB", jobId: job.jobId });
      await refreshDownloadsList();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const progress = Math.max(0, Math.min(100, job.progress || 0));

    const label = document.createElement("p");
    label.className = "progress-label";
    label.textContent =
      job.status === "error" ? job.error || "Erro no download." : statusLabel(job.status);

    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = `progress-fill status-${job.status}`;
    fill.style.width = `${progress}%`;
    bar.appendChild(fill);

    const percent = document.createElement("p");
    percent.className = "progress-percent";
    percent.textContent = `${progress}%`;

    item.appendChild(header);
    item.appendChild(label);
    item.appendChild(bar);
    item.appendChild(percent);

    els.downloadsList.appendChild(item);
  }

  els.downloadsSection.hidden = false;
}

async function refreshDownloadsList() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" });
  renderDownloadsList((response && response.jobs) || []);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "JOB_UPDATE") {
    refreshDownloadsList();
  }
  if (message.type === "MEDIA_UPDATE" && message.tabId === currentTabId) {
    refreshDetectedMedia();
  }
});

async function init() {
  const tab = await getCurrentTab();
  currentTabId = tab ? tab.id : null;
  els.url.value = (tab && tab.url) || "";

  els.btnAnalyze.addEventListener("click", () => analyzeVideo());
  els.btnDownload.addEventListener("click", () => startDownload());

  await Promise.all([refreshDetectedMedia(), refreshDownloadsList()]);
}

init();
