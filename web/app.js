import {
  initSia, Builder, AppKey, generateRecoveryPhrase, setLogger, PinnedObject,
} from './vendor/sia-storage/dist/index.js';

const APP_ID = '821b0216228fcc9d6427c97a31093e1bb2f34f6e4c83df836d25b5f212126d08';
const INDEXER_URL = 'https://sia.storage';
const APP_META = {
  appId: APP_ID,
  name: 'Pomme',
  description: 'A relay drawing game on Sia.',
  serviceUrl: location.origin,
};

// ---------- DOM helpers ----------
const $ = id => document.getElementById(id);

// Managed timers: any setInterval/setTimeout that should die when the view
// transitions goes through these helpers. Prevents stale pollers / countdowns
// / reveal animations from racing newly-rendered views.
const _intervals = new Set();
const _timeouts = new Set();
function setTrackedInterval(fn, ms) {
  const id = setInterval(fn, ms);
  _intervals.add(id);
  return id;
}
function setTrackedTimeout(fn, ms) {
  const id = setTimeout(() => { _timeouts.delete(id); fn(); }, ms);
  _timeouts.add(id);
  return id;
}
function clearTrackedTimers() {
  for (const id of _intervals) clearInterval(id);
  for (const id of _timeouts) clearTimeout(id);
  _intervals.clear();
  _timeouts.clear();
}

const show = (id) => {
  clearTrackedTimers();
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $(id).hidden = false;
  // Chain-status block is shown explicitly by the views that want it.
  $('chain-status-section').hidden = true;
  // Inline progress is moved into the active view's slot only during an
  // operation; reset on every view transition.
  hideInlineProgress();
  restoreOperationalUI();
};

// Re-enable any form/button that gets temporarily disabled during an in-flight
// upload, so a transition out of the operation leaves the next-view UI usable.
function restoreOperationalUI() {
  if ($('start-btn')) $('start-btn').disabled = false;
  if ($('home-name')) $('home-name').disabled = false;
  if ($('gift-accept')) $('gift-accept').hidden = false;
  if ($('gift-name')) $('gift-name').disabled = false;
  if ($('holding-pass-btn')) $('holding-pass-btn').hidden = false;
  if ($('holding-tools')) $('holding-tools').hidden = false;
}

// Cache the user's potato bytes by hop ID so we can re-render the personal
// view (image + share link) without re-downloading from Sia. Lives in window
// memory; lost on full reload (lookback path will fall back to archive URL).
window.__hpPotatoBlobs = window.__hpPotatoBlobs || {};
const cachePotatoBlob = (hopID, blob) => { window.__hpPotatoBlobs[hopID] = blob; };
const getCachedPotatoBlob = (hopID) => window.__hpPotatoBlobs[hopID];
const setText = (id, s) => { const el = $(id); if (el) el.innerText = s; };

// ---------- name persistence ----------
const NAME_KEY = 'hp_name';
const getStoredName = () => localStorage.getItem(NAME_KEY) || '';
const setStoredName = (s) => localStorage.setItem(NAME_KEY, s);
const sanitizeName = (s) => (s || '').trim().slice(0, 32);

// Validates a name input; on empty, focuses + shakes + shows error and returns null.
function requireName(inputID, errID) {
  const input = $(inputID);
  const err = $(errID);
  const name = sanitizeName(input.value);
  if (!name) {
    if (err) err.hidden = false;
    input.classList.remove('error');
    void input.offsetWidth; // restart animation
    input.classList.add('error');
    input.focus();
    setTimeout(() => input.classList.remove('error'), 400);
    return null;
  }
  if (err) err.hidden = true;
  return name;
}
const displayName = (name, pubkey) => {
  if (name && name.trim()) return name;
  if (!pubkey) return 'Some poor unsuspecting soul';
  const m = pubkey.match(/^ed25519:([0-9a-f]{8})/);
  return m ? '@' + m[1] : pubkey;
};

// ---------- progress ----------
function setProgress(percent, stage) {
  const bar = $('progress-bar');
  if (percent === 'indeterminate') {
    bar.classList.add('indeterminate');
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }
  if (stage !== undefined) setText('progress-stages', stage);
}
function setProgressTitle(s) {
  const el = $('progress-title');
  if (!el) return;
  el.innerText = s || '';
  el.hidden = !s;
}

// Move the shared inline-progress block into the named slot in the active view.
function showInlineProgress(slotID) {
  const slot = $(slotID);
  const block = $('inline-progress');
  if (!slot || !block) return;
  slot.appendChild(block);
  block.hidden = false;
  // Reset bar visuals.
  $('progress-bar').classList.remove('indeterminate');
  $('progress-bar').style.width = '0%';
  $('approval-link').hidden = true;
}
function hideInlineProgress() {
  const block = $('inline-progress');
  if (block) block.hidden = true;
}

// ---------- Sia connect ----------
let sdk = null;
let appKey = null;

async function ensureSiaInit() {
  await initSia();
  if (!window.__hpLoggerInstalled) {
    setLogger(msg => console.log('[sia]', msg), 'info');
    window.__hpLoggerInstalled = true;
  }
}

async function tryRestoreSdk() {
  if (sdk) return sdk;
  const savedKeyHex = localStorage.getItem('hp_appkey');
  if (!savedKeyHex) return null;
  try {
    await ensureSiaInit();
    const builder = new Builder(INDEXER_URL, APP_META);
    const seed = new Uint8Array(savedKeyHex.match(/../g).map(b => parseInt(b, 16)));
    const ak = new AppKey(seed);
    const s = await builder.connected(ak);
    if (s) {
      sdk = s; appKey = ak;
      localStorage.setItem('hp_pubkey', s.appKey().publicKey());
      return s;
    }
  } catch (e) { console.warn('restore failed', e); }
  return null;
}

