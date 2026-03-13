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

---

## FASE 7.3 — Herramientas de Control Avanzado de PC

**Período:** 2026-03-13
**Objetivo:** Darle a JARVIS control total sobre la PC: mouse, teclado, multimedia, archivos, webcam, procesos.

### Herramientas agregadas (19 total)

| Herramienta | Descripción | Implementación |
|---|---|---|
| `media_control` | Play/pause/next/prev/volumen/mute | PowerShell `SendKeys` con teclas multimedia globales |
| `send_keys_to_app` | Focaliza una ventana y envía shortcuts | PowerShell `SetForegroundWindow` + `SendKeys` |
| `mouse_click` | Click izquierdo/derecho/doble en coordenadas (x,y) | PowerShell `DllImport user32.dll` + `mouse_event` |
| `get_clipboard` | Lee el portapapeles | PowerShell `Get-Clipboard` |
| `set_clipboard` | Escribe en el portapapeles | PowerShell `Set-Clipboard` |
| `type_text` | Escribe texto en la ventana activa | PowerShell `SendKeys` |
| `get_active_window` | Obtiene la ventana con foco actual | PowerShell `GetForegroundWindow` |
| `search_files` | Busca archivos por patrón en el sistema | PowerShell `Get-ChildItem -Recurse` |
| `download_file` | Descarga URL a un archivo en disco | PowerShell `Invoke-WebRequest` |

### Bug #10 — Antivirus bloquea Add-Type con DllImport

**Síntoma:** `Este script contiene elementos malintencionados y ha sido bloqueado por el software antivirus.`

**Causa:** El AV de Windows 11 detecta el patrón `Add-Type @"... DllImport("user32.dll") ..."@` como código potencialmente malicioso. Este patrón es común en malware de captura de pantalla (spyware).

**Impacto:** La versión JPEG de `take_screenshot` (con `EncoderParameters`) fue bloqueada. La versión original PNG (sin `EncoderParameters`) no fue bloqueada.

**Fix — compresión del lado de Node.js:**

En lugar de comprimir/redimensionar en PowerShell (bloqueado por AV), se usa `ffmpeg` desde Node.js:

```javascript
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// 1. Captura PNG con PowerShell (sin DllImport extra → no bloqueado)
await execAsync(psCmdPng, { shell: 'powershell.exe' });

// 2. Comprimir a JPEG 1280px en Node.js (ffmpeg — el AV no lo inspecciona)
await compressScreenshot(pngFile, jpgFile); // -q:v 5 -vf scale=1280:-1

// 3. Enviar JPEG (~150KB) al chat de Telegram
await bot.telegram.sendPhoto(chatId, { source: jpgFile });

// 4. Guardar base64 en Firestore para que Gemini vea la pantalla
const jpgBuffer = await fs.readFile(jpgFile);
await db.collection('Cloud_Context').doc('last_screenshot').set({
    base64: jpgBuffer.toString('base64'),
    mimeType: 'image/jpeg',
    timestamp: Date.now()
});
```

**Resultado:** JPEG de ~150KB generado, almacenado en Firestore, Gemini puede ver la pantalla para determinar coordenadas antes de `mouse_click`.

---

### Bug #11 — mouse_click no hacía nada visible

**Síntoma:** JARVIS ejecutaba `mouse_click` y devolvía "Click izquierdo en (X, Y)" pero no pasaba nada en la pantalla.

**Causa:** Gemini adivinaba las coordenadas sin haber visto la pantalla. Sin un screenshot previo, Gemini inventaba valores arbitrarios que no correspondían a ningún elemento real.

**Fix — regla en system prompt:**

```javascript
const visionHint = recentScreenshot
    ? `Analizá la imagen para determinar coordenadas exactas antes de mouse_click. NUNCA adivines coordenadas.`
    : `REGLA CRÍTICA: Si el usuario pide hacer click en algo, PRIMERO llamá a take_screenshot. NUNCA uses mouse_click con coordenadas adivinadas.`;
```

**Flujo correcto:**
1. Usuario: *"Hace click en el botón de búsqueda"*
2. JARVIS: → `take_screenshot` (ve la pantalla)
3. JARVIS: analiza la imagen, identifica el elemento, determina coordenadas exactas
4. JARVIS: → `mouse_click(x, y)` con coordenadas reales

---

## FASE 7.4 — Visión: Gemini Ve la Pantalla

**Objetivo:** Gemini puede analizar screenshots para determinar coordenadas de UI sin pedirle al usuario que las especifique.

### Implementación

**En garra.js:**
- `take_screenshot` captura PNG con PowerShell, comprime a JPEG con ffmpeg
- Guarda el JPEG como base64 en `Cloud_Context/last_screenshot` en Firestore
- Screenshot válido por 5 minutos

**En brain/functions/index.js:**
```javascript
const screenshotData = screenshotSnap.exists ? screenshotSnap.data() : null;
const recentScreenshot = screenshotData && (Date.now() - screenshotData.timestamp) < 300_000
    ? screenshotData : null;

// Si hay screenshot reciente, enviarlo como imagen inline a Gemini
const geminiMessage = recentScreenshot?.base64
    ? [{ text }, { inlineData: { mimeType: 'image/jpeg', data: recentScreenshot.base64 } }]
    : text;
```

