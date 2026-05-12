/* ═══════════════════════════════════════════════════════════════════════════
   GeoSabotage – Client
   ═══════════════════════════════════════════════════════════════════════════ */

const socket = io();

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  roomCode: null,
  myId: null,
  isHost: false,
  players: [],
  isHider: false,
  hiderId: null,
  phase: null,        // hiding | betting | guessing | results | gameover
  round: 0,
  totalRounds: 0,
  timeLeft: 0,
  hasBet: false,
  hasGuessed: false,
  magnetized: false,  // sabotage flag
  mapillaryToken: null,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const screens = {
  home:    $("home-screen"),
  lobby:   $("lobby-screen"),
  game:    $("game-screen"),
  results: $("results-screen"),
  gameover:$("gameover-screen"),
};
const phases = {
  hiding:      $("phase-hiding"),
  waiting:     $("phase-waiting"),
  betting:     $("phase-betting"),
  bettingWait: $("phase-betting-wait"),
  guessing:    $("phase-guessing"),
};

// ── Maps & Pano ────────────────────────────────────────────────────────────
let hidingMap = null, guessMap = null, resultsMap = null;
let panoViewer = null, previewViewer = null;
let hidingMarker = null, guessMarker = null;
let pendingLat = null, pendingLng = null;
let validated = false;

function initHidingMap() {
  if (hidingMap) { hidingMap.invalidateSize(); return; }
  hidingMap = L.map("hiding-map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© OpenStreetMap"
  }).addTo(hidingMap);

  hidingMap.on("click", (e) => {
    pendingLat = e.latlng.lat;
    pendingLng = e.latlng.lng;
    validated = false;
    $("validate-btn").disabled = false;
    $("lockin-btn").style.display = "none";
    $("pano-preview").style.display = "none";
    $("hiding-status").textContent = `Selected: ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    if (hidingMarker) hidingMap.removeLayer(hidingMarker);
    hidingMarker = L.marker(e.latlng).addTo(hidingMap);
  });
}

function initGuessMap() {
  if (guessMap) { guessMap.invalidateSize(); return; }
  guessMap = L.map("guess-map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© OpenStreetMap"
  }).addTo(guessMap);

  guessMap.on("click", (e) => {
    if (S.isHider || S.hasGuessed) return;
    let lat = e.latlng.lat, lng = e.latlng.lng;
    if (S.magnetized) {
      lat += (Math.random() - 0.5) * 20;
      lng += (Math.random() - 0.5) * 20;
    }
    if (guessMarker) guessMap.removeLayer(guessMarker);
    guessMarker = L.marker([lat, lng]).addTo(guessMap);
    guessMarker._guessLat = lat;
    guessMarker._guessLng = lng;
    $("submit-guess-btn").disabled = false;
  });
}

async function initPano(containerId, imageId) {
  if (!S.mapillaryToken) {
    try {
      const res = await fetch("/api/mapillary-token");
      const data = await res.json();
      S.mapillaryToken = data.token;
    } catch { S.mapillaryToken = null; }
  }
  if (!S.mapillaryToken) return null;

  const container = document.getElementById(containerId);
  if (!container) return null;
  container.innerHTML = "";
  try {
    const viewer = new mapillary.Viewer({
      accessToken: S.mapillaryToken,
      container: containerId,
      imageId: imageId,
    });
    return viewer;
  } catch (err) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ff4444;">Panorama failed to load</div>`;
    return null;
  }
}

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  $("chat-widget").style.display = (name === "home") ? "none" : "block";
}

function showPhase(name) {
  Object.values(phases).forEach((p) => p.style.display = "none");
  if (phases[name]) phases[name].style.display = "flex";
  $("sabotage-panel").style.display = "none";
  $("hint-bar").style.display = "none";
}

function updateBar() {
  $("bar-round").textContent = S.totalRounds ? `Round ${S.round}/${S.totalRounds}` : "";
  $("bar-role").textContent = S.isHider ? "🙈 HIDER" : "🔍 SEEKER";
  $("bar-timer").textContent = S.timeLeft > 0 ? `⏱ ${S.timeLeft}s` : "";
  const me = S.players.find((p) => p.id === S.myId);
  $("bar-score").textContent = me ? `Score: ${me.score}` : "";
}

