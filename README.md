# SecureClaw — Agente de IA Personal J.A.R.V.I.S.

> **El primer asistente de IA personal con Human-in-the-Loop obligatorio.**
> Mientras OpenClaw ejecuta en silencio, SecureClaw siempre te pregunta primero.

[![Node.js](https://img.shields.io/badge/Node.js-22+-green)](https://nodejs.org)
[![Firebase](https://img.shields.io/badge/Firebase-Cloud%20Functions%20v2-orange)](https://firebase.google.com)
[![Gemini](https://img.shields.io/badge/Gemini-2.5%20Flash-blue)](https://deepmind.google/gemini)
[![Android](https://img.shields.io/badge/Android-Kotlin-purple)](android/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

---

## ¿Por qué SecureClaw?

Los agentes de IA personales ya son lo suficientemente poderosos como para controlar tu PC, leer tus archivos, enviar mensajes en tu nombre y ejecutar código. Ese poder necesita una capa de seguridad.

OpenClaw tiene **512 vulnerabilidades documentadas**, **CVE-2026-25253** (ejecución remota de código con un solo click), el 12% de su marketplace comprometido con skills maliciosas y 135.000+ instancias expuestas en internet. China lo baneó de bancos estatales. Kaspersky, Cisco y Sophos lo declararon inseguro.

**El problema no es la IA. El problema es confiar ciegamente en la IA.**

La respuesta de SecureClaw: **Human-in-the-Loop obligatorio en cada operación.**

```
Usuario → Telegram → Cerebro (Gemini) → [Aprobación HITL] → La Garra → PC
                                                ↑
                                    Vos aprobás o denegás
                                    cada acción antes de
                                    que se ejecute.
```

Sin ejecución silenciosa. Sin prompt injection que se cuele. Sin marketplace de terceros. El humano siempre es el último firewall.

---

## Arquitectura

SecureClaw corre como tres nodos independientes:

```
┌─────────────────────────────────────────────────────┐
│                   TU CELULAR                         │
│  Bot de Telegram ←→ Botones Aprobar / Denegar (HITL) │
└─────────────────────┬───────────────────────────────┘
                      │ HTTPS (Webhook)
┌─────────────────────▼───────────────────────────────┐
│           EL CEREBRO — Firebase Cloud Functions      │
│  • Gemini 2.5 Flash (razonamiento + function calling)│
│  • 25+ declaraciones de herramientas                 │
│  • Firestore como bus de mensajes (cola PC_Jobs)     │
│  • Cloud Scheduler (briefing matutino, recordatorios)│
│  • Corre 24/7 sin necesitar que la PC esté encendida │
└─────────────────────┬───────────────────────────────┘
                      │ Firestore onSnapshot
┌─────────────────────▼───────────────────────────────┐
│           LA GARRA — Agente Node.js Local            │
│  • Ejecuta trabajos aprobados por el usuario         │
│  • Screenshot, mouse, teclado, multimedia            │
│  • Webcam + micrófono via ffmpeg DirectShow          │
│  • Google Calendar (OAuth2, token local)             │
│  • Memoria cifrada AES-256-GCM (Engram)              │
│  • Tus datos nunca salen de tu máquina               │
└─────────────────────────────────────────────────────┘
                      │ FCM
┌─────────────────────▼───────────────────────────────┐
│           ANDROID — App Nativa Kotlin                │
│  • Notificaciones push FCM (briefings, HITL)         │
│  • Botones nativos Aprobar/Denegar desde notificación│
│  • Wake word listener — "JARVIS"                     │
│  • Compañero siempre activo                          │
└─────────────────────────────────────────────────────┘
```

---

## Funcionalidades

### Control de PC (via La Garra)
| Herramienta | Descripción |
|-------------|-------------|
| `take_screenshot` | Captura pantalla, comprime con ffmpeg, envía a Telegram |
| `mouse_click` | Click en coordenadas — Gemini ve la pantalla primero |
| `type_text` | Escribe texto en la posición del cursor |
| `open_app` | Abre cualquier aplicación por nombre o ruta |
| `media_control` | Play/pause/siguiente/anterior/volumen via VK codes de Windows |
| `take_webcam_photo` | Captura frame de webcam via DirectShow |
| `record_audio` | Graba micrófono (hasta 30s) via DirectShow |
| `send_file` | Envía cualquier archivo (imagen/video/audio/documento) a Telegram |
| `run_powershell` | Ejecuta comandos PowerShell (con aprobación HITL) |
| `get_system_info` | CPU, RAM, disco, uptime |

### Inteligencia (via Cerebro)
| Función | Descripción |
|---------|-------------|
| Gemini 2.5 Flash | Multimodal — ve screenshots, entiende el contexto |
| Visión para mouse | Analiza la pantalla antes de hacer click — nunca adivina coordenadas |
| Historial de conversación | Ventana deslizante (5 mensajes) — contexto sin inflar tokens |
| Google Calendar | Lee y crea eventos via OAuth2 |
| Recordatorios | Crear, listar, eliminar — almacenados en Firestore |
| Briefing matutino | Todos los días a las 8:00 AM — clima + recordatorios + agenda |
| Comando `/briefing` | Briefing on-demand en cualquier momento |

### Seguridad (por diseño)
| Capa | Descripción |
|------|-------------|
| **HITL obligatorio** | Cada operación de PC requiere Aprobar/Denegar explícito |
| **Timeout HITL** | Auto-deniega después de 120 segundos sin respuesta |
| **Auth Telegram** | Solo tu ID numérico puede interactuar con JARVIS |
| **Webhook secret** | Requests de Telegram validados antes de procesar |
| **Memoria local** | Engram AES-256-GCM, clave en Windows Credential Manager |
| **Sin marketplace** | Cero superficie de ejecución de código de terceros |
| **OAuth2 local** | Tokens de Google nunca salen de tu máquina |

---

## Instalación

### Requisitos
- Node.js 22+
- Windows (ffmpeg DirectShow para webcam/mic/screenshots)
- Proyecto Firebase (plan Blaze para Cloud Functions)
- API key de Gemini (Google AI Studio)
- Token de bot de Telegram (@BotFather)

### 1. Clonar e instalar
```bash
git clone https://github.com/Zesbastian/JarvisClaw.git
cd JarvisClaw
npm install
cp .env.example .env
# Editá .env con tus claves
```

### 2. Secrets de Firebase
```bash
cd brain
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
firebase functions:secrets:set TELEGRAM_ALLOWED_ID
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set OPENWEATHER_API_KEY
firebase deploy --only functions
```

### 3. Correr La Garra
```bash
node garra.js
```

### 4. App Android
Abrí `android/` en Android Studio → agregá `google-services.json` a `android/app/` → Run.

---

## Estructura del proyecto

```
SecureClaw/
├── garra.js                    # Agente local — control de PC
├── package.json
├── brain/
│   └── functions/index.js      # Firebase Cloud Function — Cerebro
├── android/
│   └── app/src/main/java/com/secureclaw/jarvis/
│       ├── MainActivity.kt
│       ├── JarvisMessagingService.kt   # Receptor FCM
│       ├── HitlActionReceiver.kt       # Aprobar/Denegar nativo
│       └── JarvisListenerService.kt    # Wake word
└── documentacion/              # Bitácoras completas de implementación
```

---

## Estado actual

| Componente | Estado | Notas |
|------------|--------|-------|
| Cerebro (Firebase) | ✅ Online | `telegramWebhook` + `morningBriefing` |
| La Garra | ✅ Corriendo | 25+ herramientas, Calendar, webcam, mic |
| App Android | ✅ Conectada | Token FCM registrado en Firestore |
| Wake word Android | ⚠️ En progreso | Porcupine — pendiente resolución de key |

---

## Roadmap

- [x] Fases 1–4: CLI, sandboxing físico, memoria cifrada, optimización de costos
- [x] Fase 5: Voz (TTS + STT via Gemini Multimodal)
- [x] Fase 6: Wake word (Porcupine) + gateway Telegram
- [x] Fase 7: Cerebro dual — Firebase + La Garra, 25 herramientas, Google Calendar
- [x] Fase 8.1: App Android — FCM + HITL nativo
- [ ] Fase 8.2: Wake word en Android
- [ ] Fase 8.3: Pipeline Voz → Cerebro en Android
- [ ] Fase 8.4: TTS en Android
- [ ] Fase 8.5: HITL completamente nativo (sin necesitar Telegram en el celu)

---

## Filosofía

**La IA no es el riesgo. La confianza ciega en la IA sí lo es.**

Cada decisión de arquitectura en SecureClaw parte de una pregunta: *¿qué pasa si Gemini se equivoca, o es manipulado?* La capa HITL no es una feature de UX — es el límite de seguridad. No podés hacer prompt injection pasando por un humano.

---

## Contribuciones

Proyecto personal. Contribuciones bienvenidas. Una regla: **la capa HITL no es negociable.** La aprobación humana no puede ser opcional — ese es el punto central.

---

## Licencia

MIT — usalo libremente, pero no saques la capa de seguridad.

---

*Construido en 9 días. Gemini como cerebro. Firebase como nube. Node.js como manos. Kotlin como oídos.*
