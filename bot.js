require('dotenv').config();

const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { promisify, inspect } = require('util');
const prism = require('prism-media');

const execFileAsync = promisify(execFile);

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN en .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// --- Config ---
const clipsDir = path.join(__dirname, 'clips');
if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir, { recursive: true });
}

// 48kHz * 2ch * 2 bytes * 120s = ~23MB para 2 minutos reales
const CLIP_SECONDS = 120;
const MAX_BYTES = 48000 * 2 * 2 * CLIP_SECONDS;
const CLIP_COOLDOWN_MS = 30 * 1000;
const DATA_FILE = path.join(__dirname, 'timeData.json');
const PREFIX_FILE = path.join(__dirname, 'prefixes.json');
const ADMIN_FILE = path.join(__dirname, 'admins.json');
const DEFAULT_PREFIX = 'c!';

// --- Auto-update (GitHub, cada 20h) ---
const UPDATE_INTERVAL_MS = 20 * 60 * 60 * 1000;
const AUTO_UPDATE = process.env.NO_AUTO_UPDATE !== '1';
let isUpdating = false;
let lastUpdateCheck = null;
let lastUpdateResult = 'nunca';

// guildId -> { chunks: Buffer[], byteLength: number }
const audioBuffers = new Map();
// guildId -> grabando (c!start / c!stop). c!join ya no graba solo.
const isRecording = new Map();
// guildId -> connection
const callConnections = new Map();
// userId (por guild) -> stream activo
const audioStreams = new Map(); // key `${guildId}:${userId}`
// guildId -> timestamp ultimo clip
const clipCooldown = new Map();
// guildId con clip en curso (evita picos de memoria por clips paralelos)
const clipBusy = new Set();

// --- Event Logs (ultimos 15 min): entradas/salidas, muteos, transmisiones, sonidos ---
const LOG_WINDOW_MS = 15 * 60 * 1000;
const LOG_KEEP_MS = 30 * 60 * 1000;
// guildId -> [{ t, type, userId, username, detail, sound }]
const eventLogs = new Map();
// guildId -> { player } para sonidos
const guildPlayers = new Map();
const soundsDir = path.join(__dirname, 'sounds');
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}

// --- Logs a archivo (logs/bot-YYYY-MM-DD.log): todo lo que pasa por console + errores ---
// Sirve para saber qué pasó cuando el bot se cae/sale solo. Rotación: se borran los de +7 días.
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const LOG_KEEP_DAYS = 7;
function logFileFor(d = new Date()) {
  return path.join(logsDir, `bot-${d.toISOString().slice(0, 10)}.log`);
}
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logsDir)) {
      if (!/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = path.join(logsDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* noop */ }
    }
  } catch { /* noop */ }
}
function writeLogFile(level, args) {
  try {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 200 }))).join(' ');
    fs.appendFileSync(logFileFor(), `[${ts}] [${level}] ${msg}\n`);
  } catch { /* nunca romper el bot por el log */ }
}
const _conLog = console.log.bind(console);
const _conErr = console.error.bind(console);
const _conWarn = console.warn.bind(console);
console.log = (...a) => { writeLogFile('INFO', a); _conLog(...a); };
console.warn = (...a) => { writeLogFile('WARN', a); _conWarn(...a); };
console.error = (...a) => { writeLogFile('ERROR', a); _conErr(...a); };
process.on('uncaughtException', (e) => { console.error('[fatal] uncaughtException:', e?.stack || e); });
process.on('unhandledRejection', (r) => { console.error('[fatal] unhandledRejection:', r?.stack || r); });
pruneOldLogs();
setInterval(pruneOldLogs, 24 * 60 * 60 * 1000).unref();

function logEvent(guildId, type, userId, username, detail = '', extra = {}) {
  if (!eventLogs.has(guildId)) eventLogs.set(guildId, []);
  const arr = eventLogs.get(guildId);
  arr.push({ t: Date.now(), type, userId, username: username || 'Desconocido', detail, ...extra });
  // poda: quedarnos solo con lo reciente para no crecer en memoria
  const cutoff = Date.now() - LOG_KEEP_MS;
  while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
  if (arr.length > 2000) arr.splice(0, arr.length - 2000);
}

function getRecentEvents(guildId, windowMs = LOG_WINDOW_MS) {
  const arr = eventLogs.get(guildId) || [];
  const cutoff = Date.now() - windowMs;
  return arr.filter(e => e.t >= cutoff);
}

// --- Salidas previstas del bot (leave, cambio de canal, limpiezas): no son kicks ---
// Se marca ANTES de destruir la conexión a propósito; el voiceStateUpdate que
// llega después la consume y NO manda DM. Caduca en 15s para no tapar un kick real.
const expectedBotLeave = new Set();
function markExpectedLeave(guildId) {
  expectedBotLeave.add(guildId);
  setTimeout(() => expectedBotLeave.delete(guildId), 15000).unref();
}
// Antibucle del re-enganche: si acabamos de re-enganchar (<5s), se ignoran
// movimientos repetidos para no entrar en entra/sale infinito.
const botReengageAt = new Map();

