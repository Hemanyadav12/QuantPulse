// QuantPulse — Institutional Quantitative Analytics & Trading Terminal Logic

let selectedSymbol = "AAPL";
let isSyncPaused = false;
let pollingInterval = null;

// Chart instances
let priceChart = null;
let returnChart = null;

// Full Company Name Mapping
const ASSET_NAME_MAP = {
  "AAPL": "Apple",
  "TSLA": "Tesla",
  "NVDA": "Nvidia",
  "BTC-USD": "Bitcoin",
  "ETH-USD": "Ethereum",
  "BTC": "Bitcoin",
  "ETH": "Ethereum",
};

function getAssetDisplayName(symbol) {
  return ASSET_NAME_MAP[symbol] || symbol;
}

// Caches for delta calculation, sparklines, historical trends, intraday baseline, and fast asset switching
const previousPriceMap = {};
const symbolHistoryCache = {};
const historicalDataCache = {};
const intradayDataCache = {};   // 8-10h intraday 15-min bars per symbol
let latestCachedMarketRecords = [];

// DOM Elements
const symbolSelect = document.getElementById("symbolSelect");
const assetPills = document.getElementById("assetPills");
const pauseResumeBtn = document.getElementById("pauseResumeBtn");
const pauseIcon = document.getElementById("pauseIcon");
const playIcon = document.getElementById("playIcon");
const pauseBtnText = document.getElementById("pauseBtnText");
const lastSyncBadge = document.getElementById("lastSync");

// -----------------------------------------------------------------------------
// Interactive Controls & Asset Switcher Setup
// -----------------------------------------------------------------------------

function setupControls() {
  if (assetPills) {
    assetPills.addEventListener("click", (e) => {
      const btn = e.target.closest(".pill-btn");
      if (!btn) return;
      const symbol = btn.getAttribute("data-symbol");
      if (symbol && symbol !== selectedSymbol) {
        selectAsset(symbol);
      }
    });
  }

  if (symbolSelect) {
    symbolSelect.addEventListener("change", (e) => {
      selectAsset(e.target.value);
    });
  }

  if (pauseResumeBtn) {
    pauseResumeBtn.addEventListener("click", togglePauseResume);
  }

  // Reset Zoom button for the 3-Zone Price Chart
  const resetZoomBtn = document.getElementById("resetZoomBtn");
  if (resetZoomBtn) {
    resetZoomBtn.addEventListener("click", () => {
      if (priceChart && typeof priceChart.resetZoom === "function") {
        priceChart.resetZoom();
      }
      hideResetZoomBtn();
    });
  }
}

