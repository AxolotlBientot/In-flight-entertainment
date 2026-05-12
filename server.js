const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let fetch;
try { fetch = global.fetch ?? require("node-fetch"); } catch { fetch = global.fetch; }

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || "fcafa296f1f98056fedd594cb005cbad";
const MAPILLARY_ACCESS_TOKEN = process.env.MAPILLARY_ACCESS_TOKEN || "MLY|26578602881834697|9956a52a2fb9a16752a6280ca7320a80";

const ROUND_RESULT_DELAY_MS = 6000;
const DEFAULT_ROUND_LENGTH  = 60;
const BETTING_TIMEOUT_MS    = 30000;

const mockLocations = [
  { name: "Tokyo, Japan",      country: "Japan",          continent: "Asia",          region: "Kanto",             coords: { lat: 35.6762,  lng: 139.6503 } },
  { name: "Paris, France",     country: "France",         continent: "Europe",        region: "Île-de-France",     coords: { lat: 48.8566,  lng: 2.3522   } },
  { name: "New York, USA",     country: "USA",            continent: "North America", region: "New York",          coords: { lat: 40.7128,  lng: -74.0060 } },
  { name: "Sydney, Australia", country: "Australia",      continent: "Oceania",       region: "New South Wales",   coords: { lat: -33.8688, lng: 151.2093 } },
  { name: "São Paulo, Brazil", country: "Brazil",         continent: "South America", region: "Southeast",         coords: { lat: -23.5505, lng: -46.6333 } },
  { name: "Cairo, Egypt",      country: "Egypt",          continent: "Africa",        region: "Cairo Governorate", coords: { lat: 30.0444,  lng: 31.2357  } },
  { name: "London, UK",        country: "United Kingdom", continent: "Europe",        region: "Greater London",    coords: { lat: 51.5072,  lng: -0.1276  } },
  { name: "Toronto, Canada",   country: "Canada",         continent: "North America", region: "Ontario",           coords: { lat: 43.6532,  lng: -79.3832 } },
];

const rooms = new Map();

function makeCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function metersToLatDelta(m) { return m / 111320; }
function metersToLngDelta(m, lat) { return m / (111320 * Math.max(0.15, Math.cos(lat * Math.PI / 180))); }

function baseScore(distanceKm) {
  return Math.max(0, Math.round(10000 - distanceKm * 4));
}

function computeSeekerScore(distanceKm, strategy, wager, tier) {
  const base = baseScore(distanceKm);
  if (strategy !== "bold" || wager <= 0) return { points: base, base, won: null };

  const thresholds  = { 1: 500, 2: 1000, 3: 1500, 4: 1700, 5: 1900 };
  const multipliers = { 1: 2.0, 2: 1.7,  3: 1.5,  4: 1.3,  5: 1.2  };
  const threshold   = thresholds[tier]  ?? thresholds[5];
  const multiplier  = multipliers[tier] ?? multipliers[5];

  if (distanceKm <= threshold) {
    return { points: Math.round(base + wager * multiplier), base, won: true };
  }
  return { points: Math.max(0, base - wager), base, won: false };
}

function hintCost(hint) {
  return ({ continent: 1500, country: 2500, region: 4500 }[hint]) ?? 0;
}

function sabotageCost(action) {
  return ({ ink: 1500, smoke: 2000, cleanse: 1000, magnetize: 1800 }[action]) ?? 0;
}

function safePlayers(room) {
  return room.players.map((p) => ({
    id: p.id, username: p.username, score: p.score, isHost: p.id === room.hostId,
  }));
}

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("updatePlayers", safePlayers(room));
  io.to(code).emit("lobbyState", { code, hostId: room.hostId, players: safePlayers(room), state: room.state });
}

function stopRoundTimers(room) {
  if (room.timerId)        { clearInterval(room.timerId);       room.timerId        = null; }
  if (room.autoAdvanceId)  { clearTimeout(room.autoAdvanceId);  room.autoAdvanceId  = null; }
  if (room.bettingTimerId) { clearTimeout(room.bettingTimerId); room.bettingTimerId = null; }
}