// --- Detección rápida de expulsión del bot ---
// Vía 1 (instantánea): voiceStateUpdate del propio bot (~1s).
// Vía 2 (respaldo): vigilancia cada 5s por si el evento se pierde/retrasa.
// Todo lo no-previsto pasa por onBotRemoved(): PUNTO DE ENGANCHE para las
// futuras medidas (ahora mismo solo avisa por DM).
const BOT_WATCH_INTERVAL_MS = 5000;
const BOT_JOIN_GRACE_MS = 10000; // tras un join, el watchdog no sospecha
const BOT_EXIT_DEDUP_MS = 30000; // misma salida no se procesa 2 veces
const botJoinedAt = new Map(); // guildId -> timestamp del último join
const handledBotExit = new Map(); // guildId -> timestamp de salida ya tratada
const botExitWatch = new Map(); // guildId -> última salida { at, channelId, channelName, expected, source, kickerId, kickerTag }
function recordBotExit(guildId, info) {
  botExitWatch.set(guildId, { at: Date.now(), ...info });
  if (botExitWatch.size > 100) botExitWatch.delete(botExitWatch.keys().next().value);
}
function getLastBotExit(guildId) {
  return botExitWatch.get(guildId) ?? null;
}
function wasBotExitHandled(guildId) {
  const last = handledBotExit.get(guildId) ?? 0;
  return Date.now() - last < BOT_EXIT_DEDUP_MS;
}
function markBotExitHandled(guildId) {
  handledBotExit.set(guildId, Date.now());
}
// Ruta única para salidas NO previstas del bot: congela tiempos, limpia,
// registra y dispara el enganche de medidas. `kicker` puede venir ya
// resuelto (watchdog) o null (se atribuye por auditoría en 2º plano).
function handleUnexpectedBotExit(guild, { channelId = null, channelName = null, source = 'event', kicker = undefined } = {}) {
  const gid = guild.id;
  if (wasBotExitHandled(gid)) return false; // duplicada (evento + watchdog)
  markBotExitHandled(gid);
  console.warn(`[voz] BOT fuera de voz en guild ${gid} (${guild.name}) canal=${channelName ?? channelId ?? '?'} fuente=${source}. Congelo tiempos y limpio.`);
  finalizeGuildTimes(gid);
  try { getVoiceConnection(gid)?.destroy(); } catch { /* noop */ }
  callConnections.delete(gid);
  isRecording.set(gid, false);
  botJoinedAt.delete(gid);
  saveData();
  recordBotExit(gid, { channelId, channelName, expected: false, source, kickerId: kicker?.id ?? null, kickerTag: kicker?.tag ?? null });
  onBotRemoved(guild, { channelId, channelName, source, kicker }).catch(e => {
    console.error(`[voz] fallo en medidas anti-kick guild ${gid}:`, e.message);
  });
  return true;
}
// PUNTO DE ENGANCHE — futuras medidas anti-kick van aquí.
// Medida 1 (activa): rejoin al toque (500ms). Aviso por DM en paralelo.
async function onBotRemoved(guild, { channelId = null, channelName = null, source = 'event', kicker = undefined } = {}) {
  const gid = guild.id;
  // El rejoin se lanza YA para no esperar a la auditoría (2s): el rejoin
  // manda, el DM informa. Van en paralelo.
  const rejoinP = channelId ? rejoinAfterKick(guild, { channelId, channelName }) : Promise.resolve(false);
  try {
    let who = kicker;
    if (who === undefined) {
      who = await findVoiceKicker(guild, channelId);
      const rec = botExitWatch.get(gid);
      if (rec) {
        rec.kickerId = who?.id ?? null;
        rec.kickerTag = who?.tag ?? null;
      }
    }
    await notifyBotKicked(guild, { channelName, kicker: who ?? null });
  } catch (e) {
    console.error(`[voz] fallo avisando kick en guild ${gid}:`, e.message);
  }
  await rejoinP.catch(() => false);
}
// Freno anti-bucle: más de N kicks en 60s = alguien peleando -> NO reentro,
// se pasa al panic mode (pendiente de definir).
const KICK_STREAK_WINDOW_MS = 60 * 1000;
const KICK_STREAK_MAX = 5;
const kickStreak = new Map(); // guildId -> { count, firstAt }
// Reentra al mismo canal 500ms después de la expulsión. Un solo intento:
// si el canal murió o no hay permisos, no insiste (lo verá el panic/DM).
async function rejoinAfterKick(guild, { channelId, channelName = null } = {}) {
  const gid = guild.id;
  const now = Date.now();
  let st = kickStreak.get(gid);
  if (!st || now - st.firstAt > KICK_STREAK_WINDOW_MS) st = { count: 1, firstAt: now };
  else st.count++;
  kickStreak.set(gid, st);
  const maxKicks = getPanic(gid).kicks ?? KICK_STREAK_MAX;
  if (st.count >= maxKicks) {
    console.warn(`[voz] guild ${gid}: ${st.count} kicks en 60s (límite ${maxKicks}), NO reentro. Paso a panic mode.`);
    await enterPanicMode(guild, { reason: 'kick-loop', streak: st.count, channelId, channelName });
    return false;
  }
  return doRejoin(guild, channelId, `${st.count} en 60s`);
}
// Núcleo del rejoin (lo usan el anti-kick y el panic mode): entra AL TOQUE
// (intento inmediato) con un reintento a los 500ms si el primero falla,
// reconecta audio y retoma tiempos.
async function doRejoin(guild, channelId, note = '') {
  const gid = guild.id;
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isVoiceBased?.()) {
    console.warn(`[voz] guild ${gid}: no reentro, el canal ${channelId} ya no existe.`);
    return false;
  }
  const attempt = () => {
    const connection = joinVoiceChannel({
      channelId,
      guildId: gid,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    callConnections.set(gid, connection);
    setupAudioReceiver(connection, gid);
    attachConnectionHandlers(connection, gid);
    return connection;
  };
  let connection = null;
  try {
    connection = attempt();
  } catch (e1) {
    console.warn(`[voz] guild ${gid}: rejoin inmediato falló (${e1.message?.split('\n')[0]}), reintento en 500ms...`);
    await new Promise(r => setTimeout(r, 500));
    try {
      connection = attempt();
    } catch (e2) {
      console.error(`[voz] guild ${gid}: no pude reentrar a ${channelId}:`, e2.message);
      return false;
    }
  }
  try {
    botJoinedAt.set(gid, Date.now());
    handledBotExit.delete(gid); // el próximo kick real debe procesarse
    isRecording.set(gid, false);
    audioBuffers.delete(gid); // sesión nueva, como en join
    // Retomo tiempos de quienes siguen en el canal
    finalizeGuildTimes(gid);
    const times = getGuildTimes(gid);
    const t = Date.now();
    channel.members?.forEach(member => {
      if (member.user.bot) return;
      const prev = times.get(member.user.id);
      if (!prev) times.set(member.user.id, { startTime: t, totalTime: 0 });
      else if (prev.startTime == null) { prev.startTime = t; times.set(member.user.id, prev); }
    });
    saveData();
    logEvent(gid, 'bot_rejoin', client.user.id, client.user?.username ?? 'bot', `reentré a ${channel.name ?? channelId}${note ? ` (${note})` : ''}`);
    const rec = botExitWatch.get(gid);
    if (rec) rec.rejoined = true;
    console.log(`[voz] guild ${gid}: reentré a ${channel.name ?? channelId}${note ? ` (${note})` : ''}.`);
  } catch (e) {
    console.error(`[voz] guild ${gid}: entré pero falló el post-join:`, e.message);
  }
  // Alarma en voz (opcional): si existe sounds/panic.mp3, suena al reentrar
  // tras un kick para que los humanos del canal se enteren.
  try {
    const alarmPath = path.join(soundsDir, 'panic.mp3');
    if (fs.existsSync(alarmPath)) {
      const { player } = getGuildPlayer(gid, connection);
      player.play(createAudioResource(alarmPath, { inputType: StreamType.Arbitrary }));
      console.log(`[panic] guild ${gid}: alarma sonando.`);
    }
  } catch (e) {
    console.warn(`[panic] guild ${gid}: no pude sonar la alarma:`, e.message);
  }
  return true;
}
// --- Panic mode: si nos echan en bucle, se traen refuerzos ---
// Manda en un canal de texto los comandos de join de otros bots
// (!join, m!join, -join...) para que entren, además de reentrar infinity.
// Config por servidor en panic.json (comando `panic`, solo admins).
const PANIC_FILE = path.join(__dirname, 'panic.json');
const PANIC_SUMMON_DELAY_MS = 800;
const PANIC_COOLDOWN_MS = 5 * 60 * 1000;
const PANIC_MAX_SUMMONS = 10;
const DEFAULT_SUMMONS = ['!join', 'm!join', '-join'];
const panicCfg = new Map(); // guildId -> { enabled, channelId|null, summons[] }
const panicAt = new Map(); // guildId -> último disparo
function getPanic(guildId) {
  if (!panicCfg.has(guildId)) panicCfg.set(guildId, { enabled: true, channelId: null, summons: [...DEFAULT_SUMMONS], kicks: 5 });
  return panicCfg.get(guildId);
}
function loadPanic() {
  try {
    if (!fs.existsSync(PANIC_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PANIC_FILE, 'utf8'));
    for (const [g, c] of Object.entries(raw)) {
      if (!c || typeof c !== 'object') continue;
      const summons = Array.isArray(c.summons)
        ? c.summons.filter(s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 50).slice(0, PANIC_MAX_SUMMONS)
        : [...DEFAULT_SUMMONS];
      panicCfg.set(g, {
        enabled: c.enabled !== false,
        channelId: typeof c.channelId === 'string' ? c.channelId : null,
        summons: summons.length ? summons : [...DEFAULT_SUMMONS],
        kicks: Number.isInteger(c.kicks) && c.kicks >= 1 && c.kicks <= 5 ? c.kicks : 5
      });
    }
    console.log('Panic cargado.');
  } catch (e) {
    console.error('No se pudo cargar panic.json:', e.message);
  }
}
function savePanic() {
  try {
    fs.writeFileSync(PANIC_FILE, JSON.stringify(Object.fromEntries(panicCfg), null, 2));
  } catch (e) {
    console.error('No se pudo guardar panic.json:', e.message);
  }
}
function botCanSend(channel) {
  try {
    if (!channel?.isTextBased?.()) return false;
    return !!channel.permissionsFor(client.user)?.has(PermissionFlagsBits.SendMessages);
  } catch { return false; }
}
// Canal donde se mandan los summons: el configurado, si no el del sistema,
// si no el primer canal de texto escribible (hilos no: los webhooks no van).
function resolvePanicChannel(guild) {
  const cfg = getPanic(guild.id);
  if (cfg.channelId) {
    const c = guild.channels.cache.get(cfg.channelId);
    if (botCanSend(c)) return c;
  }
  const sys = guild.systemChannelId ? guild.channels.cache.get(guild.systemChannelId) : null;
  if (botCanSend(sys)) return sys;
  const sorted = [...guild.channels.cache.values()].filter(c => botCanSend(c) && !c.isThread?.()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return sorted[0] ?? null;
}
const PANIC_WEBHOOK_NAME = 'Infinity Panic';
// Webhook propio del canal para camuflar los summons (no salen a nombre del
// bot). Requiere permiso Gestionar webhooks; si falla, se usa mensaje normal.
async function getPanicWebhook(channel) {
  try {
    const hooks = await channel.fetchWebhooks();
    const mine = hooks.find(w => w.owner?.id === client.user.id && w.name === PANIC_WEBHOOK_NAME);
    if (mine) return mine;
    return await channel.createWebhook({ name: PANIC_WEBHOOK_NAME, avatar: client.user.displayAvatarURL({ extension: 'png', size: 64 }) });
  } catch (e) {
    console.warn(`[panic] sin webhook en #${channel.name ?? channel.id}:`, e.message);
    return null;
  }
}
// Manda un summon: primero vía webhook (camuflado), si no mensaje del bot.
// Devuelve 'webhook' | 'bot' | null (falló).
async function sendSummon(channel, text) {
  const hook = await getPanicWebhook(channel);
  if (hook) {
    try {
      await hook.send({ content: text, username: PANIC_WEBHOOK_NAME });
      return 'webhook';
    } catch (e) {
      console.warn(`[panic] webhook falló, pruebo mensaje normal:`, e.message);
    }
  }
  try {
    await channel.send(text);
    return 'bot';
  } catch (e) {
    console.error(`[panic] no pude mandar '${text}':`, e.message);
    return null;
  }
}
// PUNTO DE ENGANCHE 2 — panic mode: infinity reentra + summons a otros bots + DM.
async function enterPanicMode(guild, info = {}) {
  const gid = guild.id;
  const cfg = getPanic(gid);
  logEvent(gid, 'panic', client.user.id, client.user?.username ?? 'bot', `panic mode: ${info.reason ?? '?'} x${info.streak ?? '?'}`);
  if (!cfg.enabled) {
    console.warn(`[panic] guild ${gid}: panic desactivado, no hago nada.`);
    return false;
  }
  const last = panicAt.get(gid) ?? 0;
  if (Date.now() - last < PANIC_COOLDOWN_MS) {
    console.log(`[panic] guild ${gid}: en cooldown, no re-disparo.`);
    return false;
  }
  panicAt.set(gid, Date.now());
  console.warn(`[panic] guild ${gid} (${guild.name}): MODO PÁNICO por ${info.reason ?? '?'} (racha ${info.streak ?? '?'})`);
  // 1) Infinity entra también (un intento, sin contar racha)
  let back = false;
  if (info.channelId) back = await doRejoin(guild, info.channelId, 'panic mode');
  await new Promise(r => setTimeout(r, 1000));
  // 2) Summons: comandos de join de otros bots en el chat
  const channel = resolvePanicChannel(guild);
  let sentCount = 0;
  let via = 'bot';
  if (!channel) {
    console.error(`[panic] guild ${gid}: sin canal de texto donde mandar summons (¿sin permiso de Enviar mensajes?).`);
  } else {
    for (const text of cfg.summons) {
      const how = await sendSummon(channel, text);
      if (how) { sentCount++; via = how; logEvent(gid, 'panic', client.user.id, client.user?.username ?? 'bot', `summon '${text}' en #${channel.name ?? channel.id} vía ${how}`); }
      await new Promise(r => setTimeout(r, PANIC_SUMMON_DELAY_MS));
    }
  }
  const pasteBlock = cfg.summons.join('\n');
  await dmOwners(guild, `🆘 **PANIC MODE** en **${guild.name}** (me echaron x${info.streak ?? '?'} en 60s).\nInfinity: ${back ? 'de vuelta en voz ✅' : 'no pudo reentrar ❌'}\nRefuerzos: ${sentCount}/${cfg.summons.length} summons en ${channel ? `#${channel.name}` : 'ningún canal (sin permiso de Enviar mensajes)'} (vía ${via}).\nSi los bots no entraron (ignoran mensajes no-humanos), pega esto en ${channel ? `#${channel.name}` : 'el chat'}:\n\`\`\`\n${pasteBlock}\n\`\`\`\nRachas en \`bot> status\`.`);
  return true;
}
// --- Subida de la alarma del panic mode (sounds/panic.mp3) ---
// Descarga el adjunto, valida que sea audio y lo normaliza a MP3.
// Devuelve { ok, detail } para responder al admin.
const PANIC_SOUND_MAX_BYTES = 8 * 1024 * 1024;
const PANIC_SOUND_EXTS = ['mp3', 'wav', 'ogg', 'm4a'];
async function savePanicSoundFromUrl(url, { filename = '', contentType = '', size = 0 } = {}) {
  const ext = (filename.split('.').pop() || '').toLowerCase().split(/[^a-z0-9]/)[0];
  if (size && size > PANIC_SOUND_MAX_BYTES) {
    return { ok: false, detail: `Pesa ${(size / 1048576).toFixed(1)}MB: máximo 8MB (ideal <1MB para una alarma).` };
  }
  if (!PANIC_SOUND_EXTS.includes(ext) && !(contentType || '').startsWith('audio/')) {
    return { ok: false, detail: 'Tiene que ser audio: MP3/WAV/OGG/M4A.' };
  }
  const tmpIn = path.join(require('os').tmpdir(), `panicup-${Date.now()}.${ext || 'bin'}`);
  const tmpOut = path.join(soundsDir, 'panic.tmp.mp3');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    let buf;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, detail: `No pude descargarlo (HTTP ${res.status}).` };
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, detail: e.name === 'AbortError' ? 'Tardó demasiado en descargar (timeout 30s).' : `Fallo de descarga: ${e.message}` };
    } finally {
      clearTimeout(t);
    }
    if (buf.length === 0) return { ok: false, detail: 'Archivo vacío.' };
    if (buf.length > PANIC_SOUND_MAX_BYTES) return { ok: false, detail: `Pesa ${(buf.length / 1048576).toFixed(1)}MB: máximo 8MB.` };
    await fsp.writeFile(tmpIn, buf);
    // Normalizo a MP3: si no es audio real, ffmpeg falla aquí y no se pisa nada
    let duration = '?';
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-q:a', '4', '-ar', '48000', '-ac', '2', tmpOut], { timeout: 60000 });
      const dm = String(stderr || '').match(/Duration:\s*(\d+:\d+[\d:.]*)/);
      if (dm) duration = dm[1].split('.')[0];
    } catch (e) {
      await fsp.unlink(tmpOut).catch(() => {});
      const cause = String(e.message || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 150) || 'formato no soportado';
      return { ok: false, detail: `No es audio válido (${cause}).` };
    }
    await fsp.rename(tmpOut, path.join(soundsDir, 'panic.mp3'));
    const st = await fsp.stat(path.join(soundsDir, 'panic.mp3'));
    return { ok: true, detail: `${(st.size / 1024).toFixed(0)}KB · ${duration}` };
  } finally {
    await fsp.unlink(tmpIn).catch(() => {});
  }
}
// Respaldo por si el evento de salida se pierde: cada 5s comprueba que donde
// creemos estar en voz el bot siga ahí. Solo actúa con prueba de expulsión
// (auditoría reciente) o conexión muerta; ante la duda NO toca nada.
async function botWatchdogTick() {
  for (const [gid, conn] of [...callConnections]) {
    try {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const live = getVoiceConnection(gid);
      if (!live || conn?.state?.status === VoiceConnectionStatus.Destroyed) continue; // lo gestiona getLiveConnection
      const meChannelId = guild.members.me?.voice?.channelId ?? conn?.joinConfig?.channelId ?? null;
      if (meChannelId) continue; // sigue en voz, todo bien
      if (Date.now() - (botJoinedAt.get(gid) ?? 0) < BOT_JOIN_GRACE_MS) continue; // join reciente, dando tiempo a Discord
      // Fuera de voz según caché y sin evento: ¿kick confirmado en auditoría?
      const kicker = await findVoiceKickerFast(guild, conn?.joinConfig?.channelId ?? null);
      if (!kicker) continue; // sin prueba: no toco nada (evita falsos positivos)
      const channelId = conn?.joinConfig?.channelId ?? null;
      let channelName = null;
      try { channelName = guild.channels.cache.get(channelId)?.name ?? null; } catch { /* noop */ }
      handleUnexpectedBotExit(guild, { channelId, channelName, source: 'watchdog', kicker });
    } catch (e) {
      console.error(`[voz] watchdog guild ${gid}:`, e.message);
    }
  }
}
// Variante sin espera para el watchdog (el evento ya se perdió: no hay prisa
// pero tampoco espera extra; la ventana de auditoría cubre el hueco).
async function findVoiceKickerFast(guild, channelId) {
  try {
    const me = client.user?.id;
    if (!me || !guild?.fetchAuditLogs) return null;
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberDisconnect, limit: 5 });
    const now = Date.now();
    for (const entry of logs.entries.values()) {
      if (entry.target?.id !== me) continue;
      if (now - entry.createdTimestamp > 15000) continue;
      const entryChannelId = entry.extra?.channel?.id ?? entry.extra?.channelId ?? null;
      if (channelId && entryChannelId && entryChannelId !== channelId) continue;
      if (entry.executor && entry.executor.id !== me) return entry.executor;
    }
  } catch (e) {
    console.warn(`[voz] watchdog sin auditoría en guild ${guild?.id}:`, e.message);
  }
  return null;
}
function setupBotWatchdog() {
  setInterval(() => {
    botWatchdogTick().catch(e => console.error('[voz] watchdog:', e.message));
  }, BOT_WATCH_INTERVAL_MS).unref();
  console.log(`Vigilancia anti-kick activada: chequeo cada ${BOT_WATCH_INTERVAL_MS / 1000}s.`);
}

// Busca en la auditoría quién desconectó al bot de voz (requiere permiso
// "Ver registro de auditoría"). Intento inmediato + un reintento a los 1.5s
// (la entrada a veces llega tarde). Devuelve el executor o null.
async function findVoiceKicker(guild, channelId) {
  const scan = async () => {
    const me = client.user?.id;
    if (!me || !guild?.fetchAuditLogs) return null;
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberDisconnect, limit: 5 });
    const now = Date.now();
    for (const entry of logs.entries.values()) {
      if (entry.target?.id !== me) continue;
      if (now - entry.createdTimestamp > 25000) continue;
      const entryChannelId = entry.extra?.channel?.id ?? entry.extra?.channelId ?? null;
      if (channelId && entryChannelId && entryChannelId !== channelId) continue;
      if (entry.executor && entry.executor.id !== me) return entry.executor;
    }
    return null;
  };
  try {
    const first = await scan();
    if (first) return first;
    await new Promise(r => setTimeout(r, 1500));
    return await scan();
  } catch (e) {
    console.warn(`[voz] no pude leer audit logs en guild ${guild?.id}:`, e.message);
    return null;
  }
}

