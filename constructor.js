// Конструктор макета. Модели изделий развёрнуты по выкройке (tools/build_model.py из FBX), поэтому одна и та же
// картинка — «текстура» — рисуется на плоских деталях кроя и сразу ложится на 3D-модель.
// Все размеры слоёв хранятся в сантиметрах выкройки: x, y — центр слоя (y вниз от верха листа), w, h — размер.
// Слой принадлежит одной детали и обрезается её контуром.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const WHATSAPP = "77771737475";
const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.round(v * 10) / 10).toString().replace(".", ",");
const MOBILE = matchMedia("(max-width: 760px)").matches;

const FABRICS = [{ id: "black", name: "Чёрный", hex: "#151516" }, { id: "graphite", name: "Графит", hex: "#4a4d52" },
  ...(window.IZUM_COLORS || []).map((c) => (c.id === "white" ? c : c))];
const FONTS = {
  gotham: { css: 'italic 900 100px "Gotham Pro", Arial, sans-serif', upper: true },
  bold: { css: '700 100px "Gotham Pro", Arial, sans-serif', upper: false },
  serif: { css: 'italic 700 100px Georgia, "Times New Roman", serif', upper: false },
  impact: { css: '400 100px Impact, "Arial Narrow", sans-serif', upper: true },
};
// Каймы: плитка 96 px высотой, повторяется по ширине детали. ink — цвет слоя.
const ORNS = {
  meander: { name: "Меандр", w: 96, draw(g, ink) {
    g.strokeStyle = ink; g.lineWidth = 9; g.lineJoin = "miter"; g.lineCap = "butt";
    g.beginPath(); g.moveTo(0, 8); g.lineTo(96, 8); g.moveTo(0, 88); g.lineTo(96, 88); g.stroke();
    g.beginPath(); g.moveTo(0, 70); g.lineTo(78, 70); g.lineTo(78, 26); g.lineTo(26, 26); g.lineTo(26, 50); g.lineTo(56, 50); g.stroke();
  } },
  rhomb: { name: "Ромбы", w: 96, draw(g, ink) {
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 7;
    g.beginPath(); g.moveTo(0, 7); g.lineTo(96, 7); g.moveTo(0, 89); g.lineTo(96, 89); g.stroke();
    g.beginPath(); g.moveTo(48, 18); g.lineTo(90, 48); g.lineTo(48, 78); g.lineTo(6, 48); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(48, 36); g.lineTo(64, 48); g.lineTo(48, 60); g.lineTo(32, 48); g.closePath(); g.fill();
    g.beginPath(); g.arc(0, 48, 5, 0, 7); g.arc(96, 48, 5, 0, 7); g.fill();
  } },
  zig: { name: "Зигзаг", w: 64, draw(g, ink) {
    g.strokeStyle = ink; g.lineWidth = 10; g.lineJoin = "miter";
    for (const dy of [0, 30]) { g.beginPath(); g.moveTo(-32, 62 + dy); g.lineTo(0, 22 + dy); g.lineTo(32, 62 + dy); g.lineTo(64, 22 + dy); g.lineTo(96, 62 + dy); g.stroke(); }
  } },
  solid: { name: "Сплошная полоса", w: 16, draw(g, ink) { g.fillStyle = ink; g.fillRect(0, 0, 16, 96); } },
  // фирменная линия Izum: четыре равные части в исходном порядке, цвет слоя на неё не влияет
  line: { name: "Линия Izum", w: 16, own: true, draw(g) { ["#ffed00", "#009fe3", "#e5007d", "#0d0d0d"].forEach((c, j) => { g.fillStyle = c; g.fillRect(0, j * 24, 16, 24); }); } },
};
const KIND = { img: "Логотип", text: "Текст", band: "Кайма" };

const MODELS = [{ id: "tee_male", name: "Мужская" }, { id: "tee_female", name: "Женская" }];
const S = { fabric: FABRICS[0], layers: [], sel: null, picks: [], tab: "all", pieces: [], A: 100, H: 0.6, model: null, seq: 1 };
let dirty = true;          // перерисовать 3D
let model = null;

// ---------- выкройка ----------
const piece = (id) => S.pieces.find((p) => p.id === id);
function inPoly(x, y, o) {
  let c = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const [x1, y1] = o[i], [x2, y2] = o[j];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
const pieceAt = (x, y) => S.pieces.find((p) => x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && inPoly(x, y, p.o));
// точка развёртки модели -> точка листа: зеркально развёрнутая деталь на листе лежит «как снаружи»
function fromUV(x, y) {
  const p = S.pieces.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1 && inPoly(x, y, q.raw));
  return p && p.mir ? [p.x0 + p.x1 - x, y] : [x, y];
}
// низ рукава на листе и в какую сторону от него уходит деталь
const hemY = (p) => (p.hem === "top" ? p.y0 : p.y1), hemS = (p) => (p.hem === "top" ? -1 : 1);
function tracePiece(g, p) {
  g.beginPath();
  p.o.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}

// ---------- слои ----------
const tileCache = new Map();
function ornTile(key, ink) {
  const k = key + "|" + ink;
  if (!tileCache.has(k)) {
    const o = ORNS[key], c = document.createElement("canvas");
    c.width = o.w; c.height = 96;
    o.draw(c.getContext("2d"), ink);
    tileCache.set(k, c);
  }
  return tileCache.get(k);
}
function tinted(L) {
  if (!L.ink) return L.src;
  if (L._ink !== L.ink) {
    const c = document.createElement("canvas");
    c.width = L.src.naturalWidth || L.src.width; c.height = L.src.naturalHeight || L.src.height;
    const g = c.getContext("2d");
    g.drawImage(L.src, 0, 0, c.width, c.height);
    g.globalCompositeOperation = "source-in"; g.fillStyle = L.ink; g.fillRect(0, 0, c.width, c.height);
    L._tint = c; L._ink = L.ink;
  }
  return L._tint;
}
// Средний цвет непрозрачной части картинки: по нему видно, что она сливается с тканью (белый знак на белой футболке).
const TONES = new WeakMap();
function toneOf(src) {
  if (!TONES.has(src)) {
    let tone = null;
    try {
      const c = document.createElement("canvas"); c.width = c.height = 24;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(src, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (a < 0.3) continue; r += d[i] * a; gg += d[i + 1] * a; b += d[i + 2] * a; n += a; }
      if (n) tone = [r / n, gg / n, b / n];
    } catch (e) { /* чужая картинка без доступа к точкам — считаем, что не знаем */ }
    TONES.set(src, tone);
  }
  return TONES.get(src);
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function fades(L) {
  if (L.type !== "img" || L.ink) return false;
  const t = toneOf(L.src), f = rgbOf(S.fabric.hex);
  return !!t && Math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]) < 70;
}
const meas = document.createElement("canvas").getContext("2d");
function textOf(L) { const f = FONTS[L.font] || FONTS.gotham; return f.upper ? L.text.toUpperCase() : L.text; }
function fitText(L) {                    // ширина текста следует из высоты строки
  meas.font = (FONTS[L.font] || FONTS.gotham).css;
  L.w = Math.max(1, (meas.measureText(textOf(L) || " ").width / 100) * L.h * 1.32);
}
// цвет слоя; если он совпал с тканью, берётся контрастный — иначе нанесение пропадает
const inkOf = (L) => (L.ink && L.ink.toLowerCase() !== S.fabric.hex.toLowerCase() ? L.ink : defaultInk());
function defaultInk() { return lum(S.fabric.hex) > 0.55 ? "#0d0d0d" : "#ffffff"; }
function lum(hex) { const [r, g, b] = [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16)); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

// ---------- переход через шов ----------
// У детали есть швы: пары точек «здесь на этой детали — там на соседней» (из модели, см. tools/build_model.py).
// Если рамка слоя задевает шов, слой дорисовывается на соседней детали ПО РАСКРОЮ: тем же сдвигом, каким точка шва
// под слоем переходит на соседнюю деталь, и без поворота — надпись идёт так же ровно, как лежат детали на листе.
// Так переходить можно только через швы, по которым детали на листе смотрят друг на друга: боковые (перед — спинка)
// и нижний шов рукава. У проймы и плеча края развёрнуты друг к другу на 30–160°: сдвиг без поворота там кладёт
// копию нанесения внутрь соседней детали, а с поворотом надпись уходит под углом (пользователь это отверг).
// Поэтому при загрузке модели в p.seams остаются только «ровные» швы (seamTurn), у остальных нанесение обрезается.
function seamTurn(P) {                      // наибольший местный разворот соседней детали вдоль шва, в радианах
  let worst = 0;
  for (const c of P) {
    const use = P.filter((r) => Math.hypot(r[0] - c[0], r[1] - c[1]) < 3);
    if (use.length < 3) continue;
    let ax = 0, ay = 0, bx = 0, by = 0, dot = 0, crs = 0;
    use.forEach((r) => { ax += r[0]; ay += r[1]; bx += r[2]; by += r[3]; });
    ax /= use.length; ay /= use.length; bx /= use.length; by /= use.length;
    use.forEach((r) => { const ux = r[0] - ax, uy = r[1] - ay, vx = r[2] - bx, vy = r[3] - by; dot += ux * vx + uy * vy; crs += ux * vy - uy * vx; });
    worst = Math.max(worst, Math.abs(Math.atan2(crs, dot)));
  }
  return worst;
}
function wrapsOf(L) {
  const p = piece(L.piece);
  if (!p || !p.seams || L.type === "band" || L.wrap === false) return [];
  const a = (-L.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), hw = L.w / 2, hh = L.h / 2, out = [];
  for (const sm of p.seams) {
    let n = 0, cross = 0, ax = 0, ay = 0, bx = 0, by = 0;
    for (const q of sm.P) {
      const dx = q[0] - L.x, dy = q[1] - L.y, lx = Math.abs(dx * co - dy * si), ly = Math.abs(dx * si + dy * co);
      if (lx > hw + 1 || ly > hh + 1) continue;                  // запас 1 см: сдвиг готов чуть раньше касания
      n++; ax += q[0]; ay += q[1]; bx += q[2]; by += q[3];
      if (lx <= hw && ly <= hh) cross++;
    }
    if (n < 2) continue;
    out.push({ to: piece(sm.to), dx: (bx - ax) / n, dy: (by - ay) / n, cross: cross > 0 });
  }
  return out;
}
const seamT = (g, w) => g.translate(w.dx, w.dy);
// слой становится слоем соседней детали: тот же сдвиг, что и у его продолжения
function carry(L, w) { L.x += w.dx; L.y += w.dy; L.piece = w.to.id; }

