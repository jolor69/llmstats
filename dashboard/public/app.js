const API_BASE = "/api";

const el = (id) => document.getElementById(id);

function usd(n) {
  if (n == null) return "n/a";
  return `$${n.toFixed(2)}`;
}

function fmtLocal(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleString("en-SG", {
      timeZone: "Asia/Singapore",
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json();
}

function setConnStatus(status) {
  const dot = el("conn-dot");
  const label = el("conn-label");
  dot.classList.remove("ok", "err");
  if (status === "ok") {
    dot.classList.add("ok");
    label.textContent = "LIVE";
  } else if (status === "err") {
    dot.classList.add("err");
    label.textContent = "OFFLINE";
  } else {
    label.textContent = "CONNECTING";
  }
}

function renderAccount(aggregate, accounts) {
  if (aggregate) {
    el("balance-value").textContent = usd(aggregate.balance);
    el("balance-value").classList.toggle("negative", aggregate.balance < 0);
    el("used-value").textContent = usd(aggregate.total_usage);
    el("purchased-value").textContent = usd(aggregate.total_credits);
    el("delta-value").textContent = aggregate.delta_24h != null ? usd(aggregate.delta_24h) : "n/a";
    el("last-updated").textContent = `LAST SYNC: ${fmtLocal(aggregate.fetched_at)}`;
  }

  const wrap = el("hero-accounts");
  wrap.innerHTML = "";
  for (const acc of accounts ?? []) {
    const pill = document.createElement("div");
    pill.className = "hero-account-pill";
    pill.setAttribute("role", "listitem");
    pill.innerHTML = `<span class="acct-name">${escapeHtml(acc.name)}</span><span class="acct-balance">${usd(acc.balance)}</span>`;
    wrap.appendChild(pill);
  }
}

let allApps = [];

function renderGrid(apps) {
  const grid = el("app-grid");
  grid.innerHTML = "";
  el("app-count").textContent = `[${apps.length}]`;

  for (const app of apps) {
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "listitem");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `${app.label}, usage ${usd(app.usage)}`);

    const pct = app.limit ? Math.min(100, (app.usage / app.limit) * 100) : 0;
    const barClass = pct > 90 ? "crit" : pct > 70 ? "warn" : "";

    card.innerHTML = `
      <div class="card-top">
        <span class="card-label">${escapeHtml(app.label)}</span>
        <div class="card-top-badges">
          <span class="card-account">${escapeHtml(app.account)}</span>
          ${app.disabled ? '<span class="card-badge">DISABLED</span>' : ""}
        </div>
      </div>
      <div class="card-usage">${usd(app.usage)}</div>
      <div class="card-limit">LIMIT: ${app.limit != null ? usd(app.limit) : "UNLIMITED"}</div>
      ${app.limit ? `<div class="card-bar-track"><div class="card-bar-fill ${barClass}" style="width:${pct}%"></div></div>` : ""}
      <div class="card-delta">24H: ${app.delta_24h != null ? `<span class="${app.delta_24h > 0 ? "up" : ""}">${usd(app.delta_24h)}</span>` : "n/a"}</div>
    `;

    card.addEventListener("click", () => openDrawer(app.hash, app.label, app.account, app.usage));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDrawer(app.hash, app.label, app.account, app.usage);
      }
    });

    grid.appendChild(card);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function applyFilter() {
  const q = el("filter-input").value.trim().toLowerCase();
  const filtered = q
    ? allApps.filter((a) => a.label.toLowerCase().includes(q) || a.account.toLowerCase().includes(q))
    : allApps;
  renderGrid(filtered);
}

// --- Drawer / history chart ---

let currentHash = null;
let currentDays = 7;

function openDrawer(hash, label, account, usage) {
  currentHash = hash;
  currentDays = 7;
  document.querySelectorAll(".range-btn").forEach((b) => b.classList.toggle("active", b.dataset.days === "7"));
  el("drawer-title").textContent = `${label} [${account}]`;
  el("drawer-total").textContent = `TOTAL (ALL-TIME): ${usd(usage)}`;
  el("history-drawer").classList.add("open");
  el("history-drawer").setAttribute("aria-hidden", "false");
  loadHistory();
  loadModels();
}