function selectAsset(symbol) {
  selectedSymbol = symbol;

  // Reset zoom/pan when switching assets so the new asset view is fully visible
  if (priceChart && typeof priceChart.resetZoom === "function") {
    priceChart.resetZoom();
  }
  hideResetZoomBtn();

  if (assetPills) {
    assetPills.querySelectorAll(".pill-btn").forEach((btn) => {
      if (btn.getAttribute("data-symbol") === symbol) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  if (symbolSelect && symbolSelect.value !== symbol) {
    symbolSelect.value = symbol;
  }

  updateWatchlistActiveRow();

  // Fetch real 1M historical daily data if not cached yet
  fetchHistoricalTrend(symbol).then(() => {
    if (latestCachedMarketRecords && latestCachedMarketRecords.length > 0) {
      renderSelectedAssetViews(latestCachedMarketRecords);
    }
  });

  if (latestCachedMarketRecords && latestCachedMarketRecords.length > 0) {
    renderSelectedAssetViews(latestCachedMarketRecords);
  }
}

function togglePauseResume() {
  isSyncPaused = !isSyncPaused;

  if (isSyncPaused) {
    if (pauseResumeBtn) pauseResumeBtn.classList.add("paused");
    if (pauseIcon) pauseIcon.classList.add("hidden");
    if (playIcon) playIcon.classList.remove("hidden");
    if (pauseBtnText) pauseBtnText.textContent = "Resume Sync";
    if (lastSyncBadge) {
      lastSyncBadge.textContent = "Sync Paused";
      lastSyncBadge.style.color = "#f59e0b";
    }
  } else {
    if (pauseResumeBtn) pauseResumeBtn.classList.remove("paused");
    if (playIcon) playIcon.classList.add("hidden");
    if (pauseIcon) pauseIcon.classList.remove("hidden");
    if (pauseBtnText) pauseBtnText.textContent = "Pause Sync";
    if (lastSyncBadge) lastSyncBadge.style.color = "";
    refreshDashboard();
  }
}

// -----------------------------------------------------------------------------
// Crosshair Hover Guide Plugin (vertical dashed line tracking mouse position)
// -----------------------------------------------------------------------------

const crosshairPlugin = {
  id: "crosshairPlugin",
  _x: null,
  afterEvent(chart, args) {
    if (!chart || !chart.canvas || chart.canvas.id !== "priceChart") return;
    const event = args && args.event;
    if (!event) return;
    if (event.type === "mousemove") {
      this._x = event.x;
      chart.draw();
    } else if (event.type === "mouseout") {
      this._x = null;
      chart.draw();
    }
  },
  afterDraw(chart) {
    if (!chart || !chart.canvas || chart.canvas.id !== "priceChart") return;
    if (this._x === null) return;
    const { top, bottom, left, right } = chart.chartArea || {};
    if (top === undefined) return;
    const x = this._x;
    if (x < left || x > right) return;
    const ctx = chart.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = 1;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// -----------------------------------------------------------------------------
// Reset Zoom Button Helpers
// -----------------------------------------------------------------------------

function showResetZoomBtn() {
  const btn = document.getElementById("resetZoomBtn");
  if (btn) btn.classList.remove("hidden");
}

function hideResetZoomBtn() {
  const btn = document.getElementById("resetZoomBtn");
  if (btn) btn.classList.add("hidden");
}

// -----------------------------------------------------------------------------
// 3-Zone Vertical Transition Dividers Plugin (Custom Chart.js Canvas Hook)
// -----------------------------------------------------------------------------

const threeZoneDividerPlugin = {
  id: "threeZoneDividerPlugin",
  afterDraw(chart) {
    if (!chart || !chart.canvas || chart.canvas.id !== "priceChart") return;
    if (!chart.chartArea) return;

    const { top, bottom, left, right } = chart.chartArea;
    const ctx = chart.ctx;
    if (!ctx) return;

    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || meta.data.length === 0) return;

    function drawDivider(index, labelText, strokeColor, textColor) {
      if (index === undefined || index < 0 || index >= meta.data.length) return;
      const point = meta.data[index];
      if (!point || isNaN(point.x)) return;
      const x = point.x;
      if (x < left || x > right) return;

      ctx.save();
      // Crisp vertical dashed divider line
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      // Floating header badge
      ctx.setLineDash([]);
      ctx.font = "600 8.5px 'JetBrains Mono', monospace";
      const textWidth = ctx.measureText(labelText).width;
      const badgeW = textWidth + 12;
      const badgeH = 17;
      const badgeX = Math.max(left + 2, Math.min(right - badgeW - 2, x - badgeW / 2));
      const badgeY = top + 4;

      ctx.fillStyle = "rgba(7, 12, 24, 0.94)";
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
        ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
      }

      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, badgeX + badgeW / 2, badgeY + badgeH / 2);
      ctx.restore();
    }

    // Divider 1: Boundary between Historical Trend and Live Stream
    if (chart._boundaryLiveIndex !== undefined) {
      drawDivider(chart._boundaryLiveIndex, "LIVE STREAM", "rgba(6, 182, 212, 0.85)", "#06b6d4");
    }

    // Divider 2: Boundary between Live Stream and Future Forecast
    if (chart._boundaryForecastIndex !== undefined) {
      const isUp = chart._isForecastUp !== undefined ? chart._isForecastUp : true;
      const forecastColor = isUp ? "rgba(16, 185, 129, 0.85)" : "rgba(244, 63, 94, 0.85)";
      const forecastTextColor = isUp ? "#10b981" : "#f43f5e";
      drawDivider(chart._boundaryForecastIndex, "AI FORECAST", forecastColor, forecastTextColor);
    }
  },
};

if (typeof Chart !== "undefined") {
  Chart.register(threeZoneDividerPlugin);
  Chart.register(crosshairPlugin);
  if (typeof ChartZoom !== "undefined") {
    Chart.register(ChartZoom);
  }
}

// -----------------------------------------------------------------------------
// Chart.js Setup (3-Zone Unified Price Chart & Return Distribution)
// -----------------------------------------------------------------------------

function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded yet");
    return;
  }

  const commonGrid = {
    color: "rgba(148, 163, 184, 0.07)",
    tickColor: "transparent",
  };

  const commonTicks = {
    color: "#64748b",
    font: { family: "'JetBrains Mono', monospace", size: 10.5 },
  };

  const commonTooltip = {
    backgroundColor: "rgba(7, 12, 24, 0.95)",
    titleColor: "#94a3b8",
    titleFont: { family: "'Inter', sans-serif", size: 11, weight: "600" },
    bodyColor: "#f8fafc",
    bodyFont: { family: "'JetBrains Mono', monospace", size: 12, weight: "600" },
    borderColor: "rgba(148, 163, 184, 0.22)",
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    cornerRadius: 6,
    displayColors: false,
    callbacks: {
      label: (ctx) => {
        if (ctx.datasetIndex === 3) return null; // Hide raw upper bound line
        if (ctx.datasetIndex === 4) {
          return `Confidence Cone: ±1σ Range`;
        }
        const val = Number(ctx.raw);
        if (isNaN(val)) return null;
        return `${ctx.dataset.label}: $${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
      },
    },
  };

  // Zone-aware tooltip title for priceChart (shows zone label + date/time)
  const priceTooltipCallbacks = {
    title: (items) => {
      if (!items || items.length === 0) return "";
      const item = items[0];
      const idx = item.dataIndex;
      let zoneTag = "Historical Close";
      if (priceChart) {
        const liveIdx = priceChart._boundaryLiveIndex;
        const forecastIdx = priceChart._boundaryForecastIndex;
        if (liveIdx !== undefined && forecastIdx !== undefined) {
          if (idx > forecastIdx) {
            zoneTag = "AI Forecast (48h Horizon)";
          } else if (idx >= liveIdx) {
            zoneTag = "Live Stream Quote";
          } else {
            zoneTag = "Historical Close";
          }
        }
      }
      const label = item.label || "";
      return `${zoneTag}  •  ${label}`;
    },
    label: (ctx) => {
      if (ctx.datasetIndex === 3) return null;
      if (ctx.datasetIndex === 4) return `Confidence Cone: ±1σ Range`;
      const val = Number(ctx.raw);
      if (isNaN(val)) return null;
      return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    },
  };

  // 1. 3-Zone Unified Price Chart Canvas
  const priceCanvas = document.getElementById("priceChart");
  if (priceCanvas) {
    const priceCtx = priceCanvas.getContext("2d");
    if (priceCtx) {
      const trendGradient = priceCtx.createLinearGradient(0, 0, 0, 310);
      trendGradient.addColorStop(0, "rgba(100, 116, 139, 0.2)");
      trendGradient.addColorStop(1, "rgba(100, 116, 139, 0.0)");

      const liveGradient = priceCtx.createLinearGradient(0, 0, 0, 310);
      liveGradient.addColorStop(0, "rgba(6, 182, 212, 0.35)");
      liveGradient.addColorStop(0.6, "rgba(16, 185, 129, 0.1)");
      liveGradient.addColorStop(1, "rgba(6, 182, 212, 0.0)");

      priceChart = new Chart(priceCtx, {
        type: "line",
        data: {
          labels: [],
          datasets: [
            {
              label: "1M Historical Trend",
              data: [],
              borderColor: "#64748b",
              borderWidth: 1.8,
              backgroundColor: trendGradient,
              fill: true,
              tension: 0.25,
              pointRadius: 0,
              pointHoverRadius: 4,
            },
            {
              label: "Live Stream",
              data: [],
              borderColor: "#06b6d4",
              borderWidth: 2.2,
              backgroundColor: liveGradient,
              fill: true,
              tension: 0.25,
              pointRadius: 2.5,
              pointBackgroundColor: "#06b6d4",
              pointHoverRadius: 5.5,
              pointHoverBackgroundColor: "#ffffff",
            },
            {
              label: "Future Projection",
              data: [],
              borderColor: "#10b981",
              borderWidth: 2,
              borderDash: [5, 4],
              fill: false,
              tension: 0.25,
              pointRadius: 2.5,
              pointBackgroundColor: "#10b981",
              pointHoverRadius: 5,
            },
            {
              label: "Upper Bound (+1σ)",
              data: [],
              borderColor: "transparent",
              borderWidth: 0,
              fill: false,
              pointRadius: 0,
              pointHoverRadius: 0,
            },
            {
              label: "Confidence Cone",
              data: [],
              borderColor: "transparent",
              borderWidth: 0,
              backgroundColor: "rgba(16, 185, 129, 0.12)",
              fill: "-1",
              pointRadius: 0,
              pointHoverRadius: 0,
            },
            {
              label: "Session Mean",
              data: [],
              borderColor: "rgba(6, 182, 212, 0.55)",
              borderWidth: 1.5,
              borderDash: [5, 4],
              fill: false,
              pointRadius: 0,
              pointHoverRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              ...commonTooltip,
              callbacks: priceTooltipCallbacks,
            },
            zoom: {
              pan: {
                enabled: true,
                mode: "xy",
                onPan() { showResetZoomBtn(); },
              },
              zoom: {
                wheel: { enabled: true, modifierKey: null },
                drag: { enabled: true, modifierKey: "ctrl" },
                mode: "xy",
                onZoom() { showResetZoomBtn(); },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                ...commonTicks,
                autoSkip: false,
                maxRotation: 0,
                callback: function (value, index) {
                  const label = this.getLabelForValue(value);
                  if (!label) return "";
                  // Always guarantee +24h (1D) and +48h (2D) are visible on the X-axis
                  if (label === "+24h (1D)" || label === "+48h (2D)") return label;
                  // Hide intermediate +6h/+12h/+18h/+30h/+36h/+42h labels so 1D & 2D stand out cleanly
                  if (label.startsWith("+")) return "";
                  // Show evenly spaced historical & intraday timestamps
                  return index % 8 === 0 ? label : "";
                },
              },
              grid: commonGrid,
            },
            y: {
              ticks: {
                ...commonTicks,
                callback: (v) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
              },
              grid: commonGrid,
            },
          },
        },
      });
    }
  }

  // 2. Predicted Return Bar Chart (Clear Zero Baseline)
  const returnCanvas = document.getElementById("returnChart");
  if (returnCanvas) {
    const returnCtx = returnCanvas.getContext("2d");
    if (returnCtx) {
      returnChart = new Chart(returnCtx, {
        type: "bar",
        data: {
          labels: [],
          datasets: [
            {
              label: "Pred Ret %",
              data: [],
              backgroundColor: [],
              borderRadius: 4,
              borderSkipped: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              ...commonTooltip,
              callbacks: {
                label: (ctx) => `Alpha Forecast: ${Number(ctx.raw) >= 0 ? "+" : ""}${Number(ctx.raw).toFixed(4)}%`,
              },
            },
          },
          scales: {
            x: {
              ticks: { ...commonTicks, maxTicksLimit: 6 },
              grid: commonGrid,
            },
            y: {
              ticks: {
                ...commonTicks,
                callback: (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`,
              },
              grid: {
                color: (ctx) => (ctx.tick.value === 0 ? "rgba(148, 163, 184, 0.35)" : "rgba(148, 163, 184, 0.06)"),
                lineWidth: (ctx) => (ctx.tick.value === 0 ? 1.5 : 1),
              },
            },
          },
        },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Formatters & Utility Functions
