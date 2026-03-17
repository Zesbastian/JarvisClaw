# Fase 9 — Health Connect: Camino hasta la solución final

**Fecha:** 15-16 de marzo de 2026
**Resultado:** Health Connect funcional, datos reales del Xiaomi Band 9 llegando a Firestore

---

## Objetivo

Integrar Health Connect para leer pasos, sueño, frecuencia cardíaca y calorías desde el Xiaomi Smart Band 9 (vía Mi Fitness) y sincronizarlos a Firestore, para que el Brain pueda usarlos en el briefing matutino y proactividad.

---

## Lo que teníamos al arrancar

- App Android estable con FCM funcionando
- Health Connect instalado en el dispositivo (versión `2026.01.22.00.release`)
- Mi Fitness sincronizando datos al Band 9 y a Health Connect
- `HealthSyncManager.kt` y `MainActivity.kt` con la integración básica escrita

---

## El camino — todo lo que falló y por qué

### Problema 1: Crash loop al abrir la app

**Síntoma:** La app se abría y cerraba en bucle cada ~10 segundos. El logcat mostraba `JarvisListenerService iniciado` seguido inmediatamente de `JarvisListenerService detenido`, sin stack trace visible.

**Causa:** `JarvisListenerService` estaba declarado en el manifest con `android:foregroundServiceType="microphone"`. En Android 14+, llamar a `startForeground()` con tipo `microphone` requiere que el permiso `RECORD_AUDIO` esté concedido en el momento exacto de la llamada. Como Picovoice (wake word) no estaba configurado, la app llegaba al fallback que llama `startForeground()` sin que RECORD_AUDIO estuviera garantizado → `SecurityException` → crash → Android reiniciaba → loop.

**Lo que no funcionó:** Intentar otorgar RECORD_AUDIO antes, reestructurar el orden de inicialización.

**Solución aplicada:** Cambiar `foregroundServiceType` de `microphone` a `dataSync` (ya que Picovoice no está activo). El servicio ya no requiere RECORD_AUDIO para iniciar la notificación foreground.

---

### Problema 2: `getSdkStatus=2` — SDK y provider incompatibles

**Síntoma:** `HC getSdkStatus=2 (SDK_AVAILABLE=3, NEEDS_UPDATE=2)` — Health Connect disponible pero el SDK decía que el provider necesitaba actualización.

**Causa real (descubierta tarde):** Teníamos el razonamiento invertido. La versión de Health Connect instalada (`2026.01.22`) es **más nueva** que nuestro SDK. El SDK viejo (1.1.0-rc01, 1.1.0-alpha01) no sabe hablar con un provider de 2026 — devuelve status 2 porque él mismo es el obsoleto, aunque el mensaje diga "provider needs update".

**Lo que intentamos y falló:**
- SDK `1.1.0-rc01` → status 2
- SDK `1.1.0-alpha01` → status 2
- SDK `1.0.0-alpha11` → `Service not available` (el protocolo de binding de alpha fue deprecado por el provider moderno)
- Forzar status 2 como si fuera disponible → permisos rechazados instantáneamente sin diálogo

**Solución aplicada:** SDK `1.2.0-alpha02` → `getSdkStatus=3 (SDK_AVAILABLE)`. El provider 2026.01.22 requiere SDK 1.2.x para ser compatible.

---

### Problema 3: Permisos que no se podían otorgar

**Síntoma:** El diálogo de permisos de Health Connect nunca aparecía. El callback del `PermissionController` se disparaba instantáneamente con permisos vacíos.

**Causa:** Health Connect tiene una allowlist. Apps no publicadas en Play Store no pueden mostrar el diálogo automático de permisos. El callback retornaba vacío sin mostrar nada al usuario.