function closeDrawer() {
  el("history-drawer").classList.remove("open");
  el("history-drawer").setAttribute("aria-hidden", "true");
}

el("drawer-backdrop").addEventListener("click", closeDrawer);
el("drawer-close").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentDays = Number(btn.dataset.days);
    loadHistory();
    loadModels();
  });
});

async function loadHistory() {
  if (!currentHash) return;
  try {
    const data = await apiGet(`/apps/${encodeURIComponent(currentHash)}/history?days=${currentDays}`);
    drawChart(data.points ?? []);
    const meta = el("drawer-meta");
    const points = data.points ?? [];
    if (points.length >= 2) {
      const spend = points[points.length - 1].usage - points[0].usage;
      meta.textContent = `${points.length} snapshots · spend over range: ${usd(spend)}`;
    } else {
      meta.textContent = "insufficient snapshots for this range yet";
    }
  } catch (err) {
    console.error(err);
    el("drawer-meta").textContent = "failed to load history";
  }
}

async function loadModels() {
  if (!currentHash) return;
  const container = el("models-table");
  container.innerHTML = '<div class="models-empty">loading...</div>';
  try {
    const data = await apiGet(`/apps/${encodeURIComponent(currentHash)}/models?days=${currentDays}`);
    const models = data.models ?? [];
    const days = data.days ?? currentDays;
    el("models-range-label").textContent = `[LAST ${days}D]`;
    if (models.length === 0) {
      container.innerHTML = `<div class="models-empty">no activity in the last ${days} days</div>`;
      return;
    }
    container.innerHTML = models
      .map(
        (m) => `
      <div class="model-row">
        <span class="model-name">${escapeHtml(m.model)}</span>
        <span class="model-requests">${m.requests} req</span>
        <span class="model-usage">${usd(m.usage)}</span>
      </div>
    `
      )
      .join("");
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="models-empty">failed to load model breakdown</div>';
  }
}

function drawChart(points) {
  const svg = el("history-chart");
  svg.innerHTML = "";
  const W = 640;
  const H = 220;
  const PAD = 24;

  if (points.length < 2) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", W / 2);
    text.setAttribute("y", H / 2);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#7c8798");
    text.setAttribute("font-family", "Fira Code, monospace");
    text.setAttribute("font-size", "12");
    text.textContent = "not enough data yet";
    svg.appendChild(text);
    return;
  }

  const usages = points.map((p) => p.usage);
  const min = Math.min(...usages);
  const max = Math.max(...usages);
  const range = max - min || 1;

  const xStep = (W - PAD * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = PAD + i * xStep;
    const y = H - PAD - ((p.usage - min) / range) * (H - PAD * 2);
    return [x, y];
  });

  // gridlines
  for (let i = 0; i <= 4; i++) {
    const y = PAD + (i * (H - PAD * 2)) / 4;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", PAD);
    line.setAttribute("x2", W - PAD);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#334155");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-dasharray", "2,3");
    svg.appendChild(line);
  }

  const pathD = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${coords[coords.length - 1][0].toFixed(1)},${H - PAD} L${coords[0][0].toFixed(1)},${H - PAD} Z`;

  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  area.setAttribute("d", areaD);
  area.setAttribute("fill", "rgba(34,217,122,0.12)");
  svg.appendChild(area);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#22d97a");
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);

  const last = coords[coords.length - 1];
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", last[0]);
  dot.setAttribute("cy", last[1]);
  dot.setAttribute("r", "3.5");
  dot.setAttribute("fill", "#22d97a");
  svg.appendChild(dot);
}

// --- filter wiring ---
el("filter-input").addEventListener("input", applyFilter);

// --- polling loop ---
async function refresh() {
  try {
    const [appsRes, accountRes] = await Promise.all([apiGet("/apps"), apiGet("/account")]);
    allApps = (appsRes.apps ?? []).sort((a, b) => a.label.localeCompare(b.label));
    applyFilter();
    renderAccount(accountRes.aggregate, accountRes.accounts);
    setConnStatus("ok");
  } catch (err) {
    console.error(err);
    setConnStatus("err");
  }
}

refresh();
setInterval(refresh, 60_000);