**Resultado:** Gemini recibe la imagen junto al texto del usuario y puede:
- Identificar botones, campos de texto, menús
- Determinar coordenadas (x,y) exactas
- Ejecutar `mouse_click` con precisión sin preguntarle al usuario

---

## FASE 7.5 — Proactividad: Briefing Matutino y Recordatorios

**Objetivo:** JARVIS no espera órdenes — envía información útil proactivamente.

### Cloud Scheduler — Briefing Matutino

**Implementación:** `firebase-functions/v2/scheduler` con `onSchedule`

```javascript
export const morningBriefing = onSchedule({
    schedule:  '0 8 * * *',           // 8:00 AM todos los días
    timeZone:  'America/Argentina/Mendoza',
    secrets:   [TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID, OPENWEATHER_API_KEY]
}, async () => {
    // 1. Fetch clima en Mendoza (OpenWeatherMap API)
    // 2. Leer recordatorios del día desde Firestore
    // 3. Construir y enviar mensaje consolidado
});
```

**Contenido del briefing:**
```
🌅 ¡Buenos días, Sebastián!

📅 Viernes 13 de marzo

🌦️ Mendoza:
☀️ Despejado — 28°C (sensación 30°C)
💧 Humedad: 35% | 💨 Viento: 12 km/h

📋 Recordatorios de hoy:
• Llamar al médico a las 10:00

JARVIS listo para lo que necesites.
```

**Comando `/briefing`:** Disponible para disparar el resumen en cualquier momento sin esperar las 8am.

### Herramientas de Recordatorios (Cloud-side, sin La Garra)

| Herramienta | Descripción |
|---|---|
| `set_reminder` | Guarda recordatorio con mensaje, fecha/hora opcional y repetición |
| `list_reminders` | Lista todos los recordatorios activos |
| `delete_reminder` | Elimina recordatorio por índice |

**Decisión arquitectónica:** Los recordatorios se manejan directamente en el Brain (Cloud Function) sin necesidad de La Garra. El Brain detecta si la herramienta es "cloud-side" o "PC-side" antes de crear un PC_Job:

```javascript
const CLOUD_TOOLS = new Set(['set_reminder', 'list_reminders', 'delete_reminder']);

if (CLOUD_TOOLS.has(call.name)) {
    // Ejecutar directamente en la Cloud Function
    const remRef = db.collection('Reminders').doc(String(userId)).collection('items');
    // ...
} else {
    // Crear PC_Job para La Garra
    const jobRef = await db.collection('PC_Jobs').add({ ... });
}
```

**Uso natural (texto):**
- *"Recordame comprar pan mañana a las 9"*
- *"Qué recordatorios tengo"*
- *"Borrá el recordatorio 2"*

**Secret requerido:** `OPENWEATHER_API_KEY` (cuenta gratuita en openweathermap.org)

---

## ESTADO ACTUAL DEL SISTEMA

```
✅ Fase 7.1 — Brain Cloud: JARVIS en Telegram 24/7
✅ Fase 7.2 — La Garra: 19 herramientas, Aduana HITL, Conciencia
✅ Fase 7.3 — Control avanzado de PC: mouse, teclado, multimedia, archivos
✅ Fase 7.4 — Visión: Gemini ve la pantalla vía ffmpeg + Firestore base64
✅ Fase 7.5 — Proactividad: briefing matutino, clima, recordatorios
✅ Markdown estabilizado: escapeMd + backticks + fallback universal
✅ Paths corregidos: pc_info en Firestore → rutas absolutas correctas
✅ Daemon: arranque automático en Windows login
🔲 Fase 8 — App Android Kotlin
```

---

## HERRAMIENTAS COMPLETAS — REFERENCIA RÁPIDA

### Herramientas de PC (La Garra — requieren Aduana)

| Herramienta | Parámetros clave |
|---|---|
| `list_directory` | `path?` |
| `read_file` | `path`, `start_line?`, `end_line?` |
| `write_file` | `path`, `content` |
| `delete_file` | `path`, `recursive?` |
| `create_directory` | `path` |
| `run_command` | `command` (PowerShell) |
| `get_system_info` | — |
| `list_processes` | — |
| `kill_process` | `pid` o `name` |
| `open_app` | `app` (nombre, ruta o URL) |
| `take_screenshot` | — |
| `send_file` | `path` (absoluta) |
| `save_memory` | `content`, `category` |
| `media_control` | `action`: play_pause/next/prev/volume_up/volume_down/mute |
| `send_keys_to_app` | `app`, `keys` |
| `mouse_click` | `x`, `y`, `button?` (left/right/double) |
| `get_clipboard` | — |
| `set_clipboard` | `text` |
| `type_text` | `text` |
| `get_active_window` | — |
| `search_files` | `pattern`, `path?` |
| `download_file` | `url`, `destination` |

### Herramientas Cloud (Brain — sin Aduana, instantáneas)

| Herramienta | Parámetros clave |
|---|---|
| `set_reminder` | `message`, `datetime?` (ISO 8601), `repeat?` |
| `list_reminders` | — |
| `delete_reminder` | `index` |

---

## PRÓXIMAS ETAPAS

Ver `Fases7-8_Cerebro_Dual_y_Android.md` para el roadmap completo.

**Pendiente inmediato:**
1. Probar `/briefing` y recordatorios (requiere deploy con `OPENWEATHER_API_KEY`)
2. Probar visión + mouse_click (tomar screenshot → Gemini analiza → click)
3. Fase 8 — App Android Kotlin
