/**
 * Multiplayer rooms over PeerJS.
 *
 * Topology is a star: the room's host is the center. Clients connect only to
 * the host; the host relays every client message to the rest of the room and
 * stamps it with the sender's id, so no client ever trusts a payload's claim
 * about who sent it. Room codes are five characters from an alphabet with the
 * ambiguous glyphs (0/O, 1/I/L) taken out, because they get read aloud or
 * retyped by humans.
 *
 * Damage authority is the victim: each player owns their own health, applies
 * hits they receive, and broadcasts the resulting deaths. That keeps hit
 * registration playable on normal residential links without a tick-rate
 * server, and a desynced scoreboard is a better failure than shots that
 * sometimes do nothing.
 *
 * PeerJS is imported lazily from the CDN so a singleplayer visit never pays
 * for it.
 */

const ROOM_PREFIX = 'vibeslops-room-';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 15000;
const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';

export const REJOIN_KEY = 'vibeslops:rejoin';

/** A room code, or a fresh one if none was supplied. */
export function roomCode(existing = null) {
  const clean = String(existing ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length === CODE_LENGTH) return clean;
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function peerIdFor(code) {
  return ROOM_PREFIX + code;
}

/**
 * Load PeerJS on first multiplayer use.
 *
 * The dist/bundler.mjs build cannot be imported directly in a browser page:
 * it keeps a bare `peerjs-js-binarypack` specifier that only a bundler can
 * resolve. The UMD build defines window.Peer and works everywhere, so it is
 * injected as a classic script and read back off the global.
 */
async function loadPeer() {
  if (globalThis.Peer) return { Peer: globalThis.Peer };
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PEERJS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('PeerJS script failed to load'));
    document.head.appendChild(script);
  });
  if (!globalThis.Peer) throw new Error('PeerJS loaded without window.Peer');
  return { Peer: globalThis.Peer };
}

export class NetSession {
  constructor({ id, code, isHost, name, mapId, peer }) {
    this.id = id;
    this.code = code;
    this.isHost = Boolean(isHost);
    this.name = name;
    this.mapId = mapId;
    this.peer = peer;
    this.players = new Map();
    this.ended = false;
    this.onEvent = null;
  }

