// =============================================
//  다비도의 내전 - 통합 서버
//  npm install ws express chzzk
//  실행: node server.js
// =============================================

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store');
  },
}));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INHOUSE_DB_FILE = path.join(DATA_DIR, 'inhouse-db.json');
const SEED_INHOUSE_DB_FILE = path.join(__dirname, 'data', 'inhouse-db.json');
const INHOUSE_BACKUP_DIR = path.join(DATA_DIR, 'backups');

function defaultInhouseDB() {
  return {
    players: [],
    history: [],
    viewers: [],
    curBlue: [],
    curRed: [],
    pid: 0,
    vid: 0,
    updatedAt: null,
  };
}

function normalizeInhouseDB(data) {
  return {
    players: Array.isArray(data?.players) ? data.players : [],
    history: Array.isArray(data?.history) ? data.history : [],
    viewers: Array.isArray(data?.viewers) ? data.viewers : [],
    curBlue: Array.isArray(data?.curBlue) ? data.curBlue : [],
    curRed: Array.isArray(data?.curRed) ? data.curRed : [],
    pid: Number.isFinite(Number(data?.pid)) ? Number(data.pid) : 0,
    vid: Number.isFinite(Number(data?.vid)) ? Number(data.vid) : 0,
    updatedAt: data?.updatedAt || null,
  };
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function latestBackupFile() {
  try {
    if (!fs.existsSync(INHOUSE_BACKUP_DIR)) return null;
    return fs.readdirSync(INHOUSE_BACKUP_DIR)
      .filter(name => /^inhouse-db-\d+\.json$/.test(name))
      .sort()
      .pop() || null;
  } catch (err) {
    console.error('[INHOUSE_DB] backup scan failed:', err.message);
    return null;
  }
}

function backupInhouseDB(data) {
  try {
    if (!data || !Array.isArray(data.viewers) || !data.viewers.length) return;
    if (!fs.existsSync(INHOUSE_BACKUP_DIR)) fs.mkdirSync(INHOUSE_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(INHOUSE_BACKUP_DIR, `inhouse-db-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');

    const backups = fs.readdirSync(INHOUSE_BACKUP_DIR)
      .filter(name => /^inhouse-db-\d+\.json$/.test(name))
      .sort();
    backups.slice(0, Math.max(0, backups.length - 30)).forEach(name => {
      fs.unlinkSync(path.join(INHOUSE_BACKUP_DIR, name));
    });
  } catch (err) {
    console.error('[INHOUSE_DB] backup failed:', err.message);
  }
}

function mergeViewers(existing, incoming) {
  const byId = new Map();
  const byName = new Map();
  const merged = [];
  const remember = viewer => {
    if (!viewer || !viewer.name) return;
    if (Number.isFinite(Number(viewer.id))) byId.set(Number(viewer.id), viewer);
    byName.set(String(viewer.name).trim().toLowerCase(), viewer);
  };

  existing.forEach(remember);
  incoming.forEach(viewer => {
    if (!viewer || !viewer.name) return;
    const id = Number(viewer.id);
    const key = String(viewer.name).trim().toLowerCase();
    const prior = (Number.isFinite(id) && byId.get(id)) || byName.get(key) || {};
    const next = { ...prior, ...viewer };
    merged.push(next);
    remember(next);
  });

  existing.forEach(viewer => {
    if (!viewer || !viewer.name) return;
    const exists = merged.some(v =>
      (Number.isFinite(Number(v.id)) && Number(v.id) === Number(viewer.id)) ||
      String(v.name).trim().toLowerCase() === String(viewer.name).trim().toLowerCase()
    );
    if (!exists) merged.push(viewer);
  });
  return merged;
}

function readInhouseDB() {
  try {
    if (fs.existsSync(INHOUSE_DB_FILE)) return { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(INHOUSE_DB_FILE)) };

    const backup = latestBackupFile();
    if (backup) return { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(path.join(INHOUSE_BACKUP_DIR, backup))) };

    if (fs.existsSync(SEED_INHOUSE_DB_FILE)) {
      const seeded = { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(SEED_INHOUSE_DB_FILE)) };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INHOUSE_DB_FILE, JSON.stringify(seeded), 'utf8');
      return seeded;
    }

    return defaultInhouseDB();
  } catch (err) {
    console.error('[INHOUSE_DB] read failed:', err.message);
    return defaultInhouseDB();
  }
}

function writeInhouseDB(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = readInhouseDB();
  backupInhouseDB(existing);

  const incoming = normalizeInhouseDB(data || {});
  const viewers = mergeViewers(existing.viewers, incoming.viewers);
  const maxViewerId = viewers.reduce((max, viewer) => Math.max(max, Number(viewer.id) || 0), 0);
  const payload = {
    ...incoming,
    viewers,
    vid: Math.max(incoming.vid || 0, existing.vid || 0, maxViewerId),
    updatedAt: new Date().toISOString(),
  };
  const tmp = INHOUSE_DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, INHOUSE_DB_FILE);
  return payload;
}

app.get('/api/inhouse-db', (req, res) => {
  res.json(readInhouseDB());
});

app.post('/api/inhouse-db', (req, res) => {
  try {
    res.json({ ok: true, data: writeInhouseDB(req.body || {}) });
  } catch (err) {
    console.error('[INHOUSE_DB] write failed:', err.message);
    res.status(500).json({ ok: false, error: 'write_failed' });
  }
});

// ── 상태 ──
const MATCHUP_CACHE = new Map();
const COUNTERSTATS_SLUGS = {
  AurelionSol: 'aurelion-sol',
  Belveth: 'belveth',
  Chogath: 'chogath',
  DrMundo: 'dr-mundo',
  JarvanIV: 'jarvan-iv',
  Kaisa: 'kaisa',
  Khazix: 'khazix',
  KogMaw: 'kogmaw',
  KSante: 'ksante',
  LeeSin: 'lee-sin',
  MasterYi: 'master-yi',
  MissFortune: 'miss-fortune',
  MonkeyKing: 'wukong',
  Nunu: 'nunu-willump',
  RekSai: 'reksai',
  Renata: 'renata-glasc',
  TahmKench: 'tahm-kench',
  TwistedFate: 'twisted-fate',
  Velkoz: 'velkoz',
  XinZhao: 'xin-zhao',
};

function counterStatsSlug(champion) {
  const key = String(champion || '').trim();
  if (!key) return '';
  if (COUNTERSTATS_SLUGS[key]) return COUNTERSTATS_SLUGS[key];
  return key.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/['.&]/g, '').replace(/\s+/g, '-').toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchCounterStatsPage(slug) {
  const cached = MATCHUP_CACHE.get(`page:${slug}`);
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) return cached.html;
  const response = await fetch(`https://www.counterstats.net/league-of-legends/${encodeURIComponent(slug)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`counterstats_http_${response.status}`);
  const html = await response.text();
  MATCHUP_CACHE.set(`page:${slug}`, { ts: Date.now(), html });
  return html;
}

function parseCounterStatsWinrate(html, sourceSlug, targetSlug, lane) {
  const lanePart = lane ? `${escapeRegExp(lane)}/all` : '[^"]*';
  const rowRe = new RegExp(`<a[^>]+href="/league-of-legends/${escapeRegExp(sourceSlug)}/vs-${escapeRegExp(targetSlug)}/${lanePart}"[\\s\\S]*?<span class="win">\\s*Win\\s*<span class="b">(\\d+(?:\\.\\d+)?)%`, 'i');
  const match = html.match(rowRe);
  return match ? Number(match[1]) : null;
}

async function getCounterStatsBlueRate(blueChampion, redChampion, lane) {
  const blueSlug = counterStatsSlug(blueChampion);
  const redSlug = counterStatsSlug(redChampion);
  if (!blueSlug || !redSlug) return null;
  const key = `rate:${blueSlug}:${redSlug}:${lane || 'any'}`;
  const cached = MATCHUP_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) return cached.data;

  const bluePage = await fetchCounterStatsPage(blueSlug);
  const redWin = parseCounterStatsWinrate(bluePage, blueSlug, redSlug, lane);
  if (Number.isFinite(redWin)) {
    const data = { blueRate: 100 - redWin, redRate: redWin, source: 'CounterStats' };
    MATCHUP_CACHE.set(key, { ts: Date.now(), data });
    return data;
  }

  const redPage = await fetchCounterStatsPage(redSlug);
  const blueWin = parseCounterStatsWinrate(redPage, redSlug, blueSlug, lane);
  if (Number.isFinite(blueWin)) {
    const data = { blueRate: blueWin, redRate: 100 - blueWin, source: 'CounterStats' };
    MATCHUP_CACHE.set(key, { ts: Date.now(), data });
    return data;
  }
  return null;
}

app.get('/api/matchup-rate', async (req, res) => {
  try {
    const blueChampion = String(req.query.blue || '');
    const redChampion = String(req.query.red || '');
    const lane = String(req.query.lane || '').toLowerCase();
    const data = await getCounterStatsBlueRate(blueChampion, redChampion, lane);
    if (!data) return res.status(404).json({ ok: false, error: 'matchup_not_found' });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[MATCHUP_RATE]', err.message);
    res.status(502).json({ ok: false, error: 'matchup_fetch_failed' });
  }
});

const state = {
  channelId: null,
  chzzkConnected: false,
  vote: { active: false, title: '내전 투표', items: [], startedAt: null },
  roulette: { items: [] },
  music: { queue: [], currentIdx: 0, playing: false },
  inhouseTeams: { blue: [], red: [], updatedAt: null },
  lcuDraft: { connected: false, inChampSelect: false, error: null, session: null, updatedAt: null },
  bot: {
    enabled: true,
    sendToChat: false,
    hasAuth: false,
    status: 'idle',
    lastSendError: null,
    commandCount: 0,
    lastCommand: null,
    lastReply: null,
    macros: [
      { id: 'join', title: '내전 참가 안내', text: '!참가 를 치면 내전 참가 신청이 됩니다.' },
      { id: 'point', title: '포인트 안내', text: '!포인트 로 내전 포인트를 확인할 수 있습니다.' },
      { id: 'rule', title: '내전 안내', text: '내전 참가자는 방송 화면과 내전사이트 안내를 확인해주세요.' },
    ],
  },
  chatLog: [],
};

let chzzkWs = null;
let chzzkPing = null;
let chzzkChatChannelId = null;
let chzzkTid = 10;
let chzzkReconnectTimer = null;
let chzzkReconnectDelay = 5000;
let chzzkAuthed = false;
const chzzkAuth = {
  nidAut: process.env.CHZZK_NID_AUT || '',
  nidSes: process.env.CHZZK_NID_SES || '',
};

function hasChzzkAuth() {
  return !!(chzzkAuth.nidAut && chzzkAuth.nidSes);
}

function chzzkCookieHeader() {
  if (!hasChzzkAuth()) return '';
  return `NID_AUT=${chzzkAuth.nidAut}; NID_SES=${chzzkAuth.nidSes}`;
}

function chzzkHeaders(extra = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Origin': 'https://chzzk.naver.com',
    'Referer': 'https://chzzk.naver.com/',
    ...extra,
  };
  const cookie = chzzkCookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchChzzkJson(url, options={}, timeoutMs=5000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(url,{...options,signal:controller.signal});
    const json=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    return json;
  }finally{clearTimeout(timer);}
}

const chzzkProfileCache=new Map();
async function fetchChzzkProfile(chzzkName){
  if(!chzzkName)return null;
  const key=String(chzzkName).trim().toLowerCase();
  if(chzzkProfileCache.has(key))return chzzkProfileCache.get(key);
  try{
    const url=`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(chzzkName)}&size=5`;
    const json=await fetchChzzkJson(url,{headers:chzzkHeaders()},4000);
    const list=json?.content?.data||[];
    const match=list.find(c=>String(c.channel?.channelName||'').toLowerCase()===key)||list[0];
    const img=match?.channel?.channelImageUrl||null;
    chzzkProfileCache.set(key,img);
    return img;
  }catch{return null;}
}

const INHOUSE_API_URL=(process.env.INHOUSE_API_URL||'https://davido-inhouse-production.up.railway.app').replace(/\/+$/,'');

app.get('/api/draft-profiles', async(req,res)=>{
  // Railway 내전 서버에서 최신 팀 데이터 가져오기
  let db=null;
  try{
    const r=await fetch(`${INHOUSE_API_URL}/api/inhouse-db`,{signal:AbortSignal.timeout(5000)});
    if(r.ok)db=await r.json();
  }catch(e){console.log('[draft-profiles] Railway fetch 실패, 로컬 fallback:',e.message);}
  // 로컬 파일 fallback
  if(!db){
    const davidoDb=path.join(__dirname,'..','davido-inhouse','data','inhouse-db.json');
    if(fs.existsSync(davidoDb)){
      try{db=JSON.parse(fs.readFileSync(davidoDb,'utf8').replace(/^﻿/,''));}catch{}
    }
  }
  if(!db)db=readInhouseDB();

  // 플레이어별 승패 계산
  const history=Array.isArray(db.history)?db.history:[];
  function playerStats(viewerId){
    let wins=0,losses=0;const form=[];
    for(let i=history.length-1;i>=0;i--){
      const h=history[i];
      if(!h.res)continue;
      const inBlue=(h.blue||[]).some(p=>p.viewerId===viewerId);
      const inRed=(h.red||[]).some(p=>p.viewerId===viewerId);
      if(!inBlue&&!inRed)continue;
      const won=(inBlue&&h.res==='blue')||(inRed&&h.res==='red');
      if(won){wins++;}else{losses++;}
      if(form.length<5)form.unshift(won?'W':'L');
    }
    return{wins,losses,form:form.join('')};
  }

  const fmt=async p=>{
    const stats=playerStats(p.viewerId);
    return{
      name:p.chzzk||(p.name||'').replace(/#.*$/,''),
      tier:p.tier||'',
      position:p.assignedPos||'',
      profileImage:await fetchChzzkProfile(p.chzzk),
      wins:stats.wins,
      losses:stats.losses,
      form:stats.form,
    };
  };
  const POS_ORDER={탑:0,정글:1,미드:2,원딜:3,서포터:4,서폿:4};
  const sortPos=arr=>[...arr].sort((a,b)=>(POS_ORDER[a.position]??9)-(POS_ORDER[b.position]??9));

  const[blue,red]=await Promise.all([
    Promise.all((db.curBlue||[]).map(fmt)),
    Promise.all((db.curRed||[]).map(fmt)),
  ]);
  res.json({blue:sortPos(blue),red:sortPos(red)});
});

// ── 브로드캐스트 ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function broadcastState() {
  state.bot.hasAuth = hasChzzkAuth();
  broadcast({ type: 'state', data: publicState() });
}

function publicState() {
  state.bot.hasAuth = hasChzzkAuth();
  return { ...state, chzzkConnected: chzzkAuthed && chzzkWs?.readyState === 1 };
}

function normalizeChatName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function displayViewerName(viewer, fallback) {
  return String(viewer?.name || fallback || '').replace(/#.+$/, '').trim();
}

function findViewerByChzzkNickname(nickname) {
  const key = normalizeChatName(nickname);
  if (!key) return null;
  const db = readInhouseDB();
  return db.viewers.find(viewer =>
    normalizeChatName(viewer.chzzk) === key || normalizeChatName(viewer.name) === key
  ) || db.viewers.find(viewer => {
    const chzzk = normalizeChatName(viewer.chzzk);
    const name = normalizeChatName(viewer.name);
    return (chzzk && (chzzk.includes(key) || key.includes(chzzk)))
      || (name && (name.includes(key) || key.includes(name)));
  }) || null;
}

function sendBotNotice(targetNickname, text) {
  const payload = {
    type: 'bot_reply',
    nickname: targetNickname,
    text,
    ts: Date.now(),
  };
  state.bot.commandCount += 1;
  state.bot.lastReply = payload;
  broadcast(payload);
  broadcast({ type: 'chat', nickname: '다비도 봇', text, ts: payload.ts, isSystem: true });
  if (state.bot.sendToChat) sendChzzkChat(text);
  broadcastState();
}

function sendChzzkChat(text) {
  const msg = String(text || '').trim();
  if (!msg) return false;
  if (!chzzkWs || chzzkWs.readyState !== 1 || !chzzkChatChannelId) {
    state.bot.lastSendError = '치지직 채팅에 연결되어 있지 않습니다.';
    broadcastState();
    return false;
  }

  try {
    chzzkWs.send(JSON.stringify({
      ver: '3',
      cmd: 3101,
      svcid: 'game',
      cid: chzzkChatChannelId,
      bdy: {
        msg,
        msgTypeCode: 1,
        extras: '{}',
      },
      tid: ++chzzkTid,
    }));
    state.bot.lastSendError = null;
    return true;
  } catch (err) {
    state.bot.lastSendError = err.message || '치지직 채팅 전송 실패';
    broadcastState();
    return false;
  }
}

function handlePointCommand(nickname) {
  const viewer = findViewerByChzzkNickname(nickname);
  if (!viewer) {
    sendBotNotice(nickname, `${nickname}님은 아직 시청자 DB에 등록되어 있지 않습니다.`);
    return true;
  }
  const points = Math.max(0, Number(viewer.pass) || 0);
  const name = displayViewerName(viewer, nickname);
  sendBotNotice(nickname, `${name}님의 내전 포인트는 ${points}P 입니다.`);
  return true;
}

// ── WebSocket 클라이언트 ──
wss.on('connection', (ws) => {
  console.log('[WS] 브라우저 연결');
  ws.send(JSON.stringify({ type: 'state', data: publicState() }));
  ws.send(JSON.stringify({ type: 'lcu_champ_select', data: state.lcuDraft }));
});

// ── 롤 클라이언트 LCU 연동 ──
const LCU_LOCKFILE_CANDIDATES = [
  () => process.env.LCU_LOCKFILE,
  () => process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Riot Games', 'League of Legends', 'lockfile'),
  () => 'C:\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
].filter(Boolean);

let lcuCreds = null;
let lcuLastSig = '';
let lcuPollTimer = null;

function findLcuLockfile() {
  for (const getPath of LCU_LOCKFILE_CANDIDATES) {
    const file = getPath();
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function readLcuLockfile() {
  const file = findLcuLockfile();
  if (!file) return null;
  const [name, pid, port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
  if (!port || !password) return null;
  return { file, name, pid, port, password, protocol: protocol || 'https' };
}

function lcuRequest(endpoint) {
  return new Promise((resolve, reject) => {
    if (!lcuCreds) return reject(new Error('lcu_not_connected'));
    const auth = Buffer.from(`riot:${lcuCreds.password}`).toString('base64');
    const req = https.request({
      hostname: '127.0.0.1',
      port: lcuCreds.port,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${auth}` },
      timeout: 1200,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`lcu_${res.statusCode}`));
        try { resolve(body ? JSON.parse(body) : null); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('lcu_timeout')));
    req.on('error', reject);
    req.end();
  });
}

function simplifyChampSelect(session) {
  if (!session) return null;
  const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
  const theirTeam = Array.isArray(session.theirTeam) ? session.theirTeam : [];
  const teamByCell = new Map();
  myTeam.forEach((p, idx) => teamByCell.set(p.cellId, { side: 'blue', idx, player: p }));
  theirTeam.forEach((p, idx) => teamByCell.set(p.cellId, { side: 'red', idx, player: p }));

  const actions = [];
  (Array.isArray(session.actions) ? session.actions : []).flat().forEach(action => {
    if (!action || !['ban', 'pick'].includes(action.type)) return;
    const meta = teamByCell.get(action.actorCellId) || { side: 'blue', idx: 0, player: {} };
    actions.push({
      id: action.id,
      type: action.type,
      side: meta.side,
      idx: meta.idx,
      championId: Number(action.championId || 0),
      completed: !!action.completed,
      inProgress: !!action.isInProgress,
      actorCellId: action.actorCellId,
    });
  });

  const player = (p, idx) => ({
    idx,
    cellId: p.cellId,
    championId: Number(p.championId || 0),
    summonerId: p.summonerId,
    name: p.displayName || p.summonerName || p.gameName || `참가자 ${idx + 1}`,
    lane: p.assignedPosition || '',
  });

  return {
    timer: session.timer || null,
    localPlayerCellId: session.localPlayerCellId,
    blue: myTeam.map(player),
    red: theirTeam.map(player),
    actions,
  };
}

async function pollLcuDraft() {
  if (state.lcuDraft?.source === 'relay' && Date.now() - Number(state.lcuDraft.updatedAt || 0) < 5000) {
    return;
  }
  try {
    const nextCreds = readLcuLockfile();
    if (!nextCreds) {
      lcuCreds = null;
      updateLcuDraft({ connected: false, inChampSelect: false, error: '롤 클라이언트를 찾지 못했습니다.', session: null });
      return;
    }
    lcuCreds = nextCreds;
    const session = await lcuRequest('/lol-champ-select/v1/session');
    updateLcuDraft({
      connected: true,
      inChampSelect: !!session,
      error: null,
      session: simplifyChampSelect(session),
    });
  } catch (err) {
    updateLcuDraft({
      connected: !!lcuCreds,
      inChampSelect: false,
      error: err.message,
      session: null,
    });
  }
}

function updateLcuDraft(next) {
  state.lcuDraft = { ...next, updatedAt: Date.now() };
  const sig = JSON.stringify(state.lcuDraft);
  if (sig === lcuLastSig) return;
  lcuLastSig = sig;
  broadcast({ type: 'lcu_champ_select', data: state.lcuDraft });
}

function startLcuPolling() {
  if (lcuPollTimer) return;
  pollLcuDraft();
  lcuPollTimer = setInterval(pollLcuDraft, 1200);
}

function scheduleChzzkReconnect(chatChannelId, originalChannelId) {
  if (!state.channelId || state.channelId !== originalChannelId) return;
  if (chzzkReconnectTimer) return;
  state.bot.status = 'reconnecting';
  broadcastState();
  const delay = chzzkReconnectDelay;
  chzzkReconnectDelay = Math.min(chzzkReconnectDelay * 2, 60000);
  console.log(`[CHZZK] reconnect in ${delay}ms`);
  chzzkReconnectTimer = setTimeout(async () => {
    chzzkReconnectTimer = null;
    let newToken = null;
    try {
      const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
        { headers: chzzkHeaders() });
      const json = await res.json();
      newToken = json?.content?.accessToken || null;
    } catch (err) {
      state.bot.lastSendError = err.message || '치지직 토큰 갱신 실패';
    }
    connectChatWs(chatChannelId, originalChannelId, newToken);
  }, delay);
}

// ── 치지직 연결 ──
async function connectChzzk(channelId) {
  clearTimeout(chzzkReconnectTimer);
  chzzkReconnectTimer = null;
  chzzkAuthed = false;
  state.bot.status = 'connecting';
  broadcastState();
  // 기존 연결 완전히 종료
  if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
  if (chzzkWs) {
    chzzkWs.removeAllListeners();
    try { chzzkWs.terminate(); } catch {}
    chzzkWs = null;
  }
  chzzkChatChannelId = null;
  // 잠시 대기 후 연결 (이전 연결 정리 시간)
  await new Promise(r => setTimeout(r, 500));

  state.channelId = channelId;
  if (state.bot.sendToChat && !hasChzzkAuth()) {
    state.bot.lastSendError = '채팅답장 ON 상태지만 봇 계정 인증이 없어 읽기 연결만 시도합니다.';
  }

  let chatChannelId = channelId;
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: chzzkHeaders() });
    const json = await res.json();
    chatChannelId = json?.content?.chatChannelId || channelId;
    chzzkChatChannelId = chatChannelId;
    console.log('[CHZZK] chatChannelId:', chatChannelId);
  } catch (e) { chzzkChatChannelId = chatChannelId; console.log('[CHZZK] chatChannelId fallback:', e.message); }

  let accessToken = null;
  try {
    const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: chzzkHeaders() });
    const json = await res.json();
    accessToken = json?.content?.accessToken || null;
    console.log('[CHZZK] accessToken:', accessToken ? '획득' : '없음');
  } catch (e) { console.log('[CHZZK] token failed:', e.message); }

  connectChatWs(chatChannelId, channelId, accessToken);
}

function connectChatWs(chatChannelId, originalChannelId, accessToken) {
  const WS = require('ws');
  chzzkAuthed = false;
  const chatAuthMode = state.bot.sendToChat && hasChzzkAuth() ? 'SEND' : 'READ';
  const serverNum = Math.floor(Math.random() * 9) + 1;
  const url = `wss://kr-ss${serverNum}.chat.naver.com/chat`;
  console.log('[CHZZK] connecting to', url);

  const ws = new WS(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10000,
    headers: {
      ...chzzkHeaders(),
    }
  });
  chzzkWs = ws;

  ws.on('open', () => {
    console.log('[CHZZK] open!');
    // 연결 확인 패킷 먼저 대기
    setTimeout(() => {
      ws.send(JSON.stringify({
        ver: '3', cmd: 100, svcid: 'game', cid: chatChannelId,
        bdy: { uid: null, devType: 2001, accTkn: accessToken, auth: chatAuthMode,
               libVer: '4.9.1', osVer: 'Windows/10', devName: 'Chrome/120.0.0.0',
               locale: 'ko', chzzkTk: null },
        tid: 1,
      }));
    }, 500);
    chzzkPing = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ ver: '3', cmd: 0 }));
    }, 20000);
    broadcastState();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      console.log('[CHZZK] recv cmd:', msg.cmd);
      if (msg.cmd === 0) { ws.send(JSON.stringify({ ver: '3', cmd: 10000 })); return; }
      if (msg.cmd === 10000) return;
      if (msg.cmd === 100) {
        console.log('[CHZZK] auth response:', JSON.stringify(msg.bdy));
        chzzkAuthed = true;
        chzzkReconnectDelay = 5000;
        state.bot.status = chatAuthMode === 'SEND' ? 'connected-send' : 'connected-read';
        if (chatAuthMode === 'READ' && state.bot.sendToChat && !hasChzzkAuth()) {
          state.bot.lastSendError = '봇 계정 인증이 없어 채팅 읽기만 연결됐습니다.';
        }
        broadcastState();
        return;
      }
      if (msg.cmd === 100) { console.log('[CHZZK] 인증 응답:', JSON.stringify(msg.bdy)); return; }
      if (msg.cmd === 93101) { console.log('[CHZZK] chat raw:', JSON.stringify(msg.bdy).slice(0,200)); handleChat(msg); }
    } catch (e) { console.log('[CHZZK] parse error:', e.message); }
  });

  ws.on('close', (code) => {
    console.log('[CHZZK] closed:', code);
    if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
    chzzkAuthed = false;
    state.bot.status = 'closed';
    broadcastState();
    scheduleChzzkReconnect(chatChannelId, originalChannelId);
    return;
    if (state.channelId === originalChannelId) {
      console.log('[CHZZK] 재연결 5초 후...');
      setTimeout(async () => {
        let newToken = null;
        try {
          const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
            { headers: chzzkHeaders() });
          const json = await res.json();
          newToken = json?.content?.accessToken || null;
        } catch {}
        connectChatWs(chatChannelId, originalChannelId, newToken);
      }, 5000);
    }
  });

  ws.on('error', (err) => console.error('[CHZZK] error:', err.message));
}

function handleChat(msg) {
  const chats = Array.isArray(msg.bdy) ? msg.bdy : (msg.bdy?.messageList || []);
  chats.forEach(chat => {
    const rawProfile = chat.profile;
    const profile = typeof rawProfile === "string" ? JSON.parse(rawProfile || "{}") : (rawProfile || {});
    const nickname = profile.nickname || chat.nickname || "unknown";
    const text = (chat.msg || chat.message || chat.content || '').trim();
    if (!text) return;
    console.log('[CHAT] keys:', Object.keys(chat).join(','), 'nick:', nickname, 'text:', text);

    state.chatLog.push({ nickname, text, ts: Date.now() });
    if (state.chatLog.length > 300) state.chatLog.shift();

    if (/^!포인트(?:\s|$)/.test(text)) {
      state.bot.lastCommand = { nickname, text, command: '!포인트', ts: Date.now() };
      handlePointCommand(nickname);
    }

    if (/^!참가(?:\s|$)/.test(text)) {
      broadcast({ type: 'inhouse_join', nickname, text, ts: Date.now() });
    }

    // 투표
    if (state.vote.active) {
      const m = text.match(/^!투표\s*(\d+)$/);
      if (m) {
        const idx = parseInt(m[1]) - 1;
        if (idx >= 0 && idx < state.vote.items.length) {
          state.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname); });
          state.vote.items[idx].votes.push(nickname);
        }
      }
    }

    // 신청곡
    if (text.startsWith('!신청곡 ')) {
      const query = text.slice(5).trim();
      if (query) handleMusicRequest(nickname, query);
    }

    broadcast({ type: 'chat', nickname, text, ts: Date.now() });
    broadcast({ type: 'vote_update', vote: state.vote });
  });
}

