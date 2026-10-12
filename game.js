const SHIPS = [
  { id: "carrier", name: "Carrier", length: 5 },
  { id: "battleship", name: "Battleship", length: 4 },
  { id: "cruiser", name: "Cruiser", length: 3 },
  { id: "submarine", name: "Submarine", length: 3 },
  { id: "destroyer", name: "Destroyer", length: 2 },
];
const PEER_PREFIX = "bsweb-v1-";

const state = {
  role: null,
  seat: null,
  code: null,
  conn: null,
  peer: null,
  phase: "home",
  selected: "carrier",
  horizontal: true,
  placed: {},
  ownShots: {},
  incoming: {},
  room: null,
};

const el = {
  status: document.getElementById("status"),
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  place: document.getElementById("screen-place"),
  battle: document.getElementById("screen-battle"),
  over: document.getElementById("screen-over"),
  roomCode: document.getElementById("room-code"),
  shipList: document.getElementById("ship-list"),
  placeBoard: document.getElementById("place-board"),
  enemyBoard: document.getElementById("enemy-board"),
  ownBoard: document.getElementById("own-board"),
  ready: document.getElementById("btn-ready"),
};

function show(screen) {
  for (const key of ["home", "lobby", "place", "battle", "over"]) {
    el[key].classList.toggle("hidden", key !== screen);
  }
}

function setStatus(text) {
  el.status.textContent = text;
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function occupancy(cells) {
  const map = new Map();
  for (const cell of cells || []) map.set(`${cell.r},${cell.c}`, cell.id);
  return map;
}

function cellsMatchShips(cells) {
  if (!Array.isArray(cells) || cells.length !== SHIPS.reduce((n, s) => n + s.length, 0)) return false;
  const seen = new Set();
  const byId = new Map(SHIPS.map((s) => [s.id, s]));
  const grouped = new Map();
  for (const cell of cells) {
    if (!cell || !byId.has(cell.id)) return false;
    const key = `${cell.r},${cell.c}`;
    if (seen.has(key)) return false;
    if (!Number.isInteger(cell.r) || !Number.isInteger(cell.c)) return false;
    if (cell.r < 0 || cell.r > 9 || cell.c < 0 || cell.c > 9) return false;
    seen.add(key);
    if (!grouped.has(cell.id)) grouped.set(cell.id, []);
    grouped.get(cell.id).push(cell);
  }
  if (grouped.size !== SHIPS.length) return false;
  for (const ship of SHIPS) {
    const group = grouped.get(ship.id);
    if (!group || group.length !== ship.length) return false;
    const rows = group.map((g) => g.r).sort((a, b) => a - b);
    const cols = group.map((g) => g.c).sort((a, b) => a - b);
    const sameRow = rows.every((r) => r === rows[0]);
    const sameCol = cols.every((c) => c === cols[0]);
    if (sameRow) {
      if (cols[cols.length - 1] - cols[0] !== ship.length - 1) return false;
      for (let i = 1; i < cols.length; i++) if (cols[i] !== cols[i - 1] + 1) return false;
    } else if (sameCol) {
      if (rows[rows.length - 1] - rows[0] !== ship.length - 1) return false;
      for (let i = 1; i < rows.length; i++) if (rows[i] !== rows[i - 1] + 1) return false;
    } else return false;
  }
  return true;
}

function shipSunk(cells, hits, shipId) {
  return cells.filter((c) => c.id === shipId).every((c) => hits.has(`${c.r},${c.c}`));
}

function allSunk(cells, hits) {
  return cells.every((c) => hits.has(`${c.r},${c.c}`));
}

function newRoom() {
  return {
    fleets: [null, null],
    hits: [new Set(), new Set()],
    misses: [new Set(), new Set()],
    turn: 0,
    phase: "lobby",
  };
}

function sendOut(payload) {
  if (state.conn && state.conn.open) state.conn.send(payload);
}

function broadcast(payload) {
  handle(payload);
  sendOut(payload);
}

function processCommand(seat, msg) {
  const room = state.room;
  if (!room) return;

  if (msg.type === "place") {
    if (room.phase !== "placing") return;
    if (room.fleets[seat] || !cellsMatchShips(msg.cells)) return;
    room.fleets[seat] = msg.cells;
    if (seat === state.seat) handle({ type: "placed" });
    else sendOut({ type: "placed" });
    const other = 1 - seat;
    if (other === state.seat) handle({ type: "opponent_placed" });
    else sendOut({ type: "opponent_placed" });
    if (room.fleets[0] && room.fleets[1]) {
      room.phase = "battle";
      room.turn = 0;
      broadcast({ type: "battle_start", turn: 0 });
    }
    return;
  }

  if (msg.type === "fire") {
    if (room.phase !== "battle" || room.turn !== seat) return;
    const r = msg.r;
    const c = msg.c;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 9 || c < 0 || c > 9) return;
    const key = `${r},${c}`;
    if (room.hits[seat].has(key) || room.misses[seat].has(key)) return;
    const enemy = occupancy(room.fleets[1 - seat]);
    const shipId = enemy.get(key) || null;
    let result = "miss";
    let sunkId = null;
    if (shipId) {
      room.hits[seat].add(key);
      result = "hit";
      if (shipSunk(room.fleets[1 - seat], room.hits[seat], shipId)) {
        result = "sunk";
        sunkId = shipId;
      }
    } else room.misses[seat].add(key);
    const over = allSunk(room.fleets[1 - seat], room.hits[seat]);
    if (over) room.phase = "over";
    else room.turn = 1 - seat;
    const sunkCells = sunkId
      ? room.fleets[1 - seat].filter((cell) => cell.id === sunkId).map((cell) => ({ r: cell.r, c: cell.c }))
      : [];
    broadcast({
      type: "shot",
      r,
      c,
      result,
      sunkId,
      sunkCells,
      shooter: seat,
      turn: room.turn,
      over,
      winner: over ? seat : null,
    });
  }
}