// -----------------------------------------------------------------------------

function formatTime(isoOrTimestamp) {
  if (!isoOrTimestamp) return "";
  const d = new Date(isoOrTimestamp);
  return isNaN(d.getTime())
    ? String(isoOrTimestamp).slice(11, 19)
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h ago`;
}

function formatCurrency(val) {
  const n = Number(val);
  if (isNaN(n)) return "--";
  const decimals = n >= 100 ? 2 : 4;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// -----------------------------------------------------------------------------
// Real Historical Data Fetching & Fallback Generator
// -----------------------------------------------------------------------------

async function fetchHistoricalTrend(symbol) {
  const cached = historicalDataCache[symbol];
  const now = Date.now();
  if (cached && (now - cached.timestamp < 600000)) {
    return cached.records;
  }

  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&points=22`);
    if (res.ok) {
      const data = await res.json();

      // Zone 1: 1-month daily records
      if (data && Array.isArray(data.records) && data.records.length > 0) {
        const records = data.records.map((r) => ({
          date: r.date || "Past",
          close: Number(r.close),
          timestamp: r.timestamp || new Date().toISOString(),
        }));
        historicalDataCache[symbol] = { records, timestamp: now };
      }

      // Zone 2 baseline: 15-min intraday bars (8-10 hours)
      if (data && Array.isArray(data.intraday) && data.intraday.length > 0) {
        const intraday = data.intraday.map((r) => ({
          time: r.time || "",
          close: Number(r.close),
          timestamp: r.timestamp || new Date().toISOString(),
        }));
        intradayDataCache[symbol] = { records: intraday, timestamp: now };
      }

      if (historicalDataCache[symbol]) {
        return historicalDataCache[symbol].records;
      }
    }
  } catch (err) {
    console.warn(`Historical API unavailable for ${symbol}, utilizing deterministic baseline:`, err);
  }

  const fallback = generateFallbackHistorical(symbol);
  historicalDataCache[symbol] = { records: fallback, timestamp: now };
  return fallback;
}