// Manda DM a los dueños (bot + servidor). Devuelve a quiénes llegó.
async function dmOwners(guild, msg) {
  const sent = [];
  const targets = new Set();
  const bOwner = botOwnerId();
  if (bOwner) targets.add(bOwner);
  else console.warn('[dm] sin OWNER_ID configurado: el aviso solo va al owner del servidor.');
  if (guild.ownerId) targets.add(guild.ownerId);
  for (const uid of targets) {
    try {
      const u = await client.users.fetch(uid);
      await u.send(msg);
      sent.push(uid);
    } catch (e) {
      console.warn(`[dm] no pude mandar DM a ${uid}:`, e.message);
    }
  }
  return sent;
}
// Avisa por DM a los dueños cuando echan al bot de voz, indicando quién lo
// hizo. Registra el evento para bot_logs.
async function notifyBotKicked(guild, { channelName, kicker } = {}) {
  const gid = guild.id;
  const kickerTxt = kicker ? `${kicker.tag ?? kicker.username ?? 'Desconocido'} (${kicker.id})` : 'desconocido (me falta permiso "Ver registro de auditoría" o fue una desconexión)';
  logEvent(gid, 'bot_kicked', kicker?.id ?? '???', kicker?.username ?? kicker?.tag ?? 'Desconocido', `me echó de ${channelName ?? 'voz'} en ${guild.name}`);
  console.warn(`[voz] BOT echado en guild ${gid} (${guild.name}) canal=${channelName ?? '?'} por=${kickerTxt}`);
  const msg = `🚨 Me echaron de voz en **${guild.name}** (canal **${channelName ?? 'desconocido'}**).\nQuién me echó: **${kickerTxt}**\nHora: <t:${Math.floor(Date.now() / 1000)}:F>\nVuelve a meterme con \`join\` cuando quieras.`;
  await dmOwners(guild, msg);
}

const BOT_LOG_LABELS = {
  join: '🟢 entró al canal', leave: '🔴 salió del canal',
  mute: '🔇 se muteó', unmute: '🔈 se desmuteó',
  stream_start: '📡 inició pantalla', stream_end: '📴 terminó pantalla',
  video_start: '📹 inició cámara', video_end: '📹 terminó cámara',
  sound: '🔊 sonido', bot_join: '🤖 BOT se unió', bot_leave: '🤖 BOT salió (previsto)',
  bot_moved: '🔀 BOT movido', bot_kicked: '🚨 BOT echado', bot_rejoin: '↩️ BOT reentró',
  panic: '🆘 panic mode'
};
function formatBotLogLine(e) {
  const ts = new Date(e.t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = BOT_LOG_LABELS[e.type] ?? e.type;
  const who = `${e.username} (${e.userId})`;
  const extra = [e.detail, e.sound ? `[${e.sound}]` : ''].filter(Boolean).join(' ');
  return `[${ts}] ${label} — ${who}${extra ? ` — ${extra}` : ''}`;
}

function getGuildPlayer(guildId, connection) {
  let entry = guildPlayers.get(guildId);
  if (!entry?.player) {
    const player = createAudioPlayer();
    entry = { player };
    guildPlayers.set(guildId, entry);
    player.on('error', (e) => console.error(`[sound] player error guild ${guildId}:`, e.message));
  }
  // Resuscribir SIEMPRE: tras un leave+join la conexión es nueva y el player
  // viejo quedaba atado a la destruida (decía "Reproduciendo" en silencio).
  try { connection.subscribe(entry.player); } catch { /* noop */ }
  return entry;
}

function listSoundFiles() {
  try {
    return fs.readdirSync(soundsDir).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
  } catch { return []; }
}

// --- Motor Opus (necesario para decodificar voz y reproducir sonidos) ---
// Sin @discordjs/opus ni opusscript, los clips salen vacíos y `c!s` es mudo.
let OPUS_OK = true;
try {
  new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }).destroy();
} catch (e) {
  OPUS_OK = false;
  console.error('[audio] SIN motor Opus (@discordjs/opus ni opusscript). Clips vacíos y sonidos mudos. Corre `npm install`.');
}

// guildId -> Map(userId -> { startTime: number|null, totalTime: number })
const timeInCall = new Map();

// guildId -> prefix personalizado
const prefixes = new Map();
function getPrefix(guildId) {
  return prefixes.get(guildId) ?? DEFAULT_PREFIX;
}
function loadPrefixes() {
  try {
    if (!fs.existsSync(PREFIX_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'));
    for (const [g, p] of Object.entries(raw)) {
      if (typeof p === 'string' && p.length >= 1 && p.length <= 5) prefixes.set(g, p);
    }
    console.log('Prefijos cargados.');
  } catch (e) {
    console.error('No se pudo cargar prefixes.json:', e.message);
  }
}
function savePrefixes() {
  try {
    fs.writeFileSync(PREFIX_FILE, JSON.stringify(Object.fromEntries(prefixes), null, 2));
  } catch (e) {
    console.error('No se pudo guardar prefixes.json:', e.message);
  }
}

// --- Admins del bot por servidor (pueden sacarme con leave y gestionar admins) ---
// Admins por defecto, sin configurar nada: el dueño del servidor y el dueño
// del bot (OWNER_ID). Los extra se guardan en admins.json vía /addadmin.
const botAdmins = new Map(); // guildId -> Set(userId)
function botOwnerId() {
  return (process.env.OWNER_ID || '').trim();
}
function getAdminSet(guildId) {
  if (!botAdmins.has(guildId)) botAdmins.set(guildId, new Set());
  return botAdmins.get(guildId);
}
function isBotAdmin(guild, userId) {
  if (!userId) return false;
  if (userId === botOwnerId() && botOwnerId()) return true;
  if (guild?.ownerId && userId === guild.ownerId) return true;
  return getAdminSet(guild?.id).has(userId);
}
function loadAdmins() {
  try {
    if (!fs.existsSync(ADMIN_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    for (const [g, arr] of Object.entries(raw)) {
      if (Array.isArray(arr)) botAdmins.set(g, new Set(arr.filter(id => typeof id === 'string')));
    }
    console.log('Admins cargados.');
  } catch (e) {
    console.error('No se pudo cargar admins.json:', e.message);
  }
}
function saveAdmins() {
  try {
    const out = {};
    for (const [g, set] of botAdmins.entries()) out[g] = [...set];
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('No se pudo guardar admins.json:', e.message);
  }
}

function getGuildTimes(guildId) {
  if (!timeInCall.has(guildId)) timeInCall.set(guildId, new Map());
  return timeInCall.get(guildId);
}

function getAudioBuffer(guildId) {
  if (!audioBuffers.has(guildId)) audioBuffers.set(guildId, { chunks: [], byteLength: 0 });
  return audioBuffers.get(guildId);
}

function pushAudioChunk(guildId, chunk) {
  const buf = getAudioBuffer(guildId);
  buf.chunks.push(chunk);
  buf.byteLength += chunk.length;
  while (buf.chunks.length > 0 && buf.byteLength > MAX_BYTES) {
    const removed = buf.chunks.shift();
    buf.byteLength -= removed.length;
  }
}

// --- Persistencia ---
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [guildId, users] of Object.entries(raw)) {
      const m = new Map();
      for (const [userId, data] of Object.entries(users)) {
        m.set(userId, {
          totalTime: Number(data.totalTime) || 0,
          // Al cargar, nadie esta "dentro": startTime siempre null para no inflar
          startTime: null
        });
      }
      timeInCall.set(guildId, m);
    }
    console.log('Datos de tiempo cargados.');
  } catch (e) {
    console.error('No se pudo cargar timeData.json:', e.message);
  }
}

function saveData() {
  try {
    const out = {};
    for (const [guildId, users] of timeInCall.entries()) {
      out[guildId] = {};
      for (const [userId, data] of users.entries()) {
        out[guildId][userId] = { totalTime: data.totalTime, startTime: null };
      }
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('No se pudo guardar timeData.json:', e.message);
  }
}

loadData();
loadPrefixes();
loadAdmins();
loadPanic();
setInterval(saveData, 5 * 60 * 1000).unref();

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

// Devuelve la conexión viva o null. Si el mapa guardaba una conexión
// muerta/fantasma (la causa del "dice que está pero no está"), la limpia
// y lo deja registrado en el log para saber qué pasó.
function getLiveConnection(guildId) {
  const live = getVoiceConnection(guildId);
  const stored = callConnections.get(guildId);
  const conn = live ?? stored;
  if (!conn) return null;
  if (conn?.state?.status === VoiceConnectionStatus.Destroyed) {
    if (stored) {
      console.warn(`[voz] conexión zombie en guild ${guildId} (destroyed), congelo tiempos y limpio mapa`);
      finalizeGuildTimes(guildId);
      markExpectedLeave(guildId);
      try { stored.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);
      isRecording.set(guildId, false);
      botJoinedAt.delete(guildId);
      saveData();
    }
    return null;
  }
  // discord.js ya no la reconoce pero el mapa la guarda: es fantasma.
  // Se limpia para que `join` reconecte en vez de decir "ya estoy aquí".
  if (!live && stored) {
    console.warn(`[voz] conexión fantasma en guild ${guildId} (sin getVoiceConnection), congelo tiempos y limpio para reconectar`);
    finalizeGuildTimes(guildId);
    markExpectedLeave(guildId);
    try { stored.destroy(); } catch { /* noop */ }
    callConnections.delete(guildId);
    isRecording.set(guildId, false);
    botJoinedAt.delete(guildId);
    saveData();
    return null;
  }
  return conn;
}

function botChannelIdFor(guildId) {
  const conn = getLiveConnection(guildId);
  return conn?.joinConfig?.channelId ?? null;
}

// Registra cada cambio de estado de la conexión: así el log dice por qué se cayó/salió.
// Si se queda colgada en desconectado >15s, congela tiempos y limpia (antes quedaba fantasma).
function attachConnectionHandlers(connection, guildId) {
  try {
    connection.on('stateChange', (oldS, newS) => {
      console.log(`[voz] guild ${guildId}: ${oldS.status} -> ${newS.status}`);
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn(`[voz] guild ${guildId}: desconectado, esperando reconexión automática (15s)...`);
      await new Promise(r => setTimeout(r, 15000));
      try {
        const cur = getVoiceConnection(guildId);
        const st = cur?.state?.status;
        if (!cur || st === VoiceConnectionStatus.Destroyed || st === VoiceConnectionStatus.Disconnected) {
          console.error(`[voz] guild ${guildId}: no se recuperó (status=${st ?? 'none'}), congelo tiempos y limpio`);
          finalizeGuildTimes(guildId);
          markExpectedLeave(guildId);
          try { cur?.destroy(); } catch { /* noop */ }
          try { connection.destroy(); } catch { /* noop */ }
          callConnections.delete(guildId);
          isRecording.set(guildId, false);
          botJoinedAt.delete(guildId);
          saveData();
        } else {
          console.log(`[voz] guild ${guildId}: reconexión OK (status=${st})`);
        }
      } catch (e) {
        console.error(`[voz] guild ${guildId}: error vigilando desconexión:`, e.message);
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.warn(`[voz] guild ${guildId}: conexión destruida`);
    });
  } catch (e) {
    console.error(`[voz] guild ${guildId}: no pude enganchar handlers:`, e.message);
  }
}

// --- Embeds bonitos ---
const EMBED_COLOR = 0x5865F2;
const EMBED_OK = 0x57F287;
const EMBED_WARN = 0xFEE75C;
const EMBED_ERR = 0xED4245;

function embedBase(message, color = EMBED_COLOR) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `Pedido por ${message.author.username}` })
    .setTimestamp();
}
function embedOk(message, title, desc) {
  return embedBase(message, EMBED_OK).setTitle(`✅ ${title}`).setDescription(desc);
}
function embedErr(message, title, desc) {
  return embedBase(message, EMBED_ERR).setTitle(`❌ ${title}`).setDescription(desc);
}
function embedInfo(message, title, desc) {
  return embedBase(message, EMBED_COLOR).setTitle(title).setDescription(desc);
}

