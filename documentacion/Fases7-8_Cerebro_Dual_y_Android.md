# Roadmap Fases 7 y 8: JARVIS Omnipresente
## Cerebro Dual (Firebase) + App Android Nativa

**Estado base al iniciar este roadmap:**
- ✅ Fases 1-6 completadas (CLI + Voz + Wake Word + Telegram + Engram cifrado)
- ✅ Proyecto Firebase creado con Cloud Functions y Firestore habilitados (Plan Blaze)
- ✅ Firebase CLI instalado y autenticado

**Estado actual (2026-03-12):**
- ✅ **Fase 7.1 COMPLETA** — Brain online en `https://us-central1-claw-brain-e6596.cloudfunctions.net/telegramWebhook`
- ✅ JARVIS responde en Telegram 24/7 sin necesidad de que la PC esté encendida
- ✅ `garra.js` implementado (Fase 7.2 ready to test)
- ✅ **Fase 7.2 COMPLETA** — Flujo Brain → Garra → Aduana → resultado funcionando
- 🔲 Fase 8 — App Android Kotlin

---

## La Visión

Un asistente personal que:
1. **Vive en la nube** → responde 24/7 sin depender de que la PC esté encendida
2. **Habla en tu Android** → "Hey JARVIS" en el celular activa el micrófono sin abrir ninguna app
3. **Controla tu PC de forma remota** → con aprobación humana vía notificación nativa
4. **Es proactivo** → te avisa del clima, recordatorios, eventos del calendario

---

## Arquitectura Final

```
┌──────────────────────────────────────────────────────────────┐
│                  FIREBASE CLOUD (Plan Blaze)                  │
│                                                              │
│  ┌─────────────────────┐    ┌────────────────────────────┐  │
│  │   Cloud Function    │◄──►│       Firestore DB          │  │
│  │  (Brain / Gemini)   │    │  PC_Jobs: bus efímero       │  │
│  │  Telegram Webhook   │    │  Cloud_Context: 4 campos    │  │
│  └─────────────────────┘    └────────────────────────────┘  │
└──────────────────┬───────────────────────┬───────────────────┘
                   │ onSnapshot()          │ FCM Push / Telegram
     ┌─────────────▼──────────┐   ┌────────▼─────────────────┐
     │   LA GARRA (PC Windows) │   │  APP ANDROID (Kotlin)    │
     │                        │   │                          │
     │  garra.js              │   │  "Hey JARVIS"            │
     │  Firebase Admin SDK    │   │  Porcupine Wake Word     │
     │  Conciencia + Aduana   │   │  Voz → Cloud Function    │
     │  Engram AES-256 local  │   │  TTS respuesta           │
     │  Herramientas OS       │   │  Botones HITL nativos    │
     └────────────────────────┘   └──────────────────────────┘
```

---

## FASE 7.1 — El Cerebro (Firebase Cloud Functions)

**Objetivo:** JARVIS responde en Telegram 24/7, aunque la PC esté apagada.

### Estructura de archivos

```
brain/
├── functions/
│   ├── index.js          ← Cloud Function principal
│   └── package.json      ← dependencias del Brain
├── .firebaserc           ← proyecto Firebase vinculado
└── firebase.json         ← config de deploy
```

### Colecciones Firestore

**`PC_Jobs`** — Bus de mensajes efímero (se eliminan tras procesar)
```json
{
  "jobId": "1234567890",
  "telegramChatId": 123456789,
  "tool": "list_directory",
  "params": { "path": "SecureClaw_Sandbox" },
  "status": "pending",
  "result": null,
  "createdAt": "timestamp"
}
```

**`Cloud_Context`** — Caché mínimo no sensible (máximo 4 campos)
```json
{
  "userId": "zesbastian",
  "userName": "Zesbastian",
  "agentPersona": "JARVIS",
  "lastSeen": "timestamp"
}
```

### Lógica del Brain (functions/index.js)

```
Mensaje Telegram
  → Verificar TELEGRAM_ALLOWED_ID
  → Leer Cloud_Context (saber quién es el usuario)
  → Enviar a Gemini con system prompt + contexto
  → ¿Gemini pide herramienta local?
      SÍ → Escribir en PC_Jobs { status: "pending" }
           → Esperar respuesta (polling Firestore, timeout 30s)
           → Responder en Telegram con el resultado
      NO  → Responder directamente en Telegram
```

### Tools disponibles SIN la PC (solo en la nube)
- Búsqueda web (Google Search API o SerpAPI)
- Respuestas generales de Gemini
- Clima (OpenWeatherMap API gratuita)
- Leer/escribir Cloud_Context

### Tools que REQUIEREN la PC (via PC_Jobs)
- `list_directory` — explorar archivos locales
- `read_file` — leer contenido de archivos
- `save_memory` — actualizar Engram cifrado

### Pasos de implementación