function paintBody(g, L) {
  g.translate(L.x, L.y); g.rotate((L.rot * Math.PI) / 180);
  if (L.flip) g.scale(-1, 1);
  if (L.type === "img") g.drawImage(tinted(L), -L.w / 2, -L.h / 2, L.w, L.h);
  else {
    g.font = (FONTS[L.font] || FONTS.gotham).css; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = inkOf(L);
    const k = (L.h * 1.32) / 100; g.scale(k, k); g.fillText(textOf(L), 0, 4);
  }
}
function drawLayer(g, L, onTex) {
  const p = piece(L.piece);
  if (!p || L.hidden) return;
  const vis = (q) => onTex || shown(q);
  const into = (q) => {
    g.save();
    if (onTex && q.mir) { g.translate(q.x0 + q.x1, 0); g.scale(-1, 1); }     // на текстуру зеркальная деталь печатается перевёрнутой
    tracePiece(g, q); g.clip();
  };
  if (vis(p)) {
    into(p);
    if (L.type === "band") {
      const tile = ornTile(L.orn, ORNS[L.orn].own ? "" : inkOf(L)), k = L.h / 96;
      const pat = g.createPattern(tile, "repeat");
      pat.setTransform(L.flip ? new DOMMatrix().translate(p.x1, L.y - L.h / 2).scale(-k, k) : new DOMMatrix().translate(p.x0, L.y - L.h / 2).scale(k));
      g.fillStyle = pat; g.fillRect(p.x0, L.y - L.h / 2, p.x1 - p.x0, L.h);
    } else paintBody(g, L);
    g.restore();
  }
  for (const w of wrapsOf(L)) {                                 // продолжение на соседней детали
    if (!vis(w.to)) continue;
    into(w.to); seamT(g, w); paintBody(g, L); g.restore();
  }
}
let hitWrap = null;       // через какой шов попали в слой последним hitLayer (нажали на его продолжение на соседней детали)
function hitLayer(x, y, anyPiece) {
  const at = pieceAt(x, y);
  hitWrap = null;
  for (let i = S.layers.length - 1; i >= 0; i--) {
    const L = S.layers[i], p = piece(L.piece);
    if (L.hidden || (anyPiece ? !shown(p) : !at)) continue;
    if (L.type === "band") { if ((anyPiece || at.id === L.piece) && x >= p.x0 && x <= p.x1 && Math.abs(y - L.y) <= L.h / 2) return L; continue; }
    let px = x, py = y, via = null;
    if (!anyPiece && at.id !== L.piece) {
      const a = (-L.rot * Math.PI) / 180;
      via = wrapsOf(L).find((w) => {
        if (w.to !== at) return false;
        const qx = x - w.dx - L.x, qy = y - w.dy - L.y;                                       // обратно в лист своей детали
        return Math.abs(qx * Math.cos(a) - qy * Math.sin(a)) <= L.w / 2 && Math.abs(qx * Math.sin(a) + qy * Math.cos(a)) <= L.h / 2;
      });
      if (via) { hitWrap = via; return L; }
      continue;
    }
    const a = (-L.rot * Math.PI) / 180, dx = px - L.x, dy = py - L.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= L.w / 2 && Math.abs(ly) <= L.h / 2) return L;
  }
  return null;
}
function spot(p, type) {                  // место по умолчанию на детали
  const cx = (p.x0 + p.x1) / 2, h = p.y1 - p.y0;
  if (p.kind === "trim") return [cx, (p.y0 + p.y1) / 2];
  if (type === "band") return [cx, p.kind === "sleeve" ? hemY(p) - hemS(p) * 3 : p.y1 - 6];
  if (p.id === "front") return [cx, p.y0 + h * 0.36];
  if (p.id === "back") return [cx, p.y0 + h * 0.28];
  return [cx, p.y0 + h * 0.6];
}
function addLayer(L, pid = "front") {
  const p = piece(pid), [x, y] = spot(p, L.type);
  Object.assign(L, { id: S.seq++, piece: pid, x, y, rot: 0, ink: L.ink ?? null }, L.x != null ? { x: L.x, y: L.y } : {});
  if (L.type === "text") fitText(L);
  S.layers.push(L); select(L); changed();
  return L;
}
function moveTo(L, x, y) {
  const p = pieceAt(x, y);
  if (p) L.piece = p.id;
  L.x = x; L.y = y;
  if (L.type === "band") { const q = piece(L.piece); L.y = Math.min(q.y1 - L.h / 2, Math.max(q.y0 + L.h / 2, y)); L.x = (q.x0 + q.x1) / 2; }
}

// ---------- текстура ----------
const texCv = document.createElement("canvas");
const HI = MOBILE ? 2048 : 4096;
let tex = null, hiTimer = 0;
function paintTex(size) {
  if (texCv.width !== size) { texCv.width = texCv.height = size; if (tex) tex.dispose(); }
  const g = texCv.getContext("2d"), k = size / S.A;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = S.fabric.hex; g.fillRect(0, 0, size, size);
  g.setTransform(k, 0, 0, k, 0, 0);
  g.imageSmoothingQuality = "high";
  S.layers.forEach((L) => drawLayer(g, L, true));
  if (tex) tex.needsUpdate = true;
  dirty = true;
}
function changed(live) {
  syncPairs(live);
  paintTex(2048);
  clearTimeout(hiTimer);
  if (!live && HI > 2048) hiTimer = setTimeout(() => paintTex(HI), 350);
  drawPattern(); if (!live) { syncPanel(); record(); }
}

// ---------- отмена и повтор ----------
// Снимок — цвет ткани и слои (картинки по ссылке). При смене модели история начинается заново:
// координаты слоёв привязаны к листу развёртки конкретной модели.
const HIST = { list: [], i: -1, lock: false };
const snapKey = (fabric, layers) => fabric + JSON.stringify(layers.map(({ src, _tint, ...r }) => r));
function record() {
  if (HIST.lock || !S.pieces.length) return;
  const layers = S.layers.map((L) => ({ ...L })), k = snapKey(S.fabric.id + S.fabric.hex, layers);
  const sel = S.sel ? S.sel.id : null, picks = S.picks.map((L) => L.id);
  if (HIST.i >= 0 && HIST.list[HIST.i].k === k) { Object.assign(HIST.list[HIST.i], { sel, picks }); return; }
  HIST.list.length = HIST.i + 1;
  HIST.list.push({ fabric: S.fabric.id, hex: S.fabric.hex, layers, sel, picks, k });
  if (HIST.list.length > 80) HIST.list.shift();
  HIST.i = HIST.list.length - 1; syncHist();
}
function stepHist(d) {
  const t = HIST.i + d;
  if (t < 0 || t >= HIST.list.length) return;
  HIST.i = t; const h = HIST.list[t];
  HIST.lock = true;
  S.layers = h.layers.map((L) => ({ ...L }));
  S.picks = S.layers.filter((L) => h.picks.includes(L.id));
  S.sel = S.layers.find((L) => L.id === h.sel) || S.picks[S.picks.length - 1] || null;
  if (h.fabric === "own") { OWN.hex = h.hex; OWN.set = true; }
  setFabric(h.fabric, true);
  HIST.lock = false; syncHist();
}
// выбор запоминается в текущем шаге истории: после отмены выбранным остаётся то же, что было в тот момент
function markSel() { const h = HIST.list[HIST.i]; if (h) { h.sel = S.sel ? S.sel.id : null; h.picks = S.picks.map((L) => L.id); } }
function resetHist() { HIST.list = []; HIST.i = -1; record(); }
function syncHist() { $("undo").disabled = HIST.i <= 0; $("redo").disabled = HIST.i >= HIST.list.length - 1; }