// ── Home ───────────────────────────────────────────────────────────────────
$("create-btn").addEventListener("click", () => {
  const username = $("username-input").value.trim() || "Player";
  const rounds = parseInt($("rounds-input").value) || 5;
  const roundLength = parseInt($("round-length-input").value) || 60;
  socket.emit("createRoom", { username, rounds, roundLength });
});

$("join-btn").addEventListener("click", () => {
  const username = $("username-input").value.trim() || "Player";
  const code = $("room-code-input").value.trim().toUpperCase();
  if (!code) { $("home-error").textContent = "Enter a room code"; return; }
  socket.emit("joinRoom", { code, username });
});

// ── Lobby ──────────────────────────────────────────────────────────────────
function renderLobby() {
  const list = $("lobby-players");
  list.innerHTML = S.players.map((p) =>
    `<div class="player-item">
      <span>${p.username} ${p.isHost ? '<span class="host-badge">HOST</span>' : ""}</span>
      <span class="score">${p.score}</span>
    </div>`
  ).join("");

  const isHost = S.players.some((p) => p.id === S.myId && p.isHost);
  S.isHost = isHost;
  $("start-game-btn").style.display = isHost ? "block" : "none";
  $("lobby-settings").style.display = isHost ? "block" : "none";
  $("lobby-wait").style.display = isHost ? "none" : "block";
}

$("start-game-btn").addEventListener("click", () => {
  const rounds = parseInt($("lobby-rounds").value) || 5;
  const roundLength = parseInt($("lobby-round-length").value) || 60;
  socket.emit("startGame", { code: S.roomCode, rounds, roundLength });
});

// ── Hiding phase ──────────────────────────────────────────────────────────
$("validate-btn").addEventListener("click", () => {
  if (pendingLat == null) return;
  $("validate-btn").disabled = true;
  $("hiding-status").textContent = "Searching for panorama…";
  socket.emit("validateLocation", { code: S.roomCode, lat: pendingLat, lng: pendingLng });
});

$("lockin-btn").addEventListener("click", () => {
  socket.emit("setLocation", { code: S.roomCode });
  $("lockin-btn").disabled = true;
  $("hiding-status").textContent = "Locked in! Waiting for bets…";
});

// ── Betting phase ─────────────────────────────────────────────────────────
let chosenStrategy = "safe";
document.querySelectorAll(".strategy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".strategy-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    chosenStrategy = btn.dataset.strategy;
    $("bold-opts").style.display = chosenStrategy === "bold" ? "block" : "none";
  });
});

$("wager-input").addEventListener("input", () => {
  $("wager-val").textContent = $("wager-input").value;
});

$("submit-bet-btn").addEventListener("click", () => {
  if (S.hasBet) return;
  S.hasBet = true;
  const wager = chosenStrategy === "bold" ? parseInt($("wager-input").value) : 0;
  const tier = chosenStrategy === "bold" ? parseInt($("tier-select").value) : 5;
  socket.emit("submitBet", { code: S.roomCode, wager, strategy: chosenStrategy, tier });
  $("submit-bet-btn").disabled = true;
  $("bet-progress").textContent = "Bet submitted! Waiting for others…";
});

// ── Guessing phase ────────────────────────────────────────────────────────
$("submit-guess-btn").addEventListener("click", () => {
  if (!guessMarker || S.hasGuessed) return;
  S.hasGuessed = true;
  socket.emit("submitGuess", {
    code: S.roomCode,
    lat: guessMarker._guessLat,
    lng: guessMarker._guessLng,
  });
  $("submit-guess-btn").disabled = true;
  $("submit-guess-btn").textContent = "Guess submitted!";
});

// ── Hints ─────────────────────────────────────────────────────────────────
document.querySelectorAll(".hint-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.disabled = true;
    socket.emit("requestHint", { code: S.roomCode, hint: btn.dataset.hint });
  });
});

