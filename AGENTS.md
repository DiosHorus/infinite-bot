# AGENTS.md — infinite-bot

Bot de Discord de un solo archivo. `bot.js` (~1230 líneas, CommonJS) es toda la app. Sin paquetes, tests, lint ni build.

## Arranque
- `node bot.js` (o `npm start`). No hay otro punto de entrada.
- Requiere: Node 20+, `ffmpeg` en PATH, `git`, `.env` con `DISCORD_TOKEN=...`
- `npm test` es un marcador que siempre falla — no usar.
- Nunca commitear `.env`, `timeData.json`, `prefixes.json`, `clips/*.pcm|*.mp3`, `*.log`, ni los zips grandes (`bot.zip`, `package-lock.zip`). Todo salvo los zips ya está en gitignore — mantenerlo así.

## Variables de entorno (`bot.js:785-793`, `README.md:44-54`)
- Obligatoria: `DISCORD_TOKEN`
- Opcionales: `GITHUB_TOKEN`/`GH_TOKEN` (obligatorio en hosting con repo privado para el auto-update), `UPDATE_REPO` (por defecto `DiosHorus/infinite-bot`), `UPDATE_BRANCH` (por defecto `main`), `NO_AUTO_UPDATE=1` (desactiva el auto-update de 20h), `OWNER_ID` (comando secreto solo-dueño `iadmin!update`, `bot.js:281`).

## Arquitectura (todo en `bot.js`)
- `Map`s en memoria por servidor: `timeInCall`, `audioBuffers`, `isRecording`, `callConnections`, `eventLogs`, `prefixes`. Persistencia: `timeData.json` + `prefixes.json` (se escriben cada 5 min, al `leave`/apagado/restart; carga en `bot.js:191-193`). Al cargar, `startTime` siempre es `null` para no inflar tiempos.
- Tiempos: `voiceStateUpdate` (`bot.js:698`) solo cuenta usuarios en el canal del propio bot; `lb` verifica la pertenencia al canal para no inflar a los que ya salieron. El bot nunca sale solo si se vacía — solo con `leave` o expulsión.
- Audio: `setupAudioReceiver` suscribe por usuario que habla (`EndBehaviorType.AfterSilence` 500ms) y decodifica Opus→PCM s16le con `prism.opus.Decoder` antes de guardar (sin decodificar el clip es ruido); los fragmentos solo se guardan si `isRecording` (`start`/`stop`, apagado por defecto tras `join`). Búfer circular limitado a 120s (`MAX_BYTES = 48000*2*2*120`), se vacía en cada `join`. `clip` concatena el búfer → `ffmpeg -f s16le -ar 48000 -ac 2` → MP3, con cooldown de 30s por servidor que solo cuenta si el clip se entrega; temporales de `clips/` se borran en `finally`.
- Motor Opus: requiere `@discordjs/opus` (nativo) u `opusscript` (respaldo puro-JS, en `package.json`); sonda `OPUS_OK` al arrancar + chequeo `opus` en `debug`. Sin motor: clips vacíos y `c!s` mudo. `join` usa `selfMute: false` (muteado no transmitiría sonidos) y `getGuildPlayer` resuscribe el player en cada uso (si no, mudo tras `leave`+`join`).
- Prefijo: por defecto `c!`, sobreescrito por servidor vía slash global `/prefix` (puede tardar hasta 1h en propagar — existe lectura de respaldo `c!prefix` en texto) + `getPrefix()` en cada `messageCreate`.
- Sonidos: soltar `.mp3/.wav/.ogg/.m4a` en `sounds/` (se autocrea, contenido gitignoreado pero el directorio debe existir); se reproducen con `c!s <nombre>`, nombre saneado a `[\w\-ñáéíóúü]+`.
- Consola de terminal (`bot> help · status · debug [fix] · update · save · guilds · logs [n] · restart · exit`), auto-update cada 20h (`git pull` si existe `.git`, si no clon fresco a temp + copia), autodebug + `debug fix` cada 30 min. El update nunca sobreescribe `node_modules, .env, .git, clips, sounds, logs, timeData.json, prefixes.json, .version` (`UPDATE_EXCLUDE`, `bot.js:869`).
- Logs a archivo: `logs/bot-YYYY-MM-DD.log` captura todo `console` + `uncaughtException`/`unhandledRejection` + transiciones de voz (`[voz]`, `[cmd]`); rotación 7 días (`pruneOldLogs`); ver con `bot> logs [n]`. Si el bot "se sale solo", buscar `[voz]` de ese día.
- Anti-fantasma: `getLiveConnection()` valida contra `getVoiceConnection()` y limpia zombies del mapa (antes `join` decía "ya estoy aquí" con la conexión muerta); `attachConnectionHandlers` vigila `Disconnected` (15s de gracia y luego congela tiempos + limpia) y `voiceStateUpdate` registra toda salida/movimiento del propio bot.

## Cuidados
- Regla fija: cada cambio que se haga, commitearlo y subirlo a GitHub (`main`) al terminar. No dejar cambios sin pushear.
- No "arreglar" `npm test`, ni convertir a ESM, ni dividir `bot.js` sin que lo pidan — el repo se mantiene en un archivo a propósito para despliegue por copiar-pegar en hosting.
- `.version` guarda el SHA corto para el modo hosting-sin-git; actualizarlo solo vía el updater, nunca a mano.
- `bot.js.bak-*` / `bot.zip` / `package-lock.zip` son artefactos locales — no tocar.
- No hay suite de verificación; tras editar, como mínimo ejecutar `node --check bot.js`.