client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}!`);
  // Registra slash globales (tardan hasta 1h en propagar; en test usa un server y reinicia)
  try {
    const cmdPrefix = new SlashCommandBuilder()
      .setName('prefix')
      .setDescription('Ver o cambiar el prefijo de comandos de este servidor')
      .addStringOption(o => o.setName('nuevo').setDescription('Nuevo prefijo (1-5 caracteres, sin espacios)').setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    const cmdAddAdmin = new SlashCommandBuilder()
      .setName('addadmin')
      .setDescription('Hacer a un usuario admin del bot (solo admins)')
      .addUserOption(o => o.setName('usuario').setDescription('Usuario a hacer admin').setRequired(true));
    const cmdRemoveAdmin = new SlashCommandBuilder()
      .setName('removeadmin')
      .setDescription('Quitar admin del bot a un usuario (solo admins)')
      .addUserOption(o => o.setName('usuario').setDescription('Usuario a quitar admin').setRequired(true));
    const cmdAddPanicSound = new SlashCommandBuilder()
      .setName('addpanicsound')
      .setDescription('Sube la alarma del panic mode (solo admins)')
      .addAttachmentOption(o => o.setName('sonido').setDescription('MP3/WAV/OGG/M4A, máx 8MB').setRequired(true));
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: [cmdPrefix.toJSON(), cmdAddAdmin.toJSON(), cmdRemoveAdmin.toJSON(), cmdAddPanicSound.toJSON()] });
    console.log('Slash /prefix, /addadmin, /removeadmin, /addpanicsound registrados.');
  } catch (e) {
    console.error('No se pudo registrar slash:', e.message);
  }
});

async function handleAdminSlash(interaction, add) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) return interaction.reply({ content: 'Solo funciona en servidores.', ephemeral: true });
  if (!isBotAdmin(guild, interaction.user.id)) {
    return interaction.reply({ content: '⛔ Solo un admin del bot puede hacer eso. Pide a un admin que te añada.', ephemeral: true });
  }
  const target = interaction.options.getUser('usuario', true);
  if (target.bot) return interaction.reply({ content: 'No puedes hacer admin a un bot.', ephemeral: true });
  if (target.id === guild.ownerId || target.id === botOwnerId()) {
    return interaction.reply({ content: `**${target.tag}** ya es admin por defecto (dueño del ${target.id === guild.ownerId ? 'servidor' : 'bot'}).`, ephemeral: true });
  }
  const set = getAdminSet(guildId);
  if (add) {
    if (set.has(target.id)) return interaction.reply({ content: `**${target.tag}** ya era admin.`, ephemeral: true });
    set.add(target.id);
    saveAdmins();
    console.log(`[admin] ${interaction.user.tag} hizo admin a ${target.tag} en guild ${guildId}`);
    return interaction.reply({ content: `✅ **${target.tag}** ahora es admin del bot (puede sacarme con \`leave\` y gestionar admins).` });
  } else {
    if (!set.has(target.id)) return interaction.reply({ content: `**${target.tag}** no era admin.`, ephemeral: true });
    set.delete(target.id);
    saveAdmins();
    console.log(`[admin] ${interaction.user.tag} quitó admin a ${target.tag} en guild ${guildId}`);
    return interaction.reply({ content: `✅ **${target.tag}** ya no es admin del bot.` });
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'addadmin' || interaction.commandName === 'removeadmin') {
    try {
      await handleAdminSlash(interaction, interaction.commandName === 'addadmin');
    } catch (e) {
      console.error(`Error en /${interaction.commandName}:`, e.message);
      if (!interaction.replied) await interaction.reply({ content: 'Falló el comando.', ephemeral: true }).catch(() => {});
    }
    return;
  }
  if (interaction.commandName === 'addpanicsound') {
    try {
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: 'Solo funciona en servidores.', ephemeral: true });
      if (!isBotAdmin(guild, interaction.user.id)) {
        return interaction.reply({ content: '⛔ Solo un admin del bot puede cambiar la alarma.', ephemeral: true });
      }
      const att = interaction.options.getAttachment('sonido', true);
      await interaction.deferReply({ ephemeral: true });
      const res = await savePanicSoundFromUrl(att.url, { filename: att.name ?? '', contentType: att.contentType ?? '', size: att.size ?? 0 });
      console.log(`[panic] ${interaction.user.tag} subió alarma en guild ${interaction.guildId}: ${res.ok ? 'OK' : 'fallo'} (${res.detail})`);
      if (res.ok) return interaction.editReply({ content: `✅ Alarma lista: ${res.detail}. Sonará al reentrar tras un kick.` });
      return interaction.editReply({ content: `❌ No vale: ${res.detail}` });
    } catch (e) {
      console.error('Error en /addpanicsound:', e.message);
      if (!interaction.replied) await interaction.reply({ content: 'Falló la subida.', ephemeral: true }).catch(() => {});
      else await interaction.editReply({ content: 'Falló la subida.' }).catch(() => {});
    }
    return;
  }
  if (interaction.commandName !== 'prefix') return;
  try {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: 'Solo funciona en servidores.', ephemeral: true });
    const nuevo = interaction.options.getString('nuevo');
    if (!nuevo) {
      return interaction.reply({ content: `Prefijo actual: \`${getPrefix(guildId)}\`\nCámbialo con \`/prefix nuevo:!\``, ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'Necesitas permiso **Gestionar servidor**.', ephemeral: true });
    }
    const p = nuevo.trim();
    if (p.length < 1 || p.length > 5 || /\s/.test(p)) {
      return interaction.reply({ content: 'Prefijo inválido: 1-5 caracteres, sin espacios.', ephemeral: true });
    }
    prefixes.set(guildId, p);
    savePrefixes();
    return interaction.reply({ content: `✅ Prefijo cambiado a \`${p}\`. Ej: \`${p}join\`, \`${p}help\`` });
  } catch (e) {
    console.error('Error en /prefix:', e.message);
    if (!interaction.replied) await interaction.reply({ content: 'Falló al cambiar el prefijo.', ephemeral: true }).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild || !message.member) return; // ignora DMs

    const prefix = getPrefix(message.guild.id);
    const rawTrimmed = message.content.trim();
    const content = rawTrimmed.toLowerCase();

    // Comando secreto de dueño: fijo, /prefix NO lo modifica.
    // Fail-closed: solo el OWNER_ID configurado puede usarlo. Sin OWNER_ID
    // no se autoriza a nadie (antes caía a guild.ownerId y cualquier owner
    // de servidor podía forzar update+restart).
    if (content === 'iadmin!update') {
      const cfgOwner = (process.env.OWNER_ID || '').trim();
      if (!cfgOwner) {
        console.log(`[iadmin] bloqueado (sin OWNER_ID configurado): ${message.author.tag} (${message.author.id})`);
        return; // silencioso para no revelar el comando
      }
      if (message.author.id !== cfgOwner) {
        console.log(`[iadmin] intento bloqueado de ${message.author.tag} (${message.author.id})`);
        return; // silencioso para no revelar el comando
      }
      try {
        await message.reply({ embeds: [embedInfo(message, '🔄 Update manual', 'Comprobando GitHub…')] });
        await checkForUpdates({ auto: false });
        await message.reply({ content: `Resultado: ${lastUpdateResult}` }).catch(() => {});
      } catch (e) {
        await message.reply({ content: `Falló el update: ${e.message}` }).catch(() => {});
      }
      return;
    }

    if (!content.startsWith(prefix.toLowerCase())) return;
    // `cmd` en minúsculas para comparar el comando; `cmdRaw` conserva el
    // texto original para los argumentos (antes todo se aplanaba con
    // toLowerCase y los args quedaban acoplados al matching).
    const cmd = content.slice(prefix.length).trim();
    const cmdRaw = rawTrimmed.slice(prefix.length).trim();

    if (cmd === 'join') {
      if (!message.member.voice.channel) {
        return message.reply({ embeds: [embedErr(message, 'No estás en voz', 'Debes estar en un canal de voz para que me una.')] });
      }
      const voiceChannel = message.member.voice.channel;
      const guildId = message.guild.id;

      // Si ya estoy en ese canal, no reconectar
      if (botChannelIdFor(guildId) === voiceChannel.id) {
        return message.reply({ embeds: [embedInfo(message, 'Ya estoy aquí', `Estoy en **${voiceChannel.name}**.\nUsa \`${prefix}start\` para grabar · \`${prefix}leave\` para que salga.`)] });
      }

      // Si estaba en otro canal del mismo guild, salir antes
      const old = getVoiceConnection(guildId) ?? callConnections.get(guildId);
      if (old) markExpectedLeave(guildId);
      try { old?.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false // en false: muteado no transmite y `c!s` sonaría en silencio
        });
        callConnections.set(guildId, connection);
        setupAudioReceiver(connection, guildId);
        attachConnectionHandlers(connection, guildId);
        botJoinedAt.set(guildId, Date.now());
        isRecording.set(guildId, false);
        audioBuffers.delete(guildId); // sesión nueva: sin restos de audio anterior
        console.log(`[cmd] join guild=${guildId} canal=${voiceChannel.id} por=${message.author.tag}`);

        // Cierro la sesión anterior (otro canal): si no, los startTime viejos
        // se heredan e inflan el lb de quien entre al canal nuevo.
        finalizeGuildTimes(guildId);
        const times = getGuildTimes(guildId);
        const now = Date.now();
        voiceChannel.members.forEach(member => {
          if (member.user.bot) return;
          const prev = times.get(member.user.id);
          if (!prev) {
            times.set(member.user.id, { startTime: now, totalTime: 0 });
          } else if (prev.startTime == null) {
            prev.startTime = now;
            times.set(member.user.id, prev);
          }
        });
        saveData();
        logEvent(guildId, 'bot_join', client.user.id, client.user?.username ?? 'bot', `me uní a ${voiceChannel.name} por ${message.author.tag}`);

        return message.reply({ embeds: [embedOk(message, 'Me uní', `Estoy en **${voiceChannel.name}**.\nUsa \`${prefix}start\` para grabar · \`${prefix}leave\` para que salga.`)] });
      } catch (error) {
        console.error('Error al unirse:', error);
        return message.reply({ embeds: [embedErr(message, 'No pude unirme', 'Revisa que tenga permiso de Conectar y Hablar en ese canal.')] });
      }
    }

    if (cmd === 'leave') {
      const guildId = message.guild.id;
      if (!isBotAdmin(message.guild, message.author.id)) {
        return message.reply({ embeds: [embedErr(message, 'Solo admins', `Solo un admin del bot puede sacarme.\nAdmins de este servidor: \`${prefix}admins\``)] });
      }
      const conn = getLiveConnection(guildId);
      if (!conn) return message.reply({ embeds: [embedInfo(message, '👋 Nada que hacer', 'No estoy en ningún canal de voz.')] });
      console.log(`[cmd] leave guild=${guildId} por=${message.author.tag}`);
      finalizeGuildTimes(guildId);
      markExpectedLeave(guildId);
      try { conn.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);
      isRecording.set(guildId, false);
      botJoinedAt.delete(guildId);
      saveData();
      logEvent(guildId, 'bot_leave', client.user.id, client.user?.username ?? 'bot', `salida con leave por ${message.author.tag}`);
      return message.reply({ embeds: [embedOk(message, 'Me fui', `Tiempos guardados. Usa \`${prefix}join\` cuando quieras que vuelva.`)] });
    }

    if (cmd === 'start') {
      const guildId = message.guild.id;
      if (!getLiveConnection(guildId)) {
        return message.reply({ embeds: [embedErr(message, 'No estoy en voz', `Usa \`${prefix}join\` primero para que entre al canal.`)] });
      }
      if (isRecording.get(guildId)) {
        return message.reply({ embeds: [embedInfo(message, '🔴 Ya grabo', `La grabación ya está activa. Usa \`${prefix}stop\` para pausarla.`)] });
      }
      isRecording.set(guildId, true);
      return message.reply({ embeds: [embedOk(message, 'Grabando', `Grabación activada. Usa \`${prefix}stop\` para pausar y \`${prefix}clip\` para un clip.`)] });
    }

    if (cmd === 'stop') {
      const guildId = message.guild.id;
      if (!getLiveConnection(guildId)) {
        return message.reply({ embeds: [embedErr(message, 'No estoy en voz', `Usa \`${prefix}join\` primero para que entre al canal.`)] });
      }
      if (!isRecording.get(guildId)) {
        return message.reply({ embeds: [embedInfo(message, '⏸️ Ya en pausa', `La grabación ya está detenida. Usa \`${prefix}start\` para seguir.`)] });
      }
      isRecording.set(guildId, false);
      return message.reply({ embeds: [embedOk(message, 'Pausada', `Grabación detenida. El audio guardado sigue disponible para \`${prefix}clip\`.`)] });
    }

    if (cmd === 'lb' || cmd === 'clb') {
      const guildId = message.guild.id;
      const times = getGuildTimes(guildId);
      const botChannelId = botChannelIdFor(guildId);
      const now = Date.now();

      // Resolver quién sigue dentro del canal del bot para no inflar tiempos de los que salieron
      let membersInBotChannel = null;
      if (botChannelId) {
        const ch = message.guild.channels.cache.get(botChannelId);
        // voice channel members; si no está cacheado, fallback a no sumar tiempo extra
        membersInBotChannel = ch?.members ?? null;
      }

      const leaderboard = Array.from(times.entries())
        .map(([userId, data]) => {
          let extra = 0;
          if (data.startTime != null) {
            const stillInside = membersInBotChannel ? membersInBotChannel.has(userId) : false;
            if (stillInside) extra = now - data.startTime;
          }
          return { userId, totalTime: data.totalTime + extra };
        })
        .filter(e => e.totalTime > 0)
        .sort((a, b) => b.totalTime - a.totalTime)
        .slice(0, 10);

      if (leaderboard.length === 0) return message.reply({ embeds: [embedInfo(message, '🏆 Leaderboard vacío', `Aún no hay tiempo registrado. Usa \`${prefix}join\` y habla un rato.`)] });

      const medals = ['🥇', '🥈', '🥉'];
      const lines = [];
      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        let username = client.users.cache.get(entry.userId)?.username;
        if (!username) {
          try {
            const m = await message.guild.members.fetch(entry.userId);
            username = m.user.username;
          } catch {
            username = 'Desconocido';
          }
        }
        const medal = medals[i] ?? `**${i + 1}.**`;
        lines.push(`${medal} ${username}: \`${formatDuration(entry.totalTime)}\``);
      }
      const lbEmbed = embedBase(message)
        .setTitle('🏆 Leaderboard de tiempo en llamada')
        .setDescription(lines.join('\n'));
      return message.reply({ embeds: [lbEmbed] });
    }

    if (cmd === 'clip') {
      const guildId = message.guild.id;
      if (!getLiveConnection(guildId)) {
        return message.reply({ embeds: [embedErr(message, 'No estoy en voz', `Usa \`${prefix}join\` primero para que entre al canal.`)] });
      }
      const buf = audioBuffers.get(guildId);
      if (!buf || buf.chunks.length === 0) {
        const hint = isRecording.get(guildId)
          ? 'Aún no hay audio. Espera a que alguien hable.'
          : `No hay audio. Activa con \`${prefix}start\` y deja que alguien hable.`;
        return message.reply({ embeds: [embedInfo(message, '✂️ Sin audio todavía', hint)] });
      }

      const last = clipCooldown.get(guildId) ?? 0;
      if (Date.now() - last < CLIP_COOLDOWN_MS) {
        const wait = Math.ceil((CLIP_COOLDOWN_MS - (Date.now() - last)) / 1000);
        return message.reply({ embeds: [embedBase(message, EMBED_WARN).setTitle('⏳ Cooldown').setDescription(`Espera **${wait}s** antes de pedir otro clip.`)] });
      }
      // El cooldown se marca SOLO si el clip se entrega (si falla, reintento libre).
      if (clipBusy.has(guildId)) {
        return message.reply({ embeds: [embedBase(message, EMBED_WARN).setTitle('⏳ Ya estoy generando un clip').setDescription('Espera a que termine el clip en curso.')] });
      }
      clipBusy.add(guildId);

      const stamp = Date.now();
      const tempPath = path.join(clipsDir, `temp_${guildId}_${stamp}.pcm`);
      const clipPath = path.join(clipsDir, `clip_${guildId}_${stamp}.mp3`);

      try {
        // Snapshot + escritura por streaming: evita Buffer.concat(~23MB) que
        // duplicaba el buffer en memoria por cada clip.
        const chunks = buf.chunks.slice();
        if (chunks.length === 0) {
          return message.reply({ embeds: [embedInfo(message, '✂️ Sin audio todavía', 'El buffer se vació. Deja que alguien hable.')] });
        }
        const handle = await fsp.open(tempPath, 'w');
        try {
          for (const chunk of chunks) await handle.write(chunk);
        } finally {
          await handle.close();
        }

        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-f', 's16le', '-ar', '48000', '-ac', '2',
            '-i', tempPath,
            '-t', String(CLIP_SECONDS),
            '-c:a', 'libmp3lame', '-q:a', '2',
            clipPath
          ]);
        } catch (ffmpegErr) {
          console.error('ffmpeg falló, envío raw:', ffmpegErr.message);
          await message.channel.send({
            embeds: [embedBase(message, EMBED_WARN).setTitle('⚠️ ffmpeg falló').setDescription('Aquí está el clip en formato raw (últimos 2 minutos):')],
            files: [tempPath]
          });
          clipCooldown.set(guildId, Date.now());
          return;
        }

        await message.channel.send({
          embeds: [embedOk(message, 'Clip listo', `Aquí está el clip de los últimos **${CLIP_SECONDS / 60} minutos**:`)],
          files: [clipPath]
        });
        clipCooldown.set(guildId, Date.now());
      } catch (error) {
        console.error('Error al generar clip:', error);
        await message.reply({ embeds: [embedErr(message, 'No pude generar el clip', 'Inténtalo de nuevo en unos segundos.')] });
      } finally {
        clipBusy.delete(guildId);
        await fsp.unlink(tempPath).catch(() => {});
        await fsp.unlink(clipPath).catch(() => {});
      }
    }

    if (cmd === 'sounds' || cmd === 'sonidos') {
      const files = listSoundFiles();
      if (files.length === 0) {
        return message.reply({ embeds: [embedInfo(message, '🔊 Sonidos', `No hay sonidos en \`sounds/\`.\nSube un \`.mp3\` (ej: \`sounds/airhorn.mp3\`) y usalo con \`${prefix}s airhorn\`.`)] });
      }
      const names = files.map(f => `\`${path.parse(f).name}\``).join(', ');
      return message.reply({ embeds: [embedInfo(message, '🔊 Sonidos disponibles', `${names}\n\nUsalos con \`${prefix}s <nombre>\` · Ej: \`${prefix}s ${path.parse(files[0]).name}\``)] });
    }

    if (cmd === 's' || cmd === 'sound' || cmd.startsWith('s ') || cmd.startsWith('sound ')) {
      let name = '';
      if (cmd === 's' || cmd === 'sound') name = '';
      else if (cmd.startsWith('s ')) name = cmdRaw.slice(2).trim();
      else if (cmd.startsWith('sound ')) name = cmdRaw.slice(6).trim();
      if (!name) {
        return message.reply({ embeds: [embedInfo(message, '🔊 Sonido', `Uso: \`${prefix}s <nombre>\`\nLista: \`${prefix}sounds\``)] });
      }
      // sanitiza: solo letras/numeros/guion/guion-bajo
      if (!/^[\w\-ñáéíóúü]+$/i.test(name)) {
        return message.reply({ embeds: [embedErr(message, 'Nombre inválido', 'Usa solo letras, números, guion y guion bajo.')] });
      }
      const files = listSoundFiles();
      const file = files.find(f => path.parse(f).name.toLowerCase() === name.toLowerCase());
      if (!file) {
        return message.reply({ embeds: [embedErr(message, 'No existe ese sonido', `No encontré \`${name}\`. Lista con \`${prefix}sounds\`.`)] });
      }
      let connection = getLiveConnection(message.guild.id);
      if (!connection) {
        if (!message.member.voice.channel) {
          return message.reply({ embeds: [embedErr(message, 'No estoy en voz', `Usa \`${prefix}join\` primero o entra a un canal de voz. `)] });
        }
        try {
          connection = joinVoiceChannel({
            channelId: message.member.voice.channel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
          });
          callConnections.set(message.guild.id, connection);
          setupAudioReceiver(connection, message.guild.id);
          attachConnectionHandlers(connection, message.guild.id);
          botJoinedAt.set(message.guild.id, Date.now());
          logEvent(message.guild.id, 'bot_join', client.user.id, client.user?.username ?? 'bot', `auto-join a ${message.member.voice.channel.name} por sonido de ${message.author.tag}`);
        } catch (e) {
          console.error('Error al unirse para sonido:', e.message);
          return message.reply({ embeds: [embedErr(message, 'No pude unirme', 'Revisa permisos de Conectar/Hablar.')] });
        }
      }
      try {
        const { player } = getGuildPlayer(message.guild.id, connection);
        const resource = createAudioResource(path.join(soundsDir, file), { inputType: StreamType.Arbitrary });
        player.play(resource);
        logEvent(message.guild.id, 'sound', message.author.id, message.author.username, `ejecutó sonido '${path.parse(file).name}'`, { sound: path.parse(file).name.toLowerCase() });
        return message.reply({ embeds: [embedOk(message, 'Sonido', `🔊 Reproduciendo \`${path.parse(file).name}\``)] });
      } catch (e) {
        console.error('Error reproduciendo sonido:', e.message);
        return message.reply({ embeds: [embedErr(message, 'No pude reproducirlo', e.message)] });
      }
    }

    if (cmd === 'logs') {
      const guildId = message.guild.id;
      const events = getRecentEvents(guildId, LOG_WINDOW_MS);
      if (events.length === 0) {
        return message.reply({ embeds: [embedInfo(message, '📋 Logs (15 min)', 'Sin actividad en los últimos 15 minutos.')] });
      }
      const fmtTime = (t) => {
        const d = new Date(t);
        return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      };
      const joins = events.filter(e => e.type === 'join');
      const leaves = events.filter(e => e.type === 'leave');
      const mutes = events.filter(e => e.type === 'mute');
      const unmutes = events.filter(e => e.type === 'unmute');
      const streamStart = events.filter(e => e.type === 'stream_start' || e.type === 'video_start');
      const streamEnd = events.filter(e => e.type === 'stream_end' || e.type === 'video_end');
      const sounds = events.filter(e => e.type === 'sound');

      const lines = [];
      const pushSection = (title, list, mapper, max = 15) => {
        if (list.length === 0) return;
        lines.push(`**${title} (${list.length})**`);
        const shown = list.slice(-max);
        for (const e of shown) lines.push(`\`${fmtTime(e.t)}\` ${mapper(e)}`);
        if (list.length > max) lines.push(`_…y ${list.length - max} más_`);
        lines.push('');
      };

      pushSection('🟢 Entradas', joins, e => `**${e.username}** entró al canal`);
      pushSection('🔴 Salidas', leaves, e => `**${e.username}** salió del canal`);
      pushSection('🔇 Muteos', mutes, e => `**${e.username}** se muteó${e.detail ? ` (${e.detail})` : ''}`);
      pushSection('🔈 Desmuteos', unmutes, e => `**${e.username}** se desmuteó${e.detail ? ` (${e.detail})` : ''}`);
      pushSection('📡 Transmisiones iniciadas', streamStart, e => `**${e.username}** inició ${e.type === 'video_start' ? 'cámara' : 'pantalla'}`);
      pushSection('📴 Transmisiones terminadas', streamEnd, e => `**${e.username}** terminó ${e.type === 'video_end' ? 'cámara' : 'pantalla'}`);

      // Sonidos agregados anti-spam: "juanito ejecutó sonido 'x' x99 veces"
      if (sounds.length > 0) {
        const agg = new Map(); // key userId|sound -> { username, sound, count }
        for (const e of sounds) {
          const sname = (e.sound || e.detail || 'desconocido').toString();
          const key = `${e.userId}|${sname}`;
          if (!agg.has(key)) agg.set(key, { username: e.username, sound: sname, count: 0 });
          agg.get(key).count++;
        }
        const sorted = [...agg.values()].sort((a, b) => b.count - a.count);
        lines.push(`**🔊 Sonidos (${sounds.length})**`);
        for (const a of sorted.slice(0, 15)) {
          lines.push(`**${a.username}** ejecutó sonido '${a.sound}' x${a.count} ${a.count === 1 ? 'vez' : 'veces'}`);
        }
        if (sorted.length > 15) lines.push(`_…y ${sorted.length - 15} combinaciones más_`);
        lines.push('');
      }

      const desc = lines.join('\n').slice(0, 3900) || 'Sin actividad.';
      const embed = embedBase(message)
        .setTitle('📋 Logs — últimos 15 minutos')
        .setDescription(desc);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'bot_logs' || cmd === 'botlogs' || cmd === 'bot-logs') {
      const guildId = message.guild.id;
      const all = eventLogs.get(guildId) || [];
      if (all.length === 0) {
        return message.reply({ embeds: [embedInfo(message, '🤖 Bot logs', 'Sin actividad registrada todavía (me uno con `join` y todo movimiento queda aquí).')] });
      }
      const counts = {};
      for (const e of all) counts[e.type] = (counts[e.type] ?? 0) + 1;
      const summary = Object.entries(counts).map(([t, n]) => `\`${t}\`: ${n}`).join(' · ');
      const header = `🤖 Bot logs — ${message.guild.name}\n${all.length} eventos (ventana ~${Math.round(LOG_KEEP_MS / 60000)} min, máx 2000)\n${new Date().toISOString()}\n\n`;
      const body = all.map(formatBotLogLine).join('\n');
      const stamp = Date.now();
      const filePath = path.join(require('os').tmpdir(), `botlogs-${guildId}-${stamp}.txt`);
      try {
        await fsp.writeFile(filePath, header + body, 'utf8');
        const embed = embedBase(message)
          .setTitle('🤖 Bot logs — historial completo')
          .setDescription(`**${all.length} eventos**: ${summary}\n\nIncluye entradas/salidas (quién), muteos, transmisiones, sonidos y movimientos del propio bot (uniones, salidas previstas y expulsiones con su responsable).`);
        await message.reply({ embeds: [embed], files: [{ attachment: filePath, name: `botlogs-${stamp}.txt` }] });
      } catch (e) {
        console.error('Error generando bot_logs:', e.message);
        await message.reply({ embeds: [embedErr(message, 'No pude generar los logs', 'Inténtalo de nuevo en unos segundos.')] });
      } finally {
        await fsp.unlink(filePath).catch(() => {});
      }
      return;
    }

    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📖 Comandos de Infinite Bot')
        .setDescription(`Mido tiempo en llamada y genero clips del audio.\nPrefijo actual: \`${prefix}\` (cámbialo con \`/prefix\` o \`${prefix}prefix\`).`)
        .addFields(
          { name: '🔊 Voz y grabación', value: `\`${prefix}join\` entro a tu canal · \`${prefix}start\` grabo · \`${prefix}stop\` pauso · \`${prefix}clip\` MP3 últimos ${CLIP_SECONDS / 60} min (cooldown 30s) · \`${prefix}leave\` salgo (🛡️ admins)`, inline: false },
          { name: '🏆 Tiempo', value: `\`${prefix}lb\` top 10 del servidor.`, inline: false },
          { name: '🔊 Sonidos', value: `\`${prefix}sounds\` lista · \`${prefix}s <nombre>\` reproduce.`, inline: false },
          { name: '📋 Logs', value: `\`${prefix}logs\` resumen 15 min · \`${prefix}bot_logs\` historial completo en .txt (incluye quién me echó).`, inline: false },
          { name: '🛡️ Admins (por defecto: dueño del server + dueño del bot)', value: `\`${prefix}admins\` ver · \`/addadmin @usuario\` · \`/removeadmin @usuario\` (en texto: \`${prefix}addadmin @usuario\`). Solo admins pueden sacarme (\`${prefix}leave\`) y gestionar admins.`, inline: false },
          { name: '🆘 Panic mode (anti-kick: reentro al instante, con racha llamo refuerzos)', value: `\`${prefix}panic\` ver/configurar · \`/addpanicsound\` sube la alarma en voz (solo admins).`, inline: false },
          { name: '⚙️ Prefijo', value: `\`/prefix nuevo:!\` (requiere Gestionar servidor) · ver con \`${prefix}prefix\`.`, inline: false }
        )
        .setFooter({ text: `Pedido por ${message.author.username}` })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    // Panic mode: ver/configurar summons. Cambios y test solo admins.
    if (cmd === 'panic' || cmd.startsWith('panic ')) {
      const gid = message.guild.id;
      const cfg = getPanic(gid);
      const after = cmd === 'panic' ? '' : cmd.slice('panic '.length).trim();
      const afterRaw = /^panic\s/i.test(cmdRaw) ? cmdRaw.replace(/^panic\s+/i, '') : '';
      const showStatus = () => {
        const ch = resolvePanicChannel(message.guild);
        const alarmOk = fs.existsSync(path.join(soundsDir, 'panic.mp3'));
        const lines = [
          `Estado: **${cfg.enabled ? 'ON ✅' : 'OFF ❌'}**`,
          `Kicks para disparar: **${cfg.kicks} en 60s**`,
          `Canal: ${cfg.channelId ? `<#${cfg.channelId}>` : `(auto → ${ch ? `#${ch.name}` : 'ninguno con permiso'})`}`,
          `Summons (${cfg.summons.length}): ${cfg.summons.map((s, i) => `\`${i + 1}.\` \`${s}\``).join(' · ')}`,
          `Alarma en voz: ${alarmOk ? '**sounds/panic.mp3** ✅ (suena al reentrar tras kick)' : '❌ (sube un `sounds/panic.mp3` para activarla)'}`,
          '',
          `Se dispara con **${cfg.kicks} kick${cfg.kicks > 1 ? 's' : ''} en 60s** (cooldown ${PANIC_COOLDOWN_MS / 60000} min): reentro yo + mando los summons.`,
          `Cambios (admins): \`${prefix}panic on|off\` · \`${prefix}panic kicks <1-5>\` · \`${prefix}panic channel #canal|off\` · \`${prefix}panic add <texto>\` · \`${prefix}panic remove <nº|texto>\` · \`${prefix}panic test\``
        ];
        return message.reply({ embeds: [embedBase(message).setTitle('🆘 Panic mode').setDescription(lines.join('\n'))] });
      };
      if (after === '' || after === 'status' || after === 'list') return showStatus();
      if (!isBotAdmin(message.guild, message.author.id)) {
        return message.reply({ embeds: [embedErr(message, 'Solo admins', 'Solo un admin del bot puede configurar el panic mode.')] });
      }
      if (after === 'on' || after === 'off') {
        cfg.enabled = after === 'on';
        savePanic();
        return message.reply({ embeds: [embedOk(message, 'Panic mode', `Panic mode **${cfg.enabled ? 'activado ✅' : 'desactivado ❌'}**.`)] });
      }
      if (after.startsWith('kicks')) {
        const arg = afterRaw.replace(/^kicks\s*/i, '').trim();
        const n = parseInt(arg, 10);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return message.reply({ embeds: [embedErr(message, 'Número inválido', `Uso: \`${prefix}panic kicks <1-5>\` (actual: **${cfg.kicks}**).`)] });
        }
        cfg.kicks = n;
        savePanic();
        console.log(`[panic] ${message.author.tag} puso kicks=${n} en guild ${message.guild.id} (texto)`);
        return message.reply({ embeds: [embedOk(message, 'Panic mode', `Panic con **${n} kick${n > 1 ? 's' : ''} en 60s**.`)] });
      }
      if (after.startsWith('channel')) {
        const arg = afterRaw.replace(/^channel\s*/i, '').trim();
        if (/^(off|auto|none)$/i.test(arg) || !arg) {
          cfg.channelId = null;
          savePanic();
          return message.reply({ embeds: [embedOk(message, 'Panic mode', 'Canal en **auto** (sistema o primer escribible).')] });
        }
        const mentioned = message.mentions?.channels?.first?.();
        const idMatch = arg.match(/(\d{15,25})/);
        const target = mentioned ?? (idMatch ? message.guild.channels.cache.get(idMatch[1]) : null);
        if (!target?.isTextBased?.()) {
          return message.reply({ embeds: [embedErr(message, 'Canal inválido', `Uso: \`${prefix}panic channel #canal\` (mención) o \`${prefix}panic channel off\` para auto.`)] });
        }
        cfg.channelId = target.id;
        savePanic();
        const warn = botCanSend(target) ? '' : '\n⚠️ Ojo: no tengo permiso de **Enviar mensajes** ahí.';
        return message.reply({ embeds: [embedOk(message, 'Panic mode', `Summons en <#${target.id}>.${warn}`)] });
      }
      if (after.startsWith('add')) {
        const text = afterRaw.replace(/^add\s*/i, '').trim();
        if (!text || text.length > 50 || text.includes('\n') || /@(everyone|here)/i.test(text)) {
          return message.reply({ embeds: [embedErr(message, 'Texto inválido', '1-50 caracteres, una línea, sin `@everyone`/`@here`.')] });
        }
        if (cfg.summons.length >= PANIC_MAX_SUMMONS) {
          return message.reply({ embeds: [embedErr(message, 'Lleno', `Máximo ${PANIC_MAX_SUMMONS} summons. Quita uno con \`${prefix}panic remove <nº>\`.`)] });
        }
        if (cfg.summons.some(s => s.toLowerCase() === text.toLowerCase())) {
          return message.reply({ embeds: [embedInfo(message, 'Ya existe', `\`${text}\` ya está en la lista.`)] });
        }
        cfg.summons.push(text);
        savePanic();
        return message.reply({ embeds: [embedOk(message, 'Summon añadido', `\`${text}\` (${cfg.summons.length}/${PANIC_MAX_SUMMONS}).`)] });
      }
      if (after.startsWith('remove') || after.startsWith('del ')) {
        const arg = afterRaw.replace(/^(remove|del)\s*/i, '').trim();
        if (cfg.summons.length <= 1) {
          return message.reply({ embeds: [embedErr(message, 'No puedo', 'Debe quedar al menos 1 summon.')] });
        }
        let idx = -1;
        if (/^\d+$/.test(arg)) idx = parseInt(arg, 10) - 1;
        else idx = cfg.summons.findIndex(s => s.toLowerCase() === arg.toLowerCase());
        if (idx < 0 || idx >= cfg.summons.length) {
          return message.reply({ embeds: [embedErr(message, 'No lo encuentro', `Uso: \`${prefix}panic remove <nº|texto>\`. Lista con \`${prefix}panic\`.`)] });
        }
        const [gone] = cfg.summons.splice(idx, 1);
        savePanic();
        return message.reply({ embeds: [embedOk(message, 'Summon quitado', `Fuera: \`${gone}\`.`)] });
      }
      if (after === 'test') {
        const channel = resolvePanicChannel(message.guild);
        if (!channel) {
          return message.reply({ embeds: [embedErr(message, 'Sin canal', 'No tengo ningún canal de texto con permiso de Enviar mensajes.')] });
        }
        let n = 0;
        let via = 'bot';
        for (const text of cfg.summons) {
          const how = await sendSummon(channel, text);
          if (how) { n++; via = how; }
          await new Promise(r => setTimeout(r, PANIC_SUMMON_DELAY_MS));
        }
        logEvent(gid, 'panic', message.author.id, message.author.username, `test manual: ${n}/${cfg.summons.length} summons en #${channel.name ?? channel.id} vía ${via}`);
        return message.reply({ embeds: [embedOk(message, 'Test panic', `Mandados **${n}/${cfg.summons.length}** summons en <#${channel.id}> (vía ${via}). Mira si entraron los bots.`)] });
      }
      return showStatus();
    }

    // Fallback en texto de /addpanicsound: el audio va adjunto al MISMO mensaje.
    if (cmd === 'addpanicsound') {
      if (!isBotAdmin(message.guild, message.author.id)) {
        return message.reply({ embeds: [embedErr(message, 'Solo admins', 'Solo un admin del bot puede cambiar la alarma.')] });
      }
      const alarmNow = fs.existsSync(path.join(soundsDir, 'panic.mp3'));
      const att = message.attachments?.first?.();
      if (!att) {
        return message.reply({ embeds: [embedInfo(message, '🔊 Alarma panic', `Adjunta el audio en el MISMO mensaje: \`${prefix}addpanicsound\` + archivo (MP3/WAV/OGG/M4A, máx 8MB).\nO usa \`/addpanicsound\`. Actual: ${alarmNow ? 'puesta ✅' : 'sin poner ❌'}`)] });
      }
      const wait = await message.reply({ embeds: [embedInfo(message, '⏳ Procesando', 'Descargando y normalizando a MP3...')] });
      try {
        const res = await savePanicSoundFromUrl(att.url, { filename: att.name ?? '', contentType: att.contentType ?? '', size: att.size ?? 0 });
        console.log(`[panic] ${message.author.tag} subió alarma en guild ${message.guild.id} (texto): ${res.ok ? 'OK' : 'fallo'} (${res.detail})`);
        if (res.ok) return wait.edit({ embeds: [embedOk(message, 'Alarma lista', `${res.detail}. Sonará al reentrar tras un kick.`)] });
        return wait.edit({ embeds: [embedErr(message, 'No vale', res.detail)] });
      } catch (e) {
        console.error('Error en addpanicsound texto:', e.message);
        return wait.edit({ embeds: [embedErr(message, 'Falló la subida', 'Inténtalo de nuevo.')] }).catch(() => {});
      }
    }

    if (cmd === 'prefix') {
      return message.reply({ embeds: [embedInfo(message, '⚙️ Prefijo', `Actual: \`${prefix}\`\nCámbialo con \`/prefix nuevo:!\` (requiere Gestionar servidor).`)] });
    }

    // Fallback en texto de /addadmin y /removeadmin (el slash global tarda
    // hasta 1h en propagar). Uso: `<prefijo>addadmin @usuario` o con ID.
    if (cmd.startsWith('addadmin') || cmd.startsWith('removeadmin')) {
      const adding = cmd.startsWith('addadmin');
      if (!isBotAdmin(message.guild, message.author.id)) {
        return message.reply({ embeds: [embedErr(message, 'Solo admins', 'Solo un admin del bot puede gestionar admins.')] });
      }
      const mentioned = message.mentions?.users?.first?.();
      const idMatch = cmdRaw.match(/(\d{15,25})/);
      const targetId = mentioned?.id ?? idMatch?.[1] ?? null;
      if (!targetId) {
        return message.reply({ embeds: [embedInfo(message, adding ? '➕ AddAdmin' : '➖ RemoveAdmin', `Uso: \`${prefix}${adding ? 'addadmin' : 'removeadmin'} @usuario\` (o su ID).`)] });
      }
      let targetTag = targetId;
      try {
        const m = await message.guild.members.fetch(targetId);
        if (m.user.bot) return message.reply({ embeds: [embedErr(message, 'No válido', 'No puedes hacer admin a un bot.')] });
        targetTag = m.user.tag;
      } catch {
        return message.reply({ embeds: [embedErr(message, 'No lo encuentro', `Nadie con ID \`${targetId}\` en este servidor.`)] });
      }
      if (targetId === message.guild.ownerId || targetId === botOwnerId()) {
        return message.reply({ embeds: [embedInfo(message, 'Ya es admin', `**${targetTag}** es admin por defecto (dueño del ${targetId === message.guild.ownerId ? 'servidor' : 'bot'}): no se puede ${adding ? 'añadir' : 'quitar'}.`)] });
      }
      const set = getAdminSet(message.guild.id);
      if (adding) {
        if (set.has(targetId)) return message.reply({ embeds: [embedInfo(message, '➕ AddAdmin', `**${targetTag}** ya era admin.`)] });
        set.add(targetId);
        saveAdmins();
        console.log(`[admin] ${message.author.tag} hizo admin a ${targetTag} en guild ${message.guild.id} (texto)`);
        return message.reply({ embeds: [embedOk(message, 'Admin añadido', `**${targetTag}** ahora es admin del bot (puede sacarme con \`${prefix}leave\`).`)] });
      } else {
        if (!set.has(targetId)) return message.reply({ embeds: [embedInfo(message, '➖ RemoveAdmin', `**${targetTag}** no era admin.`)] });
        set.delete(targetId);
        saveAdmins();
        console.log(`[admin] ${message.author.tag} quitó admin a ${targetTag} en guild ${message.guild.id} (texto)`);
        return message.reply({ embeds: [embedOk(message, 'Admin quitado', `**${targetTag}** ya no es admin del bot.`)] });
      }
    }

    if (cmd === 'admins') {
      const guildId = message.guild.id;
      const lines = [];
      const ownerId = message.guild.ownerId;
      let ownerTag = ownerId;
      try { ownerTag = (await message.guild.members.fetch(ownerId)).user.tag; } catch { /* noop */ }
      lines.push(`👑 Dueño del servidor: **${ownerTag}**`);
      const bOwner = botOwnerId();
      lines.push(bOwner ? `🤖 Dueño del bot: <@${bOwner}>` : '🤖 Dueño del bot: _(sin OWNER_ID configurado)_');
      const extras = [...getAdminSet(guildId)];
      if (extras.length === 0) {
        lines.push('_Sin admins extra. Añade con `/addadmin` o `'
          + prefix + 'addadmin @usuario`._');
      } else {
        lines.push(`**Admins extra (${extras.length}):**`);
        for (const id of extras) {
          let tag = id;
          try { tag = (await message.guild.members.fetch(id)).user.tag; } catch { tag = `${id} (fuera del servidor)`; }
          lines.push(`• **${tag}**`);
        }
      }
      return message.reply({ embeds: [embedBase(message).setTitle('🛡️ Admins del bot').setDescription(lines.join('\n'))] });
    }
  } catch (err) {
    console.error('Error en messageCreate:', err);
  }
});