function nearestCityHeat(lat, lng) {
  let nearest = null;
  for (const city of mockLocations) {
    const d = haversineKm(lat, lng, city.coords.lat, city.coords.lng);
    if (!nearest || d < nearest.distanceKm) nearest = { city, distanceKm: d };
  }
  const heat = clamp(Math.round(100 - nearest.distanceKm / 12.5), 0, 100);
  return { heat, passivePointsPerSec: Math.max(0, Math.round(heat * 2)), nearestCity: nearest.city };
}

async function fetchReverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const CONTINENT_BY_COUNTRY = {
  "Canada":"North America","United States":"North America","USA":"North America","Mexico":"North America",
  "Brazil":"South America","Argentina":"South America","Chile":"South America","Peru":"South America","Colombia":"South America","Venezuela":"South America","Ecuador":"South America","Bolivia":"South America","Paraguay":"South America","Uruguay":"South America",
  "France":"Europe","Germany":"Europe","United Kingdom":"Europe","Italy":"Europe","Spain":"Europe","Portugal":"Europe","Poland":"Europe","Netherlands":"Europe","Belgium":"Europe","Sweden":"Europe","Norway":"Europe","Denmark":"Europe","Switzerland":"Europe","Austria":"Europe","Greece":"Europe","Czech Republic":"Europe","Czechia":"Europe","Romania":"Europe","Hungary":"Europe","Finland":"Europe","Ireland":"Europe","Croatia":"Europe","Serbia":"Europe","Bulgaria":"Europe","Slovakia":"Europe","Lithuania":"Europe","Latvia":"Europe","Estonia":"Europe","Slovenia":"Europe","Luxembourg":"Europe","Malta":"Europe","Cyprus":"Europe","Iceland":"Europe","Albania":"Europe","North Macedonia":"Europe","Montenegro":"Europe","Bosnia and Herzegovina":"Europe",
  "Japan":"Asia","South Korea":"Asia","China":"Asia","India":"Asia","Thailand":"Asia","Vietnam":"Asia","Indonesia":"Asia","Philippines":"Asia","Malaysia":"Asia","Singapore":"Asia","Turkey":"Asia","Saudi Arabia":"Asia","UAE":"Asia","United Arab Emirates":"Asia","Israel":"Asia","Pakistan":"Asia","Bangladesh":"Asia","Sri Lanka":"Asia","Nepal":"Asia","Myanmar":"Asia","Cambodia":"Asia","Laos":"Asia","Mongolia":"Asia","Kazakhstan":"Asia","Uzbekistan":"Asia","Taiwan":"Asia","Hong Kong":"Asia","South Korea":"Asia","North Korea":"Asia","Iraq":"Asia","Iran":"Asia","Syria":"Asia","Jordan":"Asia","Lebanon":"Asia","Kuwait":"Asia","Qatar":"Asia","Bahrain":"Asia","Oman":"Asia","Yemen":"Asia","Afghanistan":"Asia","Tajikistan":"Asia","Kyrgyzstan":"Asia","Turkmenistan":"Asia","Georgia":"Asia","Armenia":"Asia","Azerbaijan":"Asia",
  "Australia":"Oceania","New Zealand":"Oceania","Fiji":"Oceania","Papua New Guinea":"Oceania",
  "Egypt":"Africa","Morocco":"Africa","South Africa":"Africa","Nigeria":"Africa","Kenya":"Africa","Ethiopia":"Africa","Ghana":"Africa","Tanzania":"Africa","Algeria":"Africa","Tunisia":"Africa","Libya":"Africa","Sudan":"Africa","Uganda":"Africa","Mozambique":"Africa","Madagascar":"Africa","Cameroon":"Africa","Angola":"Africa","Senegal":"Africa","Mali":"Africa","Zambia":"Africa","Zimbabwe":"Africa","Rwanda":"Africa","Botswana":"Africa","Namibia":"Africa","Gabon":"Africa",
  "Russia":"Europe","Ukraine":"Europe","Belarus":"Europe","Moldova":"Europe",
};

async function buildHintData(lat, lng) {
  const geo = await fetchReverseGeocode(lat, lng);
  const country   = geo?.countryName ?? "Unknown";
  const region    = geo?.principalSubdivision ?? geo?.locality ?? geo?.city ?? "Unknown";
  const continent = CONTINENT_BY_COUNTRY[country] ?? "Unknown";
  return { continent, country, region };
}

