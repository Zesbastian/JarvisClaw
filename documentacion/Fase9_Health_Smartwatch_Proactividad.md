# Fase 9.2 — Health Connect + Smartwatch + Proactividad con Conciencia

**Fecha:** 2026-03-15

---

## Hitos de esta sesión

### Google Calendar en la nube (sin PC)
- OAuth2 refresh_token migrado a Firebase Secret Manager
- `list_calendar_events` y `add_calendar_event` ahora son CLOUD_TOOLS
- El Brain lee y crea eventos aunque La Garra esté offline
- Briefing matutino incluye agenda del día desde Google Calendar

### Health Connect — Xiaomi Smart Band 9
- Dependencia `androidx.health.connect:connect-client:1.1.0-rc01` agregada
- `HealthSyncManager.kt` lee pasos, sueño, frecuencia cardíaca y calorías
- Sincroniza a Firestore en `HealthData/{fcmToken}` al abrir la app
- Permisos declarados en AndroidManifest: READ_STEPS, READ_SLEEP_SESSION, READ_HEART_RATE, READ_TOTAL_CALORIES_BURNED
- La pulsera sincroniza a Mi Fitness → Mi Fitness a Health Connect → JARVIS lo lee

### Notificaciones en smartwatch confirmadas
- FCM llega al celular y se espeja en Xiaomi Smart Band 9
- Configuración requerida: Mi Fitness → Band 9 → Notificaciones → activar SecureClaw y Telegram
- El reloj vibra y muestra título + cuerpo de la notificación

---

## Arquitectura de datos de salud

```
Xiaomi Band 9
    → Bluetooth
        → Mi Fitness (app)
            → Health Connect (Android)
                → HealthSyncManager.kt (nuestra app)
                    → Firestore: HealthData/{fcmToken}
                        → Brain (Firebase)
                            → Briefing + alertas proactivas
```

### Estructura del documento en Firestore

```json
HealthData/{fcmToken}: {
    "steps_today": 3200,
    "steps_goal": 10000,
    "sleep_minutes_last_night": 320,
    "sleep_hours_last_night": 5.3,
    "heart_rate_avg": 72,
    "heart_rate_min": 58,
    "heart_rate_max": 94,
    "calories_today": 1840,
    "date": "2026-03-15",
    "last_sync": Timestamp
}
```

---

## Modelo de proactividad con conciencia

### Principio central
Un asistente que interrumpe sin criterio no es un asistente — es ruido. Cada notificación proactiva debe pasar tres filtros antes de enviarse:

1. **Horario permitido** — no molestar fuera de ventana razonable
2. **Ya notifiqué hoy** — máximo una vez por categoría por día
3. **Umbral real** — el dato debe ser genuinamente significativo

### Ventanas horarias

| Ventana | Tipo |
|---------|------|
| 08:00 | Briefing matutino (único, fijo) |
| 07:30 — 22:00 | Recordatorios de calendario y tareas |
| 07:00 — 21:00 | Alertas de salud proactivas |
| Nunca | Notificaciones de sistema, errores, logs |

### Reglas por categoría

| Categoría | Condición de disparo | Horario | Máximo/día |
|-----------|---------------------|---------|------------|
| Briefing | Siempre a las 8:00 | 08:00 | 1 |
| Reunión próxima | Evento en 60 min | 07:30-22:00 | 1 por evento |
| Meta de pasos | < 70% de la meta a las 19:00 | 19:00 | 1 |
| Sueño corto | < 5h anoche | 09:00 | 1 |
| FC elevada | Promedio > 100 bpm por más de 1h | 10:00-20:00 | 1 |
| Clima extremo | Alerta de tormenta o temp > 38°C / < 0°C | 07:30-22:00 | 1 |

### Control de duplicados — ProactiveLog en Firestore

```
ProactiveLog/{userId}/{fecha}/: {
    "briefing_sent": true,
    "steps_reminder_sent": true,
    "sleep_alert_sent": false,
    ...
}
```

Antes de enviar cualquier notificación proactiva, el scheduler chequea este documento. Si ya se envió esa categoría hoy, no envía.

---

## Próximos pasos — Scheduler de salud

### A implementar

**1. eventReminder — Cloud Scheduler cada 30 minutos**
```javascript
export const eventReminder = onSchedule('*/30 * * * *', async () => {
    // Leer eventos en la próxima hora desde Google Calendar
    // Si hay uno y no fue notificado → mandar FCM + Telegram
    // Marcar en ProactiveLog
});
```

**2. healthCheck — Cloud Scheduler a las 19:00 y 09:00**
```javascript
export const healthCheck = onSchedule({
    schedule: '0 19,9 * * *',
    timeZone: 'America/Argentina/Mendoza'
}, async () => {
    // Leer HealthData de Firestore
    // Evaluar pasos (19:00), sueño (09:00)
    // Si umbral superado y no notificado hoy → enviar
});
```

**3. climateAlert — Cloud Scheduler cada 3 horas**
```javascript
export const climateAlert = onSchedule('0 */3 * * *', async () => {
    // Leer OWM — buscar alertas, temperatura extrema
    // Solo notificar si es genuinamente relevante
});
```

---

## Seguridad — datos expuestos en repo público

### Lo que está seguro
- Ningún secret en el código fuente
- `token.json`, `credentials.json`, `serviceAccount.json`, `.env` en `.gitignore`
- `google-services.json` ignorado en Android
- OAuth2 refresh_token en Firebase Secret Manager (cifrado, no en repo)

### Superficie de ataque actual (repo público)
| Dato expuesto | Riesgo | Mitigación |
|--------------|--------|------------|
| FCM token en Logcat (Android) | Bajo — solo sirve para enviar notificaciones | No loguear token en prod |
| URL del webhook de Firebase | Bajo — requiere secret de Telegram para procesar | Webhook secret validado |
| Package name `com.secureclaw.jarvis` | Ninguno | — |
| Estructura de Firestore (colecciones) | Bajo — sin reglas abiertas | Firestore Rules restringidas |

### Acciones recomendadas antes de escalar
1. Quitar logs de FCM token en `MainActivity.kt` (reemplazar por log ofuscado)
2. Agregar Firebase App Check para que solo la app legítima pueda escribir en Firestore
3. Revisar Firestore Rules — actualmente `AndroidDevices` tiene `allow write: if true`

---

## Estado del producto — visión honesta

### Lo que funciona hoy (probado)
- Telegram → Gemini → HITL → La Garra → PC (25+ herramientas)
- Google Calendar cloud-side (sin PC)
- Briefing matutino: clima + agenda + recordatorios
- FCM push al celular y al smartwatch
- Cloud Engram (memoria sin PC)
- Health Connect integrado (pendiente de prueba con datos reales)

### Lo que falta para ser producto completo
- Wake word Android (bloqueado por Picovoice)
- Scheduler proactivo de salud y eventos
- Recordatorio 1h antes de reuniones
- El Brain leer HealthData y usarlo en briefing y chat
- Firebase App Check para seguridad de producción

### Lo que lo diferencia de todo lo existente en LATAM
- HITL obligatorio — ningún agente del mercado lo tiene como arquitectura
- Costo operativo real: $0.11 en 9 días de desarrollo intensivo
- Funciona sin PC encendida para las tareas de inteligencia
- Integración nativa con smartwatch sin app en el reloj
- Open source, en español, construido en Mendoza