1. `cd brain && firebase init functions` (Node.js, ES modules)
2. Instalar dependencias: `@google/genai`, `telegraf`, `firebase-admin`
3. Escribir `functions/index.js` con el webhook
4. Configurar variables de entorno en Firebase:
   ```bash
   firebase functions:secrets:set GEMINI_API_KEY
   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
   firebase functions:secrets:set TELEGRAM_ALLOWED_ID
   ```
5. Deploy: `firebase deploy --only functions`
6. Registrar webhook de Telegram:
   ```
   https://api.telegram.org/bot{TOKEN}/setWebhook?url={CLOUD_FUNCTION_URL}
   ```
7. Desactivar el polling del `telegram_gateway.js` local (el Brain en la nube toma el control de Telegram)

---

## FASE 7.2 — La Garra Refactorizada (PC Node)

**Objetivo:** La PC escucha trabajos del Brain y los ejecuta con aprobación humana.

### Nuevo entry point: `garra.js`

El `index.js` actual sigue funcionando para uso local con Wake Word.
`garra.js` es el modo "agente remoto" — sin CLI, sin Wake Word, solo escucha Firebase.

```
garra.js arranca
  → Conecta Firebase Admin SDK (service account)
  → Inicia onSnapshot() en PC_Jobs donde status == "pending"
  → Cuando llega un job:
      1. Conciencia evalúa (sandbox check)
      2. Aduana HITL → envía botones inline al Telegram del usuario
      3. Usuario aprueba/deniega desde el celular
      4. Si aprueba → ejecuta herramienta
      5. Actualiza PC_Jobs { status: "done", result: "..." }
  → Brain en la nube detecta el cambio → responde en Telegram
```

### Service Account (credencial para Firebase)

La Garra necesita conectarse a Firebase como admin:
1. En Firebase Console → Configuración del proyecto → Cuentas de servicio
2. Generar nueva clave privada → descargar `serviceAccount.json`
3. Agregar `serviceAccount.json` al `.gitignore` (**nunca al repo**)
4. Agregar variable: `FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json` en `.env`

### Pasos de implementación

1. `npm install firebase-admin` en el proyecto raíz
2. Crear `garra.js` con Firebase Admin + onSnapshot
3. Refactorizar `telegram_gateway.js` local: ya no gestiona Telegram (lo hace el Brain), solo envía notificaciones de Aduana como bot si la PC está online
4. Instalar La Garra como daemon: reemplazar el VBScript actual para que arranque `garra.js` en lugar de `index.js` (o los dos en paralelo)

---

## FASE 8 — App Android Kotlin

**Objetivo:** "Hey JARVIS" en el celular. Sin abrir apps. Sin depender de Telegram.

### Stack tecnológico

| Componente | Librería | Costo |
|---|---|---|
| Wake Word | Picovoice Porcupine Android SDK | Gratis (mismo plan) |
| STT | Android SpeechRecognizer (nativo) | $0 |
| LLM | Cloud Function (misma que Fase 7.1) | $0 en uso normal |
| TTS | Android TextToSpeech (nativo) | $0 |
| Push Notifications | Firebase Cloud Messaging (FCM) | $0 |
| Autenticación | Ninguna (solo tu dispositivo) | — |

### Arquitectura de la app

```
[Servicio Background (Foreground Service)]
      │
      ▼
[Porcupine listener - escucha "Hey JARVIS"]
      │ wake word detectado
      ▼
[Grabación de voz (MediaRecorder o AudioRecord)]
      │ audio PCM
      ▼
[Envío a Cloud Function via HTTPS]
      │ respuesta texto
      ▼
[TextToSpeech nativo Android]
      │
      ▼
[Usuario escucha la respuesta]
```

### Botones HITL en Android

Cuando el Brain necesita ejecutar algo en la PC, envía una notificación FCM al teléfono con acciones:

```
[JARVIS solicita acceso a archivos en tu PC]
  Herramienta: list_directory
  Ruta: SecureClaw_Sandbox

  [✅ Aprobar]  [🛑 Denegar]
```

Al tocar, la app envía la decisión a Firebase → La Garra ejecuta o cancela.

### Estructura del proyecto Android

```
app/
├── src/main/
│   ├── java/com/secureclaw/jarvis/
│   │   ├── service/
│   │   │   ├── JarvisBackgroundService.kt  ← Foreground Service siempre activo
│   │   │   └── WakeWordManager.kt          ← Porcupine integration
│   │   ├── voice/
│   │   │   ├── VoiceRecorder.kt            ← AudioRecord → PCM
│   │   │   └── BrainClient.kt              ← HTTPS → Cloud Function
│   │   ├── notification/
│   │   │   └── AduanaNotification.kt       ← Botones HITL nativos
│   │   └── MainActivity.kt                 ← Config + toggle del servicio
│   └── res/
│       └── ...
├── build.gradle
└── google-services.json                    ← Firebase config (no al repo)
```

### Pasos de implementación

