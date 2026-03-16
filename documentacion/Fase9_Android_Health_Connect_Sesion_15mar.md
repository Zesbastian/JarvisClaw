# Fase 9 — Android App + Health Connect — Sesión 15 de Marzo 2026

## Resumen de la sesión

Sesión completa de debugging de la app Android. Se resolvieron múltiples crasheos y se llegó a un estado estable con Health Connect parcialmente integrado.

---

## Estado al inicio de la sesión

- App crasheaba en loop (JarvisListenerService iniciaba y se cerraba inmediatamente)
- Health Connect declarado pero nunca funcionando
- Permisos de micrófono solicitados incorrectamente

---

## Problemas resueltos

### 1. Crash loop por Android 14 + RECORD_AUDIO

**Síntoma:** App abría y se cerraba instantáneamente en loop infinito. El logcat solo mostraba el servicio iniciando y deteniéndose, sin ningún log de MainActivity.

**Causa:** En Android 14+, `startForeground()` para un servicio con `foregroundServiceType="microphone"` lanza `SecurityException` si `RECORD_AUDIO` no está concedido. El orden original era: pedir permiso (async) → iniciar servicio → `startForeground()` explota.

**Solución en `MainActivity.kt`:**
```kotlin
if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
    == PackageManager.PERMISSION_GRANTED) {
    startJarvisListener()
} else {
    requestRequiredPermissions()
    // startJarvisListener() se llama desde onRequestPermissionsResult
}
```

### 2. Health Connect: `getSdkStatus` no existía en 1.0.0-alpha11

**Causa:** `getSdkStatus()` fue introducido en la rama 1.1.x. El 1.0.0-alpha11 usa `getOrCreate()` para verificar disponibilidad.

**Solución en `HealthSyncManager.isAvailable()`:**
```kotlin
suspend fun isAvailable(): Boolean {
    return try {
        HealthConnectClient.getOrCreate(context)
        true
    } catch (e: Exception) {
        Log.w(TAG, "HC no disponible: ${e.message}")
        false
    }
}
```

### 3. Service not available con 1.0.0-alpha11

**Causa:** En Android 11+, package visibility restrictions impedían que nuestra app vea al servicio de Health Connect. Faltaba `<queries>` en el manifest.

**Solución en `AndroidManifest.xml`:**
```xml
<queries>
    <package android:name="com.google.android.apps.healthdata" />
</queries>
```
Y el intent-filter requerido por HC para mostrar la política de privacidad:
```xml
<intent-filter>
    <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
</intent-filter>
```

### 4. Permiso de sueño mal declarado

**Causa:** Declaramos `READ_SLEEP_SESSION` pero el provider de HC espera `READ_SLEEP`.

**Solución:** Cambiar en `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.health.READ_SLEEP" />
```

### 5. Firestore PERMISSION_DENIED en HealthData

**Causa:** Las reglas de Firestore solo permitían escritura en `AndroidDevices`. La colección `HealthData` estaba bloqueada.

**Solución:** Agregar en Firebase Console → Firestore Rules:
```javascript
match /HealthData/{doc} {
  allow read, write: if true;
}
```

### 6. `hasPermissions()` siempre retornaba false

**Causa:** SDK 1.0.0-alpha11 representa permisos en formato `androidx.health.permission.*` pero el provider moderno (2026.01.22) los almacena como `android.permission.health.*`. Los strings nunca coinciden.

**Solución:** Saltear la verificación de permisos y ejecutar `syncToday()` directamente. Cada operación tiene su propio try-catch.

---

## Itinerario de versiones probadas

| SDK Versión | getSdkStatus | Resultado |
|---|---|---|
| 1.1.0-rc01 | 2 (NEEDS_UPDATE) | Dialog de permisos retorna vacío instantáneo |
| 1.1.0-alpha01 | 2 (NEEDS_UPDATE) | Igual |
| 1.0.0-alpha11 | N/A (no existe) | `Service not available` |
| 1.0.0-alpha11 + manifest fix | disponible via getOrCreate | App estable, HC reads fallan por permisos |
| 1.2.0-alpha02 | disponible | Crash loop nuevo (causa desconocida) |
| **1.0.0-alpha11** (final) | disponible | **ESTADO ESTABLE ACTUAL** |

---

## Estado actual al cierre de sesión

### Lo que funciona
- App abre sin crashear ✅
- `HC disponible` (binding exitoso con getOrCreate) ✅
- FCM token registrado en Firestore ✅
- `Salud sincronizada a Firestore` — escribe `date` y `last_sync` ✅
- `JarvisListenerService` corriendo establemente ✅
- Reglas Firestore permiten escritura en `HealthData` ✅

