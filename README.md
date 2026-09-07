# ♾️ Infinite Bot

Bot de Discord **hours farmer**: se queda **24/7 en voz**, mide el tiempo de cada usuario en llamada, muestra **leaderboard** y genera **clips de audio** de los últimos 2 minutos. Prefijo configurable por servidor.

## ✨ Features

- 🔊 **Join infinito** — entra al canal y no se sale solo (solo con `leave` o si lo expulsan)
- ⏱️ **Hours farming** — trackea tiempo en llamada por servidor, con persistencia en `timeData.json`
- 🏆 **Leaderboard** — top 10 por servidor, sin inflar tiempos de los que ya salieron
- 🔴 **Grabación manual** — `start` / `stop` por servidor, el buffer aguanta ~2 min reales
- ✂️ **Clips MP3** — convierte el buffer PCM con `ffmpeg`, con cooldown anti-spam (30s)
- ⚙️ **Prefijo configurable** — `/prefix nuevo:!` por servidor (por defecto `c!`)
- 💻 **Consola terminal** — `help · status · guilds · update · save · restart · exit`
- 🔄 **Auto-update cada 20h** — desde GitHub (`git pull` si hay repo, clon fresco en hosting) + `npm install` si cambió `package.json` + restart
- 🎨 **Embeds bonitos** en todos los mensajes

## 📖 Comandos (prefijo por defecto `c!`)

| Comando  | Qué hace                                                     |
|----------|--------------------------------------------------------------|
| `c!join` | Me uno a tu canal de voz                                     |
| `c!start`| Activa la grabación                                          |
| `c!stop` | Pausa la grabación (el audio guardado sigue para clips)      |
| `c!leave`| Guardo tiempos y salgo del canal                             |
| `c!lb`   | Top 10 de tiempo en llamada del servidor                     |
| `c!clip` | MP3 con los últimos 2 min (cooldown 30s)                     |
| `c!help` | Ayuda en embed                                               |
| `/prefix`| Ver o cambiar el prefijo (requiere Gestionar servidor)       |

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
```

## ☁️ Hosting (sin `.git`)

El update funciona igual sin clon: compara `.version` con GitHub, clona fresco a temp y copia por encima **sin pisar** `node_modules, .env, clips, timeData.json`.

1. Sube `bot.js`, `package.json`, `.version` (+ `.env` con tus tokens)
2. En el panel pon `GITHUB_TOKEN` (el repo es privado, sin token falla con `128/auth`)
3. Consola: `bot> status` debe decir `git: no` + versión · `bot> update` para forzar

## ⚠️ Aviso de grabación

Grabar voz sin avisar puede ser ilegal según tu país. Usa `c!start` a la vista de todos y avisa en las normas del servidor.