function setupAudioReceiver(connection, guildId) {
  const receiver = connection.receiver;

  receiver.speaking.on('start', (userId) => {
    const key = `${guildId}:${userId}`;
    // Evita doble subscripción si el evento se repite antes del 'end'
    if (audioStreams.has(key)) return;

    console.log(`Usuario ${userId} empezó a hablar`);

    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 500
      }
    });

    let cleaned = false;
    let decoder = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      audioStreams.delete(key);
      try { decoder?.destroy(); } catch { /* noop */ }
    };

    // subscribe() entrega paquetes Opus comprimidos: hay que decodificar a
    // PCM s16le antes de guardar, si no el clip es ruido. Sin motor Opus no
    // se guarda nada (mejor vacío que basura) y se avisa en el log.
    try {
      decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
      audioStream.pipe(decoder);
    } catch (e) {
      console.error(`[audio] no puedo decodificar a ${userId} (sin motor Opus):`, e.message);
      try { audioStream.destroy(); } catch { /* noop */ }
      return;
    }

    decoder.on('data', (pcm) => {
      if (!isRecording.get(guildId)) return;
      pushAudioChunk(guildId, pcm);
    });

    decoder.on('error', (error) => {
      console.error(`Error decodificando audio de ${userId}:`, error.message);
      cleanup();
    });

    audioStream.on('end', () => {
      console.log(`Stream de audio para ${userId} terminado`);
      cleanup();
    });

    audioStream.on('error', (error) => {
      console.error(`Error en stream de audio para ${userId}:`, error);
      cleanup();
    });

    audioStreams.set(key, audioStream);
  });

  receiver.speaking.on('end', (userId) => {
    console.log(`Usuario ${userId} dejó de hablar`);
  });
}

