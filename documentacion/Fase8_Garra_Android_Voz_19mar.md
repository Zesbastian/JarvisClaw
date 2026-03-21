# Fase 8.3 — Garra Android + Activación por Voz
### Sesión: 19–20 de marzo de 2026

---

## Resumen de lo logrado

JARVIS ahora escucha en el teléfono, entiende comandos de voz y ejecuta acciones reales:
abrir Spotify, WhatsApp, cámara, alarmas, buscar contactos. La arquitectura va
Android → Cloud Function → Gemini 2.5 Flash → acción en el teléfono.

---

## Arquitectura final del flujo de voz

```
Teléfono
 └── JarvisListenerService (ForegroundService)
      ├── Vosk (offline STT) → detecta wake word "JARVIS"
      ├── AudioRecord → graba 5 segundos de comando
      ├── shortArrayToWav() → convierte PCM a WAV
      └── callVoiceWebhook() → POST a Brain
           │
           ▼
Cloud Function: voiceWebhook (us-central1)
 ├── Recibe: {audioBase64, conversationHistory?}
 ├── Gemini 2.5 Flash → detecta intención + tool call
 ├── Si tool necesita resultado del teléfono (get_contacts, get_battery):
 │    └── Devuelve {androidAction} → Android ejecuta → follow-up POST
 ├── Si tool no necesita resultado (open_app, set_alarm, etc.):
 │    └── Turno 2 Gemini con "ejecutado" → obtiene texto de confirmación
 └── Devuelve: {text, androidAction, history, conversationHistory}
           │
           ▼
AndroidGarra.execute(tool, params)
 ├── open_app       → getLaunchIntentForPackage + búsqueda fuzzy por nombre
 ├── send_whatsapp  → URI scheme whatsapp://send?phone=&text=
 ├── send_sms       → ACTION_SENDTO smsto:
 ├── make_call      → ACTION_DIAL tel:
 ├── get_contacts   → ContentResolver ContactsContract
 ├── set_alarm      → AlarmClock.ACTION_SET_ALARM
 ├── get_battery    → BatteryManager
 ├── list_apps      → PackageManager.getInstalledApplications
 └── open_camera    → MediaStore.ACTION_IMAGE_CAPTURE
           │
           ▼
TextToSpeech → habla la respuesta en español (AR)
```

---

## Problemas encontrados y soluciones

### 1. Modelo Gemini incorrecto (404)
**Problema:** El voiceWebhook usaba `gemini-2.0-flash` que ya no existe.
**Solución:** Cambiar a `gemini-2.5-flash` según documentación interna.

### 2. Android llamaba a Gemini directamente
**Problema:** La arquitectura inicial tenía el API key en el Android (inseguro y mal diseñado).
**Solución:** Toda la lógica de Gemini fue al Brain (Cloud Function). Android solo envía audio y ejecuta acciones.

### 3. JARVIS decía que ejecutaba pero no hacía nada
**Problema:** Gemini en el turno 1 solo devuelve la function call, sin texto. La app interpretaba
eso como "respuesta vacía" y no ejecutaba nada.
**Solución:** Para tools que no necesitan resultado del teléfono, se hace un Turno 2 de Gemini
enviando `functionResponse: {result: "ejecutado correctamente"}` para obtener la confirmación verbal.

### 4. `startActivity()` silenciosamente bloqueado en Android 10+
**Problema:** Desde un ForegroundService, Android bloquea el lanzamiento de actividades sin aviso ni error.
**Solución:** Agregar `SYSTEM_ALERT_WINDOW` al manifest + pedir el permiso overlay en MainActivity.
En MIUI se requiere además activar manualmente "Mostrar ventanas emergentes en segundo plano"
en Ajustes → Apps → SecureClaw → Otros permisos.

### 5. "App no encontrada" para todas las apps (Android 11+)
**Problema:** `getLaunchIntentForPackage()` devuelve null en Android 11+ sin el permiso de visibilidad de paquetes.
**Solución:** Agregar `QUERY_ALL_PACKAGES` al AndroidManifest.

### 6. `getLaunchIntentForPackage` falla si Gemini adivina mal el package name
**Problema:** Gemini enviaba `com.google.android.maps` en lugar de `com.google.android.apps.maps`.
En Xiaomi muchas apps Google no existen y hay variantes propias.
**Solución:** `openApp()` ahora hace búsqueda fuzzy: si el package name exacto no encuentra nada,
itera todas las apps instaladas y busca por nombre de label o parte del package name.
```kotlin
val match = pm.getInstalledApplications(...).firstOrNull { app ->
    label.contains(query) || app.packageName.contains(query)
}
```