// freshConnect drives the approval flow, calling onProgress with stages.
async function freshConnect(onProgress) {
  await ensureSiaInit();
  onProgress?.(5, 'Connecting to sia.storage…');
  const builder = new Builder(INDEXER_URL, APP_META);
  await builder.requestConnection();
  const url = builder.responseUrl();
  const a = $('approval-link');
  if (a) {
    a.href = url; a.innerText = 'Open sia.storage to approve →'; a.target = '_blank'; a.hidden = false;
  }
  onProgress?.('indeterminate', 'Open the approval link, then approve. Waiting…');
  await builder.waitForApproval();
  if (a) a.hidden = true;
  onProgress?.(60, 'Approved. Generating your key…');
  const phrase = generateRecoveryPhrase();
  localStorage.setItem('hp_seed', phrase);
  const newSdk = await builder.register(phrase);
  appKey = newSdk.appKey();
  const keyBytes = appKey.export();
  localStorage.setItem('hp_appkey', Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  localStorage.setItem('hp_pubkey', newSdk.appKey().publicKey());
  sdk = newSdk;
  onProgress?.(75, 'Connected.');
  return newSdk;
}

async function getOrConnect(onProgress) {
  const restored = await tryRestoreSdk();
  if (restored) { onProgress?.(75, 'Connected.'); return restored; }
  return freshConnect(onProgress);
}

// ---------- potato image generation ----------
// Generates a clean potato (no baked-in text). The reveal text is a DOM overlay,
// not part of the image — that way drawings layered on top by recipients aren't
// fighting against pre-rendered captions.
async function generatePotatoBlob() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#3a1f04'); g.addColorStop(1, '#1a0e02');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
  const pg = ctx.createRadialGradient(256, 240, 60, 256, 256, 220);
  pg.addColorStop(0, '#e3a96b'); pg.addColorStop(0.7, '#a86d2c'); pg.addColorStop(1, '#5e3812');
  ctx.fillStyle = pg;
  ctx.beginPath(); ctx.ellipse(256, 270, 200, 230, 0, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (const [x, y, r] of [[180, 200, 12], [310, 230, 16], [220, 320, 10], [330, 360, 14], [180, 380, 11]]) {
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.7, 0, 0, 2 * Math.PI); ctx.fill();
  }
  return await new Promise(r => c.toBlob(r, 'image/png'));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(hash));
}