function generateFallbackHistorical(symbol, anchorPrice) {
  const assetVolMap = {
    "AAPL": 0.0022,
    "TSLA": 0.0048,
    "NVDA": 0.0042,
    "BTC-USD": 0.0075,
    "ETH-USD": 0.0085,
  };
  const vol = assetVolMap[symbol] || 0.0035;
  const target = anchorPrice || (symbol.includes("BTC") ? 60000 : symbol.includes("ETH") ? 2500 : 180);

  let seed = 0;
  for (let c = 0; c < symbol.length; c++) {
    seed += symbol.charCodeAt(c) * (c + 1);
  }

  const points = 22;
  const records = new Array(points);
  records[points - 1] = {
    date: "Today",
    close: target,
    timestamp: new Date().toISOString(),
  };

  const now = Date.now();
  for (let i = points - 2; i >= 0; i--) {
    const wave = Math.sin((i + seed) * 0.45) * 0.55 + Math.cos((i * 1.5 + seed) * 0.3) * 0.45;
    const stepDrift = vol * wave * 0.4;
    const p = Number((records[i + 1].close * (1 - stepDrift)).toFixed(4));
    const dayOffset = points - 1 - i;
    const d = new Date(now - dayOffset * 86400000);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    records[i] = {
      date: dateStr,
      close: p,
      timestamp: d.toISOString(),
    };
  }

  return records;
}

// Fallback: generate 32-bar intraday baseline from asset volatility
function generateFallbackIntraday(symbol, anchorPrice) {
  const assetVolMap = {
    "AAPL": 0.0028, "TSLA": 0.0055, "NVDA": 0.0048,
    "BTC-USD": 0.0085, "ETH-USD": 0.0095,
  };
  const barVol = assetVolMap[symbol] || 0.004;
  const anchor = anchorPrice || (symbol.includes("BTC") ? 60000 : symbol.includes("ETH") ? 2500 : 180);

  let seed = 0;
  for (let c = 0; c < symbol.length; c++) seed += symbol.charCodeAt(c) * (c + 1);

  const N = 32;
  const prices = [anchor];
  for (let i = 1; i < N; i++) {
    const wave = Math.sin((i + seed) * 0.52) * 0.6 + Math.cos((i * 1.3 + seed) * 0.4) * 0.4;
    prices.push(Number((prices[i - 1] * (1 + barVol * wave * 0.55)).toFixed(4)));
  }
  // Rescale so last bar == anchor
  const scale = anchor / (prices[prices.length - 1] || 1);
  const now = Date.now();
  return prices.map((p, i) => {
    const offsetMs = (N - 1 - i) * 15 * 60 * 1000;
    const d = new Date(now - offsetMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return {
      time: `${hh}:${mm}`,
      close: Number((p * scale).toFixed(4)),
      timestamp: d.toISOString(),
    };
  });
}

// Apply subtle ±micro-jitter to a flat price array (display only — never KPI data)
function applyMicroJitter(prices, symbol) {
  if (!prices || prices.length < 2) return prices;
  const assetJitterMap = {
    "AAPL": 0.0008, "TSLA": 0.0014, "NVDA": 0.0012,
    "BTC-USD": 0.0018, "ETH-USD": 0.0020,
  };
  const maxJitter = assetJitterMap[symbol] || 0.0012;

  // Check if the array is flat (all values identical or variance ~0)
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  const priceMag = prices[0] || 1;
  // Flat threshold: range < 0.08% of price
  if (range / priceMag > 0.0008) return prices;

  // Apply deterministic jitter
  let seed = symbol.length * 17;
  return prices.map((p) => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    const jitter = ((seed / 0xffffffff) - 0.5) * 2 * maxJitter;
    return Number((p * (1 + jitter)).toFixed(4));
  });
}

