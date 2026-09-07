require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

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

// --- Auto-update (GitHub, cada 20h) ---
const UPDATE_INTERVAL_MS = 20 * 60 * 60 * 1000;
const AUTO_UPDATE = process.env.NO_AUTO_UPDATE !== '1';
let isUpdating = false;
let lastUpdateCheck = null;
let lastUpdateResult = 'nunca';

// guildId -> { chunks: Buffer[], byteLength: number }
const audioBuffers = new Map();
// guildId -> connection
const callConnections = new Map();
// userId (por guild) -> stream activo
const audioStreams = new Map(); // key `${guildId}:${userId}`
// guildId -> timestamp ultimo clip
const clipCooldown = new Map();

// guildId -> Map(userId -> { startTime: number|null, totalTime: number })
const timeInCall = new Map();

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
setInterval(saveData, 5 * 60 * 1000).unref();

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

function botChannelIdFor(guildId) {
  const conn = callConnections.get(guildId);
  return conn?.joinConfig?.channelId ?? null;
}

client.once('ready', () => {
  console.log(`Bot listo como ${client.user.tag}!`);
});

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild || !message.member) return; // ignora DMs

    const content = message.content.toLowerCase().trim();

    if (content === 'c!join') {
      if (!message.member.voice.channel) {
        return message.reply('Debes estar en un canal de voz para que me una.');
      }
      const voiceChannel = message.member.voice.channel;
      const guildId = message.guild.id;

      // Si ya estoy en ese canal, no reconectar
      if (botChannelIdFor(guildId) === voiceChannel.id) {
        return message.reply('Ya estoy en tu canal grabando.');
      }

      // Si estaba en otro canal del mismo guild, salir antes
      const old = getVoiceConnection(guildId) ?? callConnections.get(guildId);
      try { old?.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true
        });
        callConnections.set(guildId, connection);
        setupAudioReceiver(connection, guildId);

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

        return message.reply(`En ${voiceChannel.name}. Grabando audio. Usa \`c!leave\` para que me vaya.`);
      } catch (error) {
        console.error('Error al unirse:', error);
        return message.reply('No pude unirme.');
      }
    }

    if (content === 'c!leave') {
      const guildId = message.guild.id;
      const conn = getVoiceConnection(guildId) ?? callConnections.get(guildId);
      if (!conn) return message.reply('No estoy en ningún canal de voz.');
      finalizeGuildTimes(guildId);
      try { conn.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);
      saveData();
      return message.reply('Me fui del canal. Tiempos guardados.');
    }

    if (content === 'c!lb' || content === 'c!clb') {
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

      if (leaderboard.length === 0) return message.reply('Leaderboard vacío.');

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
        lines.push(`${i + 1}. ${username}: ${formatDuration(entry.totalTime)}`);
      }
      return message.reply(`**Leaderboard de tiempo en llamada:**\n${lines.join('\n')}`);
    }

    if (content === 'c!clip') {
      const guildId = message.guild.id;
      if (!callConnections.has(guildId)) {
        return message.reply('No estoy grabando. Usa `c!join` primero.');
      }
      const buf = audioBuffers.get(guildId);
      if (!buf || buf.chunks.length === 0) {
        return message.reply('No hay audio grabado todavía. Espera a que alguien hable.');
      }

      const last = clipCooldown.get(guildId) ?? 0;
      if (Date.now() - last < CLIP_COOLDOWN_MS) {
        const wait = Math.ceil((CLIP_COOLDOWN_MS - (Date.now() - last)) / 1000);
        return message.reply(`Espera ${wait}s antes de pedir otro clip (anti-spam).`);
      }
      clipCooldown.set(guildId, Date.now());

      const stamp = Date.now();
      const tempPath = path.join(clipsDir, `temp_${guildId}_${stamp}.pcm`);
      const clipPath = path.join(clipsDir, `clip_${guildId}_${stamp}.mp3`);

      try {
        const audioBuffer = Buffer.concat(buf.chunks);
        await fsp.writeFile(tempPath, audioBuffer);

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
            content: 'ffmpeg falló. Aquí está el clip en formato raw (últimos 2 minutos):',
            files: [tempPath]
          });
          return;
        }

        await message.channel.send({
          content: `Aquí está el clip de los últimos ${CLIP_SECONDS / 60} minutos:`,
          files: [clipPath]
        });
      } catch (error) {
        console.error('Error al generar clip:', error);
        await message.reply('No pude generar el clip.');
      } finally {
        await fsp.unlink(tempPath).catch(() => {});
        await fsp.unlink(clipPath).catch(() => {});
      }
    }

    if (content === 'c!help') {
      return message.reply('Comandos: `c!join` unirse y grabar · `c!leave` salir · `c!lb` leaderboard · `c!clip` últimos 2 min (30s cooldown)');
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

    const cleanup = () => { audioStreams.delete(key); };

    audioStream.on('data', (chunk) => {
      pushAudioChunk(guildId, chunk);
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
  // Salida/desconexión del propio bot: congela tiempos y limpia
  if (newState.member?.user.id === client.user?.id) {
    if (newState.channelId == null) {
      finalizeGuildTimes(newState.guild.id);
      callConnections.delete(newState.guild.id);
      saveData();
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

  if (!wasInBot && isInBot) {
    // Entró (o cambió) al canal del bot
    const prev = times.get(userId);
    if (!prev) times.set(userId, { startTime: now, totalTime: 0 });
    else if (prev.startTime == null) {
      prev.startTime = now;
      times.set(userId, prev);
    }
  } else if (wasInBot && !isInBot) {
    // Salió (o cambió) del canal del bot
    const data = times.get(userId);
    if (data?.startTime != null) {
      data.totalTime += now - data.startTime;
      data.startTime = null;
      times.set(userId, data);
      saveData();
    }
  }

  // Auto-leave si me quedé solo
  try {
    const ch = newState.guild.channels.cache.get(botChannelId);
    if (ch) {
      const humansLeft = ch.members.filter(m => !m.user.bot).size;
      if (humansLeft === 0) {
        finalizeGuildTimes(guildId);
        const conn = getVoiceConnection(guildId) ?? callConnections.get(guildId);
        try { conn?.destroy(); } catch { /* noop */ }
        callConnections.delete(guildId);
        saveData();
        console.log(`Canal ${botChannelId} vacío, saliendo.`);
      }
    }
  } catch (e) {
    console.error('Error en auto-leave:', e.message);
  }
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

// --- Update desde GitHub ---
async function getLocalVersion() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname });
    return stdout.trim();
  } catch { return 'sin-git'; }
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
    console.log(`${tag} Comprobando GitHub...`);
    // fetch + pull ff-only para no romper cambios locales
    await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: __dirname });
    const { stdout: status } = await execFileAsync('git', ['status', '-uno', '--porcelain', '-b'], { cwd: __dirname });
    const behind = status.match(/behind (\d+)/);
    if (!behind) {
      lastUpdateResult = 'sin cambios';
      console.log(`${tag} Sin cambios. (${status.split('\n')[0]})`);
      return false;
    }
    console.log(`${tag} Hay ${behind[1]} commit(s) nuevos. Descargando...`);
    const before = await getLocalVersion();
    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: __dirname });
    const after = await getLocalVersion();
    console.log(`${tag} Código actualizado: ${before} -> ${after}`);

    // Si cambió package.json, reinstala deps
    try {
      const { stdout: diff } = await execFileAsync('git', ['diff', '--name-only', `${before}..${after}`], { cwd: __dirname });
      if (diff.includes('package.json')) {
        console.log(`${tag} package.json cambió, corriendo npm install...`);
        const { stdout, stderr } = await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname, timeout: 5 * 60 * 1000 });
        if (stdout) console.log(stdout.slice(-2000));
        if (stderr) console.error(stderr.slice(-2000));
      }
    } catch (e) {
      console.error(`${tag} npm install falló (sigo con restart):`, e.message);
    }

    lastUpdateResult = `actualizado ${before} -> ${after}`;
    console.log(`${tag} Reiniciando para aplicar cambios...`);
    restartBot();
    return true;
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
    cwd: __dirname,
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
        console.log('Comandos: help · status · update · restart · save · guilds · exit');
        console.log('  update  -> git pull desde GitHub + npm install si cambió package.json + restart');
        console.log('  auto-update cada 20h activo' + (AUTO_UPDATE ? '' : ' (DESACTIVADO)'));
        break;
      case 'status': {
        const v = await getLocalVersion();
        console.log(`versión: ${v} · uptime: ${Math.floor(process.uptime())}s`);
        console.log(`guilds: ${client.guilds.cache.size} · voz: ${callConnections.size}`);
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
      case 'save':
        saveData();
        console.log('Datos guardados.');
        break;
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

client.login(process.env.DISCORD_TOKEN).then(() => {
  setupConsole();
  setupAutoUpdate();
});