// ---------- Sia upload + share with progress ----------
//
// Each upload produces TWO share URLs:
//   - shareUrl: 24h validity. This is the gameplay link — Sia's own URL TTL is
//     the chain's pass deadline. If 24h elapses without the heir claiming, the
//     URL dies and the next person can no longer fetch the potato. The 24h rule
//     is enforced by the network itself, not just our server.
//   - archiveUrl: 30 days. Same underlying object; this URL is used by the
//     chain status page so the chain remains viewable long after the gameplay
//     deadline has lapsed.
// Upload, pin, and share. Upload and pin are retried independently — a failed
// pin doesn't force re-uploading the whole blob.
async function uploadPotato(sdk, blob, onShard, onPhase, onAttempt) {
  const uploadAttempts = 3;
  let obj, lastErr;
  for (let i = 1; i <= uploadAttempts; i++) {
    onAttempt?.(i, uploadAttempts);
    onPhase?.('uploading', i, uploadAttempts);
    try {
      obj = await sdk.upload(new PinnedObject(), blob.stream(), {
        maxInflight: 20,
        onShardUploaded: onShard,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`upload attempt ${i}/${uploadAttempts} failed:`, e);
      if (i < uploadAttempts) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;

  const pinAttempts = 3;
  for (let i = 1; i <= pinAttempts; i++) {
    onPhase?.('pinning', i, pinAttempts);
    try {
      await sdk.pinObject(obj);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`pin attempt ${i}/${pinAttempts} failed:`, e);
      if (i < pinAttempts) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;

  onPhase?.('sharing', 1, 1);
  const passUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const archiveUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const shareUrl = sdk.shareObject(obj, passUntil);
  const archiveUrl = sdk.shareObject(obj, archiveUntil);
  return { id: obj.id(), shareUrl, archiveUrl };
}
async function downloadShared(sdk, sharedUrl, onShard) {
  const obj = await sdk.sharedObject(sharedUrl);
  const stream = sdk.download(obj, { onShardDownloaded: onShard });
  return await new Response(stream).blob();
}

// ---------- views ----------

function viewHome() {
  show('view-home');
  $('home-name').value = getStoredName();
  $('start-btn').onclick = startChain;
  loadHomeChains();
}

async function loadHomeChains() {
  const pubkey = localStorage.getItem('hp_pubkey');
  if (!pubkey) return;
  try {
    const r = await fetch('/api/chains?pubkey=' + encodeURIComponent(pubkey));
    if (!r.ok) return;
    const chains = await r.json();
    if (!chains || chains.length === 0) return;
    const list = $('home-chains-list');
    list.innerHTML = '';
    for (const c of chains) {
      list.appendChild(renderChainSummary(c));
    }
    $('home-chains-section').hidden = false;
  } catch (e) {
    console.warn('loadHomeChains', e);
  }
}

function renderChainSummary(c) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = '/p/' + c.user_hop_id;

  const badge = document.createElement('span');
  badge.className = 'chain-summary-badge ' + c.status;
  badge.innerText = ({ alive: '🔥 LIVE', won: '🎉 WON', killed: '💀 KILL' })[c.status] || c.status;

  const body = document.createElement('div');
  body.className = 'chain-summary-body';

  const line = document.createElement('div');
  line.className = 'chain-summary-line';
  line.innerText = chainSummaryLine(c);

  const meta = document.createElement('div');
  meta.className = 'chain-summary-meta';
  const ago = relativeTime(c.created_at);
  if (c.status === 'alive') {
    meta.innerText = `currently at hop ${c.current_hop_index}/${c.chain_total} · started ${ago}`;
  } else if (c.status === 'won') {
    meta.innerText = `🎉 reached all ${c.chain_total} hops · started ${ago}`;
  } else if (c.status === 'killed') {
    const killer = displayName(c.killer_name, c.killer_pubkey);
    meta.innerText = `killed by ${killer} (${humanizeKillReason(c.kill_reason)}) · started ${ago}`;
  }

  body.appendChild(line);
  body.appendChild(meta);
  a.appendChild(badge);
  a.appendChild(body);
  li.appendChild(a);
  return li;
}

function chainSummaryLine(c) {
  const isOriginator = c.user_hop_index === 0;
  const isFinal = c.user_hop_index === c.chain_total - 1;
  const passed = c.user_hop_status === 'passed';
  // For non-originators a predecessor must exist; for won chains where the user
  // isn't final, a successor must exist. If the server didn't include those
  // fields, fall back to "someone" rather than rendering literal "null".
  const expectsPred = !isOriginator;
  const expectsSucc = c.status === 'won' && !isFinal;
  const pred = c.predecessor_pubkey
    ? displayName(c.predecessor_name, c.predecessor_pubkey)
    : (expectsPred ? 'someone' : null);
  const succ = c.successor_pubkey
    ? displayName(c.successor_name, c.successor_pubkey)
    : (expectsSucc ? 'someone' : null);

  if (isFinal && c.status === 'won') {
    return `${pred} gave you a potato, and it cooled off`;
  }
  if (isOriginator) {
    if (succ) return `You baked a potato and gave it to ${succ}`;
    return passed ? `You baked a potato — waiting for someone to claim it` : `You baked a potato`;
  }
  if (succ) return `${pred} handed you a potato, and you gave it to ${succ}`;
  if (passed) return `${pred} handed you a potato — waiting for someone to claim it`;
  return `${pred} handed you a potato`;
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
  return Math.floor(ms / 86_400_000) + 'd ago';
}

async function startChain() {
  const name = requireName('home-name', 'home-name-err');
  if (!name) return;
  setStoredName(name);
  const startBtn = $('start-btn');
  startBtn.disabled = true;
  $('home-name').disabled = true;

  showInlineProgress('home-progress-slot');
  setProgressTitle('Baking your hot potato…');
  let blobForCache;
  setProgress(0, 'Starting…');

  try {
    const s = await getOrConnect((pct, stage) => setProgress(pct, stage));

    setProgress(78, 'Generating potato image…');
    const blob = await generatePotatoBlob();
    blobForCache = blob;
    const rootHash = await sha256Hex(blob);

    setProgress(80, 'Uploading to your Sia account (~30s)…');
    let seen = new Set();
    let attempt = 1, totalAttempts = 1;
    const TOTAL_SHARDS = 30;
    const note = () => attempt > 1 ? ` (try ${attempt}/${totalAttempts})` : '';
    const onShard = (p) => {
      seen.add(`${p.slabIndex}:${p.shardIndex}`);
      const done = Math.min(seen.size, TOTAL_SHARDS);
      const pct = 78 + (done / TOTAL_SHARDS) * 12;
      setProgress(pct, `Uploading to Sia: ${done}/${TOTAL_SHARDS} shards${note()}`);
    };
    const onPhase = (phase, n, total) => {
      const tryNote = n > 1 ? ` (try ${n}/${total})` : '';
      if (phase === 'pinning') setProgress(91, `Pinning to your Sia account${tryNote}`);
      if (phase === 'sharing') setProgress(93, 'Generating share link');
    };
    const onAttempt = (n, total) => {
      attempt = n; totalAttempts = total; seen = new Set();
      if (n > 1) setProgress(78, `Retrying upload (try ${n}/${total})…`);
    };
    const { shareUrl, archiveUrl } = await uploadPotato(s, blob, onShard, onPhase, onAttempt);

    setProgress(96, 'Registering chain on the server…');
    const pubkey = s.appKey().publicKey();
    const msg = 'chain:create:' + shareUrl + ':' + archiveUrl + ':' + rootHash;
    const sigHex = bytesToHex(s.appKey().sign(new TextEncoder().encode(msg)));
    const resp = await fetch('/api/chain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holder_pubkey: pubkey, holder_name: name,
        share_url: shareUrl, archive_url: archiveUrl,
        root_hash: rootHash, signature: sigHex,
      }),
    });
    if (!resp.ok) throw new Error('chain create failed: ' + await resp.text());
    const data = await resp.json();

    setProgress(100, 'Done.');
    // Cache the blob so showLookback can render it without re-downloading,
    // then navigate the URL to the user's own hop page (without a full reload).
    cachePotatoBlob(data.root_hop_id, blobForCache);
    history.pushState(null, '', '/p/' + data.root_hop_id);
    viewHop(data.root_hop_id);
  } catch (e) {
    console.error(e);
    show('view-error');
    setText('error-text', e?.message ?? String(e));
  }
}

async function viewHop(hopID) {
  show('view-loading');
  setText('loading-text', 'Looking up your gift…');
  const resp = await fetch('/api/hop/' + hopID);
  if (!resp.ok) {
    show('view-error');
    setText('error-text', 'This link is invalid or expired.');
    return;
  }
  const hop = await resp.json();

  if (hop.chain_status === 'killed') {
    show('view-killed');
    setText('killed-killer', displayName(hop.chain_killer_name, hop.chain_killer_pubkey));
    setText('killed-reason', humanizeKillReason(hop.chain_kill_reason));
    $('killed-chain-link').href = '/chain/' + hop.chain_id;
    return;
  }

  if (hop.status === 'unclaimed') {
    showUnclaimed(hopID, hop);
  } else if (hop.status === 'claimed') {
    const restored = await tryRestoreSdk();
    if (restored && restored.appKey().publicKey() === hop.holder_pubkey) {
      showHolding(hopID, hop, restored);
    } else {
      showAlreadyClaimed(hop);
    }
  } else {
    // status === 'passed'
    const restored = await tryRestoreSdk();
    if (restored && restored.appKey().publicKey() === hop.holder_pubkey) {
      showLookback(hop);
    } else {
      showAlreadyClaimed(hop);
    }
  }
}