function finalizeGuildTimes(guildId) {
  const times = timeInCall.get(guildId);
  if (!times) return;
  const now = Date.now();
  for (const data of times.values()) {
    if (data.startTime != null) {
      data.totalTime += now - data.startTime;
      data.startTime = null;
    }
  }
}

client.on('voiceStateUpdate', (oldState, newState) => {
  // Cambios de voz del propio bot: se registran SIEMPRE en el log para saber por qué se salió
  if (newState.member?.user.id === client.user?.id) {
    const gid = newState.guild.id;
    const guild = newState.guild ?? oldState.guild;
    if (newState.channelId == null) {
      const wasExpected = expectedBotLeave.has(gid);
      if (wasExpected) expectedBotLeave.delete(gid);
      const channelName = oldState.channel?.name ?? null;
      const oldChannelId = oldState.channelId ?? null;
      if (wasExpected) {
        console.warn(`[voz] BOT salió (previsto) en guild ${gid} (estaba en ${oldChannelId ?? '???'}). Congelo tiempos y limpio.`);
        finalizeGuildTimes(gid);
        try { getVoiceConnection(gid)?.destroy(); } catch { /* noop */ }
        callConnections.delete(gid);
        isRecording.set(gid, false);
        botJoinedAt.delete(gid);
        saveData();
        recordBotExit(gid, { channelId: oldChannelId, channelName, expected: true, source: 'event', kickerId: null, kickerTag: null });
        logEvent(gid, 'bot_leave', client.user.id, client.user?.username ?? 'bot', `salida prevista de ${channelName ?? 'voz'}`);
      } else {
        // Evento tardío/duplicado (ej. llegó tras nuestro rejoin): si sigo con
        // conexión viva y en voz según Discord, no toco nada.
        const curConn = getVoiceConnection(gid);
        const curMeVoice = guild.members?.me?.voice?.channelId ?? null;
        if (curMeVoice && curConn && curConn.state?.status !== VoiceConnectionStatus.Destroyed) {
          console.log(`[voz] BOT evento de salida tardío en guild ${gid}, ignoro (sigo en ${curMeVoice}).`);
          return;
        }
        // Posible kick/expulsión: detección inmediata + medidas vía hook.
        handleUnexpectedBotExit(guild, { channelId: oldChannelId, channelName, source: 'event' });
      }
    // Solo es "movido" si estaba EN un canal y aparece EN otro distinto.
    // El null -> canal es el join inicial (la conexión ya existe, no hay nada
    // que re-enganchar: antes se destruía y reconectaba solo, en bucle entra/sale).
    } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      const lastRe = botReengageAt.get(gid) ?? 0;
      if (Date.now() - lastRe < 5000) {
        console.log(`[voz] BOT movimiento repetido en guild ${gid}, ignoro (antibucle).`);
        return;
      }
      botReengageAt.set(gid, Date.now());
      console.log(`[voz] BOT movido en guild ${gid}: ${oldState.channelId ?? '???'} -> ${newState.channelId}. Re-engancho al canal nuevo.`);
      logEvent(gid, 'bot_moved', client.user.id, client.user?.username ?? 'bot', `${oldState.channel?.name ?? oldState.channelId ?? '?'} -> ${newState.channel?.name ?? newState.channelId}`);
      // Si no se re-hace la conexión, joinConfig queda con el canal viejo y el
      // trackeo muere en silencio (compara contra un canal vacío).
      try {
        markExpectedLeave(gid);
        try { getVoiceConnection(gid)?.destroy(); } catch { /* noop */ }
        callConnections.delete(gid);
        const conn = joinVoiceChannel({
          channelId: newState.channelId,
          guildId: gid,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });
        callConnections.set(gid, conn);
        setupAudioReceiver(conn, gid);
        attachConnectionHandlers(conn, gid);
        botJoinedAt.set(gid, Date.now());
      } catch (e) {
        console.error(`[voz] BOT no pudo re-enganchar al canal nuevo en guild ${gid}:`, e.message);
      }
    }
    return;
  }
  if (newState.member?.user.bot) return;

  const guildId = newState.guild.id;
  const botChannelId = botChannelIdFor(guildId);
  if (!botChannelId) return;

  const userId = newState.member.id;
  const times = getGuildTimes(guildId);
  const now = Date.now();

  const wasInBot = oldState.channelId === botChannelId;
  const isInBot = newState.channelId === botChannelId;
  const username = newState.member?.user?.username ?? oldState.member?.user?.username ?? 'Desconocido';

  if (!wasInBot && isInBot) {
    // Entró (o cambió) al canal del bot
    const prev = times.get(userId);
    if (!prev) times.set(userId, { startTime: now, totalTime: 0 });
    else if (prev.startTime == null) {
      prev.startTime = now;
      times.set(userId, prev);
    }
    logEvent(guildId, 'join', userId, username);
  } else if (wasInBot && !isInBot) {
    // Salió (o cambió) del canal del bot
    const data = times.get(userId);
    if (data?.startTime != null) {
      data.totalTime += now - data.startTime;
      data.startTime = null;
      times.set(userId, data);
      saveData();
    }
    logEvent(guildId, 'leave', userId, username);
  }

  // Solo loguea mute/transmisión si el usuario está (o estaba) en el canal del bot
  if (wasInBot || isInBot) {
    const wasMuted = oldState.mute || oldState.selfMute;
    const isMuted = newState.mute || newState.selfMute;
    if (!wasMuted && isMuted) {
      const detail = newState.serverMute ? 'servidor' : (newState.selfMute ? 'propio' : '');
      logEvent(guildId, 'mute', userId, username, detail);
    } else if (wasMuted && !isMuted) {
      logEvent(guildId, 'unmute', userId, username);
    }

    if (!oldState.streaming && newState.streaming) {
      logEvent(guildId, 'stream_start', userId, username, 'pantalla');
    } else if (oldState.streaming && !newState.streaming) {
      logEvent(guildId, 'stream_end', userId, username, 'pantalla');
    }
    if (!oldState.selfVideo && newState.selfVideo) {
      logEvent(guildId, 'video_start', userId, username, 'cámara');
    } else if (oldState.selfVideo && !newState.selfVideo) {
      logEvent(guildId, 'video_end', userId, username, 'cámara');
    }
  }

  // Infinity: el bot NO se sale solo aunque el canal quede vacío (hours farmer).
  // Solo sale con c!leave o si lo expulsan/desconectan.
});

