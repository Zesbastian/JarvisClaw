# Bitácora Técnica — Fases 7.x: Debug, Herramientas y Estabilización
## SecureClaw / JARVIS — Registro completo de desarrollo

**Período:** 2026-03-12
**Estado base:** Fases 1-6 completas (CLI + Voz + Wake Word + Telegram gateway + Engram AES-256)
**Objetivo de esta fase:** Poner el Brain en la nube, conectar La Garra, probar herramientas y estabilizar el sistema

---

## Arquitectura final al cierre de esta fase

```
Telegram (celular)
      │
      ▼
Firebase Cloud Function "Brain"  ←── Gemini 2.5 Flash
      │                                    │
      │  PC_Jobs (Firestore)               │ TOOLS (12 herramientas)
      ▼                                    │
La Garra (garra.js en PC)  ──────────────►┘
      │
      ├── Conciencia (filtro FORBIDDEN_PATTERNS)
      ├── Aduana HITL (botones Aprobar/Denegar en Telegram)
      └── executeTool() → resultado → Telegram
```

---

## FASE 7.1 — El Cerebro (Firebase Cloud Functions)

### Objetivo
JARVIS responde en Telegram 24/7 aunque la PC esté apagada.

### Implementación
- Cloud Function `telegramWebhook` en Firebase Functions v2 (Node 20, Gen2)
- Procesa mensajes via webhook (no polling)
- Integra Gemini 2.5 Flash con tool declarations
- Historial de sesión con sliding window (10 mensajes) en Firestore colección `conversations`
- Autenticación por `TELEGRAM_ALLOWED_ID` — solo el owner puede usar el bot

### Bug crítico #1 — Cloud Run corta el async después de res.send()

**Síntoma:**
- JARVIS no respondía absolutamente nada
- `pending_update_count` quedaba en 0 (Telegram confirmaba recepción)
- Cloud Logging mostraba 0 registros de ejecución del handler

**Causa:**
Firebase Functions v2 usa Cloud Run Gen2. Al enviar `res.status(200).send('OK')` al inicio del handler (para responder rápido a Telegram), Cloud Run corta la asignación de CPU inmediatamente. Todos los `await` posteriores nunca se ejecutan.

**Fix:**
```javascript
// ❌ Antes (roto)
async (req, res) => {
    res.status(200).send('OK'); // CPU cortada aquí
    const result = await gemini.sendMessage(...); // nunca llega
}

// ✅ Después (correcto)
async (req, res) => {
    try {
        // todo el procesamiento...
        const result = await gemini.sendMessage(...);
    } catch (err) {
        console.error(err);
    }
    res.status(200).send('OK'); // AL FINAL
}
```

### Bug crítico #2 — firebase functions:log no muestra logs de ejecución

**Síntoma:** `firebase functions:log` mostraba solo eventos de deploy, nunca los `console.log` del código.

**Causa:** En Firebase Functions v2 (Cloud Run), los logs de ejecución van a Google Cloud Logging, no a la CLI de Firebase.

**Fix:** Usar Google Cloud Logging Console → Explorador de registros, rango "Última hora".

### Bug crítico #3 — GEMINI_API_KEY inválida (silenciosa)

**Síntoma en logs:** `[Brain] Error Gemini: API key not valid. Please pass a valid API key.`

**Causa:** La clave se configuró incorrectamente con `firebase functions:secrets:set`. Los secrets en Firebase son versionados (v1, v2...) — una nueva versión reemplaza la anterior pero requiere redeploy.

**Fix:**
```bash
firebase functions:secrets:set GEMINI_API_KEY
# (pegar clave válida de Google AI Studio)
firebase deploy --only functions
```

### Bug crítico #4 — TELEGRAM_BOT_TOKEN revocado

**Causa:** El token del bot fue expuesto en texto durante el desarrollo. Se revocó inmediatamente.

**Fix:**
1. `/revoke` en @BotFather → genera nuevo token
2. `firebase functions:secrets:set TELEGRAM_BOT_TOKEN` → versión 2
3. Re-registrar el webhook: `curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url={CLOUD_FUNCTION_URL}"`
4. `firebase deploy --only functions`

**Lección:** Si el token aparece en logs, chats o cualquier texto: revocar inmediatamente. La función `tg()` no lanza excepción con tokens inválidos — devuelve `{"ok":false,"error_code":401}` silenciosamente.

### Resultado Fase 7.1
✅ JARVIS responde en Telegram 24/7 sin necesidad de PC encendida
✅ `/start` funciona, historial de conversación activo
✅ Gemini procesa mensajes con herramientas disponibles