function wireConn(conn) {
  state.conn = conn;
  conn.on("data", (msg) => {
    if (state.role === "host") processCommand(1, msg);
    else handle(msg);
  });
  conn.on("close", () => {
    if (state.phase !== "over" && state.phase !== "home") handle({ type: "opponent_left" });
  });
}

function createRoom() {
  const code = makeCode();
  if (typeof Peer !== "function") {
    setStatus("Could not load online matchmaking. Check your internet and refresh.");
    return;
  }
  setStatus("Opening a room…");
  const peer = new Peer(PEER_PREFIX + code);
  state.peer = peer;
  peer.on("open", () => {
    state.role = "host";
    state.seat = 0;
    state.code = code;
    state.room = newRoom();
    state.phase = "lobby";
    el.roomCode.textContent = code;
    show("lobby");
    setStatus("Waiting for your friend. They must open this same website, then join with the code.");
  });
  peer.on("connection", (conn) => {
    if (state.conn) {
      conn.on("open", () => conn.close());
      return;
    }
    wireConn(conn);
    conn.on("open", () => {
      state.room.phase = "placing";
      handle({ type: "opponent_joined" });
      sendOut({ type: "joined", code, seat: 1 });
    });
  });
  peer.on("error", (err) => {
    if (err?.type === "unavailable-id") {
      peer.destroy();
      createRoom();
      return;
    }
    setStatus("Could not create a room. Refresh and try again.");
  });
}

function joinRoom() {
  const code = document.getElementById("join-code").value.toUpperCase().trim();
  if (code.length !== 4) {
    setStatus("Enter the 4-letter room code.");
    return;
  }
  if (typeof Peer !== "function") {
    setStatus("Could not load online matchmaking. Check your internet and refresh.");
    return;
  }
  setStatus("Connecting to your friend…");
  const peer = new Peer();
  state.peer = peer;
  peer.on("open", () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    state.role = "guest";
    state.code = code;
    wireConn(conn);
    conn.on("open", () => setStatus("Connected. Starting…"));
    conn.on("error", () => setStatus("Could not join. Check the code and that your friend is waiting."));
  });
  peer.on("error", () => setStatus("Could not join. Check the code and that both of you opened the same website."));
}

function handle(msg) {
  if (msg.type === "error") {
    setStatus(msg.message);
    return;
  }
  if (msg.type === "joined") {
    state.seat = msg.seat;
    state.code = msg.code;
    startPlacing();
  }
  if (msg.type === "opponent_joined") startPlacing();
  if (msg.type === "placed") setStatus("Fleet locked. Waiting for opponent…");
  if (msg.type === "opponent_placed") setStatus("Opponent is ready. Finish your fleet.");
  if (msg.type === "battle_start") {
    state.phase = "battle";
    renderOwnBoard();
    renderEnemyBoard();
    show("battle");
    setTurn(msg.turn);
  }
  if (msg.type === "shot") applyShot(msg);
  if (msg.type === "opponent_left") {
    document.getElementById("over-title").textContent = "Match ended";
    document.getElementById("over-text").textContent = "Your opponent disconnected.";
    show("over");
    setStatus("The other player left.");
  }
}

function startPlacing() {
  state.phase = "placing";
  state.placed = {};
  state.selected = "carrier";
  el.ready.disabled = true;
  renderShipList();
  renderPlaceBoard();
  show("place");
  setStatus("Place your ships. Tap a ship, then tap the grid.");
}

function allPlaced() {
  return SHIPS.every((s) => state.placed[s.id]);
}

function renderShipList() {
  el.shipList.innerHTML = "";
  for (const ship of SHIPS) {
    const chip = document.createElement("button");
    chip.className = "ship-chip";
    if (state.selected === ship.id) chip.classList.add("active");
    if (state.placed[ship.id]) chip.classList.add("placed");
    chip.textContent = `${ship.name} (${ship.length})`;
    chip.onclick = () => {
      if (state.placed[ship.id]) {
        delete state.placed[ship.id];
        el.ready.disabled = true;
      }
      state.selected = ship.id;
      renderShipList();
      renderPlaceBoard();
    };
    el.shipList.appendChild(chip);
  }
}