// ---------- плоский вид ----------
const pat = $("pat"), pg = pat.getContext("2d");
let V = { k: 1, ox: 0, oy: 0 };
const TABS = { all: null, body: "body", sleeves: "sleeve", trim: "trim" };
const shown = (p) => !TABS[S.tab] || p.kind === TABS[S.tab];
function viewBox() {
  let ps = TABS[S.tab] ? S.pieces.filter((p) => p.kind === TABS[S.tab]) : S.pieces;
  if (!ps.length) ps = S.pieces;
  const x0 = Math.min(...ps.map((p) => p.x0)), x1 = Math.max(...ps.map((p) => p.x1));
  const y0 = Math.min(...ps.map((p) => p.y0)), y1 = Math.max(...ps.map((p) => p.y1));
  const m = S.tab === "trim" ? 3 : 5;
  return [x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m + 4];
}
function paintFlat(g, W, H, ui) {
  const [vx, vy, vw, vh] = viewBox(), k = Math.min(W / vw, H / vh);
  const ox = (W - vw * k) / 2 - vx * k, oy = (H - vh * k) / 2 - vy * k;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#1d1e22"; g.fillRect(0, 0, W, H);
  g.setTransform(k, 0, 0, k, ox, oy);
  const px = 1 / k;
  const ps = S.pieces.filter(shown);
  ps.forEach((p) => { tracePiece(g, p); g.fillStyle = S.fabric.hex; g.fill(); });
  S.layers.forEach((L) => drawLayer(g, L));
  const light = lum(S.fabric.hex) < 0.3;
  ps.forEach((p) => {
    tracePiece(g, p); g.lineWidth = 1.2 * px; g.strokeStyle = light ? "rgba(255,255,255,.34)" : "rgba(0,0,0,.5)"; g.stroke();
    g.fillStyle = "rgba(241,239,232,.62)"; g.textBaseline = "top";
    if (p.kind === "trim") {               // узкие полосы стоят стопкой — подпись справа от полосы, в одну строку
      if (S.tab === "all" && S.pieces.filter((q) => q.kind === "trim").length > 2) return;   // на общем виде им тесно
      g.textAlign = "left"; g.textBaseline = "middle"; g.font = `700 ${10 * px}px "Gotham Pro", Arial, sans-serif`;
      g.fillText(`${p.name} · ${fmt(p.w)} × ${fmt(p.h)} см`, p.x1 + 8 * px, (p.y0 + p.y1) / 2);
      return;
    }
    g.textAlign = "center";
    // Подпись не шире своей детали. Текст рисуется постоянным экранным кеглем, а детали в маленьком окне мельче него:
    // подписи соседних рукавов слипались и ложились на кайму. Кегль ужимается до 8 px, а если и так не помещается —
    // строка не рисуется; на низкой детали остаётся одно название, без строки размеров.
    const room = p.x1 - p.x0 - 8 * px, tall = (p.y1 - p.y0) * k >= 64;
    const fits = (text, size, weight) => {
      const font = (s) => { g.font = `${weight} ${s * px}px "Gotham Pro", Arial, sans-serif`; return g.measureText(text).width; };
      const w = font(size);
      return w <= room || font(Math.max(8, (size * room) / w)) <= room + px;
    };
    // подпись стоит внутри детали у нижнего края: на листе детали лежат вплотную
    const ly = p.kind === "sleeve" ? p.y0 + (p.y1 - p.y0) * (tall ? 0.42 : 0.3) : p.y1 - (tall ? 30 : 18) * px;   // у рукава внизу обычно кайма
    g.fillStyle = light ? "rgba(241,239,232,.62)" : "rgba(13,13,13,.6)";
    if (fits(p.name, 11, 700)) g.fillText(p.name, (p.x0 + p.x1) / 2, ly);
    if (!tall) return;
    g.fillStyle = light ? "rgba(241,239,232,.4)" : "rgba(13,13,13,.42)";
    const dims = `${fmt(p.w)} × ${fmt(p.h)} см`;
    if (fits(dims, 10, 400)) g.fillText(dims, (p.x0 + p.x1) / 2, ly + 14 * px);
  });
  if (ui) {
    const group = S.picks.length > 1;
    const frame = (L, main, dash) => {
      const b = box(L);
      g.save(); g.translate(b.x, b.y); g.rotate((b.rot * Math.PI) / 180);
      g.strokeStyle = "#ffd400"; g.lineWidth = (main ? 1.5 : 1) * px;
      if (dash) g.setLineDash([5 * px, 4 * px]);
      g.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h); g.setLineDash([]);
      if (main && !group) {          // ручки размера и поворота — только у одного выбранного
        g.fillStyle = "#ffd400";
        const hs = 4.5 * px;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.fillRect((sx * b.w) / 2 - hs, (sy * b.h) / 2 - hs, hs * 2, hs * 2);
        if (L.type !== "band") { g.beginPath(); g.moveTo(0, -b.h / 2); g.lineTo(0, -b.h / 2 - 20 * px); g.stroke(); g.beginPath(); g.arc(0, -b.h / 2 - 20 * px, 5 * px, 0, 7); g.fill(); }
      }
      g.restore();
    };
    S.picks.forEach((L) => { if (shown(piece(L.piece))) frame(L, L === S.sel, group && L !== S.sel); });
    const T = !group && partner(S.sel);                       // пара на втором рукаве — пунктиром
    if (T && shown(piece(T.piece))) frame(T, false, true);
    if (!group && S.sel) for (const w of wrapsOf(S.sel)) {       // куда нанесение продолжается через шов — пунктиром
      if (!w.cross || !shown(w.to)) continue;
      g.save(); tracePiece(g, w.to); g.clip(); seamT(g, w);
      g.translate(S.sel.x, S.sel.y); g.rotate((S.sel.rot * Math.PI) / 180);
      g.strokeStyle = "rgba(255,212,0,.8)"; g.lineWidth = px; g.setLineDash([5 * px, 4 * px]);
      g.strokeRect(-S.sel.w / 2, -S.sel.h / 2, S.sel.w, S.sel.h);
      g.restore();
    }
    if (!group && S.sel && shown(piece(S.sel.piece))) {
      const L = S.sel, b = box(L);
      const txt = L.type === "band" ? `высота ${fmt(L.h)} см` : `${fmt(L.w)} × ${fmt(L.h)} см`;
      g.font = `700 ${11 * px}px "Gotham Pro", Arial, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      const ty = Math.min(b.y + extent(b, L, px)[1] + 14 * px, vy + vh - 10 * px);
      const tw = g.measureText(txt).width + 14 * px;
      g.fillStyle = "#ffd400"; g.beginPath(); g.roundRect(b.x - tw / 2, ty - 9 * px, tw, 18 * px, 9 * px); g.fill();
      g.fillStyle = "#0d0d0d"; g.fillText(txt, b.x, ty + px);
    }
  }
  return { k, ox, oy };
}
// сколько рамка (вместе с ручкой поворота) занимает вверх и вниз от центра, в сантиметрах
function extent(b, L, px) {
  const a = (b.rot * Math.PI) / 180, hh = (Math.abs(b.w * Math.sin(a)) + Math.abs(b.h * Math.cos(a))) / 2;
  const knob = L.type === "band" ? 0 : (b.h / 2 + 26 * px) * Math.cos(a);
  return [Math.max(hh, knob), Math.max(hh, -knob)];
}
function box(L) {
  if (L.type !== "band") return L;
  const p = piece(L.piece);
  return { x: (p.x0 + p.x1) / 2, y: L.y, w: p.x1 - p.x0, h: L.h, rot: 0 };
}
function drawPattern() {
  const r = pat.parentElement.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
  if (pat.width !== W || pat.height !== H) { pat.width = W; pat.height = H; }
  V = paintFlat(pg, W, H, true); V.d = d;
  placeTools();
}
// панель управления стоит над рамкой выбранного (или над всей группой); если сверху нет места — под ней
function placeTools() {
  const el = $("tools2d"), ps = S.picks.filter((L) => shown(piece(L.piece)));
  if (!ps.length || drag) { el.style.visibility = "hidden"; return; }
  const k = V.k / V.d, W = pat.clientWidth, H = pat.clientHeight, tw = el.offsetWidth, th = el.offsetHeight || 40;
  let top = 1e9, bot = -1e9, xl = 1e9, xr = -1e9;
  ps.forEach((L) => {
    const b = box(L), [up, down] = extent(b, L, 1 / k), cx = b.x * k + V.ox / V.d, cy = b.y * k + V.oy / V.d;
    top = Math.min(top, cy - up * k); bot = Math.max(bot, cy + down * k); xl = Math.min(xl, cx); xr = Math.max(xr, cx);
  });
  let y = top - 12 - th;
  if (y < 6) y = Math.min(H - th - 6, bot + (ps.length > 1 ? 12 : 34));
  el.style.transform = `translate(${Math.round(Math.max(6, Math.min(W - tw - 6, (xl + xr) / 2 - tw / 2)))}px, ${Math.round(y)}px)`;
  el.style.visibility = "visible";
}
const toCm = (e) => { const r = pat.getBoundingClientRect(); return [((e.clientX - r.left) * V.d - V.ox) / V.k, ((e.clientY - r.top) * V.d - V.oy) / V.k]; };

let drag = null;
pat.addEventListener("pointerdown", (e) => {
  const [x, y] = toCm(e), px = V.d / V.k;
  let mode = null, L = S.sel;
  if (L && !many() && !e.shiftKey) {
    const b = box(L), a = (-b.rot * Math.PI) / 180, dx = x - b.x, dy = y - b.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (L.type !== "band" && Math.hypot(lx, ly + b.h / 2 + 20 * px) < 11 * px) mode = "rot";
    else if (Math.abs(Math.abs(lx) - b.w / 2) < 9 * px && Math.abs(Math.abs(ly) - b.h / 2) < 9 * px) mode = "size";
  }
  if (!mode) {
    const hit = hitLayer(x, y, true);
    if (e.shiftKey) { select(hit, true); return; }                 // Shift + клик: добавить к выбранным или убрать
    if (hit && many() && S.picks.includes(hit)) L = hit;            // нажали на одно из выбранных — тащим всю группу
    else { select(hit); L = hit; }
    if (L) mode = "move";
  }
  if (!mode) return;
  pat.setPointerCapture(e.pointerId);
  drag = { mode, L, x, y, w: L.w, h: L.h, d0: Math.hypot(x - box(L).x, y - L.y) || 1,
    items: (mode === "move" ? S.picks : [L]).map((q) => ({ L: q, x: q.x, y: q.y })) };
});
pat.addEventListener("pointermove", (e) => {
  if (!drag) { const [x, y] = toCm(e); pat.style.cursor = hitLayer(x, y, true) ? "move" : "default"; return; }
  const [x, y] = toCm(e), L = drag.L;
  if (drag.mode === "move") { drag.moved = true; drag.items.forEach((it) => dragTo(it, x - drag.x, y - drag.y)); }
  else if (drag.mode === "rot") { let a = (Math.atan2(y - L.y, x - L.x) * 180) / Math.PI + 90; a = Math.round(a / 5) * 5; L.rot = ((a + 540) % 360) - 180; }
  else if (L.type === "band") { L.h = Math.min(piece(L.piece).h, Math.max(0.6, Math.abs(y - L.y) * 2)); moveTo(L, L.x, L.y); }
  else resize(L, Math.max(1, (drag.w * Math.hypot(x - L.x, y - L.y)) / drag.d0));
  changed(true); syncProps();
});
// Слой тащат по выкройке. Когда его середина заходит на соседнюю по шву деталь, он переезжает на неё тем же местом
// на изделии: на листе рамка сдвигается на зазор между деталями, зато на модели нанесение не прыгает.
function dragTo(it, dx, dy) {
  const L = it.L, nx = it.x + dx, ny = it.y + dy;
  if (L.type === "band") { moveTo(L, nx, ny); return; }
  const at = pieceAt(nx, ny);
  if (at && at.id !== L.piece) {
    const far = (q) => Math.hypot(L.x + q.dx - nx, L.y + q.dy - ny);          // из нескольких швов — тот, что меньше сдвигает рамку
    const w = wrapsOf(L).filter((q) => q.to === at).sort((m, n) => far(m) - far(n))[0];
    if (w) { carry(L, w); it.x = L.x - dx; it.y = L.y - dy; return; }
    L.piece = at.id;
  }
  L.x = nx; L.y = ny;
}
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === "move" && !d.moved && many()) select(d.L);        // простой клик по одному из группы оставляет выбранным только его
  changed();
};
pat.addEventListener("pointerup", endDrag); pat.addEventListener("pointercancel", endDrag);
function resize(L, w) {
  if (L.type === "band") { L.h = w; moveTo(L, L.x, L.y); return; }
  const r = L.h / L.w; L.w = w; L.h = w * r;
}

// ---------- 3D ----------
const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
cam.position.set(0.72, 0.5, 2.12);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a44, 1.5));
const key = new THREE.DirectionalLight(0xfff4e6, 2.6); key.position.set(1.6, 2.2, 2.4); scene.add(key);
const rim = new THREE.DirectionalLight(0xcfe0ff, 1.7); rim.position.set(-2.2, 1.2, -2.0); scene.add(rim);
const fill = new THREE.DirectionalLight(0xffffff, 0.7); fill.position.set(-1.6, 0.4, 2.2); scene.add(fill);

// нанесение можно тащить прямо по ткани: этот обработчик стоит раньше управления камерой
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  if (!model) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const h = ray.intersectObject(model, false)[0];
  return h && h.uv ? fromUV(h.uv.x * S.A, h.uv.y * S.A) : null;
}
let grab = null, controls = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  const p = pick(e), L = p && hitLayer(p[0], p[1]);
  if (!L) return;
  const via = hitWrap;
  if (e.shiftKey) { select(L, true); grab = { L: null }; }          // Shift + клик по ткани: добавить к выбранным или убрать
  else {
    if (via) carry(L, via);                                         // взяли за продолжение на соседней детали — слой становится её слоем
    select(L); grab = { L, dx: L.x - p[0], dy: L.y - p[1] };
  }
  controls.enabled = false; renderer.domElement.setPointerCapture(e.pointerId);
  $("hint").hidden = true;
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!grab) { if (e.buttons === 0) { const p = pick(e); renderer.domElement.classList.toggle("over", !!(p && hitLayer(p[0], p[1]))); } return; }
  if (!grab.L) return;
  const p = pick(e);
  if (!p) return;
  const at = pieceAt(p[0], p[1]), L = grab.L;
  if (L.type === "band") {
    if (at && at.id !== L.piece) { grab.dx = 0; grab.dy = 0; }
    moveTo(L, p[0] + grab.dx, p[1] + grab.dy);
  } else {
    if (at && at.id !== L.piece) {
      // Указатель ушёл через шов на соседнюю деталь. Если слой сам лежит на этом шве, он едет дальше тем же местом
      // под указателем (смещение захвата сохраняется). Иначе — не соседи по шву или плечо — слой встаёт под указатель.
      if (!wrapsOf(L).some((q) => q.to === at)) { grab.dx = 0; grab.dy = 0; }
      L.piece = at.id;
    }
    L.x = p[0] + grab.dx; L.y = p[1] + grab.dy;
  }
  changed(true); syncProps();
});
const endGrab = () => {
  if (!grab) return;
  grab = null; controls.enabled = true; changed();
};
renderer.domElement.addEventListener("pointerup", endGrab); renderer.domElement.addEventListener("pointercancel", endGrab);

controls = new OrbitControls(cam, renderer.domElement);
controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 0.5; controls.maxDistance = 3.6; controls.target.set(0, 0.3, 0);
controls.minPolarAngle = 0.25; controls.maxPolarAngle = 2.2;
controls.addEventListener("change", () => { dirty = true; });
controls.addEventListener("start", () => { renderer.domElement.classList.add("drag"); flyTo = null; });
controls.addEventListener("end", () => renderer.domElement.classList.remove("drag"));

function knit() {                         // мелкая вязка: карта нормалей из простого поля высот
  const n = 128, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"), im = g.createImageData(n, n);
  const hf = (x, y) => { const col = Math.floor(x / 8), u = (x % 8) / 8; return Math.sqrt(Math.abs(Math.sin(Math.PI * u))) * (0.7 + 0.3 * Math.sin(2 * Math.PI * (y / 8 + (col % 2) * 0.5))); };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = hf((x + 1) % n, y) - hf((x + n - 1) % n, y), dy = hf(x, (y + 1) % n) - hf(x, (y + n - 1) % n);
    const l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
    im.data[i] = (-dx / l * 0.5 + 0.5) * 255; im.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255; im.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(110, 110);
  return t;
}
let inner = null, mats = null;
function build(geo) {
  if (!mats) {
    tex = new THREE.CanvasTexture(texCv);
    tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    mats = [new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0, normalMap: knit(), normalScale: new THREE.Vector2(0.16, 0.16) }),
      new THREE.MeshStandardMaterial({ color: S.fabric.hex, roughness: 1, side: THREE.BackSide })];
  }
  mats[0].normalMap.repeat.set(S.A * 0.75, S.A * 0.75);          // вязка одного размера на любой модели
  if (model) scene.remove(model, inner);
  model = new THREE.Mesh(geo, mats[0]); inner = new THREE.Mesh(geo, mats[1]);
  scene.add(model, inner);
  controls.target.set(0, S.H * 0.5, 0);
  setFabric(S.fabric.id);
}
const OWN = { id: "own", name: "Свой цвет", hex: "#7d8791", set: false };      // свой цвет ткани из палитры
function setFabric(id, asIs, live) {
  S.fabric = id === "own" ? OWN : FABRICS.find((f) => f.id === id) || FABRICS[0];
  if (inner) inner.material.color.set(S.fabric.hex).multiplyScalar(0.42);
  // белое и чёрное нанесение переворачивается вслед за тканью, чтобы не пропасть на ней
  // (при отмене шага слои уже лежат в нужных цветах — asIs)
  const ink = defaultInk();
  if (!asIs) S.layers.forEach((L) => { if (L.ink === "#ffffff" || L.ink === "#0d0d0d") L.ink = ink; });
  [...$("fabric").children].forEach((b) => b.classList.toggle("on", b.dataset.id === S.fabric.id));
  const own = $("fabric").querySelector(".own");
  own.classList.toggle("set", OWN.set); own.style.setProperty("--c", OWN.hex);
  changed(live);
}

let flyTo = null;
const VIEWS = { front: 0.32, back: Math.PI - 0.32, left: Math.PI / 2, right: -Math.PI / 2 };
function fly(name) {
  const d = Math.max(1.9, Math.min(3.0, cam.position.distanceTo(controls.target)));
  flyTo = { az: VIEWS[name], d, y: S.H * (name === "left" || name === "right" ? 0.86 : 0.7) };
  [...$("views").children].forEach((b) => b.classList.toggle("on", b.dataset.view === name));
}
function tick() {
  requestAnimationFrame(tick);
  if (flyTo) {
    const o = cam.position.clone().sub(controls.target), az = Math.atan2(o.x, o.z), r = Math.hypot(o.x, o.z);
    let da = flyTo.az - az; da = Math.atan2(Math.sin(da), Math.cos(da));
    const na = az + da * 0.12, nr = r + (flyTo.d - r) * 0.12, ny = cam.position.y + (flyTo.y - cam.position.y) * 0.12;
    cam.position.set(controls.target.x + Math.sin(na) * nr, ny, controls.target.z + Math.cos(na) * nr);
    if (Math.abs(da) < 0.004 && Math.abs(flyTo.d - r) < 0.004) flyTo = null;
    dirty = true;
  }
  controls.update();
  if (dirty) { dirty = false; renderer.render(scene, cam); }
}
function fit() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  cam.aspect = r.width / r.height; cam.fov = r.width < r.height * 0.8 ? 36 : r.width < 560 ? 33 : 28;
  // на узком экране заголовок и панель кнопок лежат поверх сцены — изделие сдвигается в свободную середину
  if (r.width < 560) cam.setViewOffset(r.width, r.height, 0, -r.height * 0.07, r.width, r.height); else cam.clearViewOffset();
  cam.updateProjectionMatrix();
  dirty = true; drawPattern();
}
new ResizeObserver(fit).observe(stage); new ResizeObserver(drawPattern).observe(pat.parentElement);

// ---------- панель ----------
// S.sel — главный выбранный слой, S.picks — все выбранные (Shift + клик добавляет и убирает)
function select(L, add) {
  if (add) {
    if (!L) return;
    const i = S.picks.indexOf(L);
    if (i >= 0) { S.picks.splice(i, 1); S.sel = S.picks[S.picks.length - 1] || null; } else { S.picks.push(L); S.sel = L; }
  } else {
    if (S.sel === L && S.picks.length < 2) return;
    S.sel = L; S.picks = L ? [L] : [];
  }
  markSel(); syncPanel(); drawPattern();
}
const many = () => S.picks.length > 1;

// ---------- второй рукав: пара «выровнять» или «зеркало» ----------
// У слоя на рукаве может быть пара на втором рукаве (link — её id, pair — режим). Пара повторяет слой:
// то же расстояние от низа рукава и то же смещение к переду изделия. «Выровнять» — картинка как есть,
// «зеркало» — отражённая, с обратным поворотом. Меняется вместе с выбранным слоем.
const partner = (L) => (L && L.link ? S.layers.find((x) => x.id === L.link) : null);
const onSleeve = (L) => { const q = piece(L.piece); return !!q && q.kind === "sleeve" && !!piece(q.twin); };
function mirrorTo(L, T) {
  const a = piece(L.piece), b = piece(a.twin), mir = L.pair === "mirror";
  const { id, link, piece: _p, x, y, rot, flip, hidden, _tint, _ink, ...same } = L;
  Object.assign(T, same, { piece: b.id, link: L.id,
    x: (b.x0 + b.x1) / 2 + (L.x - (a.x0 + a.x1) / 2) * a.fx * b.fx,
    y: hemY(b) - hemS(b) * hemS(a) * (hemY(a) - L.y),
    rot: mir ? -L.rot : L.rot, flip: mir ? !L.flip : !!L.flip });
  if (T.type === "band") { T.h = Math.min(T.h, b.y1 - b.y0); T.x = (b.x0 + b.x1) / 2; T.y = Math.min(b.y1 - T.h / 2, Math.max(b.y0 + T.h / 2, T.y)); }
}
function setPair(L, mode) {
  let T = partner(L);
  if (!mode) { if (T) ACTS.del(T); L.link = null; L.pair = null; return; }      // «нет» убирает копию со второго рукава
  if (!onSleeve(L)) return;
  L.pair = mode;
  if (!T) { T = { id: S.seq++ }; S.layers.splice(S.layers.indexOf(L) + 1, 0, T); L.link = T.id; }
  mirrorTo(L, T);
}
function syncPairs(live) {
  const done = new Set();
  for (const L of [S.sel, ...S.picks]) {
    if (!L || !L.link || done.has(L.id)) continue;
    const T = partner(L);
    if (!T) { L.link = null; L.pair = null; continue; }
    if (onSleeve(L)) { mirrorTo(L, T); done.add(L.id); done.add(T.id); }
    else if (!live) { L.link = T.link = null; L.pair = T.pair = null; }       // слой унесли с рукава — пара распадается, оба остаются
  }
}

// ---------- выравнивание нескольких выбранных ----------
// Рамки считаются от своей детали: по горизонтали — от её середины, по вертикали — от верха (у рукавов — от низа).
// Поэтому на разных деталях «по верху» значит на одной высоте, а на двух рукавах смещение считается к переду изделия.
function relBox(L, ref) {
  const q = piece(L.piece), a = (L.rot * Math.PI) / 180, band = L.type === "band", sl = q.kind === "sleeve", both = sl && ref.kind === "sleeve";
  const hw = band ? (q.x1 - q.x0) / 2 : (Math.abs(L.w * Math.cos(a)) + Math.abs(L.h * Math.sin(a))) / 2;
  const hh = band ? L.h / 2 : (Math.abs(L.w * Math.sin(a)) + Math.abs(L.h * Math.cos(a))) / 2;
  const sx = both ? q.fx * ref.fx : 1, sy = both ? hemS(q) * hemS(ref) : 1, oy = sl ? hemY(q) : q.y0;
  return { L, q, band, hw, hh, sx, sy, oy, cx: (L.x - (q.x0 + q.x1) / 2) * sx, cy: (L.y - oy) * sy };
}
function alignPicks(name) {
  if (!many()) return;
  const ref = piece((S.sel || S.picks[0]).piece), all = S.picks.map((L) => relBox(L, ref));
  const horiz = /^(alignL|alignCx|alignR|distH)$/.test(name), set = horiz ? all.filter((b) => !b.band) : all;
  if (set.length < 2) return;
  const c = horiz ? "cx" : "cy", h = horiz ? "hw" : "hh";
  const lo = Math.min(...set.map((b) => b[c] - b[h])), hi = Math.max(...set.map((b) => b[c] + b[h]));
  if (name === "alignL" || name === "alignT") set.forEach((b) => { b[c] = lo + b[h]; });
  else if (name === "alignR" || name === "alignB") set.forEach((b) => { b[c] = hi - b[h]; });
  else if (name === "alignCx" || name === "alignCy") set.forEach((b) => { b[c] = (lo + hi) / 2; });
  else {                                   // распределить: крайние стоят на месте, промежутки между остальными равные
    if (set.length < 3) return;
    set.sort((m, n) => m[c] - n[c]);
    const gap = (hi - lo - set.reduce((sum, b) => sum + 2 * b[h], 0)) / (set.length - 1);
    let cur = lo;
    set.forEach((b) => { b[c] = cur + b[h]; cur += 2 * b[h] + gap; });
  }
  set.forEach((b) => {
    b.L.x = (b.q.x0 + b.q.x1) / 2 + b.cx * b.sx; b.L.y = b.oy + b.cy * b.sy;
    if (b.band) { b.L.x = (b.q.x0 + b.q.x1) / 2; b.L.y = Math.min(b.q.y1 - b.L.h / 2, Math.max(b.q.y0 + b.L.h / 2, b.L.y)); }
  });
}

// ---------- кнопки управления нанесением ----------
const IC = {
  del: "M6 6l12 12M18 6L6 18", dup: "M9 9h11v11H9zM5 15H4V4h11v1", minus: "M5 12h14", plus: "M12 5v14M5 12h14",
  rotL: "M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8M3 3v5h5", rotR: "M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8M21 3v5h-5",
  flip: "M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4", center: "M12 3v18M6 8h12v8H6z",
  up: "M12 19V5M6 11l6-6 6 6", down: "M12 5v14M6 13l6 6 6-6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  eyeOff: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 4l16 16",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11", redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  alignL: "M4 3v18M8 6h11v4H8zM8 14h6v4H8z", alignCx: "M12 3v18M6 6h12v4H6zM8.5 14h7v4h-7z", alignR: "M20 3v18M5 6h11v4H5zM10 14h6v4h-6z",
  alignT: "M3 4h18M6 8h4v11H6zM14 8h4v6h-4z", alignCy: "M3 12h18M6 6h4v12H6zM14 8.5h4v7h-4z", alignB: "M3 20h18M6 5h4v11H6zM14 10h4v6h-4z",
  distH: "M4 3v18M20 3v18M10 7h4v10h-4z", distV: "M3 4h18M3 20h18M7 10h10v4H7z",
  ink: "M12 3s6.5 6.8 6.5 11.2a6.5 6.5 0 0 1-13 0C5.5 9.8 12 3 12 3z",
  pairAlign: "M12 3v18M3 9h5M6 7l2 2-2 2M16 9h5M19 7l2 2-2 2M4 14h4v4H4zM16 14h4v4h-4z",
  pairMirror: "M12 3v18M9 8H4l5 9zM15 8h5l-5 9z",
};
const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const btn = (act, title, ic = act, off = false) => `<button type="button" data-act="${act}" title="${title}" aria-label="${title}"${off ? " disabled" : ""}>${icon(ic)}</button>`;
const TITLES = { minus: "Меньше", plus: "Больше", rotL: "Повернуть влево на 15°", rotR: "Повернуть вправо на 15°", flip: "Отразить зеркально", center: "Поставить по центру детали", dup: "Дублировать", del: "Удалить", ink: "Перекрасить: залить своим цветом",
  alignL: "Выровнять по левому краю", alignCx: "Выровнять по центру", alignR: "Выровнять по правому краю",
  alignT: "Выровнять по верхнему краю", alignCy: "Выровнять по середине", alignB: "Выровнять по нижнему краю",
  distH: "Распределить по горизонтали", distV: "Распределить по вертикали",
  pairAlign: "Второй рукав: выровнять (та же картинка в том же месте)", pairMirror: "Второй рукав: зеркало (отражённая картинка)" };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function scaleLayer(L, k) {
  if (L.type === "text") { L.h = clamp(L.h * k, 0.8, 40); fitText(L); }
  else if (L.type === "band") { L.h = clamp(L.h * k, 0.6, piece(L.piece).h); moveTo(L, L.x, L.y); }
  else resize(L, clamp(L.w * k, 1, 90));
}
const ACTS = {
  del(L) {
    const T = partner(L);
    if (T) { T.link = null; T.pair = null; }                       // пара остаётся на своём рукаве самостоятельным слоем
    S.layers = S.layers.filter((x) => x !== L); S.picks = S.picks.filter((x) => x !== L);
    if (S.sel === L) S.sel = S.picks[S.picks.length - 1] || null;
  },
  dup(L) {
    const { id, _tint, _ink, link, pair, ...rest } = L;
    const a = piece(L.piece), b = piece(a.twin) || a, twin = b.id;
    // копия встаёт на парную деталь в то же место: кайма на втором рукаве, знак на спине
    const c = { ...rest, id: S.seq++, piece: twin, x: (b.x0 + b.x1) / 2 + (L.x - (a.x0 + a.x1) / 2), y: b.y0 + (L.y - a.y0) };
    if (c.type === "band") c.y = b.y1 - (a.y1 - L.y);
    if (a === b) { c.x += 3; c.y += c.type === "band" ? -c.h * 1.4 : 3; }      // парной детали нет — копия рядом
    S.layers.push(c); S.sel = c; S.picks = [c]; look(twin);
  },
  pairAlign(L) { setPair(L, L.pair === "align" ? null : "align"); },
  pairMirror(L) { setPair(L, L.pair === "mirror" ? null : "mirror"); },
  minus(L) { scaleLayer(L, 1 / 1.1); }, plus(L) { scaleLayer(L, 1.1); },
  rotL(L) { L.rot = ((L.rot - 15 + 540) % 360) - 180; }, rotR(L) { L.rot = ((L.rot + 15 + 540) % 360) - 180; },
  flip(L) { L.flip = !L.flip; },
  center(L) { const q = piece(L.piece); L.x = (q.x0 + q.x1) / 2; },
  up(L) { const i = S.layers.indexOf(L); if (i < S.layers.length - 1) { S.layers.splice(i, 1); S.layers.splice(i + 1, 0, L); } },
  down(L) { const i = S.layers.indexOf(L); if (i > 0) { S.layers.splice(i, 1); S.layers.splice(i - 1, 0, L); } },
  eye(L) { L.hidden = !L.hidden; },
};
function act(name, L) {
  if (/^(align|dist)/.test(name)) { alignPicks(name); changed(); return; }
  if (!L && name === "del" && many()) { S.picks.slice().forEach(ACTS.del); changed(); return; }
  L = L || S.sel;
  if (!L || !ACTS[name]) return;
  ACTS[name](L); changed();
}
let toolsKind = "";
const ALIGN = ["alignL", "alignCx", "alignR", "distH", "alignT", "alignCy", "alignB", "distV"];
function syncTools() {
  const L = S.sel, n = S.picks.length, t2 = $("tools2d"), t3 = $("tools3d");
  t2.hidden = t3.hidden = !L;
  if (!L) return;
  const ownOrn = L.type === "band" && ORNS[L.orn].own;         // у фирменной линии свои цвета — её не перекрашивают
  const sl = n < 2 && onSleeve(L), kind = n > 1 ? "many" + Math.min(n, 3) : L.type + (sl ? "+" : "") + (ownOrn ? "o" : "");
  if (toolsKind !== kind) {
    toolsKind = kind;
    const list = n > 1 ? ["alignL", "alignCx", "alignR", "alignT", "alignCy", "alignB", ...(n > 2 ? ["distH", "distV"] : []), "del"]
      : [...(L.type === "band" ? ["minus", "plus"] : ["minus", "plus", "rotL", "rotR", "flip", "center"]), ...(ownOrn ? [] : ["ink"]), ...(sl ? ["pairAlign", "pairMirror"] : []), "dup", "del"];
    const html = list.map((a) => btn(a, TITLES[a])).join("");
    t2.innerHTML = html; t3.innerHTML = '<span id="toolsName"></span>' + html;
  }
  $("toolsName").textContent = n > 1 ? `Выбрано: ${n}` : nameOf(L);
  for (const b of document.querySelectorAll('.mk-tools [data-act^="pair"]')) b.classList.toggle("on", L.pair === (b.dataset.act === "pairAlign" ? "align" : "mirror"));
}
for (const id of ["tools2d", "tools3d", "multi"]) $(id).addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b && b.dataset.act === "ink") inkPalette(b); else if (b) act(b.dataset.act);
});
// заливка выбранного нанесения своим цветом: картинка красится целиком, форма и прозрачность остаются
function inkPalette(anchor) {
  const L = S.sel;
  if (!L) return;
  const t = L.type === "img" ? toneOf(L.src) : null;
  const from = L.ink || (t ? "#" + t.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : defaultInk());
  openPicker(anchor, from, (hex) => { L.ink = hex; changed(true); }, (hex) => { L.ink = hex; changed(); });
}
$("pFadeFix").onclick = () => { if (S.sel) { S.sel.ink = defaultInk(); changed(); } };
function syncProps() {
  const L = S.sel;
  if (!L) return;
  const size = L.type === "band" ? L.h : L.type === "text" ? L.h : L.w;
  $("pSize").max = L.type === "band" ? 20 : L.type === "text" ? 30 : 70;
  $("pSize").value = size; $("pSizeOut").textContent = fmt(size) + " см";
  $("pRot").value = L.rot; $("pRotOut").textContent = Math.round(L.rot) + "°";
  $("pPiece").value = L.piece;
  renderLayers();
}
$("multiAlign").innerHTML = ALIGN.map((a) => btn(a, TITLES[a])).join("");
$("pWrap").onclick = (e) => { const b = e.target.closest("button"); if (b && S.sel) { S.sel.wrap = !!b.dataset.wrap; changed(); } };
$("pPair").onclick = (e) => { const b = e.target.closest("button"); if (b && S.sel) { setPair(S.sel, b.dataset.pair || null); changed(); } };
function syncPanel() {
  const L = S.sel, n = S.picks.length;
  $("props").hidden = !L || n > 1; $("multi").hidden = n < 2; syncTools();
  if (n > 1) {
    $("multiTitle").textContent = `Выбрано: ${n}`;
    for (const b of $("multiAlign").querySelectorAll('[data-act^="dist"]')) b.disabled = n < 3;
    renderLayers();
    return;
  }
  if (L) {
    const sl = onSleeve(L);
    [...$("pWrap").children].forEach((b) => b.classList.toggle("on", (L.wrap !== false) === !!b.dataset.wrap));
    $("pPairRow").hidden = !sl;
    if (sl) [...$("pPair").children].forEach((b) => b.classList.toggle("on", (L.pair || "") === b.dataset.pair));
    $("propsTitle").textContent = KIND[L.type];
    document.querySelectorAll("#props [data-for]").forEach((el) => { const f = el.dataset.for; el.hidden = f === "free" ? L.type === "band" : f !== L.type; });
    $("pSizeName").textContent = L.type === "img" ? "Ширина" : "Высота";
    $("pInkName").textContent = L.type === "img" ? "Заливка" : "Цвет";
    $("pFade").hidden = !fades(L);
    if (L.type === "text") { $("pText").value = L.text; $("pFont").value = L.font; }
    if (L.type === "band") $("pOrn").value = L.orn;
    const inks = [...$("pInk").querySelectorAll("button[data-ink]")], ownInk = !!L.ink && !inks.some((b) => b.dataset.ink === L.ink);
    inks.forEach((b) => b.classList.toggle("on", (L.ink || "") === b.dataset.ink));
    $("pInkOwn").classList.toggle("on", ownInk); $("pInkOwn").classList.toggle("set", ownInk); $("pInkOwn").style.setProperty("--c", L.ink || "#fff");
    syncProps();
  } else renderLayers();
}
const nameOf = (L) => (L.type === "text" ? `«${L.text}»` : L.type === "band" ? ORNS[L.orn].name : L.name || KIND.img);
// миниатюра 160 px: полноразмерная картинка в списке не нужна
function small(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, k = Math.min(1, 160 / Math.max(w, h, 1));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
const THUMBS = new WeakMap();
const thumbOf = (src) => { if (!THUMBS.has(src)) THUMBS.set(src, small(src)); return THUMBS.get(src); };
function renderLayers() {
  if (LIB.length) renderLib();
  const ol = $("layers"), n = S.layers.length;
  ol.innerHTML = n ? "" : '<li class="empty">Пока пусто — добавьте изображение, текст или кайму.</li>';
  $("clear").hidden = !n;
  [...S.layers].reverse().forEach((L, j) => {
    const i = n - 1 - j, li = document.createElement("li");
    li.className = (S.picks.includes(L) ? "on" : "") + (L.hidden ? " off" : ""); li.dataset.id = L.id;
    const t = document.createElement("span"); t.className = "lt";
    if (L.type === "img") { const im = document.createElement("img"); im.src = thumbOf(L.src); im.alt = ""; t.append(im); } else t.textContent = L.type === "text" ? "Aa" : "≋";
    const d = document.createElement("div"); d.className = "ln";
    const nm = document.createElement("b"); nm.textContent = nameOf(L);
    const sz = document.createElement("small"); sz.textContent = `${piece(L.piece).name} · ${L.type === "band" ? fmt(L.h) : fmt(L.w) + " × " + fmt(L.h)} см${L.link ? (L.pair === "mirror" ? " · зеркало" : " · в паре") : ""}`;
    d.append(nm, sz);
    const c = document.createElement("div"); c.className = "lb";
    c.innerHTML = btn("eye", L.hidden ? "Показать" : "Скрыть", L.hidden ? "eyeOff" : "eye") + btn("up", "Выше", "up", i === n - 1) + btn("down", "Ниже", "down", i === 0) + btn("del", "Удалить");
    li.append(t, d, c); ol.append(li);
  });
}
$("layers").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]"); if (!li) return;
  const L = S.layers.find((x) => x.id === +li.dataset.id), b = e.target.closest("button[data-act]");
  if (b) act(b.dataset.act, L); else if (e.shiftKey) select(L, true); else { select(L); look(L.piece); }
});
$("clear").onclick = () => { S.layers = []; S.sel = null; S.picks = []; changed(); };
$("undo").innerHTML = icon("undo"); $("redo").innerHTML = icon("redo");
$("undo").onclick = () => stepHist(-1); $("redo").onclick = () => stepHist(1);
const look = (pid) => fly((piece(pid) || {}).look || "front");

$("fabric").innerHTML = FABRICS.map((c) => `<button type="button" data-id="${c.id}" style="--c:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join("")
  + '<button type="button" data-id="own" class="own" title="Свой цвет" aria-label="Свой цвет ткани"></button>';
$("fabric").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.id !== "own") { setFabric(b.dataset.id); return; }
  // свой цвет: палитра открывается с текущим цветом ткани; ткань меняется, пока двигают ползунки
  openPicker(b, OWN.set ? OWN.hex : S.fabric.hex, (hex) => { OWN.hex = hex; OWN.set = true; setFabric("own", false, true); }, (hex) => { OWN.hex = hex; OWN.set = true; setFabric("own"); });
};

