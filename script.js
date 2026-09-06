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
    accessCode: localStorage.getItem("lf_access_code") || "",
  visitorId: (function () {
    let id = localStorage.getItem("lf_visitor_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("lf_visitor_id", id);
    }
    return id;
  })(),
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
   accessCodeInput: document.getElementById("accessCode"),
  manageSubLink: document.getElementById("manageSubLink"),
};

els.accessCodeInput.value = state.accessCode;
els.accessCodeInput.addEventListener("input", (e) => {
  state.accessCode = e.target.value;
  localStorage.setItem("lf_access_code", state.accessCode);
});

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
    const reader = new FileReader();
    reader.onload = (e) => {
      state.documentText = String(e.target.result || "");
      els.textarea.value = state.documentText;
      updateAnalyzeButton();
    };
    reader.onerror = () => showError("Couldn't read that file. Try pasting the text directly instead.");
    reader.readAsText(file);
  }
}

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFile(file);
});

els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("drag");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("drag"));
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("drag");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// --- Analysis: submit, then poll ---
function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function setBusy(isBusy) {
  els.analyzeBtn.disabled = isBusy || !state.documentText.trim();
  els.analyzeBtn.textContent = isBusy ? "Reviewing…" : "Review document";
}

async function handleAnalyze() {
  if (!state.documentText.trim()) return;
  clearError();
  clearStatus();
  state.results = null;
  els.resultsSection.hidden = true;
  setBusy(true);
  state.startedAt = Date.now();

  try {
    const res = await fetch("/api/start-analysis", {
      method: "POST",
            headers: {
        "Content-Type": "application/json",
        "X-Access-Code": state.accessCode,
        "X-Visitor-Id": state.visitorId,
      },
      body: JSON.stringify({ documentText: state.documentText }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    state.jobId = data.jobId;
    showStatus("Reviewing… 0s elapsed");
    state.tickTimer = setInterval(() => {
      const secs = Math.round((Date.now() - state.startedAt) / 1000);
      showStatus(`Reviewing… ${secs}s elapsed. Longer documents can take a few minutes.`);
    }, 1000);
    pollJob();
  } catch (err) {
    showError(err.message || "Couldn't start the review. Try again.");
    setBusy(false);
    clearStatus();
  }
}
els.analyzeBtn.addEventListener("click", handleAnalyze);

async function pollJob() {
  if (!state.jobId) return;

  if (Date.now() - state.startedAt > MAX_POLL_MS) {
    stopPolling();
    clearStatus();
    setBusy(false);
    showError("This is taking longer than expected. The review may still finish in the background — try again in a minute, or with a shorter document.");
    return;
  }

  try {
    const res = await fetch(`/api/job-status?id=${encodeURIComponent(state.jobId)}`);
    const job = await res.json();

    if (!res.ok) {
      throw new Error(job.error || `Request failed (${res.status})`);
    }

    if (job.status === "done") {
      stopPolling();
      clearStatus();
      setBusy(false);
      state.results = {
        summary: job.result.summary || "",
        contradictions: Array.isArray(job.result.contradictions) ? job.result.contradictions : [],
        vagueTerms: Array.isArray(job.result.vagueTerms) ? job.result.vagueTerms : [],
        gaps: Array.isArray(job.result.gaps) ? job.result.gaps : [],
        keyClauses: Array.isArray(job.result.keyClauses) ? job.result.keyClauses : [],
      };
      state.activeTab = "contradictions";
      renderResults();
      return;
    }

    if (job.status === "error") {
      stopPolling();
      clearStatus();
      setBusy(false);
      showError(job.error || "The review didn't complete cleanly. Try again.");
      return;
    }

    // still pending — poll again
    state.pollTimer = setTimeout(pollJob, POLL_INTERVAL_MS);
  } catch (err) {
    stopPolling();
    clearStatus();
    setBusy(false);
    showError(err.message || "Lost track of the review. Try again.");
  }
}

// --- Rendering ---
function severityDot(level) {
  const cls = level === "High" ? "high" : level === "Medium" ? "medium" : "low";
  return `<span class="lf-dot ${cls}" title="${level || "Unspecified"} severity"></span>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function cardHtml(category, index, item) {
  if (category === "contradictions") {
    return `
      <article class="lf-card lf-card-burgundy">
        <div class="lf-card-head">
          <span class="lf-index">No. ${index}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <span class="lf-severity">${severityDot(item.severity)} ${escapeHtml(item.severity)}</span>
        </div>
        <blockquote class="lf-quote">${escapeHtml(item.clauseA)}</blockquote>
        <div class="lf-vs">conflicts with</div>
        <blockquote class="lf-quote">${escapeHtml(item.clauseB)}</blockquote>
        <p class="lf-explain">${escapeHtml(item.explanation)}</p>
      </article>`;
  }
  if (category === "vagueTerms") {
    return `
      <article class="lf-card lf-card-amber">
        <div class="lf-card-head">
          <span class="lf-index">No. ${index}</span>
          <h3>&ldquo;${escapeHtml(item.term)}&rdquo;</h3>
        </div>
        <blockquote class="lf-quote">${escapeHtml(item.context)}</blockquote>
        <p class="lf-explain">${escapeHtml(item.whyVague)}</p>
        <p class="lf-fix"><span class="lf-fix-label">Suggested fix</span> ${escapeHtml(item.suggestedFix)}</p>
      </article>`;
  }
  if (category === "gaps") {
    return `
      <article class="lf-card lf-card-teal">
        <div class="lf-card-head">
          <span class="lf-index">No. ${index}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <span class="lf-severity">${severityDot(item.risk)} ${escapeHtml(item.risk)}</span>
        </div>
        <p class="lf-explain">${escapeHtml(item.explanation)}</p>
        <p class="lf-fix"><span class="lf-fix-label">Suggested addition</span> ${escapeHtml(item.suggestedAddition)}</p>
      </article>`;
  }
  // keyClauses
  const present = !!item.present;
  return `
    <article class="lf-card lf-card-brass">
      <div class="lf-card-head">
        <span class="lf-index">No. ${index}</span>
        <h3>${escapeHtml(item.clause)}</h3>
        <span class="lf-presence ${present ? "present" : "absent"}">${present ? "Present" : "Absent"}</span>
      </div>
      ${present && item.quote ? `<blockquote class="lf-quote">${escapeHtml(item.quote)}</blockquote>` : ""}
      <p class="lf-explain">${escapeHtml(item.plainEnglish)}</p>
    </article>`;
}

function renderResults() {
  if (!state.results) return;
  els.resultsSection.hidden = false;
  els.summaryText.textContent = state.results.summary;

  els.tabs.querySelectorAll(".lf-tab").forEach((btn) => {
    const key = btn.dataset.tab;
    const count = state.results[key].length;
    const label = TABS.find((t) => t.key === key).label;
    btn.textContent = `${label} (${count})`;
    btn.classList.toggle("active", key === state.activeTab);
  });

  const list = state.results[state.activeTab];
  const label = TABS.find((t) => t.key === state.activeTab).label.toLowerCase();
  if (list.length === 0) {
    els.findingsList.innerHTML = `<div class="lf-empty">No ${label} found in this document.</div>`;
    return;
  }
  els.findingsList.innerHTML = list
    .map((item, i) => cardHtml(state.activeTab, i + 1, item))
    .join("");
}

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".lf-tab");
  if (!btn) return;
  state.activeTab = btn.dataset.tab;
  renderResults();
});

// --- Copy / reset ---
function resultsToMarkdown(results) {
  const lines = [];
  lines.push(`# Loophole Audit\n`);
  lines.push(results.summary || "");
  lines.push(`\n## Contradictions (${results.contradictions.length})\n`);
  results.contradictions.forEach((c, i) => {
    lines.push(`${i + 1}. **${c.title}** — ${c.severity}`);
    lines.push(`   - "${c.clauseA}"`);
    lines.push(`   - "${c.clauseB}"`);
    lines.push(`   - ${c.explanation}\n`);
  });
  lines.push(`\n## Vague or undefined terms (${results.vagueTerms.length})\n`);
  results.vagueTerms.forEach((v, i) => {
    lines.push(`${i + 1}. **"${v.term}"**`);
    lines.push(`   - Context: "${v.context}"`);
    lines.push(`   - Why it's vague: ${v.whyVague}`);
    lines.push(`   - Suggested fix: ${v.suggestedFix}\n`);
  });
  lines.push(`\n## Gaps — what the document does not prohibit (${results.gaps.length})\n`);
  results.gaps.forEach((g, i) => {
    lines.push(`${i + 1}. **${g.title}** — ${g.risk} risk`);
    lines.push(`   - ${g.explanation}`);
    lines.push(`   - Suggested addition: ${g.suggestedAddition}\n`);
  });
  lines.push(`\n## Key clauses\n`);
  results.keyClauses.forEach((k) => {
    lines.push(`- **${k.clause}** — ${k.present ? "Present" : "Absent"}`);
    if (k.present && k.quote) lines.push(`   - "${k.quote}"`);
    lines.push(`   - ${k.plainEnglish}\n`);
  });
  return lines.join("\n");
}

els.copyBtn.addEventListener("click", async () => {
  if (!state.results) return;
  try {
    await navigator.clipboard.writeText(resultsToMarkdown(state.results));
    els.copyBtn.textContent = "Copied";
    setTimeout(() => (els.copyBtn.textContent = "Copy findings as memo"), 2000);
  } catch {
    showError("Couldn't copy to clipboard in this browser.");
  }
});

els.resetBtn.addEventListener("click", () => {
  stopPolling();
  state.documentText = "";
  state.fileName = "";
  state.results = null;
  state.jobId = null;
  els.textarea.value = "";
  els.fileName.textContent = "";
  els.resultsSection.hidden = true;
  clearError();
  clearStatus();
  updateAnalyzeButton();
  els.fileInput.value = "";
});

updateAnalyzeButton();
els.manageSubLink.addEventListener("click", async (e) => {
  e.preventDefault();
  clearError();
  if (!state.accessCode.trim()) {
    showError("Enter your subscription's access code in the box first, then click Manage subscription again.");
    return;
  }
  const originalText = els.manageSubLink.textContent;
  els.manageSubLink.textContent = "Loading…";
  try {
    const res = await fetch("/api/manage-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: state.accessCode.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't open subscription management.");
    window.location.href = data.url;
  } catch (err) {
    showError(err.message || "Couldn't open subscription management.");
    els.manageSubLink.textContent = originalText;
  }
});