### 7. WhatsApp abría el navegador en vez de la app
**Problema:** El intent usaba `https://wa.me/...` que abre el browser primero.
**Solución:** Cambiar a URI scheme directo: `whatsapp://send?phone=X&text=Y` con `setPackage("com.whatsapp")`.

### 8. voiceWebhook devolvía HTTP 400 en follow-up de tool results
**Problema:** El check de validación `if (!audioBase64)` bloqueaba los requests de follow-up
que no traen audio, solo `{toolName, toolResult, history}`.
**Solución:**
```javascript
const isFollowUp = !!toolName;
if (!audioBase64 && !isFollowUp) { res.status(400)... }
```

### 9. conversationHistory rompía Gemini en el próximo comando (HTTP 500)
**Problema:** Al guardar el historial entre comandos, se incluían los `functionCall` turns del modelo.
Cuando el próximo comando los enviaba como contexto, Gemini respondía:
`"function call turn comes immediately after a user turn or after a function response turn"`.
**Solución:** El `conversationHistory` cross-comando ahora solo guarda pares de texto simples:
```javascript
const newPair = text ? [
    { role: 'user',  parts: [{ text: '[comando de voz]' }] },
    { role: 'model', parts: [{ text }] }
] : [];
const lightHistory = [...prevHistory, ...newPair].slice(-6);
```
Esto garantiza que Gemini siempre recibe un historial con estructura válida (user → model → user → ...).

---

## Permisos del AndroidManifest.xml requeridos

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
<uses-permission android:name="android.permission.READ_CONTACTS" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

El `foregroundServiceType` del servicio:
```xml
android:foregroundServiceType="dataSync|microphone"
```

---

## Estado actual (funcionando)

| Función | Estado |
|---------|--------|
| Wake word "JARVIS" (Vosk offline) | ✅ Detecta (con variantes fonéticas) |
| "Abrí Spotify" | ✅ Funciona |
| "Abrí WhatsApp" | ✅ Funciona |
| "Abrí la cámara" | ✅ Funciona |
| "Poneme una alarma a las 8" | ✅ Abre reloj con la hora |
| "Cuánta batería tengo" | ✅ Responde con nivel y estado |
| "Buscá a Rosalía en mis contactos" | ✅ Devuelve nombre y número (sin tildes) |
| "Mandá un mensaje por WhatsApp" | ✅ Abre chat con mensaje pre-cargado |
| "Abrí Maps / Mapas" | ✅ Funciona (búsqueda fuzzy) |
| Memoria entre comandos | ✅ Recuerda las últimas 3 conversaciones |

---

## Migración de Wake Word: Picovoice Porcupine → Vosk (20 de marzo)

### Por qué se migró

Picovoice Porcupine es una excelente solución técnica, pero su plan gratuito impone restricciones de uso que generan dependencia de una cuenta externa y una API key activa. Para un proyecto de largo plazo con despliegue propio, esa dependencia es un riesgo. Se decidió migrar a **Vosk**, que es 100% open source, sin cuenta, sin API key, y corre completamente offline en el dispositivo.

### Qué es Vosk

- Motor de reconocimiento de voz offline (STT) basado en Kaldi
- Licencia Apache 2.0 — sin restricciones de uso
- Modelos de distintos idiomas y tamaños disponibles en [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)
- Para Android: AAR oficial en Maven Central (`com.alphacephei:vosk-android:0.3.75`)
- Requiere JNA como dependencia: `net.java.dev.jna:jna:5.13.0@aar`

> **Nota sobre el group ID:** El artefacto correcto en Maven Central es `com.alphacephei` (con `hei` al final). El repositorio custom en `alphacephei.com/maven/` tiene disponibilidad intermitente; se recomienda usar Maven Central directamente descargando el AAR y copiándolo a `android/app/libs/`.

### Cómo funciona el wake word con Vosk

Vosk es un motor STT general (no un detector de keywords como Porcupine). El approach es:
1. Vosk transcribe el audio continuamente en tiempo real (`partialResult`)
2. Se verifica si el texto parcial contiene la palabra wake
3. Al detectarla, se resetea el recognizer y se inicia la grabación del comando

```kotlin
val accepted = voskRecognizer?.acceptWaveForm(buffer, bytesRead) ?: false
val partial = if (accepted) {
    JSONObject(voskRecognizer?.result ?: "{}").optString("text", "")
} else {
    JSONObject(voskRecognizer?.partialResult ?: "{}").optString("partial", "")
}
if (partial.lowercase().contains("jarvis")) {
    // wake word detectado
}
```

### Problema: pronunciación argentina con modelo inglés

