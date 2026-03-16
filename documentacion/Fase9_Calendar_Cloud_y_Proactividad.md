# Fase 9 — Calendar Cloud-Side + Arquitectura de Proactividad

**Fecha:** 2026-03-15

---

## El problema que resolvimos

Hasta hoy, Google Calendar requería que La Garra (agente local) estuviera corriendo para que JARVIS pudiera leer o crear eventos. Si la PC estaba apagada, el briefing matutino llegaba sin agenda y no se podían agendar eventos desde el celular.

**Raíz del problema:** el OAuth2 token (`token.json`) vivía en la PC local.

---

## La solución: OAuth2 token en Firebase Secret Manager

### Qué movimos

| Secret | Descripción |
|--------|-------------|
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | Token de larga duración que permite obtener access_tokens |
| `GOOGLE_CALENDAR_CLIENT_ID` | ID de la app OAuth2 en Google Cloud |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Secret de la app OAuth2 |

### Por qué es seguro

- Firebase Secret Manager cifra los secrets en reposo y en tránsito
- Solo las Cloud Functions del proyecto `claw-brain-e6596` pueden acceder
- El refresh_token no es más sensible que `TELEGRAM_BOT_TOKEN` — ya estaba en Secret Manager
- Si se compromete el token: se revoca desde Google Cloud Console en segundos y se genera uno nuevo
- El token solo tiene scope `https://www.googleapis.com/auth/calendar` — acceso mínimo necesario

### Cómo funciona ahora

```javascript
async function getCalendarClient() {
    const auth = new google.auth.OAuth2(
        GOOGLE_CALENDAR_CLIENT_ID.value(),
        GOOGLE_CALENDAR_CLIENT_SECRET.value(),
        'http://localhost:3000'
    );
    auth.setCredentials({ refresh_token: GOOGLE_CALENDAR_REFRESH_TOKEN.value() });
    return google.calendar({ version: 'v3', auth });
}
```

Google renueva el access_token automáticamente usando el refresh_token. La PC no interviene.

---

## list_calendar_events y add_calendar_event ahora son CLOUD_TOOLS

Antes: creaban un PC_Job → esperaban La Garra → La Garra ejecutaba → resultado.

Ahora: el Brain los ejecuta directamente en Firebase, sin HITL, sin La Garra.

```
ANTES:  Usuario → Brain → PC_Job → [Aprobar] → La Garra → Google Calendar API
AHORA:  Usuario → Brain → Google Calendar API (directo, sin PC)
```

**Impacto en seguridad:** leer el calendario no requiere HITL porque es una operación de solo lectura. Crear eventos sí podría requerir confirmación — por ahora se ejecuta directo porque el usuario está explícitamente pidiendo crear el evento.

---

## Briefing matutino actualizado

El briefing de las 8:00 AM ahora incluye tres bloques:

```
🌅 ¡Buenos días, Sebastián!

📅 Lunes, 16 de marzo

🌦️ Mendoza:
☁️ Nubes dispersas — 18°C (sensación 18°C)
💧 Humedad: 89% | 💨 Viento: 0 km/h

📆 Agenda de hoy:
• 08:00 — pipeline sumatpsy/usymint
• 15:00 — Reunión cliente X

📋 Recordatorios de hoy:
• Llamar al banco

JARVIS listo para lo que necesites.
```

**Todos los datos se obtienen desde Firebase — la PC puede estar apagada.**

---

## Arquitectura de proactividad — estado actual y roadmap

### Proactividad actual (implementada)

| Cuándo | Qué hace | Dónde corre |
|--------|----------|-------------|
| 8:00 AM todos los días | Briefing: clima + agenda + recordatorios | Cloud Scheduler |
| Cualquier momento | `/briefing` on-demand | telegramWebhook |
| Cuando el usuario pregunta | Lee calendario, crea eventos | telegramWebhook |

### Proactividad pendiente (próximas fases)

| Cuándo | Qué haría | Complejidad |
|--------|-----------|-------------|
| 1 hora antes de un evento | "Tenés reunión en 1 hora: pipeline sumatpsy/usymint" | Media — Cloud Scheduler cada 30 min |
| Alerta de tormenta | "Se esperan tormentas esta tarde en Mendoza" | Baja — OWM tiene alertas |
| Fin de semana | Resumen de la semana + agenda del lunes | Baja — agregar al Scheduler |
| Cambio brusco de clima | Notificación proactiva | Media — comparar temperaturas |

### Cómo implementar recordatorio 1h antes de reunión

```javascript
// Cloud Scheduler: corre cada 30 minutos
export const eventReminder = onSchedule('*/30 * * * *', async () => {
    const cal = await getCalendarClient();
    const in60min = new Date(Date.now() + 60 * 60 * 1000);
    const in90min = new Date(Date.now() + 90 * 60 * 1000);

    const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: in60min.toISOString(),
        timeMax: in90min.toISOString(),
        singleEvents: true
    });

    for (const event of res.data.items || []) {
        // Chequear en Firestore si ya notificamos este evento
        // Si no, mandar mensaje de Telegram y marcar como notificado
    }
});
```

---

## Principio de seguridad aplicado

**Regla:** las operaciones de lectura de datos propios (calendario, clima, recordatorios) no requieren HITL.
Las operaciones que modifican el sistema (ejecutar código, mover archivos, enviar emails en tu nombre) sí requieren HITL.

```
LECTURA propia    → sin HITL (riesgo: ninguno)
CREACIÓN propia   → sin HITL si el usuario lo pidió explícitamente
EJECUCIÓN en PC   → HITL obligatorio
OPERACIÓN externa → HITL obligatorio (enviar email, postear en RRSS, etc.)
```

Este principio guía qué herramientas son CLOUD_TOOLS y cuáles generan PC_Jobs.