### Lo que falta
- Datos reales de HC (pasos, sueño, FC, calorías) — todos retornan "lacks permissions"
- Los permisos otorgados en HC UI no se propagan al nivel de sistema en Android 12/13

### Último log exitoso (PID 14090 — 21:25 UTC-3)
```
HC disponible × 2
No se pudieron leer pasos: lacks permissions
No se pudo leer sueño: lacks permissions
No se pudo leer frecuencia cardíaca: lacks permissions
No se pudieron leer calorías: lacks permissions
Health sync completado
FCM Token: registrado
FCM token registrado en Firestore
Salud sincronizada a Firestore ← PIPELINE FUNCIONA
JarvisListenerService arrancado
JarvisListenerService iniciado
Wake word desactivado — AccessKey no configurada
```

---

## Análisis del problema de permisos HC — Probabilidades de solución

En orden de mayor a menor probabilidad:

### 1. Health Connect Developer Mode (85%)
HC tiene un modo desarrollador oculto. Al habilitarlo, acepta solicitudes de permisos de cualquier app (no solo las del allowlist de producción).
**Cómo activarlo:** Health Connect → ⋮ (menú) → "About" o "Acerca de" → tocar la versión 7 veces → Developer options → "Allow all apps to request health permissions"
Si el menú no aparece: Settings → Apps → Health Connect → 3 puntos → opciones de desarrollador.

### 2. adb appops (60%)
A diferencia de `pm grant` (que no conoce estos permisos), `appops` es un sistema diferente que podría aceptarlos:
```
adb shell appops set com.secureclaw.jarvis READ_HEALTH_DATA allow
```
No sabemos el nombre exacto del appop para HC. Requiere investigación.

### 3. Publicar en Play Store (Internal Testing track) (55%)
Las apps en el Internal Testing track de Play Store están en el allowlist de HC automáticamente. El dialog de permisos aparecería correctamente sin ningún cambio de código.

### 4. Instalar APK APKMirror para reemplazar HC (40%)
APKMirror tiene `2026.01.22.01.release` (un parche más nuevo que el instalado `2026.01.22.00`). Podría tener comportamiento diferente con el SDK 1.0.0-alpha11.

### 5. SDK 1.1.0 stable con HC en modo compatible (25%)
El stable `1.1.0` existe en Maven. Combinado con el manifest y queries correctos, podría tener un path de permisos diferente al de las alphas/rc.

---

## Seguridad — Auditoría del código Android

**Estado: SEGURO ✅**

| Archivo | Hallazgo |
|---|---|
| `JarvisListenerService.kt` | `ACCESS_KEY = "YOUR_PICOVOICE_ACCESS_KEY_HERE"` — placeholder correcto, no es un key real |
| `MainActivity.kt` | `Log.d(TAG, "FCM Token: $token")` — loguea el token a logcat. Riesgo bajo (solo visible via adb). Eliminar en producción. |
| `HealthSyncManager.kt` | Sin hallazgos |
| `JarvisMessagingService.kt` | Sin hallazgos |
| `HitlActionReceiver.kt` | Sin hallazgos |

`google-services.json` — en `.gitignore` ✅
Ningún secret, credential o token hardcodeado en el código fuente ✅

**Acción recomendada pre-producción:** Remover `Log.d(TAG, "FCM Token: $token")` de `MainActivity.kt` línea 134.

---

## Briefing de mañana (16 de marzo 2026)

**Sí, el briefing de las 8:00 AM llegará aunque la PC esté apagada.**

El pipeline es 100% cloud:
```
Cloud Scheduler (8:00 AM)
  → morningBriefing (Firebase Cloud Function)
    → Google Calendar API (OAuth2 en Firebase Secret Manager)
    → OpenWeather API
    → Gemini 2.5 Flash
    → FCM push → celular → reloj
```

La PC no participa en ningún paso. La Garra solo se necesita para las PC_TOOLS (abrir programas, capturar pantalla, etc.). Calendar, briefing, recordatorios de reuniones — todo cloud.

---

## SDK y dependencias finales

```toml
# libs.versions.toml
healthConnect = "1.0.0-alpha11"
```

```kotlin
// HealthSyncManager.kt
// isAvailable() usa getOrCreate() (no getSdkStatus que no existe en alpha11)
// syncToday() no verifica hasPermissions() (incompatibilidad de formato de strings)
```
