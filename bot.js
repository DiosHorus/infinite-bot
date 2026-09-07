require('dotenv').config();

const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
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
        return message.reply({ embeds: [embedErr(message, 'No estás en voz', 'Debes estar en un canal de voz para que me una.')] });
      }
      const voiceChannel = message.member.voice.channel;
      const guildId = message.guild.id;

      // Si ya estoy en ese canal, no reconectar
      if (botChannelIdFor(guildId) === voiceChannel.id) {
        return message.reply({ embeds: [embedInfo(message, '🎙️ Ya estoy aquí', 'Ya estoy en tu canal grabando.')] });
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

        return message.reply({ embeds: [embedOk(message, 'Grabando', `En **${voiceChannel.name}**. Grabando audio.\nUsa \`c!leave\` para que me vaya · \`c!clip\` para un clip · \`c!help\` para ayuda.`)] });
      } catch (error) {
        console.error('Error al unirse:', error);
        return message.reply({ embeds: [embedErr(message, 'No pude unirme', 'Revisa que tenga permiso de Conectar y Hablar en ese canal.')] });
      }
    }

    if (content === 'c!leave') {
      const guildId = message.guild.id;
      const conn = getVoiceConnection(guildId) ?? callConnections.get(guildId);
      if (!conn) return message.reply({ embeds: [embedInfo(message, '👋 Nada que hacer', 'No estoy en ningún canal de voz.')] });
      finalizeGuildTimes(guildId);
      try { conn.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);
      saveData();
      return message.reply({ embeds: [embedOk(message, 'Me fui', 'Tiempos guardados. Usa `c!join` cuando quieras que vuelva.')] });
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

      if (leaderboard.length === 0) return message.reply({ embeds: [embedInfo(message, '🏆 Leaderboard vacío', 'Aún no hay tiempo registrado. Usa `c!join` y habla un rato.')] });

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

    if (content === 'c!clip') {
      const guildId = message.guild.id;
      if (!callConnections.has(guildId)) {
        return message.reply({ embeds: [embedErr(message, 'No estoy grabando', 'Usa `c!join` primero para que entre al canal.')] });
      }
      const buf = audioBuffers.get(guildId);
      if (!buf || buf.chunks.length === 0) {
        return message.reply({ embeds: [embedInfo(message, '✂️ Sin audio todavía', 'Aún no hay audio grabado. Espera a que alguien hable.')] });
      }

      const last = clipCooldown.get(guildId) ?? 0;
      if (Date.now() - last < CLIP_COOLDOWN_MS) {
        const wait = Math.ceil((CLIP_COOLDOWN_MS - (Date.now() - last)) / 1000);
        return message.reply({ embeds: [embedBase(message, EMBED_WARN).setTitle('⏳ Cooldown').setDescription(`Espera **${wait}s** antes de pedir otro clip.`)] });
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
            embeds: [embedBase(message, EMBED_WARN).setTitle('⚠️ ffmpeg falló').setDescription('Aquí está el clip en formato raw (últimos 2 minutos):')],
            files: [tempPath]
          });
          return;
        }

        await message.channel.send({
          embeds: [embedOk(message, 'Clip listo', `Aquí está el clip de los últimos **${CLIP_SECONDS / 60} minutos**:`)],
          files: [clipPath]
        });
      } catch (error) {
        console.error('Error al generar clip:', error);
        await message.reply({ embeds: [embedErr(message, 'No pude generar el clip', 'Inténtalo de nuevo en unos segundos.')] });
      } finally {
        await fsp.unlink(tempPath).catch(() => {});
        await fsp.unlink(clipPath).catch(() => {});
      }
    }

    if (content === 'c!help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📖 Comandos de Infinite Bot')
        .setDescription('Grabo voz, mido tiempo en llamada y genero clips.')
        .addFields(
          { name: '🎙️ `c!join`', value: 'Me uno a tu canal de voz y empiezo a grabar.', inline: false },
          { name: '👋 `c!leave`', value: 'Guardo tiempos y salgo del canal.', inline: false },
          { name: '🏆 `c!lb` / `c!clb`', value: 'Top 10 de tiempo en llamada de este servidor.', inline: false },
          { name: '✂️ `c!clip`', value: `Genera un MP3 con los últimos ${CLIP_SECONDS / 60} min (cooldown 30s).`, inline: false },
          { name: '❓ `c!help`', value: 'Muestra este mensaje.', inline: false }
        )
        .setFooter({ text: `Pedido por ${message.author.username}` })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
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
const UPDATE_EXCLUDE = new Set(['node_modules', '.env', '.git', 'clips', 'timeData.json', '.version']);

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
  const { stdout, stderr } = await execFileAsync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: REPO_DIR, timeout: 5 * 60 * 1000 });
  if (stdout) console.log(stdout.slice(-2000));
  if (stderr) console.error(stderr.slice(-2000));
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
        console.log(`repo: ${REPO_DIR} (.git: ${fs.existsSync(path.join(REPO_DIR, '.git')) ? 'sí' : 'NO'})`);
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