// ---------- палитра ----------
// Одна на всё: цвет ткани и цвет нанесения. Поле «тон и яркость», полоса оттенков, код цвета, пипетка (где браузер умеет)
// и недавние свои цвета. on(hex) зовётся, пока цвет меняют; done(hex) — один раз при закрытии, если цвет трогали.
const PK = { el: $("picker"), h: 0, s: 0, v: 1, on: null, done: null, anchor: null, touched: false, recent: [] };
try { PK.recent = JSON.parse(localStorage.getItem("izum-mk-colors") || "[]").filter((c) => /^#[0-9a-f]{6}$/.test(c)).slice(0, 8); } catch (e) { /* хранилище недоступно */ }
function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
function hsvToHex(h, s2, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s2 * Math.max(0, Math.min(k, 4 - k, 1)); };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
const pkHex = () => hsvToHex(PK.h, PK.s, PK.v);
function pkPaint(keepField) {
  const hex = pkHex(), sv = PK.el.querySelector(".pk-sv"), hue = PK.el.querySelector(".pk-hue");
  sv.style.setProperty("--hue", hsvToHex(PK.h, 1, 1));
  sv.firstElementChild.style.cssText = `left:${PK.s * 100}%;top:${(1 - PK.v) * 100}%;background:${hex}`;
  hue.firstElementChild.style.left = `${(PK.h / 360) * 100}%`;
  PK.el.querySelector(".pk-now").style.background = hex;
  if (!keepField) PK.el.querySelector(".pk-hex").value = hex.toUpperCase();
}
function pkSet(hex, keepField) { [PK.h, PK.s, PK.v] = hexToHsv(hex.toLowerCase()); PK.touched = true; pkPaint(keepField); if (PK.on) PK.on(pkHex()); }
function pkRecent() {
  const box = PK.el.querySelector(".pk-last");
  box.innerHTML = PK.recent.map((c) => `<button type="button" data-c="${c}" style="--c:${c}" title="${c.toUpperCase()}" aria-label="Недавний цвет ${c}"></button>`).join("");
  box.hidden = !PK.recent.length;
}
function openPicker(anchor, hex, on, done) {
  closePicker();
  Object.assign(PK, { on, done, anchor, touched: false });
  [PK.h, PK.s, PK.v] = hexToHsv(hex.toLowerCase());
  PK.el.hidden = false; pkRecent(); pkPaint();
  const r = anchor.getBoundingClientRect(), w = PK.el.offsetWidth, h = PK.el.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
  PK.el.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`;
  PK.el.style.top = `${Math.round(top)}px`;
}
function closePicker() {
  if (PK.el.hidden) return;
  PK.el.hidden = true;
  const hex = pkHex(), done = PK.done;
  PK.on = PK.done = PK.anchor = null;
  if (!PK.touched) return;
  PK.recent = [hex, ...PK.recent.filter((c) => c !== hex)].slice(0, 8);
  try { localStorage.setItem("izum-mk-colors", JSON.stringify(PK.recent)); } catch (e) { /* хранилище недоступно */ }
  if (done) done(hex);
}
for (const [cls, move] of [[".pk-sv", (x, y) => { PK.s = x; PK.v = 1 - y; }], [".pk-hue", (x) => { PK.h = x * 360; }]]) {
  const el = PK.el.querySelector(cls);
  const go = (e) => {
    const r = el.getBoundingClientRect();
    move(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    PK.touched = true; pkPaint(); if (PK.on) PK.on(pkHex());
  };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); go(e); });
  el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) go(e); });
}
PK.el.querySelector(".pk-hex").addEventListener("input", (e) => {
  const v = e.target.value.trim().replace(/^#?/, "#");
  if (/^#[0-9a-f]{6}$/i.test(v)) pkSet(v, true);
});
PK.el.querySelector(".pk-hex").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") closePicker(); });
PK.el.querySelector(".pk-last").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) pkSet(b.dataset.c); });
const pkDrop = PK.el.querySelector(".pk-drop");
pkDrop.hidden = !("EyeDropper" in window);
pkDrop.onclick = () => new window.EyeDropper().open().then((r) => pkSet(r.sRGBHex)).catch(() => 0);      // отказ пользователя — не ошибка
PK.el.querySelector(".pk-ok").onclick = closePicker;
// нажатие мимо палитры закрывает её раньше, чем сработает то, на что нажали
document.addEventListener("pointerdown", (e) => { if (!PK.el.hidden && !PK.el.contains(e.target) && !(PK.anchor && PK.anchor.contains(e.target))) closePicker(); }, true);
addEventListener("resize", closePicker);
$("pOrn").innerHTML = Object.entries(ORNS).map(([k, o]) => `<option value="${k}">${o.name}</option>`).join("");
$("views").onclick = (e) => { const b = e.target.closest("button"); if (b) fly(b.dataset.view); };
$("tabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.tab = b.dataset.tab; [...$("tabs").children].forEach((x) => x.classList.toggle("on", x === b)); drawPattern();
};
// ---------- свои изображения ----------
// Библиотека живёт до закрытия страницы. Файлы приходят кнопкой или перетаскиванием в окно;
// миниатюру можно нажать (встанет на грудь или на выбранную деталь) или перетащить на изделие и на выкройку.
const LIB = [];
const IMG_TYPES = /^image\/(png|jpeg|webp|svg\+xml|gif|avif)$/;
function note(msg) { const n = $("libNote"); n.textContent = msg || ""; n.hidden = !msg; }
function readImage(file) {
  return new Promise((ok) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      // большие снимки уменьшаются до 2048 px: этого хватает для печати на превью и не тормозит перекраску
      const w0 = img.naturalWidth || 1000, h0 = img.naturalHeight || 1000, k = Math.min(1, 2048 / Math.max(w0, h0));
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok({ id: "i" + S.seq++, key: file.name + "|" + file.size, name: file.name.replace(/\.[^.]+$/, "").slice(0, 28) || "Изображение", src: c, thumb: small(c) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); ok(null); };
    img.src = url;
  });
}
async function addFiles(files, at) {
  const list = [...files], good = list.filter((f) => IMG_TYPES.test(f.type) && f.size <= 25 * 1024 * 1024);
  // тот же файл второй раз в библиотеку не попадает — берётся уже загруженный
  const items = (await Promise.all(good.map((f) => LIB.find((it) => it.key === f.name + "|" + f.size) || readImage(f)))).filter(Boolean);
  items.forEach((it) => { if (!LIB.includes(it)) LIB.push(it); });
  renderLib();
  const bad = list.length - items.length;
  note(bad ? `Не добавлено файлов: ${bad}. Подходят PNG, JPG, WebP, SVG до 25 МБ.` : items.length > 1 ? "Нажмите на изображение или перетащите его на изделие." : "");
  // один файл сразу встаёт на изделие; несколько — ждут в библиотеке, чтобы не лечь стопкой
  if (items.length === 1) place(items[0], at);
}
function place(item, at) {
  let p = at && pieceAt(at[0], at[1]);
  if (!p) { p = S.sel && piece(S.sel.piece).kind !== "trim" ? piece(S.sel.piece) : piece("front"); at = null; }
  const r = item.src.height / item.src.width, w = Math.min(24, (p.x1 - p.x0) * (p.kind === "trim" ? 0.3 : 0.5));
  const L = { type: "img", src: item.src, lib: item.id, name: item.name, w: r > 1.4 ? w / r : w, h: r > 1.4 ? w : w * r };
  if (at) { L.x = at[0]; L.y = at[1]; }
  addLayer(L, p.id);
  if (!at) look(p.id);
}
function renderLib() {
  const box = $("lib");
  box.innerHTML = "";
  LIB.forEach((it) => {
    const d = document.createElement("div");
    d.className = "mk-thumb"; d.draggable = true; d.title = it.name + " — нажмите или перетащите на изделие"; d.dataset.id = it.id;
    const im = document.createElement("img"); im.src = it.thumb; im.alt = it.name; im.draggable = false;
    const x = document.createElement("button"); x.type = "button"; x.innerHTML = icon("del"); x.title = "Убрать из списка"; x.setAttribute("aria-label", "Убрать из списка: " + it.name);
    const used = S.layers.filter((L) => L.lib === it.id).length;
    if (used) { const n = document.createElement("i"); n.textContent = used; n.title = "Сколько раз стоит на изделии"; d.append(n); }
    d.append(im, x); box.append(d);
  });
  $("libCount").textContent = LIB.length ? LIB.length : "";
}
$("lib").addEventListener("click", (e) => {
  const d = e.target.closest(".mk-thumb"); if (!d) return;
  const i = LIB.findIndex((it) => it.id === d.dataset.id);
  if (e.target.closest("button")) { LIB.splice(i, 1); renderLib(); }       // слои с этим изображением остаются на изделии
  else place(LIB[i]);
});
$("lib").addEventListener("dragstart", (e) => {
  const d = e.target.closest(".mk-thumb"); if (!d) return;
  e.dataTransfer.setData("application/x-izum-img", d.dataset.id); e.dataTransfer.effectAllowed = "copy";
});
$("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
// перетаскивание: файлы — в любое место конструктора; место на изделии или выкройке задаёт, куда встанет изображение
const mk = $("mk");
const dropPoint = (e) => (e.target === renderer.domElement ? pick(e) : e.target === pat ? toCm(e) : null);
const carries = (e) => { const t = [...(e.dataTransfer ? e.dataTransfer.types : [])]; return t.includes("Files") || t.includes("application/x-izum-img"); };
let dragDepth = 0;
mk.addEventListener("dragenter", (e) => { if (!carries(e)) return; e.preventDefault(); dragDepth++; mk.classList.add("dropping"); });
mk.addEventListener("dragover", (e) => { if (!carries(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
mk.addEventListener("dragleave", (e) => { if (!carries(e)) return; if (--dragDepth <= 0) { dragDepth = 0; mk.classList.remove("dropping"); } });
mk.addEventListener("drop", (e) => {
  if (!carries(e)) return;
  e.preventDefault(); dragDepth = 0; mk.classList.remove("dropping");
  const at = dropPoint(e), id = e.dataTransfer.getData("application/x-izum-img");
  if (id) { const it = LIB.find((x) => x.id === id); if (it) place(it, at); }
  else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, at);
});
// файл, брошенный мимо конструктора, не должен открыться вместо страницы
addEventListener("dragover", (e) => { if (carries(e)) e.preventDefault(); });
addEventListener("drop", (e) => { if (carries(e)) e.preventDefault(); });
$("addText").onclick = () => { addLayer({ type: "text", text: "Ваш текст", font: "gotham", h: 5, w: 1 }); look("front"); $("pText").focus(); $("pText").select(); };
$("addBand").onclick = () => { addLayer({ type: "band", orn: "meander", h: 2.6, w: 0, ink: "#ffd400" }, "sleeve_l"); look("sleeve_l"); };
$("pText").oninput = (e) => { const L = S.sel; L.text = e.target.value; fitText(L); changed(true); renderLayers(); };
$("pFont").onchange = (e) => { S.sel.font = e.target.value; fitText(S.sel); changed(); };
$("pOrn").onchange = (e) => { S.sel.orn = e.target.value; changed(); };
$("pPiece").onchange = (e) => {
  const L = S.sel, p = piece(e.target.value), [x, y] = spot(p, L.type);
  L.piece = p.id; L.x = x; L.y = y;
  if (L.type === "band") { L.h = Math.min(L.h, p.h); moveTo(L, x, y); }
  changed(); look(p.id);
};
$("pSize").oninput = (e) => {
  const L = S.sel, v = +e.target.value;
  if (L.type === "text") { L.h = v; fitText(L); } else resize(L, v);
  changed(true); syncProps();
};
$("pSize").onchange = () => changed();
$("pRot").oninput = (e) => { S.sel.rot = +e.target.value; changed(true); syncProps(); };
$("pRot").onchange = () => changed();
$("pInk").onclick = (e) => {
  const b = e.target.closest("button"), L = S.sel;
  if (!b || !L) return;
  if (b.id !== "pInkOwn") { L.ink = b.dataset.ink || null; changed(); return; }
  inkPalette(b);
};
$("pDel").onclick = () => act("del");
$("pDup").onclick = () => act("dup");
$("pText").onchange = () => changed();
addEventListener("keydown", (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); stepHist(e.shiftKey ? 1 : -1); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") { e.preventDefault(); stepHist(1); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {              // выбрать всё видимое
    e.preventDefault(); S.picks = S.layers.filter((L) => !L.hidden); S.sel = S.picks[S.picks.length - 1] || null; markSel(); syncPanel(); drawPattern(); return;
  }
  if (e.key === "Escape") { if (!PK.el.hidden) closePicker(); else select(null); return; }
  if (!S.sel) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); act("del"); }
  const step = e.shiftKey ? 1 : 0.2, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); S.picks.forEach((L) => moveTo(L, L.x + d[0], L.y + d[1])); changed(); }
});

// ---------- заявка ----------
function spec() {
  const lines = ["Здравствуйте! Макет из конструктора Izum.", `Изделие: футболка ${S.model.name.toLowerCase()}, цвет ткани — ${S.fabric.id === "own" ? "свой, " + S.fabric.hex.toUpperCase() : S.fabric.name.toLowerCase()}.`];
  const vis = S.layers.filter((L) => !L.hidden);
  vis.forEach((L, i) => {
    const p = piece(L.piece), what = L.type === "text" ? `текст «${L.text}»` : L.type === "band" ? `кайма «${ORNS[L.orn].name}»` : `логотип${L.name ? " " + L.name : ""}`;
    const size = L.type === "band" ? `высота ${fmt(L.h)} см, от низа детали ${fmt(p.y1 - L.y - L.h / 2)} см` : `${fmt(L.w)} × ${fmt(L.h)} см, от верха детали ${fmt(L.y - L.h / 2 - p.y0)} см, от середины ${fmt(L.x - (p.x0 + p.x1) / 2)} см${L.rot ? `, поворот ${Math.round(L.rot)}°` : ""}${L.flip ? ", отражено зеркально" : ""}`;
    const over = [...new Set(wrapsOf(L).filter((w) => w.cross && w.to.id !== L.piece).map((w) => w.to.name.toLowerCase()))];
    const seam = over.length ? ` Переходит через шов на: ${over.join(", ")}.` : "";
    const pair = L.link ? (L.pair === "mirror" ? " В паре со вторым рукавом, зеркально." : " В паре со вторым рукавом.") : "";
    lines.push(`${i + 1}. ${p.name}: ${what} — ${size}.${seam}${pair}`);
  });
  if (!vis.length) lines.push("Нанесения нет.");
  return lines.join("\n");
}
$("send").onclick = () => window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(spec())}`, "_blank", "noopener");
$("png").onclick = () => {
  const c = document.createElement("canvas"), tab = S.tab, sel = S.sel;
  c.width = 2400; c.height = 2000; S.tab = "all"; S.sel = null;
  paintFlat(c.getContext("2d"), c.width, c.height, false);
  S.tab = tab; S.sel = sel;
  c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "izum-maket-futbolka.png"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
};

// ---------- модели ----------
const loaded = new Map();
function fetchModel(m) {
  if (!loaded.has(m.id)) loaded.set(m.id, Promise.all([
    fetch(`models/${m.id}.json?v=1113o`).then((r) => r.json()),
    new GLTFLoader().loadAsync(`models/${m.id}.glb?v=1113o`),
  ]).then(([info, gltf]) => {
    let geo = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !geo) geo = o.geometry; });
    const A = info.atlas;
    const pieces = info.pieces.map((p) => {
      const raw = p.outline.map(([x, y]) => [x, A - y]);
      const xs = raw.map((q) => q[0]), ys = raw.map((q) => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs);
      // Деталь с зеркальной развёрткой (правый рукав мужской модели) на листе показывается «как снаружи»:
      // контур отражён, а при печати на текстуру нанесение отражается обратно — иначе надпись читалась бы задом наперёд.
      const o = p.mir ? raw.map(([x, y]) => [x0 + x1 - x, y]) : raw;
      return { ...p, o, raw, fx: (p.fx || 1) * (p.mir ? -1 : 1), x0, x1, y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    // швы: пары точек «на этой детали — на соседней», в координатах листа (с учётом зеркальных деталей)
    const byId = Object.fromEntries(pieces.map((q) => [q.id, q]));
    pieces.forEach((q) => { q.seams = []; });
    (info.seams || []).forEach(([ia, ib, flat]) => {
      const pa = byId[ia], pb = byId[ib];
      if (!pa || !pb) return;
      const fw = [], bw = [];
      for (let i = 0; i < flat.length; i += 4) {
        const ax = pa.mir ? pa.x0 + pa.x1 - flat[i] : flat[i], ay = A - flat[i + 1];
        const bx = pb.mir ? pb.x0 + pb.x1 - flat[i + 2] : flat[i + 2], by = A - flat[i + 3];
        fw.push([ax, ay, bx, by]); bw.push([bx, by, ax, ay]);
      }
      // ровный переход — только через боковые швы тела и нижний шов рукава (см. «переход через шов»)
      const even = ia === ib ? pa.kind === "sleeve" : pa.kind === "body" && pb.kind === "body" && seamTurn(fw) < 1.05;
      if (!even) return;
      pa.seams.push({ to: ib, P: fw }); pb.seams.push({ to: ia, P: bw });       // у нижнего шва рукава обе записи — на самой детали
    });
    return { info, geo, pieces };
  }));
  return loaded.get(m.id);
}
async function useModel(id) {
  const m = MODELS.find((x) => x.id === id) || MODELS[0];
  [...$("models").children].forEach((b) => b.classList.toggle("on", b.dataset.id === m.id));
  const d = await fetchModel(m), old = S.pieces;
  // слои переезжают на ту же деталь новой модели и сохраняют место в долях её размера
  S.layers.forEach((L) => {
    const a = old.find((p) => p.id === L.piece), b = d.pieces.find((p) => p.id === L.piece) || d.pieces.find((p) => a && p.kind === a.kind) || d.pieces[0];
    if (a) { L.x = b.x0 + ((L.x - a.x0) / (a.x1 - a.x0)) * (b.x1 - b.x0); L.y = L.type === "band" ? b.y1 - (a.y1 - L.y) : b.y0 + ((L.y - a.y0) / (a.y1 - a.y0)) * (b.y1 - b.y0); }
    L.piece = b.id;
    if (L.type === "band") L.h = Math.min(L.h, b.y1 - b.y0);
  });
  S.model = m; S.A = d.info.atlas; S.H = d.info.height; S.pieces = d.pieces;
  S.layers.forEach((L) => { if (L.type === "band") moveTo(L, L.x, L.y); });
  $("pPiece").innerHTML = S.pieces.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  build(d.geo);
  syncPanel(); fit(); resetHist();
}
$("models").innerHTML = MODELS.map((m) => `<button type="button" data-id="${m.id}">${m.name}</button>`).join("");
$("models").onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.id !== S.model.id) useModel(b.dataset.id); };