async function handleMusicRequest(nickname, query) {
  const track = await searchYouTube(query);
  if (!track) return;
  if (state.music.queue.some(t => t.videoId === track.videoId)) return;
  state.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() });
  if (state.music.queue.length === 1) { state.music.currentIdx = 0; state.music.playing = true; }
  broadcast({ type: 'music_update', music: state.music });
  broadcast({ type: 'chat', nickname: '🎵 신청곡', text: `[${nickname}] "${track.title}" 추가!`, ts: Date.now(), isSystem: true });
}

// ── YouTube 검색 ──
async function searchYouTube(query, max = 8) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR' } });
    const html = await res.text();
    const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/);
    if (!match) return max === 1 ? null : [];
    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
    if (!contents) return max === 1 ? null : [];
    const results = [];
    for (const item of contents) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      // 임베드 불가 영상 제외
      if (v.badges?.some(b => b?.metadataBadgeRenderer?.label === 'Unlicensed')) continue;
      results.push({
        videoId: v.videoId,
        title: v.title?.runs?.[0]?.text || '',
        channel: v.ownerText?.runs?.[0]?.text || '',
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        duration: v.lengthText?.simpleText || '',
      });
      if (results.length >= max) break;
    }
    return max === 1 ? (results[0] || null) : results;
  } catch { return max === 1 ? null : []; }
}

