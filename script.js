const TABS = [
  { key: "contradictions", label: "Contradictions" },
  { key: "vagueTerms", label: "Vague terms" },
  { key: "gaps", label: "Gaps" },
  { key: "keyClauses", label: "Key Clauses" },
];

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 6 * 60 * 1000; // 6 minutes

const state = {
  documentText: "",
  fileName: "",
  results: null,
  activeTab: "contradictions",
  jobId: null,
  pollTimer: null,
  tickTimer: null,
  startedAt: null,
};

const els = {
  textarea: document.getElementById("documentText"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  uploadLabelText: document.getElementById("uploadLabelText"),
  fileName: document.getElementById("fileName"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  errorBox: document.getElementById("errorBox"),
  statusBox: document.getElementById("statusBox"),
  resultsSection: document.getElementById("resultsSection"),
  summaryText: document.getElementById("summaryText"),
  tabs: document.getElementById("tabs"),
  findingsList: document.getElementById("findingsList"),
  copyBtn: document.getElementById("copyBtn"),
  resetBtn: document.getElementById("resetBtn"),
};

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.hidden = false;
}
function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = "";
}
function showStatus(msg) {
  els.statusBox.textContent = msg;
  els.statusBox.hidden = false;
}
function clearStatus() {
  els.statusBox.hidden = true;
  els.statusBox.textContent = "";
}

function updateAnalyzeButton() {
  els.analyzeBtn.disabled = !state.documentText.trim();
}

els.textarea.addEventListener("input", (e) => {
  state.documentText = e.target.value;
  updateAnalyzeButton();
});

// --- File handling ---
function handleFile(file) {
  if (!file) return;
  clearError();
  state.fileName = file.name;
  els.fileName.textContent = file.name;
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".docx")) {
    els.uploadLabelText.textContent = "Reading file…";
    file
      .arrayBuffer()
      .then((buf) => window.mammoth.extractRawText({ arrayBuffer: buf }))
      .then((res) => {
        state.documentText = res.value || "";
        els.textarea.value = state.documentText;
        updateAnalyzeButton();
        els.uploadLabelText.textContent = "Upload a file";
      })
      .catch(() => {
        showError("Couldn't read that .docx file. Try pasting the text directly instead.");
        els.uploadLabelText.textContent = "Upload a file";
      });
  } else {
    const