const weatherCache = new Map();
async function fetchAvgTemperatureC(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (weatherCache.has(key)) return weatherCache.get(key);
  if (!OPENWEATHER_API_KEY) return null;
  try {
    const res = await fetch(`https://history.openweathermap.org/data/2.5/aggregated/year?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}`);
    if (!res.ok) return null;
    const json = await res.json();
    const temps = Array.isArray(json?.result)
      ? json.result.map((r) => r?.temp?.mean).filter((v) => typeof v === "number" && isFinite(v))
      : [];
    if (!temps.length) return null;
    const avgC = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length - 273.15);
    weatherCache.set(key, avgC);
    return avgC;
  } catch { return null; }
}

async function findMapillaryPano(lat, lng) {
  if (!MAPILLARY_ACCESS_TOKEN) return null;
  const radii = [1000, 5000, 20000, 50000];
  for (const radius of radii) {
    const latD = metersToLatDelta(radius);
    const lngD = metersToLngDelta(radius, lat);
    const bbox = `${lng - lngD},${lat - latD},${lng + lngD},${lat + latD}`;
    try {
      const res = await fetch(
        `https://graph.mapillary.com/images?access_token=${MAPILLARY_ACCESS_TOKEN}&fields=id,geometry,is_pano&bbox=${bbox}&is_pano=true&limit=1`
      );
      if (!res.ok) continue;
      const json = await res.json();
      const image = json?.data?.[0];
      if (!image?.id) continue;
      const coords = image?.geometry?.coordinates;
      let panoLat = lat, panoLng = lng;
      if (Array.isArray(coords) && coords.length >= 2) {
        panoLng = coords[0];
        panoLat = coords[1];
      }
      return {
        imageId: image.id,
        lat: panoLat,
        lng: panoLng,
        distanceKm: haversineKm(lat, lng, panoLat, panoLng),
        searchRadius: radius,
      };
    } catch { continue; }
  }
  return null;
}

app.get("/api/mapillary-token", (_req, res) => {
  res.json({ token: MAPILLARY_ACCESS_TOKEN });
});

function startRound(room) {
  stopRoundTimers(room);
  room.state       = "playing";
  room.guesses     = {};
  room.roundEnding = false;
  room.hintDeductions = {};

  const hider = room.players[room.currentRoundIndex % room.players.length];
  room.activeRound = {
    hiderId:  hider.id,
    hiderName: hider.username,
    rawLocation: null,
    location: null,
    imageId:  null,
    panoLat:  null,
    panoLng:  null,
    validated: false,
    hintData:  null,
    heat:      0,
    passivePointsPerSec: 0,
    temperatureC: null,
    timeLeft: room.roundLength,
    phase: "hiding",
  };

  io.to(room.code).emit("gameStarted", {
    hiderId:     hider.id,
    hiderName:   hider.username,
    round:       room.currentRoundIndex + 1,
    totalRounds: room.totalRounds,
    duration:    room.roundLength,
  });
}

async function beginBetting(room) {
  room.activeRound.phase = "betting";

  const tempC = await fetchAvgTemperatureC(room.activeRound.location.lat, room.activeRound.location.lng);
  room.activeRound.temperatureC = tempC;

  io.to(room.code).emit("beginBetting", { temperatureC: tempC });

  room.bettingTimerId = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || !r.activeRound || r.activeRound.phase !== "betting") return;
    const seekers = r.players.filter((p) => p.id !== r.activeRound.hiderId);
    for (const seeker of seekers) {
      if (!r.guesses[seeker.id]) {
        r.guesses[seeker.id] = {
          wager: 0, strategy: "safe", tier: 5,
          lat: null, lng: null, submittedAt: Date.now(),
        };
      }
    }
    beginGuessing(r);
  }, BETTING_TIMEOUT_MS);
}