function occupiedMap(excludeId) {
  const map = new Map();
  for (const ship of SHIPS) {
    if (ship.id === excludeId) continue;
    for (const cell of state.placed[ship.id] || []) map.set(`${cell.r},${cell.c}`, ship.id);
  }
  return map;
}

function previewCells(r, c) {
  const ship = SHIPS.find((s) => s.id === state.selected);
  if (!ship) return [];
  const cells = [];
  for (let i = 0; i < ship.length; i++) {
    cells.push(state.horizontal ? { r, c: c + i, id: ship.id } : { r: r + i, c, id: ship.id });
  }
  return cells;
}

function validPlacement(cells) {
  const occ = occupiedMap(state.selected);
  return cells.every(
    (cell) => cell.r >= 0 && cell.r <= 9 && cell.c >= 0 && cell.c <= 9 && !occ.has(`${cell.r},${cell.c}`)
  );
}

function renderPlaceBoard(hover) {
  el.placeBoard.innerHTML = "";
  const occ = occupiedMap();
  const preview = hover ? previewCells(hover.r, hover.c) : [];
  const ok = preview.length ? validPlacement(preview) : false;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = `${r},${c}`;
      if (occ.has(key)) cell.classList.add("ship");
      if (preview.some((p) => p.r === r && p.c === c)) cell.classList.add(ok ? "preview" : "invalid");
      cell.onmouseenter = () => renderPlaceBoard({ r, c });
      cell.onclick = () => placeAt(r, c);
      el.placeBoard.appendChild(cell);
    }
  }
}

function placeAt(r, c) {
  const cells = previewCells(r, c);
  if (!validPlacement(cells)) return;
  state.placed[state.selected] = cells;
  const next = SHIPS.find((s) => !state.placed[s.id]);
  state.selected = next ? next.id : null;
  el.ready.disabled = !allPlaced();
  renderShipList();
  renderPlaceBoard();
}

function randomFleet() {
  state.placed = {};
  for (const ship of SHIPS) {
    let tries = 0;
    while (tries < 200) {
      state.selected = ship.id;
      state.horizontal = Math.random() < 0.5;
      const cells = previewCells(Math.floor(Math.random() * 10), Math.floor(Math.random() * 10));
      if (validPlacement(cells)) {
        state.placed[ship.id] = cells;
        break;
      }
      tries += 1;
    }
  }
  state.selected = null;
  el.ready.disabled = !allPlaced();
  renderShipList();
  renderPlaceBoard();
}

function flattenFleet() {
  return SHIPS.flatMap((s) => state.placed[s.id] || []);
}

function renderOwnBoard() {
  const occ = occupiedMap();
  el.ownBoard.innerHTML = "";
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = `${r},${c}`;
      if (occ.has(key)) cell.classList.add("ship");
      if (state.incoming[key]) cell.classList.add(state.incoming[key]);
      el.ownBoard.appendChild(cell);
    }
  }
}

function renderEnemyBoard() {
  el.enemyBoard.innerHTML = "";
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = `${r},${c}`;
      if (state.ownShots[key]) cell.classList.add(state.ownShots[key]);
      cell.onclick = () => fire(r, c);
      el.enemyBoard.appendChild(cell);
    }
  }
}

function setTurn(turn) {
  setStatus(turn === state.seat ? "Your shot. Tap a square in enemy waters." : "Opponent is firing…");
}

function send(payload) {
  if (state.role === "host") processCommand(state.seat, payload);
  else sendOut(payload);
}

function fire(r, c) {
  if (state.ownShots[`${r},${c}`]) return;
  send({ type: "fire", r, c });
}

function applyShot(msg) {
  const key = `${msg.r},${msg.c}`;
  const mark = msg.result === "miss" ? "miss" : msg.result === "sunk" ? "sunk" : "hit";
  const board = msg.shooter === state.seat ? state.ownShots : state.incoming;
  board[key] = mark;
  for (const cell of msg.sunkCells || []) board[`${cell.r},${cell.c}`] = "sunk";
  if (msg.sunkId && msg.shooter === state.seat) setStatus(`You sank their ${msg.sunkId}!`);
  renderOwnBoard();
  renderEnemyBoard();
  if (msg.over) {
    const win = msg.winner === state.seat;
    document.getElementById("over-title").textContent = win ? "You win" : "You lose";
    document.getElementById("over-text").textContent = win
      ? "Every enemy ship is on the bottom."
      : "Your fleet has been destroyed.";
    show("over");
    return;
  }
  setTurn(msg.turn);
}

document.getElementById("btn-create").onclick = createRoom;
document.getElementById("btn-join").onclick = joinRoom;
document.getElementById("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});
document.getElementById("btn-rotate").onclick = () => {
  state.horizontal = !state.horizontal;
  renderPlaceBoard();
};
document.getElementById("btn-random").onclick = randomFleet;
el.ready.onclick = () => {
  if (!allPlaced()) return;
  send({ type: "place", cells: flattenFleet() });
  el.ready.disabled = true;
};
document.getElementById("btn-home").onclick = () => location.reload();