---

## FASE 7.2 — La Garra (Nodo Local)

### Objetivo
La PC escucha jobs del Brain y los ejecuta con aprobación humana.

### Arquitectura de La Garra

```
garra.js arranca
  → Publica pc_info en Firestore (homeDir, username, hostname)
  → onSnapshot en PC_Jobs { status: "pending" }
  → Job recibido:
      1. Conciencia (FORBIDDEN_PATTERNS)
      2. Aduana HITL → botones inline Telegram
      3. Usuario aprueba → executeTool()
      4. Resultado → sendMessage al chat
      5. PC_Job marcado como "done"
```

### Herramientas implementadas (12 total)

| Herramienta | Descripción |
|---|---|
| `list_directory` | Lista archivos/carpetas con iconos 📁/📄 |
| `read_file` | Lee contenido con paginación (start_line/end_line) |
| `write_file` | Crea o sobreescribe archivo |
| `delete_file` | Elimina archivo o directorio (recursive opcional) |
| `create_directory` | Crea directorio con subdirectorios |
| `run_command` | Ejecuta PowerShell arbitrario (timeout 30s) |
| `get_system_info` | CPU, RAM, uptime, OS, discos |
| `list_processes` | Top 20 procesos por CPU |
| `kill_process` | Termina proceso por nombre o PID |
| `open_app` | Abre ejecutable, archivo o URL |
| `take_screenshot` | Captura escritorio y envía foto directo al chat |
| `send_file` | Envía cualquier archivo al chat (imagen/video/audio/documento) |
| `save_memory` | Guarda en Engram local cifrado (AES-256) |

### Conciencia — comandos absolutamente prohibidos

```javascript
const FORBIDDEN_PATTERNS = [
    /format\s+(c:|d:|e:)/i,
    /rm\s+-rf\s+\//i,
    /del\s+\/[sf].*system32/i,
    /bcdedit/i,
    /diskpart/i,
    /sfc\s+\/scannow/i,
];
```

### Primer test completo — list_directory

**Prueba:** "Listá los archivos en mi sandbox"
**Resultado:** ✅ La Garra listó archivos, botones de Aduana funcionaron, resultado llegó al chat

---

## BUGS ENCONTRADOS DURANTE PRUEBAS DE HERRAMIENTAS

### Bug #5 — get_system_info no enviaba botones de Aduana

**Síntoma:** Brain respondía "JARVIS necesita acceso a tu PC, Herramienta: get_system_info" pero los botones nunca llegaban al celular.

**Causa:** La Garra (`garra.js`) no estaba corriendo. El PC_Job quedó en Firestore con `status: pending` indefinidamente.
Adicionalmente, el nuevo Brain con herramientas expandidas no había sido deployado aún.

**Fix:**
1. `cd brain && firebase deploy --only functions`
2. Arrancar La Garra: `node garra.js` (desde la raíz del proyecto, no desde `brain/`)

**Error colateral:** `node: Cannot find module 'brain/garra.js'` — La Garra está en la raíz, no en la subcarpeta `brain/`.

---

### Bug #6 — Markdown roto: `Windows_NT` con underscore

**Síntoma:** `400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 135`

**Causa:** `os.type()` retorna `"Windows_NT"`. El underscore `_` es el delimitador de itálica en Telegram Markdown v1. Un `_` sin par de cierre rompe el parser.

**Fix:** Función helper `escapeMd()` + aplicarla a todo contenido dinámico:
```javascript
function escapeMd(str) {
    return String(str).replace(/[_*`\[]/g, '\\$&');
}
// En get_system_info:
const osType = escapeMd(os.type()); // "Windows\_NT"
```

---

### Bug #7 — Markdown roto en paths de Windows

**Síntoma:** `400: Can't find end of the entity starting at byte offset 25` en `list_directory`, `send_file`, `write_file`.