async function beginGuessing(room) {
  if (!room.activeRound?.location) return;
  if (room.bettingTimerId) { clearTimeout(room.bettingTimerId); room.bettingTimerId = null; }

  const { heat, passivePointsPerSec } = nearestCityHeat(
    room.activeRound.location.lat, room.activeRound.location.lng,
  );
  room.activeRound.heat               = heat;
  room.activeRound.passivePointsPerSec = passivePointsPerSec;
  room.activeRound.phase              = "guessing";
  room.activeRound.timeLeft           = room.roundLength;
  room.state                          = "guessing";

  io.to(room.code).emit("startGuessing", {
    imageId:            room.activeRound.imageId,
    panoLat:            room.activeRound.location.lat,
    panoLng:            room.activeRound.location.lng,
    hiderName:          room.activeRound.hiderName,
    temperatureC:       room.activeRound.temperatureC,
    heat,
    passivePointsPerSec,
  });
  io.to(room.code).emit("timerUpdate", room.activeRound.timeLeft);

  room.timerId = setInterval(() => {
    const r = rooms.get(room.code);
    if (!r || r.state !== "guessing" || !r.activeRound) return;
    r.activeRound.timeLeft -= 1;

    const hider = r.players.find((p) => p.id === r.activeRound.hiderId);
    if (hider) { hider.score += r.activeRound.passivePointsPerSec; broadcastLobby(r.code); }

    io.to(r.code).emit("timerUpdate", r.activeRound.timeLeft);
    if (r.activeRound.timeLeft <= 0) endRound(r.code);
  }, 1000);
}

function endRound(code) {
  const room = rooms.get(code);
  if (!room || room.roundEnding) return;
  if (!room.activeRound?.location) return;

  room.roundEnding = true;
  stopRoundTimers(room);
  room.state = "results";

  const real    = room.activeRound.location;
  const hiderId = room.activeRound.hiderId;
  const seekerRows = [];
  let bestSeeker = null;

  for (const player of room.players) {
    if (player.id === hiderId) continue;
    const guess = room.guesses[player.id];
    if (!guess || guess.lat === null) continue;

    const distance = haversineKm(guess.lat, guess.lng, real.lat, real.lng);
    const wager    = clamp(Number(guess.wager ?? 0), 0, 5000);
    const tier     = Number(guess.tier ?? 5);
    const { points, base, won } = computeSeekerScore(distance, guess.strategy, wager, tier);

    const hintDeduction = room.hintDeductions?.[player.id] ?? 0;
    const finalPoints   = Math.max(0, points - hintDeduction);

    player.score += finalPoints;

    const row = {
      id: player.id, username: player.username, role: "Seeker",
      guess, distance: Math.round(distance),
      base, wager, strategy: guess.strategy ?? "safe", tier,
      points: finalPoints, hintDeduction, won, winner: false,
    };
    seekerRows.push(row);
    if (!bestSeeker || row.points > bestSeeker.points) bestSeeker = row;
  }

  if (bestSeeker) bestSeeker.winner = true;

  const hider      = room.players.find((p) => p.id === hiderId);
  const hiderBonus = bestSeeker ? clamp(20000 - bestSeeker.points, 0, 20000) : 5000;
  if (hider) hider.score += hiderBonus;

  const results = [];
  if (hider) {
    results.push({
      id: hider.id, username: hider.username, role: "Hider",
      guess: null, distance: "—", base: 0, points: hiderBonus,
      wager: 0, strategy: "hider", tier: 0, hintDeduction: 0, won: null, winner: false,
    });
  }
  results.push(...seekerRows);

  io.to(code).emit("roundResults", {
    location: real, hiderName: room.activeRound.hiderName,
    imageId: room.activeRound.imageId ?? null, results,
  });
  broadcastLobby(code);

  room.autoAdvanceId = setTimeout(() => {
    room.roundEnding       = false;
    room.currentRoundIndex += 1;
    if (room.currentRoundIndex >= room.totalRounds) { finishGame(room); return; }
    room.state       = "playing";
    room.guesses     = {};
    room.activeRound = null;
    startRound(room);
  }, ROUND_RESULT_DELAY_MS);
}

function finishGame(room) {
  stopRoundTimers(room);
  room.state = "finished";
  io.to(room.code).emit("gameOver", [...room.players].sort((a, b) => b.score - a.score));
  broadcastLobby(room.code);
}