**Lo que intentamos:**
- `adb shell pm grant com.secureclaw.jarvis android.permission.health.READ_STEPS` → `Unknown permission` (HC no usa el PM de Android, gestiona sus propios permisos)
- Otorgar manualmente desde HC → Permisos de apps → SecureClaw (vía deeplink `healthconnect://permissions/manage?packageName=com.secureclaw.jarvis`) → los grants aparecían en HC pero no eran "API grants" reales
- SDK `1.0.0-alpha11` con permisos otorgados vía UI: `getGrantedPermissions()` devolvía set vacío (formato de permisos distinto entre SDK viejo y provider moderno)

**Solución aplicada:** Con SDK `1.2.0-alpha02` y `getSdkStatus=3`, el diálogo oficial sí aparece. El usuario revocó los permisos manuales previos desde HC Settings, reabrió la app, el diálogo apareció correctamente, los permisos se otorgaron por la vía oficial, y las lecturas comenzaron a funcionar.

---

### Problema 4: `READ_SLEEP_SESSION` vs `READ_SLEEP`

**Síntoma:** `[android.permission.health.READ_SLEEP] is not declared!`

**Causa:** El manifest declaraba `android.permission.health.READ_SLEEP_SESSION` pero el provider moderno usa `android.permission.health.READ_SLEEP` para `SleepSessionRecord`.

**Solución:** Corregir el nombre del permiso en `AndroidManifest.xml`.

---

### Problema 5: Firestore `PERMISSION_DENIED` en `HealthData`

**Síntoma:** `PERMISSION_DENIED: Missing or insufficient permissions` al intentar escribir en `HealthData/{fcmToken}`.

**Causa:** Las reglas de Firestore solo tenían `allow write: if true` para `AndroidDevices`. La colección `HealthData` no tenía reglas.

**Solución:** Agregar regla en Firebase Console para permitir escritura en `HealthData`.

---

## Solución final — resumen técnico

### Cambios en `libs.versions.toml`
```toml
healthConnect = "1.2.0-alpha02"  # era 1.0.0-alpha11
```

### Cambios en `AndroidManifest.xml`
```xml
<!-- Antes: FOREGROUND_SERVICE_MICROPHONE -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />

<!-- Permiso de sueño corregido -->
<uses-permission android:name="android.permission.health.READ_SLEEP" />
<!-- (antes era READ_SLEEP_SESSION — nombre incorrecto) -->

<!-- Servicio: tipo cambiado -->
<service android:foregroundServiceType="dataSync" />
<!-- (antes era microphone — causa del crash loop en Android 14) -->
```

### Cambios en `HealthSyncManager.kt`
```kotlin
suspend fun isAvailable(): Boolean {
    return try {
        val status = HealthConnectClient.getSdkStatus(context)
        Log.d(TAG, "HC getSdkStatus=$status (SDK_AVAILABLE=${HealthConnectClient.SDK_AVAILABLE})")
        status == HealthConnectClient.SDK_AVAILABLE
    } catch (e: Exception) {
        Log.w(TAG, "HC no disponible: ${e.message}")
        false
    }
}
```

### Pasos manuales del usuario
1. Revocar permisos en Health Connect → Permisos de apps → SecureClaw
2. Reabrir JARVIS → diálogo oficial aparece → otorgar los 4 permisos
3. Los datos del Band 9 fluyen a Firestore automáticamente

---

## Resultado final

```
D  HC getSdkStatus=3 (SDK_AVAILABLE=3)
D  Pasos hoy: 2740
D  Salud sincronizada a Firestore
```

- SDK 1.2.0-alpha02 compatible con Health Connect provider 2026.01.22 ✅
- Sin crash loop ✅
- Datos reales del Xiaomi Band 9: pasos, sueño, FC, calorías → Firestore ✅
- Servicio `JarvisListenerService` estable ✅

---

## Pendiente

- **Picovoice:** Wake word desactivado por AccessKey inválida. Cuando se resuelva la cuenta, restaurar `foregroundServiceType="microphone"` en el manifest.
- **Scheduler proactivo:** Cloud Scheduler a las 19:00 para notificar pasos del día y comparar con meta.
- **Briefing con datos de salud:** Incluir pasos y sueño en el `morningBriefing` del Brain.
