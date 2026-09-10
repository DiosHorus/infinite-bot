require('dotenv').config();

const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
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
const PREFIX_FILE = path.join(__dirname, 'prefixes.json');
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

function getGuildPlayer(guildId, connection) {
  let entry = guildPlayers.get(guildId);
  if (entry?.player) return entry;
  const player = createAudioPlayer();
  try { connection.subscribe(player); } catch { /* noop */ }
  entry = { player };
  guildPlayers.set(guildId, entry);
  player.on('error', (e) => console.error(`[sound] player error guild ${guildId}:`, e.message));
  return entry;
}

function listSoundFiles() {
  try {
    return fs.readdirSync(soundsDir).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
  } catch { return []; }
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

client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}!`);
  // Registra /prefix global (tarda hasta 1h en propagar; en test usa un server y reinicia)
  try {
    const cmd = new SlashCommandBuilder()
      .setName('prefix')
      .setDescription('Ver o cambiar el prefijo de comandos de este servidor')
      .addStringOption(o => o.setName('nuevo').setDescription('Nuevo prefijo (1-5 caracteres, sin espacios)').setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: [cmd.toJSON()] });
    console.log('Slash /prefix registrado.');
  } catch (e) {
    console.error('No se pudo registrar /prefix:', e.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'prefix') return;
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
    const content = message.content.toLowerCase().trim();

    // Comando secreto de dueño: fijo, /prefix NO lo modifica.
    if (content === 'iadmin!update') {
      const cfgOwner = (process.env.OWNER_ID || '').trim();
      const isOwner = (cfgOwner && message.author.id === cfgOwner) || message.author.id === message.guild.ownerId;
      if (!isOwner) {
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
    const cmd = content.slice(prefix.length).trim();

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
        isRecording.set(guildId, false);

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

        return message.reply({ embeds: [embedOk(message, 'Me uní', `Estoy en **${voiceChannel.name}**.\nUsa \`${prefix}start\` para grabar · \`${prefix}leave\` para que salga.`)] });
      } catch (error) {
        console.error('Error al unirse:', error);
        return message.reply({ embeds: [embedErr(message, 'No pude unirme', 'Revisa que tenga permiso de Conectar y Hablar en ese canal.')] });
      }
    }

    if (cmd === 'leave') {
      const guildId = message.guild.id;
      const conn = getVoiceConnection(guildId) ?? callConnections.get(guildId);
      if (!conn) return message.reply({ embeds: [embedInfo(message, '👋 Nada que hacer', 'No estoy en ningún canal de voz.')] });
      finalizeGuildTimes(guildId);
      try { conn.destroy(); } catch { /* noop */ }
      callConnections.delete(guildId);
      isRecording.set(guildId, false);
      saveData();
      return message.reply({ embeds: [embedOk(message, 'Me fui', `Tiempos guardados. Usa \`${prefix}join\` cuando quieras que vuelva.`)] });
    }

    if (cmd === 'start') {
      const guildId = message.guild.id;
      if (!callConnections.has(guildId)) {
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
      if (!callConnections.has(guildId)) {
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
      if (!callConnections.has(guildId)) {
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
      else if (cmd.startsWith('s ')) name = cmd.slice(2).trim();
      else if (cmd.startsWith('sound ')) name = cmd.slice(6).trim();
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
      let connection = getVoiceConnection(message.guild.id) ?? callConnections.get(message.guild.id);
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

    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📖 Comandos de Infinite Bot')
        .setDescription(`Mido tiempo en llamada y genero clips del audio.\nPrefijo actual: \`${prefix}\` (cámbialo con \`/prefix\`).`)
        .addFields(
          { name: `🔊 \`${prefix}join\``, value: 'Me uno a tu canal de voz.', inline: false },
          { name: `🔴 \`${prefix}start\``, value: 'Activa la grabación.', inline: false },
          { name: `⏸️ \`${prefix}stop\``, value: 'Pausa la grabación (el audio guardado sigue para clips).', inline: false },
          { name: `👋 \`${prefix}leave\``, value: 'Guardo tiempos y salgo del canal.', inline: false },
          { name: `🏆 \`${prefix}lb\``, value: 'Top 10 de tiempo en llamada de este servidor.', inline: false },
          { name: `✂️ \`${prefix}clip\``, value: `Genera un MP3 con los últimos ${CLIP_SECONDS / 60} min (cooldown 30s).`, inline: false },
          { name: `🔊 \`${prefix}s <nombre>\``, value: `Reproduce un sonido de \`sounds/\`. Lista con \`${prefix}sounds\`.`, inline: false },
          { name: `📋 \`${prefix}logs\``, value: 'Resumen de los últimos 15 min: entradas/salidas, muteos, transmisiones y sonidos (agregados anti-spam).', inline: false },
          { name: '⚙️ `/prefix`', value: 'Ver o cambiar el prefijo (requiere Gestionar servidor).', inline: false }
        )
        .setFooter({ text: `Pedido por ${message.author.username}` })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'prefix') {
      return message.reply({ embeds: [embedInfo(message, '⚙️ Prefijo', `Actual: \`${prefix}\`\nCámbialo con \`/prefix nuevo:!\` (requiere Gestionar servidor).`)] });
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
      if (!isRecording.get(guildId)) return;
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
      isRecording.set(newState.guild.id, false);
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
const UPDATE_EXCLUDE = new Set(['node_modules', '.env', '.git', 'clips', 'sounds', 'timeData.json', 'prefixes.json', '.version']);

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

  // 5) Dependencias
  const deps = ['discord.js', '@discordjs/voice', '@discordjs/opus', 'libsodium-wrappers', 'prism-media', 'dotenv'];
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
    ['prefijos', PREFIX_FILE, loadPrefixes]
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
      if (!live || ['destroyed', 'disconnected'].includes(status)) {
        zombies++;
        if (fix) {
          try { conn?.destroy(); } catch { /* noop */ }
          callConnections.delete(gid);
          isRecording.set(gid, false);
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
        console.log('Comandos: help · status · debug [fix] · update · restart · save · guilds · exit');
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
  await runDiagnostics({ fix: true }).catch(e => console.error('[debug]', e.message));
});