1. Crear proyecto Android en Android Studio (Kotlin, minSdk 26)
2. Agregar `google-services.json` del proyecto Firebase
3. Implementar `JarvisBackgroundService` como Foreground Service
4. Integrar Porcupine Android SDK (mismo access key que el PC)
5. Implementar grabación de voz con AudioRecord (16kHz, mono, PCM)
6. Enviar audio a Cloud Function como multipart/form-data
7. Recibir respuesta de texto → TextToSpeech
8. Registrar token FCM → guardarlo en Firestore para notificaciones
9. Implementar `AduanaNotification` con PendingIntent para Aprobar/Denegar

### Permisos requeridos (AndroidManifest.xml)
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.INTERNET" />
```

---

## FASE 8.1 — Proactividad (Sentinel en la Nube)

**Objetivo:** JARVIS te informa sin que vos le preguntes.

### Implementación via Cloud Scheduler (Firebase)

Cloud Scheduler llama a una Cloud Function cada N minutos:

```
Cada 30 minutos:
  → Leer Cloud_Context del usuario
  → Consultar OpenWeatherMap API (clima actual y próximas horas)
  → Si hay evento relevante (lluvia en 1h, temperatura extrema):
      → Gemini genera mensaje contextual personalizado
      → Enviar notificación FCM a Android O mensaje en Telegram

Cada mañana a las 8:00:
  → Leer eventos de Google Calendar API (OAuth del usuario)
  → Gemini genera briefing del día
  → Enviar como notificación push o mensaje Telegram
```

### APIs externas para proactividad

| Fuente | API | Plan gratuito |
|---|---|---|
| Clima | OpenWeatherMap | 1000 llamadas/día |
| Calendario | Google Calendar API (OAuth) | Gratuito con cuota |
| Noticias (opcional) | NewsAPI | 100 req/día |

---

## Orden de construcción y criterios de éxito

| Fase | Criterio de éxito | Estado |
|---|---|---|
| **7.1 Brain** | JARVIS responde en Telegram sin PC encendida | ✅ Completo |
| **7.2 La Garra** | Pedido desde celular → PC ejecuta → respuesta en Telegram | ✅ Completo |
| **8 Android** | "Hey JARVIS" en el celular → respuesta hablada | 🔲 Pendiente |
| **8.1 Proactividad** | Aviso de clima por la mañana sin pedirlo | 🔲 Pendiente |

---

## Lecciones del deploy de Fase 7.1

### 1. Cloud Run Gen2 corta la CPU después de `res.send()`
**Problema:** El código original enviaba `res.status(200).send('OK')` al inicio del handler para responder rápido a Telegram. En Firebase Functions v2 (Cloud Run), esto corta la asignación de CPU antes de que terminen los `await` posteriores.
**Síntoma:** La función respondía 200 a Telegram, el `pending_update_count` quedaba en 0, pero JARVIS nunca enviaba respuestas. Cloud Logging mostraba 0 registros de ejecución.
**Fix:** Mover `res.send()` al final del handler, dentro de un `try/catch` global.

### 2. `firebase functions:log` solo muestra audit logs
**Problema:** El comando `firebase functions:log` en CLI solo muestra eventos de administración (deploy, update). Los logs de ejecución del código (`console.log`, errores) aparecen en Google Cloud Logging, no en la CLI.
**Fix:** Usar Google Cloud Logging Console → Explorador de registros, con rango "Última hora".

### 3. Los secrets pueden contener valores incorrectos silenciosamente
**Problema:** `GEMINI_API_KEY` se configuró con una clave inválida. La función ejecutaba sin error hasta llegar al `chatSession.sendMessage()`, que fallaba con `API_KEY_INVALID`. Para `/start` (que no usa Gemini), el problema era que `TELEGRAM_BOT_TOKEN` podía tener el token revocado.
**Fix:** Siempre verificar los secrets después de configurarlos. El error aparece en Cloud Logging como `[Brain] Error Gemini: API key not valid`.

### 4. `tg()` no lanza excepciones con tokens inválidos
**Problema:** La función `tg()` retorna la respuesta JSON de Telegram sin verificar `ok: true`. Si el token es incorrecto, Telegram devuelve `{"ok":false,"error_code":401}` pero el código lo ignora silenciosamente.
**Impacto:** El bot no responde aunque la función haya procesado el mensaje correctamente.

### 5. El token del bot debe ser revocado si fue expuesto
Si el token de Telegram aparece en logs, chats, o cualquier texto público: revocar inmediatamente con `/revoke` en @BotFather, actualizar el secret en Firebase con `firebase functions:secrets:set TELEGRAM_BOT_TOKEN`, y redesplegar.

---

## Notas de seguridad para esta fase

1. `serviceAccount.json` → jamás al repositorio (agregar al `.gitignore`)
2. `google-services.json` (Android) → jamás al repo
3. Los `PC_Jobs` en Firestore se eliminan después de procesados (zero-knowledge)
4. El Engram **nunca** sube a Firebase — solo sube el `Cloud_Context` (4 campos no sensibles)
5. Cloud Functions validan `TELEGRAM_ALLOWED_ID` antes de procesar cualquier mensaje
6. El token FCM del dispositivo Android es personal — guardarlo en Firestore bajo el userId del owner