// ── Sabotage panel ────────────────────────────────────────────────────────
document.querySelectorAll(".sab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action === "cleanse") {
      socket.emit("usePowerup", { code: S.roomCode, action: "cleanse" });
      return;
    }
    const targetSel = $("sabotage-target");
    const targetId = targetSel.value || null;
    socket.emit("usePowerup", { code: S.roomCode, action, targetId });
  });
});

function populateSabotageTargets() {
  const sel = $("sabotage-target");
  sel.innerHTML = '<option value="">Everyone</option>';
  S.players.forEach((p) => {
    if (p.id === S.myId) return;
    sel.innerHTML += `<option value="${p.id}">${p.username}</option>`;
  });
}

// ── Sabotage effects ──────────────────────────────────────────────────────
let sabotageTimers = [];
function applySabotage(action, duration) {
  const overlay = $("sabotage-overlay");

  if (action === "cleanse") {
    overlay.className = "cleanse";
    overlay.style.display = "block";
    S.magnetized = false;
    sabotageTimers.forEach((t) => clearTimeout(t));
    sabotageTimers = [];
    setTimeout(() => {
      overlay.className = "";
      overlay.style.display = "none";
    }, 500);
    return;
  }

  overlay.className = action;
  overlay.style.display = "block";
  if (action === "magnetize") S.magnetized = true;

  if (duration > 0) {
    const tid = setTimeout(() => {
      overlay.className = "";
      overlay.style.display = "none";
      if (action === "magnetize") S.magnetized = false;
    }, duration);
    sabotageTimers.push(tid);
  }
}

function showSabotageToast(msg) {
  const toast = $("sabotage-toast");
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3000);
}

// ── Chat ──────────────────────────────────────────────────────────────────
$("chat-toggle").addEventListener("click", () => {
  const panel = $("chat-panel");
  panel.style.display = panel.style.display === "none" ? "flex" : "none";
});

$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
  const msg = $("chat-input").value.trim();
  if (!msg || !S.roomCode) return;
  socket.emit("chatMessage", { code: S.roomCode, message: msg });
  $("chat-input").value = "";
}

// ── Game Over ─────────────────────────────────────────────────────────────
$("back-home-btn").addEventListener("click", () => {
  S.roomCode = null;
  showScreen("home");
});

// ═══════════════════════════════════════════════════════════════════════════
// Socket events
// ═══════════════════════════════════════════════════════════════════════════

socket.on("connect", () => { S.myId = socket.id; });

socket.on("errorMsg", (msg) => {
  $("home-error").textContent = msg;
  showSabotageToast(msg);
});

socket.on("roomCreated", (code) => {
  S.roomCode = code;
  $("lobby-code").textContent = code;
  showScreen("lobby");
});

socket.on("roomJoined", ({ code, hostId }) => {
  S.roomCode = code;
  $("lobby-code").textContent = code;
  showScreen("lobby");
});

socket.on("updatePlayers", (players) => {
  S.players = players;
  renderLobby();
  updateBar();
});

socket.on("lobbyState", ({ code, hostId, players, state }) => {
  S.roomCode = code;
  S.players = players;
  if (state === "lobby") renderLobby();
});

// ── Round start ───────────────────────────────────────────────────────────
socket.on("gameStarted", ({ hiderId, hiderName, round, totalRounds, duration }) => {
  S.hiderId = hiderId;
  S.isHider = hiderId === S.myId;
  S.round = round;
  S.totalRounds = totalRounds;
  S.timeLeft = 0;
  S.hasBet = false;
  S.hasGuessed = false;
  S.magnetized = false;
  S.phase = "hiding";

  // Reset sabotage
  $("sabotage-overlay").className = "";
  $("sabotage-overlay").style.display = "none";
  sabotageTimers.forEach((t) => clearTimeout(t));
  sabotageTimers = [];

  showScreen("game");
  updateBar();

  if (S.isHider) {
    showPhase("hiding");
    pendingLat = null; pendingLng = null; validated = false;
    $("validate-btn").disabled = true;
    $("lockin-btn").style.display = "none";
    $("lockin-btn").disabled = false;
    $("pano-preview").style.display = "none";
    $("hiding-status").textContent = "Click anywhere on the map to pick a hiding spot";
    if (hidingMarker && hidingMap) { hidingMap.removeLayer(hidingMarker); hidingMarker = null; }
    setTimeout(() => initHidingMap(), 50);
  } else {
    showPhase("waiting");
    $("waiting-text").textContent = `${hiderName} is choosing a hiding spot…`;
  }
});

