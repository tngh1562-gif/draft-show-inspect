const https = require('https');
const fs = require('fs');
const path = require('path');

const serverUrl = (process.argv[2] || process.env.DRAFT_SERVER_URL || 'http://localhost:3004').replace(/\/$/, '');
const relayToken = process.argv[3] || process.env.RELAY_TOKEN || '';

const lockfileCandidates = [
  () => process.env.LCU_LOCKFILE,
  () => process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Riot Games', 'League of Legends', 'lockfile'),
  () => 'C:\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
].filter(Boolean);

let lcuCreds = null;
let lastSig = '';

function findLockfile() {
  for (const getPath of lockfileCandidates) {
    const file = getPath();
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function readLockfile() {
  const file = findLockfile();
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

async function pushDraft(data) {
  const payload = { type: 'set_lcu_draft', data };
  if (relayToken) payload.token = relayToken;
  const res = await fetch(`${serverUrl}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`server_${res.status}`);
}

async function tick() {
  try {
    const nextCreds = readLockfile();
    if (!nextCreds) {
      lcuCreds = null;
      await pushIfChanged({ connected: false, inChampSelect: false, error: '롤 클라이언트를 찾지 못했습니다.', session: null });
      return;
    }
    lcuCreds = nextCreds;
    const session = await lcuRequest('/lol-champ-select/v1/session');
    await pushIfChanged({
      connected: true,
      inChampSelect: !!session,
      error: null,
      session: simplifyChampSelect(session),
    });
  } catch (err) {
    await pushIfChanged({
      connected: !!lcuCreds,
      inChampSelect: false,
      error: err.message,
      session: null,
    });
  }
}

async function pushIfChanged(next) {
  const data = { ...next, source: 'relay', updatedAt: Date.now() };
  const sig = JSON.stringify(data);
  if (sig === lastSig) return;
  lastSig = sig;
  await pushDraft(data);
  const status = data.inChampSelect ? 'champ-select' : (data.connected ? 'client-ready' : 'waiting-client');
  console.log(`[LCU RELAY] ${status} -> ${serverUrl}`);
}

console.log(`[LCU RELAY] sending local League client draft data to ${serverUrl}`);
setInterval(tick, 1200);
tick();