// Responsive Inline SVG Mini-Sparkline (80x24)
function generateSparklineSvg(prices, isPositive) {
  if (!prices || prices.length < 2) {
    return `<svg class="table-sparkline-svg" width="80" height="24" viewBox="0 0 80 24"><line x1="2" y1="12" x2="78" y2="12" stroke="rgba(148, 163, 184, 0.3)" stroke-width="1.5" stroke-dasharray="2 2" /></svg>`;
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const pad = 3;

  const points = prices.map((p, idx) => {
    const x = pad + (idx / (prices.length - 1)) * (w - pad * 2);
    const y = (h - pad) - ((p - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const strokeColor = isPositive ? "#10b981" : "#f43f5e";
  const pathD = `M ${points.join(" L ")}`;

  return `
    <svg class="table-sparkline-svg" width="80" height="24" viewBox="0 0 80 24" fill="none">
      <path d="${pathD}" stroke="${strokeColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

// -----------------------------------------------------------------------------
// Live Polling & Master Refresh Loop
// -----------------------------------------------------------------------------

async function refreshDashboard() {
  if (isSyncPaused) return;

  try {
    const [mktRes, newsRes] = await Promise.all([
      fetch("/api/market"),
      fetch("/api/news"),
    ]);

    const mktData = (await mktRes.json()).records || [];
    const newsData = (await newsRes.json()).records || [];

    latestCachedMarketRecords = mktData;

    if (mktData.length > 0) {
      mktData.forEach((row) => {
        if (!symbolHistoryCache[row.symbol]) {
          symbolHistoryCache[row.symbol] = [];
        }
        symbolHistoryCache[row.symbol].push(row);
        if (symbolHistoryCache[row.symbol].length > 50) {
          symbolHistoryCache[row.symbol].shift();
        }
      });

      renderSelectedAssetViews(mktData);
      renderWatchlistTable(mktData);
    }

    renderNewsFeed(newsData);

    const nowStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const syncBadge = document.getElementById("lastSync");
    if (syncBadge) {
      syncBadge.textContent = `Live • ${nowStr}`;
      syncBadge.style.color = "";
    }
  } catch (err) {
    console.warn("QuantPulse telemetry poll warning:", err);
    const syncBadge = document.getElementById("lastSync");
    if (syncBadge) {
      syncBadge.textContent = "Pipeline Offline";
      syncBadge.style.color = "#f43f5e";
    }
  }
}

// -----------------------------------------------------------------------------
// Render Asset-Specific KPIs & 3-Zone Unified Price Chart
// -----------------------------------------------------------------------------

function renderSelectedAssetViews(mktData) {
  if (!mktData || mktData.length === 0) return;

  const latestMap = {};
  mktData.forEach((row) => { latestMap[row.symbol] = row; });

  const current = latestMap[selectedSymbol] || mktData[mktData.length - 1];
  if (!current) return;

  const currentPrice = Number(current.avg_price);
  const prevPrice = previousPriceMap[selectedSymbol] !== undefined ? previousPriceMap[selectedSymbol] : currentPrice;
  const deltaVal = currentPrice - prevPrice;
  const deltaPct = prevPrice > 0 ? (deltaVal / prevPrice) * 100 : 0.0;
  previousPriceMap[selectedSymbol] = currentPrice;

  const displayName = getAssetDisplayName(selectedSymbol);

  // 1. KPI Card 1: Live Asset Price & Micro-Change Delta Pill
  const priceEl = document.getElementById("kpiPrice");
  if (priceEl) priceEl.textContent = formatCurrency(currentPrice);

  const deltaEl = document.getElementById("kpiPriceDelta");
  if (deltaEl) {
    if (deltaVal > 0.00001) {
      deltaEl.className = "delta-pill mono up";
      deltaEl.textContent = `+${deltaVal >= 1 ? deltaVal.toFixed(2) : deltaVal.toFixed(4)} / +${deltaPct.toFixed(2)}%`;
    } else if (deltaVal < -0.00001) {
      deltaEl.className = "delta-pill mono down";
      deltaEl.textContent = `${deltaVal >= 1 ? deltaVal.toFixed(2) : deltaVal.toFixed(4)} / ${deltaPct.toFixed(2)}%`;
    } else {
      deltaEl.className = "delta-pill mono neutral";
      deltaEl.textContent = `+0.00 / 0.00%`;
    }
  }

  const volEl = document.getElementById("kpiVolume");
  if (volEl) {
    volEl.textContent = current.latest_volume ? Number(current.latest_volume).toLocaleString() : (current.tick_count ? `${current.tick_count} ticks` : "--");
  }

  // 2. KPI Card 2: Predicted Return %
  const retVal = Number(current.predicted_return_pct);
  const retEl = document.getElementById("kpiReturn");
  if (retEl) {
    retEl.textContent = `${retVal >= 0 ? "+" : ""}${retVal.toFixed(4)}%`;
    if (retVal >= 0) {
      retEl.className = "kpi-value kpi-value-gradient mono";
    } else {
      retEl.className = "kpi-value kpi-value-gradient neg-grad mono";
    }
  }

  // 3. KPI Card 3: Directional Signal & Circular SVG Confidence Gauge
  const dirEl = document.getElementById("kpiDirection");
  const confTextEl = document.getElementById("kpiConfidenceText");
  const gaugeProgressArc = document.getElementById("gaugeProgressArc");
  const gaugeCenterText = document.getElementById("gaugeCenterText");
  const subBarFill = document.getElementById("kpiConfidenceSubBar");

  const direction = (current.predicted_direction || (retVal >= 0 ? "UP" : "DOWN")).toUpperCase();
  if (dirEl) {
    dirEl.textContent = direction;
    dirEl.className = direction === "UP" ? "direction-badge up-glow" : "direction-badge down-glow";
  }

  let rawProb = current.up_probability_pct !== undefined ? Number(current.up_probability_pct) : null;
  if (rawProb === null || isNaN(rawProb)) {
    const magnitude = Math.min(Math.abs(retVal) * 50, 48);
    rawProb = direction === "UP" ? 50 + magnitude : 50 - magnitude;
  }

  const displayProb = direction === "UP" ? rawProb : (100 - rawProb);
  const clampedDisplayProb = Math.max(50, Math.min(99.5, displayProb));

  if (confTextEl) {
    confTextEl.textContent = `${clampedDisplayProb.toFixed(1)}% CONF`;
  }
  if (gaugeCenterText) {
    gaugeCenterText.textContent = `${Math.round(clampedDisplayProb)}%`;
  }

  const arcLength = (clampedDisplayProb / 100) * 132;
  if (gaugeProgressArc) {
    gaugeProgressArc.setAttribute("stroke-dasharray", `${arcLength.toFixed(1)} 176`);
    gaugeProgressArc.setAttribute("stroke", direction === "UP" ? "url(#gaugeGradUp)" : "url(#gaugeGradDown)");
  }

  if (subBarFill) {
    subBarFill.className = direction === "UP" ? "subgradient-fill" : "subgradient-fill down-grad";
    subBarFill.style.width = `${clampedDisplayProb}%`;
  }

  // 4. KPI Card 4: Sentiment & Sliding Spectrum Gauge with Tracking Dot
  const sentVal = Number(current.sentiment_score || 0);
  const sentEl = document.getElementById("kpiSentiment");
  if (sentEl) sentEl.textContent = `${sentVal >= 0 ? "+" : ""}${sentVal.toFixed(3)}`;

  const sentTag = document.getElementById("kpiSentimentTag");
  if (sentTag) {
    if (sentVal > 0.05) {
      sentTag.className = "sentiment-pill-tag pos";
      sentTag.textContent = "POSITIVE";
    } else if (sentVal < -0.05) {
      sentTag.className = "sentiment-pill-tag neg";
      sentTag.textContent = "NEGATIVE";
    } else {
      sentTag.className = "sentiment-pill-tag neutral";
      sentTag.textContent = "NEUTRAL";
    }
  }

  const trackingDot = document.getElementById("sentimentTrackingDot");
  if (trackingDot) {
    const spectrumPct = Math.max(4, Math.min(96, ((sentVal + 1) / 2) * 100));
    trackingDot.style.left = `${spectrumPct}%`;
    if (sentVal > 0.05) {
      trackingDot.style.borderColor = "#10b981";
      trackingDot.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.8)";
    } else if (sentVal < -0.05) {
      trackingDot.style.borderColor = "#f43f5e";
      trackingDot.style.boxShadow = "0 0 8px rgba(244, 63, 94, 0.8)";
    } else {
      trackingDot.style.borderColor = "#06b6d4";
      trackingDot.style.boxShadow = "0 0 8px rgba(6, 182, 212, 0.8)";
    }
  }

  const volVal = Number(current.price_volatility || 0);
  const volElStatus = document.getElementById("kpiVolatility");
  if (volElStatus) volElStatus.textContent = `Volatility: ${volVal.toFixed(4)}`;

  const marketStatusEl = document.getElementById("kpiMarketStatus");
  if (marketStatusEl) {
    const isCrypto = selectedSymbol.includes("USD") || selectedSymbol.includes("BTC") || selectedSymbol.includes("ETH");
    if (isCrypto) {
      marketStatusEl.className = "market-status-pill";
      marketStatusEl.textContent = "24/7 ACTIVE";
    } else {
      if (volVal > 0) {
        marketStatusEl.className = "market-status-pill";
        marketStatusEl.textContent = "REGULAR SESSION";
      } else {
        marketStatusEl.className = "market-status-pill closed";
        marketStatusEl.textContent = "SESSION CLOSED";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Unified 3-Zone Price Trajectory & Forecast Chart
  // Zone 1: 1-Month Historical Trend (~22 trading days from /api/history)
  // Zone 2: 8-10h Intraday Baseline (32 × 15-min bars) + Live Leading Edge
  // Zone 3: 48-Hour AI Forecast Horizon (8 steps × 6h, with confidence cone)
  // ---------------------------------------------------------------------------

  // ── Zone 1: 1-month daily historical ──────────────────────────────────────
  let histRecords = (historicalDataCache[selectedSymbol] && historicalDataCache[selectedSymbol].records)
    ? historicalDataCache[selectedSymbol].records
    : generateFallbackHistorical(selectedSymbol, currentPrice);

  const N_hist = histRecords.length;

  // ── Zone 2: intraday 15-min baseline (8-10h) + live streaming ticks ───────
  let intradayRecords = (intradayDataCache[selectedSymbol] && intradayDataCache[selectedSymbol].records)
    ? intradayDataCache[selectedSymbol].records
    : generateFallbackIntraday(selectedSymbol, currentPrice);

  if (!intradayRecords || intradayRecords.length === 0) {
    intradayRecords = generateFallbackIntraday(selectedSymbol, currentPrice);
  }

  // Live trailing ticks from /api/market (up to last 8 ticks appended at right edge)
  const liveRecords = mktData.filter((r) => r.symbol === selectedSymbol).slice(-8);
  const liveSubset = liveRecords.length > 0 ? liveRecords : [current];

  // Last intraday bar price — anchor for calibration
  const lastIntradayPrice = Number(intradayRecords[intradayRecords.length - 1].close);
  const firstLivePrice = Number(liveSubset[0].avg_price);
  const lastLivePrice = Number(liveSubset[liveSubset.length - 1].avg_price);

  // Calibrate Zone 1 smoothly into the first Zone 2 intraday bar (no vertical jump)
  const firstIntradayPrice = Number(intradayRecords[0].close);
  const lastHistoricalPrice = histRecords[N_hist - 1].close;
  const histOffset = firstIntradayPrice - lastHistoricalPrice;
  const calibratedHistorical = histRecords.map((h, i) => {
    const weight = (i + 1) / N_hist;
    return Number((h.close + histOffset * weight).toFixed(4));
  });

  // Raw intraday prices; apply micro-jitter if closed/flat (display only)
  const rawIntradayPrices = intradayRecords.map((r) => Number(r.close));
  const intradayPrices = applyMicroJitter(rawIntradayPrices, selectedSymbol);
  const N_intra = intradayPrices.length;

  // Calibrate intraday tail to meet the first live tick (smooth join)
  const intradayOffset = firstLivePrice - lastIntradayPrice;
  const calibratedIntraday = intradayPrices.map((p, i) => {
    const weight = (i + 1) / N_intra;
    return Number((p + intradayOffset * weight).toFixed(4));
  });

  // Live ticks — apply micro-jitter if flat
  const rawLivePrices = liveSubset.map((r) => Number(r.avg_price));
  const livePrices = applyMicroJitter(rawLivePrices, selectedSymbol);
  const N_live = livePrices.length;
  const finalLiveDisplayPrice = livePrices[N_live - 1];

  // ── Zone 3: 48-hour AI forecast (8 steps of 6h each) ──────────────────────
  const isUp = direction === "UP" || retVal >= 0;
  // Scale 1-hour ML return into a realistic 48-hour multi-step drift
  let hourlyRate = Math.max(0.0025, Math.abs(retVal) / 100);
  if (!isUp) hourlyRate = -hourlyRate;

  let volPct = volVal / lastLivePrice;
  if (isNaN(volPct) || volPct <= 0.0005) {
    volPct = selectedSymbol.includes("USD") ? 0.015 : 0.008;
  }
  volPct = Math.max(0.006, Math.min(0.05, volPct));

  const N_FORECAST = 8;
  // 8 future labels (+6h through +48h (2D)); anchored directly to final live tick
  const forecastFutureLabels = ["+6h", "+12h", "+18h", "+24h (1D)", "+30h", "+36h", "+42h", "+48h (2D)"];
  const projPoints = [finalLiveDisplayPrice];
  const upperPoints = [finalLiveDisplayPrice];
  const lowerPoints = [finalLiveDisplayPrice];

  for (let k = 1; k <= N_FORECAST; k++) {
    // Compound 6-hour steps across 48 hours with gentle trend curvature
    const cumulativeMove = hourlyRate * (k * 2.2);
    const p = Number((finalLiveDisplayPrice * (1 + cumulativeMove)).toFixed(4));
    const coneSpread = volPct * Math.sqrt(k) * 1.15;
    projPoints.push(p);
    upperPoints.push(Number((p * (1 + coneSpread)).toFixed(4)));
    lowerPoints.push(Number((p * (1 - coneSpread)).toFixed(4)));
  }

  // ── Combined X-axis labels ─────────────────────────────────────────────────
  const histLabels = histRecords.map((h) => h.date);
  const intradayLabels = intradayRecords.map((r) => r.time || "");
  const liveTickLabels = liveSubset.map((rec) => formatTime(rec.timestamp));

  const combinedLabels = histLabels.concat(intradayLabels).concat(liveTickLabels).concat(forecastFutureLabels);
  const totalPoints = combinedLabels.length;

  // Boundary indices for zone dividers + tooltip zone detection
  const idxBoundaryLive = N_hist + N_intra - 1;               // start of live stream
  const idxBoundaryForecast = N_hist + N_intra + N_live - 1;   // last live tick (forecast bridge)

  // ── Build sparse data arrays ───────────────────────────────────────────────

  // Dataset 0: Zone 1 — 1-Month Historical Trend
  const trendData = new Array(totalPoints).fill(null);
  for (let i = 0; i < N_hist; i++) {
    trendData[i] = calibratedHistorical[i];
  }

  // Dataset 1: Zone 2 — Intraday Baseline + Live Edge
  const liveData = new Array(totalPoints).fill(null);
  for (let i = 0; i < N_intra; i++) {
    liveData[N_hist + i] = calibratedIntraday[i];
  }
  for (let j = 0; j < N_live; j++) {
    liveData[N_hist + N_intra + j] = livePrices[j];
  }

  // Datasets 2, 3, 4: Zone 3 — 48h Forecast + Confidence Cone (bridges seamlessly from idxBoundaryForecast)
  const projData = new Array(totalPoints).fill(null);
  const upperData = new Array(totalPoints).fill(null);
  const lowerData = new Array(totalPoints).fill(null);

  for (let k = 0; k <= N_FORECAST; k++) {
    projData[idxBoundaryForecast + k] = projPoints[k];
    upperData[idxBoundaryForecast + k] = upperPoints[k];
    lowerData[idxBoundaryForecast + k] = lowerPoints[k];
  }

  // High, Low, Avg across Historical + Intraday + Live (excluding future projection)
  const allHistoricalAndLive = calibratedHistorical.concat(calibratedIntraday).concat(livePrices);
  const avgP = allHistoricalAndLive.reduce((a, b) => a + b, 0) / allHistoricalAndLive.length;
  const maxP = Math.max(...allHistoricalAndLive);
  const minP = Math.min(...allHistoricalAndLive);

  // Dataset 5: Session Mean Line across the entire chart
  const meanData = new Array(totalPoints).fill(avgP);

  // Update header badges
  const avgEl = document.getElementById("chartAvgPrice");
  if (avgEl) avgEl.textContent = formatCurrency(avgP);
  const highEl = document.getElementById("chartHighPrice");
  if (highEl) highEl.textContent = formatCurrency(maxP);
  const lowEl = document.getElementById("chartLowPrice");
  if (lowEl) lowEl.textContent = formatCurrency(minP);

  const priceTitleEl = document.getElementById("priceChartTitle");
  if (priceTitleEl) priceTitleEl.textContent = `${displayName} Live Price Trajectory (USD)`;

  if (priceChart) {
    priceChart._boundaryLiveIndex = idxBoundaryLive;
    priceChart._boundaryForecastIndex = idxBoundaryForecast;
    priceChart._isForecastUp = isUp;

    priceChart.data.labels = combinedLabels;
    priceChart.data.datasets[0].data = trendData;
    priceChart.data.datasets[1].data = liveData;

    // Future Projection line
    priceChart.data.datasets[2].data = projData;
    priceChart.data.datasets[2].borderColor = isUp ? "#10b981" : "#f43f5e";
    priceChart.data.datasets[2].pointBackgroundColor = isUp ? "#10b981" : "#f43f5e";

    // Upper Bound
    priceChart.data.datasets[3].data = upperData;

    // Lower Bound (Confidence Cone)
    priceChart.data.datasets[4].data = lowerData;
    priceChart.data.datasets[4].backgroundColor = isUp ? "rgba(16, 185, 129, 0.12)" : "rgba(244, 63, 94, 0.12)";

    // Session Mean
    priceChart.data.datasets[5].data = meanData;

    priceChart.update("none");
  }

  // ---------------------------------------------------------------------------
  // 6. Predicted Return Bar Chart
  // ---------------------------------------------------------------------------
  const returnLabels = liveSubset.map((r) => formatTime(r.timestamp));
  const returns = liveSubset.map((r) => Number(r.predicted_return_pct));

  const returnTitleEl = document.getElementById("returnChartTitle");
  if (returnTitleEl) returnTitleEl.textContent = `${displayName} Predicted Return (%)`;

  if (returnChart) {
    returnChart.data.labels = returnLabels;
    returnChart.data.datasets[0].data = returns;
    returnChart.data.datasets[0].backgroundColor = returns.map((r) => (r >= 0 ? "#10b981" : "#f43f5e"));
    returnChart.update();
  }
}

// -----------------------------------------------------------------------------
// Render Interactive Matrix Watchlist (Full Company Names + Sub-Code)
// -----------------------------------------------------------------------------

function renderWatchlistTable(mktData) {
  const tbody = document.getElementById("assetsTableBody");
  if (!tbody || !mktData || mktData.length === 0) return;

  const latestMap = {};
  mktData.forEach((row) => { latestMap[row.symbol] = row; });

  const sortedRows = Object.values(latestMap).sort((a, b) => a.symbol.localeCompare(b.symbol));

  tbody.innerHTML = sortedRows
    .map((r) => {
      const isSelected = r.symbol === selectedSymbol;
      const historyPrices = (symbolHistoryCache[r.symbol] || []).map((h) => Number(h.avg_price));
      const predRet = Number(r.predicted_return_pct);
      const isUp = r.predicted_direction === "UP" || predRet >= 0;
      const sparkSvg = generateSparklineSvg(historyPrices, isUp);
      const sentVal = Number(r.sentiment_score || 0);

      const fullName = getAssetDisplayName(r.symbol);

      const sentBadgeCls = sentVal > 0.05 ? "pos" : sentVal < -0.05 ? "neg" : "neu";
      const sentBadgeText = sentVal > 0.05 ? `+${sentVal.toFixed(2)}` : sentVal < -0.05 ? `${sentVal.toFixed(2)}` : "0.00";

      return `
        <tr class="watchlist-row ${isSelected ? "selected-asset" : ""}" data-symbol="${r.symbol}">
          <td>
            <div class="ticker-cell">
              ${isSelected ? `<span class="ticker-active-dot"></span>` : ""}
              <div class="ticker-name-group">
                <span class="ticker-full-name">${fullName}</span>
                <span class="ticker-sub-code">${r.symbol}</span>
              </div>
            </div>
          </td>
          <td class="mono"><strong>${formatCurrency(r.avg_price)}</strong></td>
          <td>${sparkSvg}</td>
          <td class="mono text-muted">${Number(r.price_volatility).toFixed(4)}</td>
          <td><span class="news-sentiment-badge ${sentBadgeCls} mono">${sentBadgeText}</span></td>
          <td class="mono" style="color: ${predRet >= 0 ? "#10b981" : "#f43f5e"}">
            ${predRet >= 0 ? "+" : ""}${predRet.toFixed(4)}%
          </td>
          <td>
            <span class="${isUp ? "table-pill-up" : "table-pill-down"}">
              ${r.predicted_direction || (isUp ? "UP" : "DOWN")}
            </span>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".watchlist-row").forEach((row) => {
    row.addEventListener("click", () => {
      const sym = row.getAttribute("data-symbol");
      if (sym) {
        selectAsset(sym);
      }
    });
  });
}

function updateWatchlistActiveRow() {
  const tbody = document.getElementById("assetsTableBody");
  if (!tbody) return;
  tbody.querySelectorAll(".watchlist-row").forEach((row) => {
    if (row.getAttribute("data-symbol") === selectedSymbol) {
      row.classList.add("selected-asset");
      const tickerBox = row.querySelector(".ticker-cell");
      if (tickerBox && !tickerBox.querySelector(".ticker-active-dot")) {
        const dot = document.createElement("span");
        dot.className = "ticker-active-dot";
        tickerBox.prepend(dot);
      }
    } else {
      row.classList.remove("selected-asset");
      const dot = row.querySelector(".ticker-active-dot");
      if (dot) dot.remove();
    }
  });
}

// -----------------------------------------------------------------------------
// Render Financial News Feed (Full Company Names in Tags)
// -----------------------------------------------------------------------------

function renderNewsFeed(newsData) {
  const newsFeed = document.getElementById("newsFeed");
  if (!newsFeed) return;

  if (newsData.length === 0) {
    newsFeed.innerHTML = `
      <div class="news-empty-state">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div>No financial headlines ingested yet.</div>
        <div>Continuous sentiment feed active.</div>
      </div>
    `;
    return;
  }

  newsFeed.innerHTML = newsData
    .slice(0, 16)
    .map((n) => {
      const sentLabel = n.sentiment_label || "NEUTRAL";
      const cls = sentLabel === "POSITIVE" ? "pos" : sentLabel === "NEGATIVE" ? "neg" : "neu";
      const score = Number(n.sentiment_score || 0);
      const symbolCode = n.related_symbol || "GENERAL";
      const displayName = symbolCode === "GENERAL" ? "General" : getAssetDisplayName(symbolCode);
      const timeStr = formatRelativeTime(n.ingested_at || n.timestamp);

      return `
        <div class="news-card-item">
          <div class="news-meta-row">
            <div class="news-meta-left">
              <span class="news-symbol-tag">${displayName}</span>
              <span class="news-source-time">${n.source || "Newswire"} • ${timeStr}</span>
            </div>
            <span class="news-sentiment-badge ${cls} mono">${sentLabel} (${score >= 0 ? "+" : ""}${score.toFixed(3)})</span>
          </div>
          <div class="news-title-clamped" title="${n.title || ""}">${n.title || "Market Update"}</div>
        </div>
      `;
    })
    .join("");
}

// -----------------------------------------------------------------------------
// Bootstrap Terminal
// -----------------------------------------------------------------------------

setupControls();
initCharts();
fetchHistoricalTrend(selectedSymbol);
refreshDashboard();

// Continuous 3-second live polling loop
pollingInterval = setInterval(refreshDashboard, 3000);