// Show view-passed for a hop the user has already passed.
// Used both for the originator's freshly-created chain and for revisits.
async function showLookback(hop) {
  show('view-passed');

  // Image: prefer the in-memory cache (fast, available right after creation /
  // pass), fall back to a download via the long-lived archive URL.
  const img = $('passed-img');
  img.hidden = false;
  const cached = getCachedPotatoBlob(hop.id);
  if (cached) {
    img.src = URL.createObjectURL(cached);
  } else {
    img.src = '';
    const sdk = await tryRestoreSdk();
    const url = hop.archive_url || hop.share_url;
    if (sdk && url) {
      try {
        const blob = await downloadShared(sdk, url);
        cachePotatoBlob(hop.id, blob);
        img.src = URL.createObjectURL(blob);
      } catch { img.hidden = true; }
    } else {
      img.hidden = true;
    }
  }

  const isWon = hop.chain_status === 'won';
  const isFinal = !hop.next_link;
  const isLive = !isWon && !isFinal;

  // Title + intro line vary by state.
  const title = $('passed-title');
  const line = $('passed-line');
  if (isWon) {
    title.innerText = 'The potato has fully cooled off — you win!';
    line.innerText = '';
    line.hidden = true;
  } else {
    title.innerText = '🥔 Potato Baked.';
    line.innerHTML = `Keep the chain alive by sending someone else this link. But choose your victim carefully: <strong>if more than one person uses your link, the chain dies.</strong> (In other words: don&apos;t post your link publicly in the hopes of getting a bite!)`;
    line.hidden = false;
  }

  // Link row + copy button only when there's still a successor to claim.
  $('passed-link-row').hidden = !isLive;
  if (isLive) {
    $('passed-url').value = hop.next_link;
    const copyBtn = $('passed-copy');
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(hop.next_link);
      copyBtn.innerText = 'Copied!';
      setTimeout(() => { copyBtn.innerText = 'Copy link'; }, 1500);
    };
  }

  // Countdown only matters while we're watching for an heir.
  $('passed-countdown').hidden = !isLive;

  // Watch banner: alive when waiting, hidden otherwise.
  const banner = $('passed-watch');
  if (isLive) {
    banner.className = 'banner banner-alive';
    banner.innerHTML = '⏳ Watching for someone to accept your link…';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // Win screen: cycle through every hop's potato, 2s per frame.
  if (isWon) startWinAnimation(hop.chain_id, $('passed-img'));

  if (isLive && hop.next_hop_id) watchNextHop(hop.next_hop_id, hop.chain_id);
  loadChainStatus(hop.chain_id, hop.id);
}

async function startWinAnimation(chainID, imgEl) {
  const sdk = await tryRestoreSdk();
  let data;
  try {
    data = await (await fetch('/api/chain/' + chainID)).json();
  } catch { return; }
  const hops = (data.hops || []).slice().sort((a, b) => a.index - b.index);

  const blobs = [];
  let activeUrl = null;
  const setFrame = (blob) => {
    const url = URL.createObjectURL(blob);
    imgEl.src = url;
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = url;
  };
  let started = false;
  let frameIdx = 0;
  const start = () => {
    if (started || blobs.length === 0) return;
    started = true;
    setFrame(blobs[0]);
    setTrackedInterval(() => {
      if (blobs.length === 0) return;
      frameIdx = (frameIdx + 1) % blobs.length;
      setFrame(blobs[frameIdx]);
    }, 2000);
  };

  for (const h of hops) {
    let blob = getCachedPotatoBlob(h.id);
    if (!blob && sdk) {
      const url = h.archive_url || h.share_url;
      if (!url) continue;
      try {
        blob = await downloadShared(sdk, url);
        cachePotatoBlob(h.id, blob);
      } catch { continue; }
    }
    if (blob) {
      blobs.push(blob);
      if (!started) start();
    }
  }
  start();
}

function humanizeKillReason(reason) {
  switch (reason) {
    case 'double_claim': return 'spammed the link to multiple people';
    case 'expired_unclaimed': return 'failed to find an heir within 24 hours';
    case 'ghosted': return 'accepted the potato but never passed it on';
    default: return reason || 'killed the chain';
  }
}

function showUnclaimed(hopID, hop) {
  show('view-gift');
  $('gift-name').value = getStoredName();
  $('gift-accept').onclick = () => acceptHop(hopID, hop);
  pollHop(hopID, 'unclaimed');
}

function pollHop(hopID, expectedStatus) {
  setTrackedInterval(async () => {
    try {
      const r = await fetch('/api/hop/' + hopID);
      if (!r.ok) return;
      const h = await r.json();
      if (h.status !== expectedStatus || h.chain_status !== 'alive') {
        viewHop(hopID); // show() inside will clear all tracked timers
      }
    } catch { /* ignore */ }
  }, 4000);
}