**Causa:** Los paths de Windows tienen `\` (backslashes) que en combinación con caracteres especiales (o nombres de archivo con `_`) confunden al parser de Markdown v1 de Telegram.

**Fix (dos capas):**

**Capa 1 — Confirmaciones con backticks** (inline code = sin parsing):
```javascript
// ✅ Inmune a Markdown
return `✅ Archivo enviado: \`${path.basename(targetPath)}\``;
return `✅ Archivo guardado: \`${targetPath}\``;
```

**Capa 2 — Fallback universal en processJob:**
```javascript
try {
    await bot.telegram.sendMessage(job.chatId, result, { parse_mode: 'Markdown' });
} catch {
    // Si Markdown falla, enviar en texto plano
    await bot.telegram.sendMessage(job.chatId, result.replace(/[\\*_`\[\]]/g, ''));
}
```

---

### Bug #8 — "Tiempo expirado" aparecía después de completar la acción

**Síntoma:** Después de que el usuario aprobaba y la herramienta se ejecutaba correctamente, 120 segundos más tarde aparecía el mensaje "⏱️ Tiempo expirado. Acción denegada automáticamente."

**Causa:** El `setTimeout` de 120s no se cancelaba al resolver la Promise. Seguía corriendo en background aunque el job ya había sido aprobado y completado.

**Fix:**
```javascript
await new Promise((resolve) => {
    let timeoutId;
    const unsubscribe = jobRef.onSnapshot((snap) => {
        const data = snap.data();
        if (data?.status === 'approved' || data?.status === 'denied') {
            clearTimeout(timeoutId); // ← LA CLAVE
            unsubscribe();
            resolve(data.status);
        }
    });
    timeoutId = setTimeout(async () => { ... }, 120_000);
});
```

---

### Bug #9 — Gemini generaba paths incorrectos (relativos o con `{username}`)

**Síntoma:**
- `"path": "Imágenes\\logo.png"` → La Garra resolvía relativo al CWD del proyecto
- `"path": "C:\\Users\\{username}\\Desktop\\archivo.txt"` → literal `{username}` como string

**Causa:** Gemini no conocía el home directory real de la PC del usuario.

**Fix — pc_info en Cloud_Context:**

La Garra publica al arrancar:
```javascript
await db.collection('Cloud_Context').doc('pc_info').set({
    homeDir:  os.homedir(),     // "C:\Users\Zesbastian"
    username: os.userInfo().username, // "Zesbastian"
    hostname: os.hostname(),
    updatedAt: new Date().toISOString()
}, { merge: true });
```

El Brain lo lee e inyecta en el system prompt:
```javascript
const pcHint = pcInfo.homeDir
    ? `\n\nPC conectada: usuario="${pcInfo.username}", home="${pcInfo.homeDir}".
       IMPORTANTE: Siempre usá rutas absolutas completas. Nunca uses {username}, ~, ni rutas relativas.`
    : '';
```

---

## PRUEBAS EXITOSAS — RESULTADOS VERIFICADOS

| Prueba | Herramienta | Resultado |
|---|---|---|
| "Listá archivos en mi sandbox" | `list_directory` | ✅ Lista con iconos 📁/📄 |
| "Cuánta RAM libre tengo?" | `get_system_info` | ✅ CPU, RAM, uptime, discos |
| "Guardá 'Sebastián' en memoria" | `save_memory` | ✅ Engram cifrado actualizado |
| "Abrí el block de notas" | `open_app` | ✅ Notepad abierto en PC |
| "Abrí Spotify" | `open_app` | ✅ Spotify abierto |
| "Tomá una captura de pantalla" | `take_screenshot` | ✅ Foto del escritorio enviada al chat |
| "Abrí Chrome, buscá imágenes, capturá" | `run_command` + `take_screenshot` | ✅ Chrome abierto + captura enviada |

---

## DAEMON DE AUTO-ARRANQUE

`install_daemon.js` instala un VBScript en Windows Startup que arranca ambos procesos de forma invisible al iniciar sesión:

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\...\SecureClaw"
WshShell.Run """node.exe"" ""index.js""", 0, false   ' CLI + Wake Word
WshShell.Run """node.exe"" ""garra.js""", 0, false   ' Agente remoto Firebase
```

Ejecutar una sola vez: `node install_daemon.js`

---

## ESTADO ACTUAL DEL SISTEMA

```
✅ Fase 7.1 — Brain Cloud: JARVIS en Telegram 24/7
✅ Fase 7.2 — La Garra: 13 herramientas, Aduana HITL, Conciencia
✅ Markdown estabilizado: escapeMd + backticks + fallback universal
✅ Paths corregidos: pc_info en Firestore → rutas absolutas correctas
✅ Daemon: arranque automático en Windows login
✅ take_screenshot: foto del escritorio directo al chat
✅ send_file: envío de cualquier archivo (imagen/video/audio/doc)
🔲 Fase 8 — App Android Kotlin
🔲 Fase 8.1 — Proactividad (clima, recordatorios)
```

---

## PRÓXIMAS ETAPAS

Ver `Fases7-8_Cerebro_Dual_y_Android.md` para el roadmap completo de Fase 8.
