// Logica da interface do popup:
// 1. pega a URL da aba atual
// 2. envia para /api/info ao clicar em "Analisar"
// 3. mostra titulo, thumbnail e formatos disponiveis
// 4. ao clicar em "Baixar", envia para /api/download e acompanha o job_id
//    (delegando o polling ao background.js, que continua rodando mesmo se
//    o popup for fechado)

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
  progressSection: document.getElementById("progress-section"),
  progressLabel: document.getElementById("progress-label"),
  progressFill: document.getElementById("progress-fill"),
  progressPercent: document.getElementById("progress-percent"),
};

let currentJobId = null;

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

async function getCurrentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.url : "";
}

async function analyzeVideo() {
  clearError();
  const url = els.url.value.trim();
  if (!url) {
    showError("Nenhuma URL encontrada na aba atual.");
    return;
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
    setBusy(els.btnAnalyze, false, "Analisar");
  }
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

async function startDownload() {
  clearError();
  const url = els.url.value.trim();
  const quality = els.qualitySelect.value;
  const format = els.formatSelect.value;

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
      setBusy(els.btnDownload, false, "BAIXAR");
      return;
    }

    currentJobId = data.job_id;
    els.progressSection.hidden = false;
    updateProgressUI({ status: "queued", progress: 0 });

    chrome.runtime.sendMessage({ type: "TRACK_JOB", jobId: currentJobId });
  } catch (err) {
    showError("Nao foi possivel conectar a API para iniciar o download.");
    setBusy(els.btnDownload, false, "BAIXAR");
  }
}

function updateProgressUI(state) {
  const progress = Math.max(0, Math.min(100, state.progress || 0));
  els.progressFill.style.width = `${progress}%`;
  els.progressPercent.textContent = `${progress}%`;

  const labels = {
    queued: "Na fila...",
    downloading: "Baixando...",
    processing: "Processando (FFmpeg)...",
    finished: "Concluido! Salvando arquivo...",
    error: "Erro no download.",
  };
  els.progressLabel.textContent = labels[state.status] || "Progresso:";

  if (state.status === "finished") {
    setBusy(els.btnDownload, false, "BAIXAR");
  }

  if (state.status === "error") {
    showError(state.error || "Ocorreu um erro durante o download.");
    setBusy(els.btnDownload, false, "BAIXAR");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "JOB_UPDATE" && message.jobId === currentJobId) {
    updateProgressUI(message);
  }
});

async function restoreJobStateIfAny() {
  if (!currentJobId) return;
  chrome.runtime.sendMessage({ type: "GET_JOB_STATE", jobId: currentJobId }, (response) => {
    if (response && response.state) {
      els.progressSection.hidden = false;
      updateProgressUI(response.state);
    }
  });
}

async function init() {
  const tabUrl = await getCurrentTabUrl();
  els.url.value = tabUrl || "";

  els.btnAnalyze.addEventListener("click", analyzeVideo);
  els.btnDownload.addEventListener("click", startDownload);

  await restoreJobStateIfAny();
}

init();