async function acceptHop(hopID, hop) {
  const name = requireName('gift-name', 'gift-name-err');
  if (!name) return;
  setStoredName(name);

  // Hide the gift form and show progress inline within the gift view.
  $('gift-accept').hidden = true;
  $('gift-name').disabled = true;
  showInlineProgress('gift-progress-slot');
  setProgressTitle('Receiving your gift…');
  setProgress(0, 'Starting…');

  try {
    const s = await getOrConnect((pct, stage) => setProgress(pct, stage));

    setProgress(80, 'Signing for the package…');
    const initResp = await fetch(`/api/hop/${hopID}/sign-init`, { method: 'POST' });
    if (!initResp.ok) {
      const err = await initResp.json().catch(() => ({}));
      if (initResp.status === 410 || initResp.status === 409) {
        // hop transitioned out from under us; re-render fresh
        viewHop(hopID);
        return;
      }
      throw new Error('sign-init: ' + (err.error || initResp.status));
    }
    const { nonce } = await initResp.json();
    const pubkey = s.appKey().publicKey();
    const msg = `accept:${hopID}:${nonce}`;
    const sigHex = bytesToHex(s.appKey().sign(new TextEncoder().encode(msg)));

    setProgress(92, 'Recording your acceptance…');
    const signResp = await fetch(`/api/hop/${hopID}/sign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey, name, nonce, signature: sigHex }),
    });
    if (!signResp.ok) {
      const err = await signResp.json().catch(() => ({}));
      if (signResp.status === 410) {
        // chain killed by this attempt (double-claim scenario)
        show('view-killed');
        setText('killed-killer', displayName(hop.parent_name, hop.parent_pubkey));
        setText('killed-reason', err.error || 'chain dead');
        $('killed-chain-link').href = '/chain/' + hop.chain_id;
        return;
      }
      if (signResp.status === 409) {
        // either already claimed, or self-pass attempt
        show('view-error');
        setText('error-text', err.error || 'cannot claim');
        return;
      }
      throw new Error('sign: ' + (err.error || signResp.status));
    }

    setProgress(100, 'Accepted.');
    const hopResp = await fetch('/api/hop/' + hopID);
    const fresh = await hopResp.json();
    showHolding(hopID, fresh, s);
  } catch (e) {
    console.error(e);
    show('view-error');
    setText('error-text', e?.message ?? String(e));
  }
}

function buildGuiltText(predNames) {
  const named = predNames.filter(n => n && n.trim());
  if (predNames.length === 0) return '';
  if (named.length === 0) return `${predNames.length} ${predNames.length === 1 ? 'person' : 'people'} before you kept this chain alive. Don't break it.`;
  const list = named.length === 1
    ? `<span class="guilt-names">${escapeHtml(named[0])}</span>`
    : named.length === 2
      ? `<span class="guilt-names">${escapeHtml(named[0])}</span> and <span class="guilt-names">${escapeHtml(named[1])}</span>`
      : named.slice(0, -1).map(n => `<span class="guilt-names">${escapeHtml(n)}</span>`).join(', ') +
        `, and <span class="guilt-names">${escapeHtml(named[named.length - 1])}</span>`;
  const verb = predNames.length === 1 ? 'is' : 'are';
  return `${list} ${verb} counting on you to keep this chain alive. Don't be the one who breaks it.`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function showHolding(hopID, hop, s) {
  show('view-holding');

  // Retry path: canvas was already initialized for this hop (e.g. after a failed
  // pass). Skip download + reveal animation; the user's drawing is preserved in
  // the canvas DOM element across view transitions.
  if (window.__hpHoldingHopID === hopID) {
    $('holding-stage-download').hidden = true;
    $('holding-stage-canvas').hidden = false;
    document.querySelectorAll('#reveal-top .reveal-word, #reveal-top .reveal-line-big').forEach(el => el.classList.add('show'));
    $('reveal-bottom').hidden = false;
    $('reveal-bottom').classList.add('show');
    setupHoldingTools(hopID, hop, s);
    const tools = $('holding-stage-tools');
    tools.hidden = false;
    tools.classList.add('show');
    loadChainStatus(hop.chain_id, hopID);
    return;
  }

  // Fresh path: reset every stage and start the download.
  $('holding-stage-download').hidden = false;
  $('holding-stage-canvas').hidden = true;
  document.querySelectorAll('#reveal-top .reveal-word, #reveal-top .reveal-line-big').forEach(el => el.classList.remove('show'));
  $('reveal-bottom').hidden = true;
  $('reveal-bottom').classList.remove('show');
  $('holding-stage-tools').hidden = true;
  $('holding-stage-tools').classList.remove('show');
  $('holding-canvas').dataset.edited = '';

  await downloadIntoHolding(hopID, hop, s);
}

async function downloadIntoHolding(hopID, hop, s) {
  setText('holding-img-status', 'Unwrapping your gift…');
  removeRetryButton();
  try {
    const startedAt = performance.now();
    const blob = await downloadShared(s, hop.parent_share_url);
    // Always linger on the gift box for at least 3 seconds — the suspense is the point.
    const elapsed = performance.now() - startedAt;
    if (elapsed < 3000) {
      await new Promise(r => setTrackedTimeout(r, 3000 - elapsed));
    }
    await revealPotato(blob, hopID, hop, s);
  } catch (e) {
    setText('holding-img-status', 'Download failed: ' + (e?.message ?? e));
    addRetryButton('holding-img-status', 'Retry download', () => downloadIntoHolding(hopID, hop, s));
  }
}

// Run the choreographed reveal: clean potato → words drop in → bottom text → tools.
async function revealPotato(blob, hopID, hop, s) {
  $('holding-stage-download').hidden = true;
  await paintBlobOntoCanvas($('holding-canvas'), blob);
  initCanvasDrawing($('holding-canvas'));
  $('holding-stage-canvas').hidden = false;

  window.__hpHoldingHopID = hopID;
  window.__hpHoldingParentBlob = blob;

  const isFinal = hop.index >= (hop.chain_total - 1);
  const words = document.querySelectorAll('#reveal-top .reveal-word');
  const big = document.querySelector('#reveal-top .reveal-line-big');
  if (big) big.textContent = isFinal ? "POTATO'D" : "HOT POTATO'D";
  setTrackedTimeout(() => words[0]?.classList.add('show'), 1000);   // "You"
  setTrackedTimeout(() => words[1]?.classList.add('show'), 2000);   // "just"
  setTrackedTimeout(() => words[2]?.classList.add('show'), 3000);   // "got"
  setTrackedTimeout(() => big?.classList.add('show'), 4000);        // "(HOT) POTATO'D"
  setTrackedTimeout(() => {
    const bot = $('reveal-bottom');
    const from = displayName(hop.parent_name, hop.parent_pubkey);
    const passes = hop.index;
    const timesWord = passes === 1 ? 'time' : 'times';
    bot.innerHTML = isFinal
      ? `${escapeHtml(from)} dropped a pleasantly-warm potato in your lap! After being passed around ${passes} ${timesWord}, it is no longer too hot to handle. You win!`
      : `${escapeHtml(from)} dropped a hot potato in your lap! Don&apos;t get burned — pass it on to another gullible sap within 24 hours.`;
    bot.hidden = false;
    requestAnimationFrame(() => bot.classList.add('show'));
  }, 5000);
  setTrackedTimeout(() => {
    setupHoldingTools(hopID, hop, s);
    const tools = $('holding-stage-tools');
    tools.hidden = false;
    requestAnimationFrame(() => tools.classList.add('show'));
    loadChainStatus(hop.chain_id, hopID);
  }, 8000);
}

function setupHoldingTools(hopID, hop, s) {
  const passBtn = $('holding-pass-btn');
  const isFinal = hop.index >= (hop.chain_total - 1);
  const defaultLabel = isFinal ? 'Commemorate Your Victory' : 'Finalize';
  passBtn.textContent = defaultLabel;
  passBtn.disabled = false;
  passBtn.hidden = false;
  passBtn.onclick = () => {
    if (passBtn.disabled) return;
    if ($('holding-canvas').dataset.edited !== '1') {
      passBtn.textContent = 'You must customize your potato';
      setTimeout(() => { passBtn.textContent = defaultLabel; }, 2200);
      return;
    }
    passBtn.disabled = true;
    passHop(hopID, hop, s);
  };
  startCountdown(hop.expires_at, 'holding-countdown');
}

async function paintBlobOntoCanvas(canvas, blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Wire up drawing on a fresh canvas. Idempotent for a given canvas.
function initCanvasDrawing(canvas) {
  if (canvas.dataset.drawingReady === '1') return;
  canvas.dataset.drawingReady = '1';

  const ctx = canvas.getContext('2d');
  let color = '#000000';
  let brush = 5;
  let drawing = false;
  let last = null;
  const undoStack = [];

  const eventToPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * (canvas.width / rect.width),
      (e.clientY - rect.top) * (canvas.height / rect.height),
    ];
  };

  const beginStroke = (e) => {
    drawing = true;
    last = eventToPoint(e);
    if (undoStack.length >= 25) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    canvas.setPointerCapture?.(e.pointerId);
    // Draw a single dot at the start so a tap leaves a mark.
    ctx.beginPath();
    ctx.arc(last[0], last[1], brush / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    canvas.dataset.edited = '1';
  };
  const continueStroke = (e) => {
    if (!drawing) return;
    const p = eventToPoint(e);
    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brush;
    ctx.strokeStyle = color;
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  };
  const endStroke = (e) => {
    drawing = false;
    canvas.releasePointerCapture?.(e.pointerId);
  };

  canvas.addEventListener('pointerdown', beginStroke);
  canvas.addEventListener('pointermove', continueStroke);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', e => { if (drawing) endStroke(e); });

  // Color & brush controls (delegated, so they work even after re-renders).
  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.onclick = () => {
      color = btn.dataset.color;
      document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });
  document.querySelectorAll('.brush-size').forEach(btn => {
    btn.onclick = () => {
      brush = parseInt(btn.dataset.size, 10);
      document.querySelectorAll('.brush-size').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });
  $('canvas-undo').onclick = () => {
    const snap = undoStack.pop();
    if (snap) ctx.putImageData(snap, 0, 0);
    if (undoStack.length === 0) canvas.dataset.edited = '';
  };
}

function addRetryButton(siblingID, label, onClick) {
  const sibling = $(siblingID);
  if (!sibling) return;
  removeRetryButton();
  const btn = document.createElement('button');
  btn.id = 'retry-btn';
  btn.className = 'big-btn';
  btn.innerText = label;
  btn.onclick = () => { btn.remove(); onClick(); };
  sibling.parentNode.insertBefore(btn, sibling.nextSibling);
}

function removeRetryButton() {
  const btn = $('retry-btn');
  if (btn) btn.remove();
}

// Render the shared chain-status block (banner + hop list with images) into
// #chain-status-section. Used by every personal-potato view (originator/heir,
// holding/passed) so the chain context lives on the same page.
async function loadChainStatus(chainID, currentHopID) {
  const section = $('chain-status-section');
  section.hidden = false;

  let data;
  try {
    data = await (await fetch('/api/chain/' + chainID)).json();
  } catch { return; }

  const list = $('chain-status-list');
  list.innerHTML = '';
  const aliveChain = data.status === 'alive';
  const cachedBlobs = new Map();

  for (const hop of data.hops) {
    const li = document.createElement('li');
    li.className = 'chain-hop chain-hop-' + hop.status;
    if (hop.id === currentHopID) li.classList.add('chain-hop-you');

    const imgBox = document.createElement('div');
    imgBox.className = 'chain-hop-img';
    const cached = getCachedPotatoBlob(hop.id);
    if (cached) {
      const im = document.createElement('img');
      im.src = URL.createObjectURL(cached);
      imgBox.appendChild(im);
      cachedBlobs.set(hop.id, cached);
      li.style.cursor = 'pointer';
      li.onclick = () => openHistoryModal(hop, cached);
    } else if (hop.share_url || hop.archive_url) {
      imgBox.classList.add('loading');
    } else {
      const ph = document.createElement('span');
      ph.className = 'placeholder';
      ph.innerText = '?';
      imgBox.appendChild(ph);
    }

    const body = document.createElement('div');
    body.className = 'chain-hop-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'chain-hop-name';
    const youSuffix = hop.id === currentHopID ? ' (you)' : '';
    nameEl.innerText = displayName(hop.holder_name, hop.holder_pubkey) + youSuffix;
    const metaEl = document.createElement('div');
    metaEl.className = 'chain-hop-meta';

    if (hop.status === 'passed') {
      if (hop.index === 0) {
        metaEl.innerText = `started the chain · ${relativeTime(hop.created_at)}`;
      } else {
        const remainingMs = new Date(hop.expires_at).getTime() - new Date(hop.passed_at).getTime();
        metaEl.innerText = `passed with ${formatDuration(remainingMs)} to spare`;
      }
    } else if (hop.status === 'claimed') {
      if (aliveChain) {
        metaEl.classList.add('chain-hop-live');
        metaEl.dataset.expiresAt = hop.expires_at;
        metaEl.innerText = '…';
      } else {
        metaEl.innerText = 'was holding when the chain died';
      }
    } else if (hop.status === 'unclaimed') {
      if (aliveChain) {
        metaEl.classList.add('chain-hop-live');
        metaEl.dataset.expiresAt = hop.expires_at;
        metaEl.innerText = '…';
      } else {
        metaEl.innerText = 'potato was never taken';
      }
    }

    body.appendChild(nameEl);
    body.appendChild(metaEl);
    li.appendChild(imgBox);
    li.appendChild(body);
    list.appendChild(li);
  }

  if (aliveChain && document.querySelector('#chain-status-list .chain-hop-live')) {
    const tick = () => {
      document.querySelectorAll('#chain-status-list .chain-hop-live').forEach(el => {
        const ms = new Date(el.dataset.expiresAt).getTime() - Date.now();
        el.innerText = ms <= 0 ? 'EXPIRED' : `${formatDuration(ms)} remaining`;
      });
    };
    tick();
    setTrackedInterval(tick, 1000);
  }

  // Fetch any thumbnails we don't already have. Prefer archive URL.
  const sdk = await tryRestoreSdk();
  if (sdk) {
    const items = list.querySelectorAll('.chain-hop');
    const hopElByIndex = new Map();
    data.hops.forEach((h, i) => hopElByIndex.set(h.index, items[i]));
    for (const hop of data.hops) {
      if (cachedBlobs.has(hop.id)) continue;
      const url = hop.archive_url || hop.share_url;
      if (!url) continue;
      const el = hopElByIndex.get(hop.index);
      const box = el?.querySelector('.chain-hop-img');
      if (!box) continue;
      try {
        const blob = await downloadShared(sdk, url);
        cachePotatoBlob(hop.id, blob);
        const im = document.createElement('img');
        im.src = URL.createObjectURL(blob);
        box.classList.remove('loading');
        box.appendChild(im);
        if (el) {
          el.style.cursor = 'pointer';
          el.onclick = () => openHistoryModal(hop, blob);
        }
      } catch {
        box.classList.remove('loading');
        const ph = document.createElement('span');
        ph.className = 'placeholder';
        ph.innerText = '…';
        box.appendChild(ph);
      }
    }
    if (data.status === 'alive') {
      checkChainLiveness(data, sdk, '#chain-status-list');
    }
  } else {
    list.querySelectorAll('.chain-hop-img.loading').forEach(box => {
      box.classList.remove('loading');
      const ph = document.createElement('span');
      ph.className = 'placeholder';
      ph.innerText = '🥔';
      box.appendChild(ph);
    });
  }
}

function openHistoryModal(hop, blob) {
  const modal = $('history-modal');
  const img = $('history-modal-img');
  img.src = URL.createObjectURL(blob);
  setText('history-modal-title', `Hop ${hop.index} · ${displayName(hop.holder_name, hop.holder_pubkey)}`);
  modal.hidden = false;
}
function closeHistoryModal() {
  const modal = $('history-modal');
  modal.hidden = true;
  const img = $('history-modal-img');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = '';
}

async function passHop(hopID, hop, s) {
  // Snapshot the canvas (image + the user's drawing) at pass time.
  const canvas = $('holding-canvas');
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) {
    show('view-error');
    setText('error-text', 'image blob missing — please reload');
    return;
  }
  // Inline progress inside the holding view: hide drawing tools + button while
  // the upload runs.
  $('holding-pass-btn').hidden = true;
  $('holding-tools').hidden = true;
  showInlineProgress('holding-progress-slot');
  setProgressTitle('');
  setProgress(0, 'Preparing your masterpiece…');

  try {
    let seen = new Set();
    let attempt = 1, totalAttempts = 1;
    const TOTAL_SHARDS = 30;
    const note = () => attempt > 1 ? ` (try ${attempt}/${totalAttempts})` : '';
    const onShard = (p) => {
      seen.add(`${p.slabIndex}:${p.shardIndex}`);
      const done = Math.min(seen.size, TOTAL_SHARDS);
      const pct = (done / TOTAL_SHARDS) * 80;
      setProgress(pct, `Uploading your masterpiece to Sia: ${done}/${TOTAL_SHARDS} shards${note()}`);
    };
    const onPhase = (phase, n, total) => {
      const tryNote = n > 1 ? ` (try ${n}/${total})` : '';
      if (phase === 'pinning') setProgress(83, `Pinning to your account${tryNote}`);
      if (phase === 'sharing') setProgress(88, 'Generating share link');
    };
    const onAttempt = (n, total) => {
      attempt = n; totalAttempts = total; seen = new Set();
      if (n > 1) setProgress(2, `Retrying upload (try ${n}/${total})…`);
    };
    setProgress(2, 'Uploading your masterpiece to your Sia account…');
    const { shareUrl, archiveUrl } = await uploadPotato(s, blob, onShard, onPhase, onAttempt);

    setProgress(92, 'Notifying the server…');
    const msg = `pass:${hopID}:${shareUrl}:${archiveUrl}`;
    const sigHex = bytesToHex(s.appKey().sign(new TextEncoder().encode(msg)));
    const resp = await fetch(`/api/hop/${hopID}/pass`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_url: shareUrl, archive_url: archiveUrl, signature: sigHex }),
    });
    if (!resp.ok) throw new Error('pass failed: ' + await resp.text());
    const data = await resp.json();

    setProgress(100, 'Passed.');
    // Cache the canvas snapshot so the lookback view renders instantly.
    cachePotatoBlob(hopID, blob);
    // Re-route to the unified personal-potato view at /p/{hopID} — it now
    // handles both alive and won states (with a victory banner when applicable).
    viewHop(hopID);
  } catch (e) {
    console.error('pass failed', e);
    showHolding(hopID, hop, s);
    setTimeout(() => {
      setText('holding-img-status', 'Pass failed: ' + (e?.message ?? e) + '. Click "Finalize" again.');
    }, 50);
  }
}