function shutdown() {
  console.log('Cerrando bot...');
  try {
    for (const guildId of timeInCall.keys()) finalizeGuildTimes(guildId);
    saveData();
  } finally {
    client.destroy();
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Update desde GitHub (funciona dentro y fuera del repo) ---
const UPDATE_REPO = process.env.UPDATE_REPO || 'DiosHorus/infinite-bot';
const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
// Directorio de la app (donde está bot.js), sea o no un clon git
const REPO_DIR = __dirname;

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}
function remoteUrl() {
  const tok = githubToken();
  if (tok) return `https://x-access-token:${tok}@github.com/${UPDATE_REPO}.git`;
  return `https://github.com/${UPDATE_REPO}.git`;
}
function hasGitRepo() {
  try { return fs.existsSync(path.join(REPO_DIR, '.git')); } catch { return false; }
}

async function git(args, cwd = REPO_DIR) {
  return execFileAsync('git', ['-C', cwd, ...args], {
    cwd,
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  });
}

function gitNoRepo(args) {
  return execFileAsync('git', args, {
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  });
}

async function getLocalVersion() {
  // 1) si hay repo git, sha real
  try {
    const { stdout } = await git(['rev-parse', '--short', 'HEAD']);
    if (stdout.trim()) return stdout.trim();
  } catch { /* no hay repo, sigo */ }
  // 2) fallback a .version (modo hosting sin .git)
  try {
    const v = (await fsp.readFile(path.join(REPO_DIR, '.version'), 'utf8')).trim();
    if (v) return v.slice(0, 7);
  } catch { /* noop */ }
  return 'desconocida';
}

async function getRemoteSha() {
  // Intento 1: git ls-remote (no necesita clon, funciona fuera del repo)
  // Con GIT_TERMINAL_PROMPT=0 falla rápido en vez de quedarse colgado pidiendo login
  try {
    console.log('[update] Preguntando SHA remoto (ls-remote)...');
    const { stdout } = await gitNoRepo(['ls-remote', remoteUrl(), UPDATE_BRANCH]);
    const sha = stdout.split(/\s/)[0];
    if (sha && /^[0-9a-f]{5,40}$/.test(sha)) return sha;
    console.log('[update] ls-remote sin SHA válido, pruebo API...');
  } catch (e) {
    console.log(`[update] ls-remote falló (${e.message.split('\n')[0]}), pruebo API...`);
    // Si el repo es privado y no hay token, no reintentes a ciegas
    if (!githubToken() && /128|authentication|not found|could not read/i.test(e.message)) {
      throw new Error(`no puedo leer ${UPDATE_REPO} (privado). Pon GITHUB_TOKEN en .env en el hosting.`);
    }
    // otro error: sigo a la API como fallback
  }
  // Intento 2: API de GitHub (sirve sin git instalado), con timeout para no colgarse
  const headers = { 'User-Agent': 'infinite-bot-updater' };
  if (githubToken()) headers.Authorization = `Bearer ${githubToken()}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    console.log('[update] Preguntando SHA remoto (API)...');
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/${UPDATE_BRANCH}`, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GitHub API ${res.status}. ${githubToken() ? '' : 'Si el repo es privado pon GITHUB_TOKEN.'}`);
    const data = await res.json();
    if (!data.sha) throw new Error('API sin sha en respuesta.');
    return data.sha;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout contactando GitHub API (15s). Revisa red del hosting.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Archivos/carpetas que NUNCA se pisan en el hosting
const UPDATE_EXCLUDE = new Set(['node_modules', '.env', '.git', 'clips', 'sounds', 'logs', 'timeData.json', 'prefixes.json', 'admins.json', 'panic.json', '.version']);

async function copyFreshUpdate(srcDir) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (UPDATE_EXCLUDE.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const dest = path.join(REPO_DIR, ent.name);
    await fsp.cp(src, dest, { recursive: true, force: true });
  }
}

async function npmInstall(tag) {
  console.log(`${tag} package.json cambió, corriendo npm install...`);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const { stdout, stderr } = await execFileAsync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: REPO_DIR, timeout: 5 * 60 * 1000 });
    if (stdout) console.log(stdout.slice(-2000));
    if (stderr) console.error(stderr.slice(-2000));
  } catch (e) {
    // El mensaje plano de execFile ("Command failed...") no dice NADA: se vuelca
    // la cola real al log y se extrae la causa para el `Resultado:` de Discord.
    if (e.stdout) console.log(`${tag} npm stdout:\n${String(e.stdout).slice(-2000)}`);
    if (e.stderr) console.error(`${tag} npm stderr:\n${String(e.stderr).slice(-3000)}`);
    const lines = String(e.stderr || e.stdout || e.message).split('\n').map(l => l.trim()).filter(Boolean);
    const cause = lines.filter(l => /npm error|ERR!/i.test(l)).slice(-2).join(' | ') || lines.slice(-2).join(' | ') || e.message.split('\n')[0];
    throw new Error(`npm install falló: ${cause.slice(0, 300)}`);
  }
}

async function checkForUpdatesGit(tag) {
  await git(['fetch', 'origin', UPDATE_BRANCH]);
  const { stdout: status } = await git(['status', '-uno', '--porcelain', '-b']);
  const behind = status.match(/behind (\d+)/);
  if (!behind) {
    lastUpdateResult = 'sin cambios';
    console.log(`${tag} Sin cambios. (${status.split('\n')[0]})`);
    return false;
  }
  console.log(`${tag} Hay ${behind[1]} commit(s) nuevos. Descargando...`);
  const before = await getLocalVersion();
  const oldPkg = await fsp.readFile(path.join(REPO_DIR, 'package.json'), 'utf8').catch(() => '');
  await git(['pull', '--ff-only', 'origin', UPDATE_BRANCH]);
  const after = await getLocalVersion();
  const newPkg = await fsp.readFile(path.join(REPO_DIR, 'package.json'), 'utf8').catch(() => '');
  console.log(`${tag} Código actualizado: ${before} -> ${after}`);
  if (oldPkg !== newPkg) {
    try { await npmInstall(tag); }
    catch (e) {
      lastUpdateResult = `error npm install, no reinicio: ${e.message.split('\n')[0]}`;
      console.error(`${tag} npm install falló, NO reinicio para no dejar node_modules roto:`, e.message);
      return false;
    }
  }
  try { await fsp.writeFile(path.join(REPO_DIR, '.version'), after); } catch { /* noop */ }
  lastUpdateResult = `actualizado ${before} -> ${after}`;
  console.log(`${tag} Reiniciando para aplicar cambios...`);
  restartBot();
  return true;
}

async function checkForUpdatesFresh(tag) {
  // Modo hosting: no hay .git, clono fresco a temp y copio por encima
  const local = await getLocalVersion();
  if (local === 'desconocida') {
    console.log(`${tag} Sin repo local y sin .version (versión desconocida). Asegúrate de subir .version al hosting. Sigo a comparar con GitHub...`);
  } else {
    console.log(`${tag} Sin repo local, comparando versión (${local}) con GitHub...`);
  }
  const remoteFull = await getRemoteSha();
  const remote = remoteFull.slice(0, 7);
  if (local === remote || local === remoteFull.slice(0, 7)) {
    lastUpdateResult = 'sin cambios';
    console.log(`${tag} Sin cambios (versión ${local}).`);
    return false;
  }
  console.log(`${tag} Hay update: ${local} -> ${remote}. Clonando...`);
  const tmp = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'ibot-'));
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--branch', UPDATE_BRANCH, remoteUrl(), tmp], {
      timeout: 5 * 60 * 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
    });
    const oldPkg = await fsp.readFile(path.join(REPO_DIR, 'package.json'), 'utf8').catch(() => '');
    await copyFreshUpdate(tmp);
    const newPkg = await fsp.readFile(path.join(REPO_DIR, 'package.json'), 'utf8').catch(() => '');
    await fsp.writeFile(path.join(REPO_DIR, '.version'), remote);
    console.log(`${tag} Código actualizado: ${local} -> ${remote}`);
    if (oldPkg !== newPkg) {
      try { await npmInstall(tag); }
      catch (e) {
        lastUpdateResult = `error npm install, no reinicio: ${e.message.split('\n')[0]}`;
        console.error(`${tag} npm install falló, NO reinicio para no dejar node_modules roto:`, e.message);
        return false;
      }
    }
    lastUpdateResult = `actualizado ${local} -> ${remote}`;
    console.log(`${tag} Reiniciando para aplicar cambios...`);
    restartBot();
    return true;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkForUpdates({ auto = false } = {}) {
  if (isUpdating) {
    console.log('[update] Ya hay una actualización en curso, omito.');
    return false;
  }
  isUpdating = true;
  lastUpdateCheck = new Date();
  const tag = auto ? '[auto-update]' : '[update]';
  try {
    console.log(`${tag} Comprobando GitHub ${UPDATE_REPO}#${UPDATE_BRANCH}... (dir: ${REPO_DIR}, git: ${hasGitRepo() ? 'sí' : 'no'})`);
    if (hasGitRepo()) return await checkForUpdatesGit(tag);
    return await checkForUpdatesFresh(tag);
  } catch (e) {
    lastUpdateResult = `error: ${e.message}`;
    console.error(`${tag} Falló:`, e.message);
    return false;
  } finally {
    isUpdating = false;
  }
}