// ── Validation result ─────────────────────────────────────────────────────
socket.on("validationResult", async ({ ok, imageId, panoLat, panoLng, distanceM, searchRadius, message }) => {
  if (!ok) {
    $("hiding-status").textContent = message;
    $("validate-btn").disabled = false;
    return;
  }
  validated = true;
  $("hiding-status").textContent = message;
  $("lockin-btn").style.display = "inline-block";
  $("pano-preview").style.display = "block";

  if (hidingMarker && hidingMap) {
    hidingMap.removeLayer(hidingMarker);
    hidingMarker = L.marker([panoLat, panoLng]).addTo(hidingMap);
    hidingMap.setView([panoLat, panoLng], 14);
  }
  previewViewer = await initPano("pano-preview", imageId);
});

// ── Betting ───────────────────────────────────────────────────────────────
socket.on("beginBetting", ({ temperatureC }) => {
  S.phase = "betting";
  if (S.isHider) {
    showPhase("bettingWait");
  } else {
    showPhase("betting");
    if (temperatureC !== null && temperatureC !== undefined) {
      $("betting-temp").textContent = `🌡 Average temperature: ${temperatureC}°C`;
    } else {
      $("betting-temp").textContent = "🌡 Temperature data unavailable";
    }
    $("submit-bet-btn").disabled = false;
    $("bet-progress").textContent = "";
    chosenStrategy = "safe";
    document.querySelectorAll(".strategy-btn").forEach((b) => b.classList.remove("active"));
    document.querySelector('[data-strategy="safe"]').classList.add("active");
    $("bold-opts").style.display = "none";
    $("wager-input").value = 0;
    $("wager-val").textContent = "0";
  }
  updateBar();
});

socket.on("betProgress", ({ betsIn, total }) => {
  $("bet-progress").textContent = `Bets: ${betsIn}/${total}`;
  $("bet-progress-hider").textContent = `Bets: ${betsIn}/${total}`;
});

// ── Guessing ──────────────────────────────────────────────────────────────
socket.on("startGuessing", async ({ imageId, panoLat, panoLng, hiderName, temperatureC, heat, passivePointsPerSec }) => {
  S.phase = "guessing";
  showPhase("guessing");

  // Show sabotage panel for everyone during guessing
  $("sabotage-panel").style.display = "block";
  populateSabotageTargets();

  if (!S.isHider) {
    $("hint-bar").style.display = "flex";
    $("hints-display").innerHTML = "";
    document.querySelectorAll(".hint-btn").forEach((b) => b.disabled = false);
    $("submit-guess-btn").disabled = true;
    $("submit-guess-btn").textContent = "Submit Guess";
  } else {
    $("submit-guess-btn").style.display = "none";
    $("hint-bar").style.display = "none";
  }

  $("bar-heat").style.display = "inline";
  $("bar-heat").textContent = `🔥 Heat: ${heat}`;

  // Reset guess map
  if (guessMarker && guessMap) { guessMap.removeLayer(guessMarker); guessMarker = null; }

  panoViewer = await initPano("pano-container", imageId);

  if (!S.isHider) {
    setTimeout(() => initGuessMap(), 100);
  }
  updateBar();
});

socket.on("timerUpdate", (t) => {
  S.timeLeft = t;
  updateBar();
});

// ── Hints ─────────────────────────────────────────────────────────────────
socket.on("hintGranted", ({ hint, value, cost }) => {
  $("hints-display").innerHTML += `<span class="hint-pill">${hint}: ${value} (−${cost})</span>`;
});

socket.on("hintError", ({ message }) => {
  showSabotageToast(message);
});

// ── Sabotage events ───────────────────────────────────────────────────────
socket.on("sabotageApplied", ({ action, targetName, targetId, duration, fromPlayer }) => {
  if (targetId && targetId !== S.myId && action !== "cleanse") return;
  if (!targetId || targetId === S.myId) {
    applySabotage(action, duration);
    if (action !== "cleanse") {
      showSabotageToast(`${fromPlayer || targetName} used ${action} on you!`);
    } else {
      showSabotageToast("Sabotage effects cleansed!");
    }
  }
});

