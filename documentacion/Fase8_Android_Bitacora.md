# Fase 8 — App Android Kotlin: Bitácora de Desarrollo
## SecureClaw / JARVIS — JARVIS en el bolsillo

**Inicio:** 2026-03-14
**Objetivo:** "Hey JARVIS" desde el celular → respuesta hablada, sin abrir ninguna app.

---

## Arquitectura

```
Celular Android
    │
    ├── JarvisListenerService (ForegroundService)
    │       └── Porcupine wake word → "Hey JARVIS"
    │               └── AudioRecord → graba voz
    │                       └── POST audio → voiceWebhook (Cloud Function)
    │
    ├── JarvisMessagingService (FCM)
    │       ├── type=briefing → notificación matutina
    │       └── type=hitl    → botones Aprobar/Denegar nativos
    │
    └── HitlActionReceiver (BroadcastReceiver)
            └── Aprobar/Denegar → actualiza PC_Job en Firestore directamente
```

---

## Sub-fases

| Sub-fase | Estado | Descripción |
|---|---|---|
| **8.1** Base + FCM | ✅ 2026-03-14 | Proyecto Android, Firebase conectado, token FCM en Firestore |
| **8.2** Wake Word | 🔲 | ForegroundService + Porcupine "Hey JARVIS" |
| **8.3** Voz → Brain | 🔲 | AudioRecord → Cloud Function → Gemini |
| **8.4** TTS | 🔲 | Respuesta hablada en voz |
| **8.5** HITL nativo | 🔲 | Aprobar/Denegar sin Telegram |

---

## FASE 8.1 — Base + FCM ✅

**Fecha:** 2026-03-14

### Setup del proyecto

- Android Studio → New Project → Empty Activity → Kotlin
- Package: `com.secureclaw.jarvis`
- Minimum SDK: API 26 (Android 8.0)
- Ubicación: `SecureClaw/android/` (monorepo — mismo repo que Brain y Garra)

### Archivos creados

```
android/
├── app/
│   ├── build.gradle.kts          ← Firebase BOM + FCM + Firestore + google-services plugin
│   ├── google-services.json      ← descargado de Firebase Console (NO va a git)
│   └── src/main/
│       ├── AndroidManifest.xml   ← permisos + servicios declarados
│       └── java/com/secureclaw/jarvis/
│           ├── MainActivity.kt           ← pide permisos, registra FCM token
│           ├── JarvisMessagingService.kt ← recibe FCM (briefing + HITL)
│           ├── HitlActionReceiver.kt     ← botones Aprobar/Denegar
│           └── JarvisListenerService.kt  ← placeholder wake word (Fase 8.2)
├── build.gradle.kts              ← plugin google-services
└── gradle/libs.versions.toml    ← versiones centralizadas
```

### Dependencias (`libs.versions.toml`)

```toml
firebaseBom = "33.7.0"
googleServices = "4.4.2"

firebase-bom = { group = "com.google.firebase", name = "firebase-bom" }
firebase-messaging = { group = "com.google.firebase", name = "firebase-messaging-ktx" }
firebase-firestore = { group = "com.google.firebase", name = "firebase-firestore-ktx" }
google-services = { id = "com.google.gms.google-services" }
```

### Permisos declarados en AndroidManifest.xml

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

**Importante:** `FOREGROUND_SERVICE_MICROPHONE` es obligatorio desde Android 14 (API 34) para servicios que acceden al micrófono en foreground. Sin este permiso, `startForeground()` con `foregroundServiceType="microphone"` lanza una excepción en runtime.

### Firestore Rules — colección AndroidDevices

La app Android escribe el FCM token en `AndroidDevices/primary`. Las Firestore Rules por defecto (deny all) bloquean esto. Fix:

```javascript
match /AndroidDevices/{deviceId} {
    allow write: if true;   // token FCM — no es dato sensible
    allow read: if false;   // solo Brain (service account) puede leer
}
```

### Flujo de registro FCM

1. App inicia → `MainActivity.onCreate()`
2. `FirebaseMessaging.getInstance().token` → obtiene el token FCM del dispositivo
3. Escribe en Firestore: `AndroidDevices/primary { fcmToken, updatedAt }`
4. El Brain (morningBriefing) lee ese token para enviar notificaciones push
5. `JarvisMessagingService.onNewToken()` actualiza Firestore si Firebase renueva el token

### Canales de notificación

| Canal | ID | Importancia | Uso |
|---|---|---|---|
| Briefing matutino | `jarvis_briefing` | DEFAULT | Clima, agenda, alertas generales |
| Aprobaciones HITL | `jarvis_hitl` | HIGH | Solicitudes de acceso a la PC |

### Cómo enviar FCM de prueba (sin Firebase Console)

Desde la raíz del proyecto, usando el service account de La Garra:

```bash
node --input-type=module <<'EOF'
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'fs/promises';

const sa = JSON.parse(await fs.readFile('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });

await getMessaging().send({
    notification: { title: '☀️ Buenos días', body: 'JARVIS conectado.' },
    data: { type: 'briefing' },
    token: 'TOKEN_FCM_DEL_DISPOSITIVO'
});
EOF
```