function restartBot() {
  console.log('Reiniciando bot...');
  try {
    for (const guildId of timeInCall.keys()) finalizeGuildTimes(guildId);
    saveData();
  } catch { /* noop */ }
  try { client.destroy(); } catch { /* noop */ }
  // Re-lanza el mismo comando con el que se arrancó
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: REPO_DIR,
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  process.exit(0);
}

function setupAutoUpdate() {
  if (!AUTO_UPDATE) {
    console.log('Auto-update desactivado (NO_AUTO_UPDATE=1).');
    return;
  }
  setInterval(() => {
    checkForUpdates({ auto: true }).catch(e => console.error('[auto-update]', e.message));
  }, UPDATE_INTERVAL_MS).unref();
  console.log(`Auto-update activado: cada 20h desde GitHub (origin/main).`);
}

// --- Autodebug y autoreparación ---
const DEBUG_INTERVAL_MS = 30 * 60 * 1000;

async function runDiagnostics({ fix = false } = {}) {
  const checks = [];
  const add = (name, ok, detail = '', fixed = false) => checks.push({ name, ok, detail, fixed });

  // 1) Node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `v${process.versions.node}${major < 20 ? ' (recomendado 20+)' : ''}`);

  // 2) Token
  const tok = process.env.DISCORD_TOKEN ?? '';
  add('token', tok.length > 20 && tok.split('.').length === 3, tok ? 'presente' : 'falta DISCORD_TOKEN en .env');

  // 3) ffmpeg
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 });
    add('ffmpeg', true, 'disponible');
  } catch (e) {
    add('ffmpeg', false, 'no encontrado en PATH (los clips MP3 fallarán)');
  }

  // 4) git (necesario para update)
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 10000 });
    add('git', true, stdout.trim());
  } catch {
    add('git', false, 'no instalado (el update por clon fallará)');
  }

  // 5) Dependencias (@discordjs/opus es opcional: lo cubre el chequeo funcional 'opus')
  const deps = ['discord.js', '@discordjs/voice', 'libsodium-wrappers', 'prism-media', 'dotenv'];
  const missing = deps.filter(d => {
    try { require.resolve(d); return false; } catch { return true; }
  });
  if (missing.length === 0) {
    add('deps', true, 'todas presentes');
  } else if (fix) {
    try {
      console.log(`[debug] Faltan ${missing.join(', ')}, corriendo npm install...`);
      await npmInstall('[debug]');
      const still = deps.filter(d => {
        try { require.resolve(d); return false; } catch { return true; }
      });
      add('deps', still.length === 0, still.length ? `siguen faltando: ${still.join(', ')}` : `reparadas: ${missing.join(', ')}`, still.length === 0);
    } catch (e) {
      add('deps', false, `faltan ${missing.join(', ')} y npm falló: ${e.message.split('\n')[0]}`);
    }
  } else {
    add('deps', false, `faltan: ${missing.join(', ')} (corre "debug fix")`);
  }

  // 5b) Motor Opus funcional (estar instalado no basta: el nativo puede fallar al cargar).
  // Sin esto los clips salen vacíos y `c!s` es mudo aunque todo lo demás esté OK.
  add('opus', OPUS_OK, OPUS_OK ? 'decodificación disponible (clips+sonidos OK)' : 'SIN motor: corre `npm install` (opusscript sirve de respaldo)');

  // 6) Carpeta clips escribible
  try {
    await fsp.mkdir(clipsDir, { recursive: true });
    const probe = path.join(clipsDir, '.writetest');
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    add('clips', true, 'escribible');
  } catch (e) {
    add('clips', false, `sin escritura: ${e.message}`);
  }

  // 7-8) JSONs corruptos -> backup + reset (solo con fix)
  for (const [label, file, loader] of [
    ['tiempos', DATA_FILE, loadData],
    ['prefijos', PREFIX_FILE, loadPrefixes],
    ['admins', ADMIN_FILE, loadAdmins],
    ['panic', PANIC_FILE, loadPanic]
  ]) {
    try {
      if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
      add(label, true, 'ok');
    } catch (e) {
      if (fix) {
        try {
          const bak = `${file}.bak-${Date.now()}`;
          fs.renameSync(file, bak);
          loader();
          add(label, false, `corrupto, backup en ${path.basename(bak)} y reseteado`, true);
        } catch (e2) {
          add(label, false, `corrupto y no pude reparar: ${e2.message}`);
        }
      } else {
        add(label, false, `corrupto: ${e.message} (corre "debug fix")`);
      }
    }
  }

  // 9) Temporales rancios
  try {
    const files = await fsp.readdir(clipsDir).catch(() => []);
    const stale = [];
    const now = Date.now();
    for (const f of files) {
      if (!/^(temp_|clip_).*\.(pcm|mp3)$/.test(f)) continue;
      const st = await fsp.stat(path.join(clipsDir, f)).catch(() => null);
      if (st && now - st.mtimeMs > 60 * 60 * 1000) stale.push(f);
    }
    if (stale.length === 0) {
      add('temporales', true, 'limpio');
    } else if (fix) {
      for (const f of stale) await fsp.unlink(path.join(clipsDir, f)).catch(() => {});
      add('temporales', true, `${stale.length} archivo(s) rancio(s) eliminado(s)`, true);
    } else {
      add('temporales', false, `${stale.length} archivo(s) de >1h (corre "debug fix")`);
    }
  } catch (e) {
    add('temporales', false, e.message);
  }

  // 10) Conexión Discord
  if (client.user) {
    const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'n/a';
    add('discord', client.ws.status === 0, `como ${client.user.tag} · ping ${ping}${client.ws.status !== 0 ? ` · ws=${client.ws.status}` : ''}`);
  } else {
    add('discord', false, 'no logueado (revisa token e intents)');
  }

  // 11) Conexiones de voz zombies
  let zombies = 0;
  for (const [gid, conn] of callConnections) {
    try {
      const live = getVoiceConnection(gid);
      const status = conn?.state?.status ?? 'desconocido';
      // Solo 'destroyed'/ausente es zombie. 'disconnected' lo gestiona el watchdog
      // de 15s: matarlo aquí cortaría reconexiones válidas en curso.
      if (!live || status === 'destroyed') {
        zombies++;
        if (fix) {
          try { conn?.destroy(); } catch { /* noop */ }
          callConnections.delete(gid);
          isRecording.set(gid, false);
          botJoinedAt.delete(gid);
        }
      }
    } catch { zombies++; }
  }
  add('voz', zombies === 0, zombies ? `${zombies} conexión(es) zombie${fix ? ' (limpiadas)' : ' (corre "debug fix")'}` : `${callConnections.size} activa(s)`, zombies > 0 && fix);

  const ok = checks.filter(c => c.ok).length;
  console.log(`[debug] ${ok}/${checks.length} OK${fix ? ' (con reparación)' : ''}:`);
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}${c.fixed ? ' [reparado]' : ''}`);
  }
  return checks;
}

function setupAutoDebug() {
  setInterval(() => {
    runDiagnostics({ fix: true }).catch(e => console.error('[debug]', e.message));
  }, DEBUG_INTERVAL_MS).unref();
  console.log('Autodebug activado: chequeo + reparación segura cada 30min.');
}

// --- Consola de terminal ---
function setupConsole() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'bot> '
  });
  console.log('Consola lista. Escribe "help" para ver comandos.');
  rl.prompt();
  rl.on('line', async (raw) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch ((cmd || '').toLowerCase()) {
      case '':
        break;
      case 'help':
        console.log('Comandos: help · status · debug [fix] · update · restart · save · guilds · logs [n] · exit');
        console.log('  debug     -> chequea token, ffmpeg, git, deps, clips, jsons, discord y voz');
        console.log('  debug fix -> lo mismo + repara (npm install, jsons corruptos, temporales, zombies)');
        console.log('  update  -> git pull desde GitHub + npm install si cambió package.json + restart');
        console.log('  auto-update cada 20h + autodebug cada 30min' + (AUTO_UPDATE ? '' : ' (UPDATE DESACTIVADO)'));
        break;
      case 'status': {
        const v = await getLocalVersion();
        console.log(`versión: ${v} · uptime: ${Math.floor(process.uptime())}s`);
        console.log(`repo: ${REPO_DIR} (.git: ${fs.existsSync(path.join(REPO_DIR, '.git')) ? 'sí' : 'NO'})`);
        console.log(`guilds: ${client.guilds.cache.size} · voz: ${callConnections.size}`);
        if (botExitWatch.size > 0) {
          for (const [gid, ex] of botExitWatch) {
            const st = kickStreak.get(gid);
            const streakTxt = st && Date.now() - st.firstAt < KICK_STREAK_WINDOW_MS ? ` · racha=${st.count}` : '';
            console.log(`salida ${gid}: ${ex.expected ? 'prevista' : 'NO prevista'} · ${ex.channelName ?? ex.channelId ?? '?'} · ${new Date(ex.at).toLocaleString()} · por=${ex.kickerTag ?? ex.kickerId ?? '?'} · vía=${ex.source}${ex.rejoined ? ' · reentré=sí' : ''}${streakTxt}`);
          }
        } else {
          console.log('salidas del bot: ninguna registrada');
        }
        console.log(`último check update: ${lastUpdateCheck ? lastUpdateCheck.toLocaleString() : '—'} (${lastUpdateResult})`);
        break;
      }
      case 'guilds':
        client.guilds.cache.forEach(g => {
          const vc = botChannelIdFor(g.id);
          console.log(`- ${g.name} (${g.id})${vc ? ` · grabando en ${vc}` : ''}`);
        });
        if (client.guilds.cache.size === 0) console.log('(sin guilds cacheados aún)');
        break;
      case 'update':
        await checkForUpdates({ auto: false });
        break;
      case 'debug':
        await runDiagnostics({ fix: arg === 'fix' || arg === '--fix' });
        break;
      case 'save':
        saveData();
        console.log('Datos guardados.');
        break;
      case 'logs': {
        const n = Math.min(Math.max(parseInt(arg, 10) || 20, 1), 100);
        try {
          const lines = fs.readFileSync(logFileFor(), 'utf8').split('\n').filter(Boolean);
          const tail = lines.slice(-n);
          if (tail.length === 0) _conLog('(log de hoy vacío)');
          else for (const line of tail) _conLog(line);
          _conLog(`— últimas ${tail.length} líneas de ${path.basename(logFileFor())} —`);
        } catch (e) {
          _conLog(`No pude leer el log: ${e.message}`);
        }
        break;
      }
      case 'restart':
        restartBot();
        break;
      case 'exit':
      case 'quit':
        shutdown();
        break;
      default:
        console.log(`Comando desconocido: "${cmd}". Usa help. ${arg}`);
    }
    rl.prompt();
  });
  rl.on('close', () => console.log('Consola cerrada (el bot sigue corriendo).'));
}

client.login(process.env.DISCORD_TOKEN).then(async () => {
  setupConsole();
  setupAutoUpdate();
  setupAutoDebug();
  setupBotWatchdog();
  await runDiagnostics({ fix: true }).catch(e => console.error('[debug]', e.message));
});