// Poll the next hop until it's claimed (we're off the hook), expires
// (chain dies and we're the killer), or the chain is otherwise resolved.
async function watchNextHop(nextHopID, chainID) {
  const initial = await fetch('/api/hop/' + nextHopID).then(r => r.ok ? r.json() : null).catch(() => null);
  if (initial?.expires_at) startCountdown(initial.expires_at, 'passed-countdown');

  setTrackedInterval(async () => {
    try {
      const r = await fetch('/api/hop/' + nextHopID);
      if (!r.ok) return;
      const h = await r.json();
      if (h.chain_status === 'killed') {
        const banner = $('passed-watch');
        banner.className = 'banner banner-dead';
        banner.innerHTML = `💀 The chain died. <a href="/chain/${chainID}">See what happened →</a>`;
        clearTrackedTimers();
      } else if (h.chain_status === 'won') {
        const banner = $('passed-watch');
        banner.className = 'banner banner-won';
        banner.innerHTML = `🎉 The chain WON! Everyone in the chain (including you) wins.`;
        clearTrackedTimers();
      } else if (h.status === 'claimed' || h.status === 'passed') {
        const banner = $('passed-watch');
        banner.className = 'banner banner-won';
        const name = displayName(h.holder_name, h.holder_pubkey);
        banner.innerHTML = `✅ <strong>${escapeHtml(name)}</strong> accepted your link — you're off the hook.`;
        clearTrackedTimers();
      }
    } catch { /* ignore */ }
  }, 6000);
}

