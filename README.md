# ♾️ Infinite Bot

Bot de Discord **hours farmer**: se queda **24/7 en voz**, mide el tiempo de cada usuario en llamada, muestra **leaderboard** y genera **clips de audio** de los últimos 2 minutos. Prefijo configurable por servidor.

## ✨ Features

- 🔊 **Join infinito** — entra al canal y no se sale solo (solo con `leave` o si lo expulsan)
- ⏱️ **Hours farming** — trackea tiempo en llamada por servidor, con persistencia en `timeData.json`
- 🏆 **Leaderboard** — top 10 por servidor, sin inflar tiempos de los que ya salieron
- 🔴 **Grabación manual** — `start` / `stop` por servidor, el buffer aguanta ~2 min reales
- ✂️ **Clips MP3** — convierte el buffer PCM con `ffmpeg`, con cooldown anti-spam (30s)
- ⚙️ **Prefijo configurable** — `/prefix nuevo:!` por servidor (por defecto `c!`)
- 💻 **Consola terminal** — `help · status · debug [fix] · logs [n] · update · save · guilds · restart · exit`
- 📝 **Logs a archivo** — todo (`logs/bot-YYYY-MM-DD.log`, rotación 7 días): comandos, salidas del bot, estados de voz y errores
- 🚨 **Aviso anti-kick** — si me echan de voz, DM al dueño del bot (`OWNER_ID`) y al dueño del servidor diciendo quién lo hizo (vía auditoría)
- ↩️ **Rejoin anti-kick** — reentro al mismo canal al instante (reintento a los 500ms si falla); freno anti-bucle (5+ kicks en 60s → panic mode)
- 🆘 **Panic mode** — con racha de kicks (configurable 1-5 con `panic kicks`): reentro yo + mando en el chat los summons de otros bots (`!join`, `m!join`, `-join`, configurables con `panic`, solo admins) + alarma opcional en voz (`/addpanicsound`, solo admins)
- 🔄 **Auto-update cada 20h** — desde GitHub (`git pull` si hay repo, clon fresco en hosting) + `npm install` si cambió `package.json` + restart
- 🎨 **Embeds bonitos** en todos los mensajes

## 📖 Comandos (prefijo por defecto `c!`)

| Comando  | Qué hace                                                     |
|----------|--------------------------------------------------------------|
| `c!join` | Me uno a tu canal de voz                                     |
| `c!start`| Activa la grabación                                          |
| `c!stop` | Pausa la grabación (el audio guardado sigue para clips)      |
| `c!leave`| Guardo tiempos y salgo del canal (solo admins)              |
| `c!lb`   | Top 10 de tiempo en llamada del servidor                     |
| `c!clip` | MP3 con los últimos 2 min (cooldown 30s)                     |
| `c!help` | Ayuda en embed                                               |
| `c!bot_logs` | Historial completo en .txt (quién entró/salió, sonidos, movimientos del bot y quién lo echó) |
| `/prefix`| Ver o cambiar el prefijo (requiere Gestionar servidor)       |
| `/addadmin`| Hacer admin del bot a un usuario (solo admins)               |
| `/removeadmin`| Quitar admin del bot (solo admins, no a dueños)           |
| `c!admins` | Ver admins del bot (por defecto: dueño del server + dueño del bot) |
| `c!panic` | Ver/configurar panic mode (summons + canal; cambios solo admins) |
| `/addpanicsound` | Subir la alarma en voz del panic mode (solo admins) |

> El slash `/prefix` es global y puede tardar hasta 1h en propagar la primera vez. Como fallback existe `c!prefix` en texto.

## 🚀 Instalación

Requisitos: **Node 20+**, **ffmpeg** en PATH, **git**.

```bash
git clone https://github.com/DiosHorus/infinite-bot.git
cd infinite-bot
npm install
cp .env.example .env   # o crea .env con DISCORD_TOKEN=...
node bot.js
```

### `.env`

```
DISCORD_TOKEN=tu_token
# Solo necesario en hosting con repo privado para el auto-update:
# GITHUB_TOKEN=ghp_...
# Opcionales:
# UPDATE_REPO=DiosHorus/infinite-bot
# UPDATE_BRANCH=main
# NO_AUTO_UPDATE=1   (desactiva el auto-update)
# OWNER_ID=tu_id_discord (dueño del bot: usa iadmin!update y recibe DM si echan al bot de voz)
```

## ☁️ Hosting (sin `.git`)

El update funciona igual sin clon: compara `.version` con GitHub, clona fresco a temp y copia por encima **sin pisar** `node_modules, .env, clips, timeData.json`.

1. Sube `bot.js`, `package.json`, `.version` (+ `.env` con tus tokens)
2. En el panel pon `GITHUB_TOKEN` (el repo es privado, sin token falla con `128/auth`)
3. Consola: `bot> status` debe decir `git: no` + versión · `bot> update` para forzar

## ⚠️ Aviso de grabación

Grabar voz sin avisar puede ser ilegal según tu país. Usa `c!start` a la vista de todos y avisa en las normas del servidor.