El token FCM del dispositivo actual está en Firestore: `AndroidDevices/primary.fcmToken`

### Hito verificado ✅

- FCM token registrado en Firestore: `fAu6MgTaQt-ru...` (2026-03-14)
- Notificación de prueba enviada y recibida en el dispositivo físico
- App muestra "✅ JARVIS conectado" al iniciar

---

## FASE 8.2 — Wake Word con Porcupine ⚠️ BLOQUEADA

**Fecha:** 2026-03-14

### Estado
Implementación completa — bloqueada por cuenta Picovoice eliminada.

### Lo que se implementó ✅

- Dependencia `ai.picovoice:porcupine-android:3.0.2` agregada y compilando
- `JarvisListenerService` completo con:
  - `Porcupine.Builder` con `BuiltInKeyword.JARVIS` (no requiere .ppn)
  - Loop de audio con `AudioRecord` en coroutine
  - `onWakeWordDetected()` con placeholder para Fase 8.3
  - Notificación foreground persistente "Escuchando... di JARVIS"
  - `updateNotification()` al detectar wake word
- `MainActivity` arranca el servicio con `startForegroundService()`
- APK compila correctamente (37 tareas, BUILD SUCCESSFUL)

### Error en runtime

```
JARVIS-Listener: Error inicializando Porcupine: Initialization failed:
  [0] Picovoice Error (code 00000136)
```

**Causa:** Cuenta Picovoice `zesdh1@gmail.com` eliminada. El error `00000136` = AccessKey inválida/no autorizada.

**Mensaje en consola:**
> "An account registered with 'zesdh1@gmail.com' has been deleted and cannot be reactivated. This may be due to a user request, inactivity, or Picovoice Terms of Use violations."

### Blocker: cuenta no reactivable

La AccessKey `kFtPFrnOCwaPilTvcZBwmUEzA3iw05X7r09kc0NZCe4wmsEX0S7x3w==` ya no es válida.

**Acción pendiente:**
- Contactar `support@picovoice.ai` para entender la razón antes de crear una cuenta nueva
- Una vez con nueva key: actualizar `ACCESS_KEY` en `JarvisListenerService.kt` y en `.env`
- El código no requiere ningún otro cambio — solo la key

### Alternativa si Picovoice no responde
Migrar wake word a **Vosk** (open source, sin cuenta, Android SDK disponible).
Requeriría reescribir `JarvisListenerService` y el wake word de `garra.js` en PC.

### Plan original

1. Crear cuenta en [Picovoice Console](https://console.picovoice.ai)
2. Obtener `AccessKey` gratuito
3. Descargar o entrenar modelo `.ppn` para "Hey JARVIS" (Android, es-AR)
4. Agregar dependencia: `ai.picovoice:porcupine-android:3.x.x`
5. Implementar en `JarvisListenerService`:

```kotlin
// Pseudocódigo
val porcupine = Porcupine.Builder()
    .setAccessKey(ACCESS_KEY)
    .setKeywordPath("hey-jarvis_es_android.ppn")
    .setSensitivity(0.7f)
    .build(context)

val audioRecord = AudioRecord(...)
audioRecord.startRecording()

// loop en coroutine
while (isListening) {
    audioRecord.read(buffer, 0, porcupine.frameLength)
    val result = porcupine.process(buffer)
    if (result >= 0) onWakeWordDetected()
}
```

6. Al detectar wake word → parar Porcupine → iniciar grabación de comando (Fase 8.3)

---

## FASE 8.3 — Voz → Brain 🔲

**Pendiente**

### Plan

- Grabar 4 segundos de audio con `AudioRecord` después del wake word
- Enviar como multipart/form-data a una nueva Cloud Function `voiceWebhook`
- El Brain pasa el audio a Gemini como `inlineData { mimeType: 'audio/wav' }`
- Gemini transcribe + responde en texto
- Brain devuelve `{ text: "respuesta" }` a la app

---

## FASE 8.4 — TTS 🔲

**Pendiente**

- `android.speech.tts.TextToSpeech` — built-in, gratis, calidad aceptable
- Idioma: `Locale("es", "AR")`
- Si la calidad no satisface → migrar a Google Cloud TTS (WaveNet)

---

## FASE 8.5 — HITL nativo 🔲

**Pendiente**

- `HitlActionReceiver` ya está implementado (recibe APPROVE/DENY)
- Falta: Brain envía FCM con `type=hitl` cuando crea un PC_Job
- La notificación nativa reemplaza los botones de Telegram para aprobaciones

### Actualización necesaria en Brain (morningBriefing / telegramWebhook)

```javascript
// Al crear PC_Job, también enviar FCM al celular
const fcmDoc = await db.collection('AndroidDevices').doc('primary').get();
const fcmToken = fcmDoc.data()?.fcmToken;
if (fcmToken) {
    await getMessaging().send({
        data: {
            type: 'hitl',
            jobId: jobRef.id,
            tool: call.name,
            description: `Herramienta: ${call.name}`
        },
        token: fcmToken
    });
}
```