function showAlreadyClaimed(hop) {
  show('view-toolate');
  setText('toolate-holder', displayName(hop.holder_name, hop.holder_pubkey));
  $('toolate-chain-link').href = '/chain/' + hop.chain_id;
}

function startCountdown(expiresAt, elementID) {
  const expiry = new Date(expiresAt).getTime();
  const tick = () => {
    const ms = expiry - Date.now();
    if (ms <= 0) { setText(elementID, 'EXPIRED'); return; }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    setText(elementID, `${h}h ${m}m ${sec}s remaining`);
  };
  tick();
  setTrackedInterval(tick, 1000);
}


function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// Probe the latest-passed hop's share URL via the indexer. Resolution-only,
// no host fetch. If it fails, the chain is dead (URL expired) and we update
// the unclaimed hop's meta line in place. Runs in the background.
async function checkChainLiveness(data, sdk, listSel) {
  const sortedDesc = [...data.hops].sort((a, b) => b.index - a.index);
  const latest = sortedDesc[0];
  if (!latest || latest.status !== 'unclaimed') return;
  const parent = data.hops.find(h => h.id === latest.parent_hop_id);
  if (!parent?.share_url) return;
  try {
    await sdk.sharedObject(parent.share_url);
  } catch {
    document.querySelectorAll(`${listSel} .chain-hop-live`).forEach(el => {
      el.classList.remove('chain-hop-live');
      el.innerText = 'potato was never taken';
    });
  }
}