El modelo inglés pequeño (`vosk-model-small-en-us`) no transcribe "JARVIS" con acento hispanohablante. Lo que el modelo escucha:

| Lo que se dice | Lo que Vosk transcribe |
|----------------|------------------------|
| "JARVIS" | "jair", "harvey's", "jr" |

**Solución implementada:** Ampliar la detección a las variantes fonéticas que el modelo inglés genera:

```kotlin
val lower = partial.lowercase()
val wakeDetected = lower.contains("jarvis") ||
    lower.contains("jair")   ||
    lower.contains("harvey") ||
    lower.contains("jar vis")
```

**Mejora futura:** Migrar al modelo español `vosk-model-small-es-0.42` (~39MB). Con ese modelo, "JARVIS" pronunciado en español se transcribe como "jarvis" directamente, sin necesidad de variantes.

### Instalación del modelo en dispositivos con MIUI

En dispositivos Xiaomi con MIUI, el sistema operativo mata los ForegroundService después de algunos minutos de ejecución, lo que interrumpe la descarga del modelo (~40MB) antes de que termine.

**Solución: push manual via ADB**

1. Descargar el modelo en la PC desde [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models) y descomprimir
2. Conectar el dispositivo con depuración USB habilitada
3. Ejecutar:

```bash
# Paso 1: copiar al almacenamiento temporal del dispositivo
adb push /ruta/local/vosk-model-small-en-us-0.15 /data/local/tmp/vosk-model

# Paso 2: mover al directorio privado de la app
adb shell run-as com.secureclaw.jarvis cp -r /data/local/tmp/vosk-model /data/user/0/com.secureclaw.jarvis/files/vosk-model
```

> **Importante:** Al instalar una nueva versión del APK, Android **no** limpia los datos de la app por defecto. Sin embargo, si se hace una desinstalación completa o se usa "Borrar datos" desde ajustes, el modelo desaparece y hay que volver a pushear.

### Integración en build.gradle.kts

```kotlin
// AAR copiado a android/app/libs/
implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))

// JNA requerido por Vosk
implementation("net.java.dev.jna:jna:5.13.0@aar")
```

---

## Pendiente — Fase 8.4: Acciones dentro de las apps

El próximo paso es que JARVIS no solo abra apps, sino que opere dentro de ellas.

### WhatsApp — enviar mensaje real (no solo abrirlo)
El flow actual abre WhatsApp con el mensaje pre-escrito pero requiere que el usuario toque "Enviar".
Para enviarlo automáticamente hay dos opciones:

**Opción A — Accessibility Service** (más potente, más complejo)
- Declarar un `AccessibilityService` en el manifest
- El usuario lo activa en Ajustes → Accesibilidad
- JARVIS puede leer y tocar elementos de UI de cualquier app
- Permite enviar mensajes, hacer búsquedas, navegar dentro de apps

**Opción B — WhatsApp Business API** (solo para números de empresa)
- No aplica para uso personal

**Opción C — Automation Intent (limitado)**
- Algunas apps exponen Intents para automatización
- WhatsApp no expone un Intent de "enviar mensaje" directamente

### Google Maps — navegar a un lugar
```kotlin
// Abrir Maps directamente a una búsqueda o navegación
val uri = Uri.parse("google.navigation:q=lugar&mode=d")
val intent = Intent(Intent.ACTION_VIEW, uri).apply {
    setPackage("com.google.android.apps.maps")
}
// O para buscar:
val uri = Uri.parse("geo:0,0?q=nombre+del+lugar")
```
Este ya es posible via URI scheme — no requiere Accessibility Service.

### Búsquedas en cualquier app
- Requiere Accessibility Service para apps que no exponen Intent de búsqueda

### Camino recomendado para Fase 8.4
1. Implementar `navigate_maps` como nueva tool usando URI scheme `geo:` / `google.navigation:` — simple, sin permisos extra
2. Implementar `AccessibilityService` para JARVIS — desbloquea control total de cualquier app
3. Agregar tool `tap_ui_element` que use el Accessibility tree para tocar elementos por texto o ID

---

## Archivos clave

| Archivo | Rol |
|---------|-----|
| `android/.../JarvisListenerService.kt` | ForegroundService: wake word, grabación, envío al Brain, TTS |
| `android/.../AndroidGarra.kt` | Ejecuta las tool calls en el teléfono |
| `android/.../MainActivity.kt` | Solicita permisos, arranca el servicio |
| `android/.../AndroidManifest.xml` | Permisos y declaración del servicio |
| `brain/functions/index.js` | Cloud Function: voiceWebhook + conversationHistory |