socket.on("sabotageConfirmed", ({ action, targetName, cost }) => {
  showSabotageToast(`${action} used on ${targetName} (−${cost} pts)`);
});

// ── Round results ─────────────────────────────────────────────────────────
socket.on("roundResults", ({ location, hiderName, imageId, results }) => {
  S.phase = "results";
  $("bar-heat").style.display = "none";
  showScreen("results");

  $("results-location").textContent = `Location: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)} (hidden by ${hiderName})`;

  // Results map
  const mapDiv = $("results-map");
  if (resultsMap) { resultsMap.remove(); resultsMap = null; }
  resultsMap = L.map(mapDiv).setView([location.lat, location.lng], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© OpenStreetMap"
  }).addTo(resultsMap);

  L.marker([location.lat, location.lng], {
    icon: L.divIcon({ className: "", html: '<div style="background:#ff6b35;width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>' })
  }).addTo(resultsMap).bindPopup("Actual location");

  const bounds = L.latLngBounds([[location.lat, location.lng]]);

  // Results table
  const tbody = $("results-body");
  tbody.innerHTML = "";
  results.forEach((r) => {
    const tr = document.createElement("tr");
    if (r.winner) tr.classList.add("winner");
    if (r.role === "Hider") tr.classList.add("hider");

    const distText = r.role === "Hider" ? "—" : `${r.distance} km`;
    const stratText = r.role === "Hider" ? "Hider" : (r.strategy === "bold" ? `Bold (${r.wager})` : "Safe");
    let pointsText = `+${r.points}`;
    if (r.hintDeduction > 0) pointsText += ` (−${r.hintDeduction} hints)`;
    if (r.won === true) pointsText += " ✓";
    if (r.won === false) pointsText += " ✗";

    tr.innerHTML = `<td>${r.username}${r.winner ? " 👑" : ""}</td><td>${r.role}</td><td>${distText}</td><td>${stratText}</td><td>${pointsText}</td>`;
    tbody.appendChild(tr);

    if (r.guess && r.guess.lat !== null) {
      L.marker([r.guess.lat, r.guess.lng], {
        icon: L.divIcon({ className: "", html: `<div style="background:#00b4d8;width:10px;height:10px;border-radius:50%;border:2px solid #fff;"></div>` })
      }).addTo(resultsMap).bindPopup(r.username);
      L.polyline([[location.lat, location.lng], [r.guess.lat, r.guess.lng]], {
        color: "#00b4d866", dashArray: "6 4"
      }).addTo(resultsMap);
      bounds.extend([r.guess.lat, r.guess.lng]);
    }
  });

  resultsMap.fitBounds(bounds, { padding: [30, 30] });
});

// ── Game over ─────────────────────────────────────────────────────────────
socket.on("gameOver", (players) => {
  S.phase = "gameover";
  showScreen("gameover");
  const ol = $("final-standings");
  ol.innerHTML = players.map((p) =>
    `<li><span>${p.username}</span><span style="color:#00b4d8">${p.score}</span></li>`
  ).join("");
});

// ── Chat ──────────────────────────────────────────────────────────────────
socket.on("chatMessage", ({ sender, message }) => {
  const div = $("chat-messages");
  div.innerHTML += `<div class="chat-msg"><span class="sender">${sender}:</span> ${message}</div>`;
  div.scrollTop = div.scrollHeight;
});

socket.on("reaction", ({ emoji }) => {
  const el = document.createElement("div");
  el.textContent = emoji;
  el.style.cssText = "position:fixed;font-size:48px;z-index:999;pointer-events:none;animation:floatUp 1.5s ease-out forwards;";
  el.style.left = Math.random() * 80 + 10 + "%";
  el.style.bottom = "10%";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
});

// Float-up animation for reactions
const style = document.createElement("style");
style.textContent = "@keyframes floatUp { 0% { opacity:1; transform:translateY(0) scale(1); } 100% { opacity:0; transform:translateY(-200px) scale(1.5); } }";
document.head.appendChild(style);