// ---------- router ----------
function route() {
  const path = location.pathname;
  if (path === '/' || path === '') {
    viewHome();
  } else if (path.startsWith('/p/')) {
    viewHop(path.slice(3));
  } else if (path.startsWith('/chain/')) {
    // Legacy URL — chain status now lives inside each user's own hop page.
    location.replace('/');
  } else {
    show('view-error');
    setText('error-text', 'Unknown page.');
  }
}

window.addEventListener('popstate', () => route());

// Try to dispose the SDK on unload so Firefox can tear down WebTransport
// sessions promptly instead of letting them dangle and slow down the next page.
window.addEventListener('pagehide', () => {
  try {
    if (sdk && sdk[Symbol.dispose]) sdk[Symbol.dispose]();
  } catch { /* ignore */ }
});

// If the page was restored from Firefox's bfcache, re-run routing so the visible
// view reflects the *current* server state (e.g. a hop we already passed should
// not still show the holding view with its now-stale Pass button).
window.addEventListener('pageshow', (e) => {
  if (e.persisted) route();
});

// History modal close handlers.
document.addEventListener('DOMContentLoaded', () => {
  $('history-modal-close')?.addEventListener('click', closeHistoryModal);
  $('history-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', closeHistoryModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('history-modal').hidden) closeHistoryModal();
  });
});

window.addEventListener('DOMContentLoaded', route);