  static async host({ name, mapId, code = null, onEvent = null, attempts = 4 } = {}) {
    const { Peer } = await loadPeer();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const code2 = roomCode(attempt === 0 ? code : null);
      const peer = new Peer(peerIdFor(code2), { debug: 0 });
      const session = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Room server did not answer in time')), CONNECT_TIMEOUT);
        peer.on('open', () => { clearTimeout(timer); resolve(new NetSession({ id: 'p0', code: code2, isHost: true, name, mapId, peer })); });
        peer.on('error', (error) => {
          if (error?.type === 'unavailable-id') { clearTimeout(timer); peer.destroy(); resolve(null); return; }
          clearTimeout(timer); reject(error);
        });
      });
      if (!session) continue; // Code collision; deal another.
      session.onEvent = onEvent;
      session.players.set('p0', { id: 'p0', name, host: true });
      session.wireHost();
      session.emit({ type: 'open' });
      return session;
    }
    throw new Error('Could not claim a room code, try again');
  }

  static async join({ name, mapId, code, onEvent = null } = {}) {
    const { Peer } = await loadPeer();
    const cleanCode = roomCode(code);
    const peer = new Peer({ debug: 0 });
    let welcomeRoster = [];
    const session = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not reach the room (timeout)')), CONNECT_TIMEOUT);
      peer.on('open', () => {
        const conn = peer.connect(peerIdFor(cleanCode), { serialization: 'json', reliable: true });
        conn.on('open', () => {
          conn.send({ t: 'hello', name, mapId });
          const welcomeTimer = setTimeout(() => reject(new Error('The room did not welcome you (timeout)')), CONNECT_TIMEOUT);
          conn.on('data', (data) => {
            if (data?.t !== 'welcome') return;
            clearTimeout(welcomeTimer);
            welcomeRoster = data.roster ?? [];
            resolve(new NetSession({ id: data.you, code: cleanCode, isHost: false, name, mapId, peer }));
          });
        });
        conn.on('error', (error) => { clearTimeout(timer); reject(error); });
        conn.on('close', () => { clearTimeout(timer); reject(new Error('The room closed the connection')); });
      });
      peer.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    session.onEvent = onEvent;
    session.wireClient();
    // The lobby shows every human, the local one included, and the client's
    // own roster otherwise only holds the host until the next relay.
    session.players.set(session.id, { id: session.id, name, host: false });
    session.applyRoster(welcomeRoster);
    session.emit({ type: 'open' });
    return session;
  }

  // ---------- wiring ----------

  emit(event) { try { this.onEvent?.(event); } catch (error) { console.warn('net event handler failed', error); } }

  wireHost() {
    this.peer.on('connection', (conn) => {
      conn.on('data', (data) => this.onHostData(conn, data));
      conn.on('close', () => this.hostDrop(conn));
      conn.on('error', () => this.hostDrop(conn));
    });
    this.peer.on('error', (error) => this.emit({ type: 'error', error }));
    this.peer.on('disconnected', () => { if (!this.ended) this.peer.reconnect(); });
  }

  onHostData(conn, data) {
    if (!data || typeof data !== 'object') return;
    if (data.t === 'hello') {
      const id = `p${this.players.size}`;
      // Ids are handed out in join order; the host is always p0. A reconnecting
      // name reuses its slot only if it left nothing behind, which is fine.
      let free = id;
      while (this.players.has(free)) free = `p${Number(free.slice(1)) + 1}`;
      conn._netId = free;
      const player = { id: free, name: String(data.name ?? 'Operative').slice(0, 16) || 'Operative', host: false, mapId: data.mapId };
      this.players.set(free, player);
      conn.send({ t: 'welcome', you: free, mapId: this.mapId, roster: this.roster() });
      this.relay(conn, { t: 'join', player: { id: free, name: player.name } });
      this.emit({ type: 'peer-joined', player });
      this.emit({ type: 'roster', players: this.roster() });
      return;
    }
    const from = conn._netId;
    if (!from) return;
    if (data.t === 'leave') { this.hostDrop(conn); return; }
    // Stamp then relay: peers only ever see ids the host vouched for.
    this.relay(conn, { ...data, from });
    this.emit({ type: 'message', data: { ...data, from } });
  }

  hostDrop(conn) {
    const id = conn?._netId;
    if (!id || !this.players.has(id)) return;
    const gone = this.players.get(id);
    this.players.delete(id);
    conn._netId = null;
    this.broadcast({ t: 'left', id });
    this.emit({ type: 'peer-left', id });
    this.emit({ type: 'roster', players: this.roster() });
    void gone;
  }

  relay(fromConn, message) {
    const senderId = fromConn?._netId;
    for (const conns of Object.values(this.peer.connections)) {
      for (const conn of conns) {
        if (conn === fromConn || !conn.open) continue;
        try { conn.send(message); } catch { /* a half-dead conn drops its own messages */ }
      }
    }
    void senderId;
  }

  wireClient() {
    for (const conns of Object.values(this.peer.connections)) {
      for (const conn of conns) {
        if (!conn.open) continue;
        conn.on('data', (data) => this.onClientData(conn, data));
        conn.on('close', () => this.emit({ type: 'close' }));
      }
    }
    this.peer.on('error', (error) => this.emit({ type: 'error', error }));
    this.peer.on('disconnected', () => { if (!this.ended) this.peer.reconnect(); });
  }

  onClientData(conn, data) {
    if (!data || typeof data !== 'object') return;
    if (data.t === 'welcome') {
      // First welcome already consumed during join; later ones are replays.
      if (data.roster) this.applyRoster(data.roster);
      return;
    }
    if (data.t === 'join') { this.applyRosterAdd(data.player); return; }
    if (data.t === 'left') {
      this.players.delete(data.id);
      this.emit({ type: 'peer-left', id: data.id });
      this.emit({ type: 'roster', players: this.roster() });
      return;
    }
    if (data.t === 'roster') { this.applyRoster(data.players ?? data.roster ?? []); return; }
    this.emit({ type: 'message', data });
  }

  applyRoster(roster) {
    for (const player of roster ?? []) {
      if (player?.id && player.id !== this.id) this.players.set(player.id, { ...player });
    }
    this.emit({ type: 'roster', players: this.roster() });
  }

  applyRosterAdd(player) {
    if (!player?.id || player.id === this.id) return;
    this.players.set(player.id, { ...player });
    this.emit({ type: 'peer-joined', player: this.players.get(player.id) });
    this.emit({ type: 'roster', players: this.roster() });
  }

  // ---------- public API ----------

  roster() { return [...this.players.values()]; }

  /** Everyone but me. */
  others() { return this.roster().filter((player) => player.id !== this.id); }

  /** Client: to host (which relays). Host: to everyone, stamped as ours. */
  send(message) {
    if (this.isHost) { this.broadcast({ ...message, from: this.id }); return; }
    for (const conns of Object.values(this.peer.connections)) {
      for (const conn of conns) { if (conn.open) { try { conn.send(message); } catch {} } }
    }
  }

  /** Host only: to one player. */
  sendTo(id, message) {
    if (!this.isHost) return;
    for (const conns of Object.values(this.peer.connections)) {
      for (const conn of conns) { if (conn._netId === id && conn.open) { try { conn.send(message); } catch {} } }
    }
  }

  /** Host: to everyone. */
  broadcast(message, exceptId = null) {
    for (const conns of Object.values(this.peer.connections)) {
      for (const conn of conns) {
        if (!conn.open || (exceptId && conn._netId === exceptId)) continue;
        try { conn.send(message); } catch {}
      }
    }
  }

  leave() {
    this.ended = true;
    try {
      if (!this.isHost) this.send({ t: 'leave' });
      this.peer.destroy();
    } catch { /* a destroyed room needs no goodbye */ }
    this.players.clear();
    this.emit({ type: 'close' });
  }
}