// ─── Socket handlers ────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.username = null;

  socket.on("createRoom", ({ username, rounds, roundLength }) => {
    if (socket.data.roomCode) { socket.emit("errorMsg", "Already in a room."); return; }
    const code        = makeCode();
    const totalRounds = clamp(Number(rounds) || 1, 1, 99);
    const roundLen    = clamp(Number(roundLength) || DEFAULT_ROUND_LENGTH, 20, 180);
    const room = {
      code, hostId: socket.id, state: "lobby",
      players: [{ id: socket.id, username: username || "Player", score: 0 }],
      totalRounds, roundLength: roundLen,
      currentRoundIndex: 0, activeRound: null, guesses: {},
      timerId: null, autoAdvanceId: null, bettingTimerId: null,
      roundEnding: false, hintDeductions: {},
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.username = username || "Player";
    socket.emit("roomCreated", code);
    broadcastLobby(code);
  });

  socket.on("joinRoom", ({ code, username }) => {
    if (socket.data.roomCode) { socket.emit("errorMsg", "Already in a room."); return; }
    const room = rooms.get(String(code ?? "").toUpperCase().trim());
    if (!room)                                         { socket.emit("errorMsg", "Room not found.");       return; }
    if (room.state !== "lobby")                        { socket.emit("errorMsg", "Game already started."); return; }
    if (room.players.some((p) => p.id === socket.id)) { socket.emit("errorMsg", "Already in room.");      return; }
    room.players.push({ id: socket.id, username: username || "Player", score: 0 });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.username = username || "Player";
    socket.emit("roomJoined", { code: room.code, hostId: room.hostId });
    broadcastLobby(room.code);
  });

  socket.on("startGame", ({ code, rounds, roundLength }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.hostId)  { socket.emit("errorMsg", "Only the host can start."); return; }
    if (room.players.length < 2)    { socket.emit("errorMsg", "Need at least 2 players."); return; }
    room.totalRounds       = clamp(Number(rounds)      || room.totalRounds      || 1, 1, 99);
    room.roundLength       = clamp(Number(roundLength) || room.roundLength      || DEFAULT_ROUND_LENGTH, 20, 180);
    room.currentRoundIndex = 0;
    room.state             = "playing";
    room.guesses           = {};
    room.hintDeductions    = {};
    room.roundEnding       = false;
    for (const p of room.players) p.score = 0;
    broadcastLobby(code);
    startRound(room);
  });

  socket.on("validateLocation", async ({ code, lat, lng }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound)             return;
    if (room.activeRound.hiderId !== socket.id) return;

    const pano = await findMapillaryPano(Number(lat), Number(lng));
    if (!pano) {
      socket.emit("validationResult", { ok: false, message: "No 360° panorama found nearby. Try a different spot (cities & roads work best)." });
      return;
    }

    room.activeRound.validated   = true;
    room.activeRound.imageId     = pano.imageId;
    room.activeRound.rawLocation = { lat: Number(lat), lng: Number(lng) };
    room.activeRound.location    = { lat: pano.lat, lng: pano.lng };

    socket.emit("validationResult", {
      ok: true,
      imageId:  pano.imageId,
      panoLat:  pano.lat,
      panoLng:  pano.lng,
      distanceM: Math.round(pano.distanceKm * 1000),
      searchRadius: pano.searchRadius,
      message:  `Panorama found ${Math.round(pano.distanceKm * 1000)}m away`,
    });
  });

  socket.on("setLocation", ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound)             return;
    if (room.activeRound.hiderId !== socket.id) return;
    if (!room.activeRound.validated)            { socket.emit("errorMsg", "Validate the spot first."); return; }
    beginBetting(room);
  });

  socket.on("submitBet", ({ code, wager, strategy, tier }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound || room.activeRound.phase !== "betting") return;
    if (socket.id === room.activeRound.hiderId) return;
    if (room.guesses[socket.id]) return;

    room.guesses[socket.id] = {
      wager:    clamp(Number(wager) || 0, 0, 5000),
      strategy: strategy === "bold" ? "bold" : "safe",
      tier:     clamp(Number(tier) || 5, 1, 5),
      lat: null, lng: null,
      submittedAt: Date.now(),
    };

    const seekers = room.players.filter((p) => p.id !== room.activeRound.hiderId);
    const betsIn  = Object.keys(room.guesses).length;
    io.to(code).emit("betProgress", { betsIn, total: seekers.length });

    if (betsIn >= seekers.length) beginGuessing(room);
  });

  socket.on("submitGuess", ({ code, lat, lng }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound || room.state !== "guessing") return;
    if (socket.id === room.activeRound.hiderId) return;
    const existing = room.guesses[socket.id];
    if (!existing || existing.lat !== null) return;

    existing.lat = Number(lat);
    existing.lng = Number(lng);

    const seekers = room.players.filter((p) => p.id !== room.activeRound.hiderId);
    const guessed = Object.values(room.guesses).filter((g) => g.lat !== null).length;
    if (guessed >= seekers.length) endRound(code);
  });

  socket.on("requestHint", ({ code, hint }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound || room.activeRound.phase !== "guessing") {
      socket.emit("hintError", { message: "Hints only available during guessing." }); return;
    }
    if (socket.id === room.activeRound.hiderId) { socket.emit("hintError", { message: "Hiders cannot buy hints." }); return; }

    const cost = hintCost(hint);

    const deliver = (data) => {
      if (!room.hintDeductions[socket.id]) room.hintDeductions[socket.id] = 0;
      room.hintDeductions[socket.id] += cost;
      socket.emit("hintGranted", { hint, value: data[hint] ?? "Unknown", cost });
    };

    if (room.activeRound.hintData) { deliver(room.activeRound.hintData); return; }
    buildHintData(room.activeRound.location.lat, room.activeRound.location.lng).then((data) => {
      room.activeRound.hintData = data;
      deliver(data);
    });
  });

  socket.on("usePowerup", ({ code, action, targetId }) => {
    const room = rooms.get(code);
    if (!room || !room.activeRound || room.activeRound.phase !== "guessing") {
      socket.emit("errorMsg", "Power-ups only during guessing."); return;
    }
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (action === "cleanse") {
      socket.emit("sabotageApplied", { action: "cleanse", targetName: player.username, targetId: socket.id, duration: 0 });
      return;
    }

    const cost = sabotageCost(action);
    if (player.score < cost) { socket.emit("errorMsg", `Not enough points (need ${cost}).`); return; }
    player.score -= cost;
    broadcastLobby(room.code);

    const target     = targetId ? room.players.find((p) => p.id === targetId) : null;
    const targetName = target?.username ?? "everyone";

    if (targetId) {
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit("sabotageApplied", { action, targetName: player.username, targetId, duration: 10000, fromPlayer: player.username });
      }
      socket.emit("sabotageConfirmed", { action, targetName, cost });
    } else {
      room.players.forEach((p) => {
        if (p.id === socket.id) return;
        const s = io.sockets.sockets.get(p.id);
        if (s) s.emit("sabotageApplied", { action, targetName: player.username, targetId: null, duration: 10000, fromPlayer: player.username });
      });
      socket.emit("sabotageConfirmed", { action, targetName: "everyone", cost });
    }
  });

  socket.on("chatMessage", ({ code, message }) => {
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit("chatMessage", { sender: socket.data.username ?? "Player", message: String(message ?? "").slice(0, 300) });
  });

  socket.on("reaction", ({ code, emoji }) => {
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit("reaction", { emoji: String(emoji ?? "") });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const wasHost  = socket.id === room.hostId;
    const wasHider = room.activeRound?.hiderId === socket.id;
    room.players = room.players.filter((p) => p.id !== socket.id);
    if (room.players.length === 0) { stopRoundTimers(room); rooms.delete(code); return; }
    if (wasHost) room.hostId = room.players[0].id;
    if (wasHider && room.state !== "finished") {
      stopRoundTimers(room);
      room.state = "results"; room.roundEnding = false;
      io.to(code).emit("roundResults", {
        location: room.activeRound?.location ?? { lat: 0, lng: 0 },
        hiderName: room.activeRound?.hiderName ?? "Left", imageId: null, results: [],
      });
      room.autoAdvanceId = setTimeout(() => {
        room.roundEnding       = false;
        room.currentRoundIndex += 1;
        if (room.currentRoundIndex >= room.totalRounds) { finishGame(room); return; }
        room.state       = "playing";
        room.guesses     = {};
        room.activeRound = null;
        startRound(room);
      }, ROUND_RESULT_DELAY_MS);
    }
    broadcastLobby(code);
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