// ---------- запуск ----------
async function start() {
  if (document.fonts) await document.fonts.load('italic 900 20px "Gotham Pro"').catch(() => 0);
  await useModel(MODELS[0].id);
  $("load").remove();
  // пример, чтобы сразу было видно, как это работает: знак на груди, надпись на спине, каймы на рукавах и бейке
  const logo = new Image();
  logo.onload = () => {
    const r = logo.naturalHeight / logo.naturalWidth, f = piece("front");
    addLayer({ type: "img", src: logo, name: "Izum", ink: "#ffffff", w: 8, h: 8 * r, x: f.x0 + (f.x1 - f.x0) * 0.7, y: f.y0 + (f.y1 - f.y0) * 0.3 }, "front");
    addLayer({ type: "text", text: "Izum Production", font: "gotham", h: 2.8, w: 1 }, "back");
    const sleeve = S.pieces.find((p) => p.kind === "sleeve");
    if (sleeve) setPair(addLayer({ type: "band", orn: "meander", h: 2.4, w: 0, ink: "#ffd400" }, sleeve.id), "mirror");
    S.pieces.filter((p) => p.kind === "trim" && p.name.startsWith("Бейка")).forEach((p) => addLayer({ type: "band", orn: "line", h: p.h, w: 0 }, p.id));
    select(null); changed(); resetHist();
  };
  logo.onerror = () => { changed(); resetHist(); };
  logo.src = "img/izum-logo.png";
  tick(); MODELS.slice(1).forEach(fetchModel);
  window.izumMk = { S, LIB, HIST, PK, act, select, setPair, pick, wrapsOf, addFiles, fly, spec, useModel, renderer, cam, controls, get model() { return model; }, get view() { return V; } };
}
start().catch((err) => { console.error(err); $("load").textContent = "Не получилось загрузить модель. Обновите страницу."; });