// ── API ──
const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#e91e63'];
const PASSWORD = process.env.APP_PASSWORD || '09870987';

app.post('/api/action', async (req, res) => {
  const { type, ...body } = req.body;

  switch (type) {
    case 'connect_chzzk':
      await connectChzzk(body.channelId);
      return res.json({ ok: true });

    case 'disconnect_chzzk':
      clearTimeout(chzzkReconnectTimer);
      chzzkReconnectTimer = null;
      if (chzzkWs) { try { chzzkWs.terminate(); } catch {} chzzkWs = null; }
      if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
      state.channelId = null;
      chzzkChatChannelId = null;
      chzzkAuthed = false;
      state.bot.status = 'idle';
      broadcastState();
      return res.json({ ok: true });

    case 'set_bot_enabled':
      state.bot.enabled = body.enabled !== false;
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'set_bot_chat_send':
      state.bot.sendToChat = body.enabled === true;
      state.bot.lastSendError = null;
      if (state.bot.sendToChat && !hasChzzkAuth()) {
        state.bot.lastSendError = '치지직 채팅 답장을 쓰려면 봇 계정 NID_AUT/NID_SES 인증이 필요합니다.';
      }
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'set_bot_auth':
      chzzkAuth.nidAut = String(body.nidAut || '').trim();
      chzzkAuth.nidSes = String(body.nidSes || '').trim();
      state.bot.hasAuth = hasChzzkAuth();
      state.bot.lastSendError = hasChzzkAuth() ? null : 'NID_AUT/NID_SES가 모두 필요합니다.';
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'clear_bot_auth':
      chzzkAuth.nidAut = '';
      chzzkAuth.nidSes = '';
      state.bot.hasAuth = false;
      state.bot.sendToChat = false;
      state.bot.lastSendError = null;
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'bot_notice':
      sendBotNotice(body.nickname || '방송공지', body.text || '');
      return res.json({ ok: true, bot: state.bot });

    case 'bot_send_test':
      sendChzzkChat(body.text || '다비도 봇 테스트');
      return res.json({ ok: true, bot: state.bot });

    case 'start_vote':
      state.vote = {
        active: true,
        title: body.title || '내전 투표',
        items: (body.items || []).map((label, i) => ({ label, votes: [], color: COLORS[i % COLORS.length] })),
        startedAt: Date.now(),
      };
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'end_vote':
      state.vote.active = false;
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'reset_vote':
      state.vote = { active: false, title: '내전 투표', items: [], startedAt: null };
      state.chatLog = [];
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'set_roulette':
      state.roulette.items = body.items || [];
      broadcast({ type: 'roulette_update', roulette: state.roulette });
      return res.json({ ok: true });

    case 'set_inhouse_teams':
      state.inhouseTeams = {
        blue: Array.isArray(body.blue) ? body.blue : [],
        red: Array.isArray(body.red) ? body.red : [],
        updatedAt: Date.now(),
      };
      broadcast({ type: 'inhouse_teams_update', inhouseTeams: state.inhouseTeams });
      return res.json({ ok: true });

    case 'vote_to_roulette':
      state.roulette.items = state.vote.items.map((it, i) => ({
        label: it.label, weight: it.votes.length || 1, color: COLORS[i % COLORS.length]
      }));
      broadcast({ type: 'roulette_update', roulette: state.roulette });
      return res.json({ ok: true });

    case 'music_search': {
      const results = await searchYouTube(body.query, 8);
      return res.json({ ok: true, results });
    }
    case 'music_add': {
      const track = body.track;
      if (!track?.videoId) return res.json({ ok: false });
      if (!state.music.queue.some(t => t.videoId === track.videoId)) {
        state.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() });
        if (state.music.queue.length === 1) { state.music.currentIdx = 0; state.music.playing = true; }
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });
    }
    case 'music_next':
      if (state.music.queue.length) {
        state.music.currentIdx = (state.music.currentIdx + 1) % state.music.queue.length;
        state.music.playing = true;
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_prev':
      if (state.music.queue.length) {
        state.music.currentIdx = (state.music.currentIdx - 1 + state.music.queue.length) % state.music.queue.length;
        state.music.playing = true;
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_play_idx':
      state.music.currentIdx = body.idx;
      state.music.playing = true;
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_remove':
      state.music.queue.splice(body.idx, 1);
      if (state.music.currentIdx >= state.music.queue.length)
        state.music.currentIdx = Math.max(0, state.music.queue.length - 1);
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_clear':
      state.music = { queue: [], currentIdx: 0, playing: false };
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'get_state':
      return res.json(publicState());

    case 'test_point_command':
      handlePointCommand(body.nickname || '다비도');
      return res.json({ ok: true, bot: state.bot });

    case 'get_lcu_draft':
      return res.json({ ok: true, data: state.lcuDraft });

    case 'set_lcu_draft':
      updateLcuDraft({
        ...(body.data || {}),
        source: 'relay',
      });
      return res.json({ ok: true });

    default:
      return res.json({ error: 'unknown' }, 400);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('========================================');
  console.log(`  다비도의 내전 서버 실행 중`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  startLcuPolling();
});
