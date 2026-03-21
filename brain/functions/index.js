/**
 * brain/functions/index.js
 * El Cerebro — Firebase Cloud Function
 *
 * Responsabilidades:
 *  1. Recibir mensajes de Telegram via Webhook (24/7, sin PC)
 *  2. Procesar con Gemini + historial de sesión en Firestore
 *  3. Si Gemini necesita herramienta local → crear PC_Job en Firestore
 *  4. Recibir callback de botones Aduana → actualizar estado del PC_Job
 *
 * El Engram (memoria cifrada) vive en la PC. La nube nunca lo toca.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import { defineSecret } from 'firebase-functions/params';

// ── Secretos (configurar con: firebase functions:secrets:set NOMBRE) ──────────
const GEMINI_API_KEY                  = defineSecret('GEMINI_API_KEY');
const TELEGRAM_BOT_TOKEN              = defineSecret('TELEGRAM_BOT_TOKEN');
const TELEGRAM_ALLOWED_ID             = defineSecret('TELEGRAM_ALLOWED_ID');
const OPENWEATHER_API_KEY             = defineSecret('OPENWEATHER_API_KEY');
const GOOGLE_CALENDAR_REFRESH_TOKEN   = defineSecret('GOOGLE_CALENDAR_REFRESH_TOKEN');
const GOOGLE_CALENDAR_CLIENT_ID       = defineSecret('GOOGLE_CALENDAR_CLIENT_ID');
const GOOGLE_CALENDAR_CLIENT_SECRET   = defineSecret('GOOGLE_CALENDAR_CLIENT_SECRET');

initializeApp();

// ── Google Calendar helper (OAuth2 cloud-side) ────────────────────────────────
async function getCalendarClient() {
    const { google } = await import('googleapis');
    const auth = new google.auth.OAuth2(
        GOOGLE_CALENDAR_CLIENT_ID.value(),
        GOOGLE_CALENDAR_CLIENT_SECRET.value(),
        'http://localhost:3000'
    );
    auth.setCredentials({ refresh_token: GOOGLE_CALENDAR_REFRESH_TOKEN.value() });
    return google.calendar({ version: 'v3', auth });
}

// ── Herramientas que Gemini puede solicitar ───────────────────────────────────
const TOOLS = [{
    functionDeclarations: [
        // ── Archivos y directorios ──────────────────────────────────────────
        {
            name: 'list_directory',
            description: 'Lista los archivos y carpetas en un directorio de la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path: { type: 'STRING', description: 'Ruta del directorio (opcional, default: directorio actual)' }
                },
                required: []
            }
        },
        {
            name: 'read_file',
            description: 'Lee el contenido de un archivo en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path:       { type: 'STRING',  description: 'Ruta absoluta del archivo' },
                    start_line: { type: 'INTEGER', description: 'Línea inicial (paginación)' },
                    end_line:   { type: 'INTEGER', description: 'Línea final (paginación)' }
                },
                required: ['path']
            }
        },
        {
            name: 'write_file',
            description: 'Crea o sobreescribe un archivo en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path:    { type: 'STRING', description: 'Ruta absoluta del archivo' },
                    content: { type: 'STRING', description: 'Contenido a escribir' }
                },
                required: ['path', 'content']
            }
        },
        {
            name: 'delete_file',
            description: 'Elimina un archivo o directorio en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path:      { type: 'STRING',  description: 'Ruta absoluta del archivo o directorio' },
                    recursive: { type: 'BOOLEAN', description: 'Si es true, elimina directorios con contenido' }
                },
                required: ['path']
            }
        },
        {
            name: 'create_directory',
            description: 'Crea un directorio (y subdirectorios necesarios) en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path: { type: 'STRING', description: 'Ruta absoluta del directorio a crear' }
                },
                required: ['path']
            }
        },
        // ── Sistema operativo ───────────────────────────────────────────────
        {
            name: 'run_command',
            description: 'Ejecuta un comando PowerShell en la PC del usuario. Puede hacer casi cualquier cosa: instalar software, modificar configuraciones, mover archivos, consultar el sistema, etc.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    command: { type: 'STRING', description: 'Comando PowerShell a ejecutar' }
                },
                required: ['command']
            }
        },
        {
            name: 'get_system_info',
            description: 'Obtiene información del sistema: CPU, RAM, discos, uptime y OS de la PC del usuario.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'list_processes',
            description: 'Lista los 20 procesos que más CPU consumen en la PC del usuario.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'kill_process',
            description: 'Termina un proceso en la PC del usuario por nombre o PID.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    name: { type: 'STRING',  description: 'Nombre del proceso (ej: chrome, notepad)' },
                    pid:  { type: 'INTEGER', description: 'PID del proceso' }
                },
                required: []
            }
        },
        {
            name: 'open_app',
            description: 'Abre una aplicación, archivo o URL en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    app: { type: 'STRING', description: 'Nombre del ejecutable, ruta de archivo, o URL' }
                },
                required: ['app']
            }
        },
        // ── Control del mouse ────────────────────────────────────────────────
        {
            name: 'mouse_click',
            description: 'Mueve el cursor del mouse a las coordenadas (x, y) y hace click en la PC del usuario. Usá take_screenshot primero para ver la pantalla y determinar las coordenadas correctas.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    x:      { type: 'INTEGER', description: 'Coordenada X en píxeles' },
                    y:      { type: 'INTEGER', description: 'Coordenada Y en píxeles' },
                    button: { type: 'STRING',  description: 'Tipo de click: left (default), right, double' }
                },
                required: ['x', 'y']
            }
        },
        // ── Control multimedia y aplicaciones ────────────────────────────────
        {
            name: 'media_control',
            description: 'Controla la reproducción multimedia de la PC del usuario con teclas globales. Funciona con Spotify, YouTube, cualquier reproductor.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    action: { type: 'STRING', description: 'Acción: play_pause, next, prev, volume_up, volume_down, mute' }
                },
                required: ['action']
            }
        },
        {
            name: 'send_keys_to_app',
            description: 'Focaliza una aplicación en la PC del usuario y le envía teclas o shortcuts de teclado. Útil para controlar apps específicas (ej: Ctrl+L en el navegador, Ctrl+T para nueva pestaña).',
            parameters: {
                type: 'OBJECT',
                properties: {
                    app:  { type: 'STRING', description: 'Nombre del proceso de la app (ej: spotify, chrome, notepad, code)' },
                    keys: { type: 'STRING', description: 'Teclas a enviar en formato SendKeys (ej: ^l para Ctrl+L, {ENTER}, +{TAB} para Shift+Tab)' }
                },
                required: ['app', 'keys']
            }
        },
        // ── Portapapeles y teclado ───────────────────────────────────────────
        {
            name: 'get_clipboard',
            description: 'Lee el contenido actual del portapapeles de la PC del usuario.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'set_clipboard',
            description: 'Escribe texto en el portapapeles de la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: { text: { type: 'STRING', description: 'Texto a copiar al portapapeles' } },
                required: ['text']
            }
        },
        {
            name: 'type_text',
            description: 'Escribe texto en la ventana activa de la PC del usuario, como si lo escribiera el teclado.',
            parameters: {
                type: 'OBJECT',
                properties: { text: { type: 'STRING', description: 'Texto a escribir' } },
                required: ['text']
            }
        },
        {
            name: 'get_active_window',
            description: 'Obtiene el nombre y título de la ventana activa en la PC del usuario.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        // ── Búsqueda y descargas ─────────────────────────────────────────────
        {
            name: 'search_files',
            description: 'Busca archivos por nombre o patrón (ej: *.pdf, foto*.jpg) en la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    pattern:   { type: 'STRING', description: 'Patrón de búsqueda (ej: *.pdf, reporte*.xlsx)' },
                    directory: { type: 'STRING', description: 'Directorio donde buscar (opcional, default: home del usuario)' }
                },
                required: ['pattern']
            }
        },
        {
            name: 'download_file',
            description: 'Descarga un archivo desde una URL a la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    url:         { type: 'STRING', description: 'URL del archivo a descargar' },
                    destination: { type: 'STRING', description: 'Ruta destino (opcional, default: carpeta Downloads)' }
                },
                required: ['url']
            }
        },
        // ── Enviar archivos ──────────────────────────────────────────────────
        {
            name: 'send_file',
            description: 'Envía un archivo de la PC del usuario directamente al chat de Telegram (imágenes, documentos, audio, video, etc.).',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path: { type: 'STRING', description: 'Ruta absoluta del archivo a enviar' }
                },
                required: ['path']
            }
        },
        // ── Captura de pantalla ─────────────────────────────────────────────
        {
            name: 'take_screenshot',
            description: 'Toma una captura de pantalla del escritorio de la PC del usuario y la envía directamente al chat de Telegram.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'take_webcam_photo',
            description: 'Toma una foto con la webcam/cámara de la PC y la envía al chat de Telegram.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'record_audio',
            description: 'Graba audio del micrófono de la PC durante N segundos y lo envía al chat.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    seconds: { type: 'INTEGER', description: 'Duración en segundos (máx 30, default 5)' }
                },
                required: []
            }
        },
        // ── Google Calendar ─────────────────────────────────────────────────
        {
            name: 'list_calendar_events',
            description: 'Lista los próximos eventos del Google Calendar del usuario. Usalo cuando el usuario pregunte por sus eventos, reuniones, agenda o calendario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    days: { type: 'NUMBER', description: 'Cuántos días hacia adelante consultar (default 7, máximo 30)' }
                },
                required: []
            }
        },
        {
            name: 'add_calendar_event',
            description: 'Crea un nuevo evento en el Google Calendar del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    title:       { type: 'STRING', description: 'Título del evento' },
                    start:       { type: 'STRING', description: 'Fecha/hora de inicio en formato ISO 8601 (ej: 2026-03-15T10:00:00) o solo fecha para eventos de día completo (ej: 2026-03-15)' },
                    end:         { type: 'STRING', description: 'Fecha/hora de fin en formato ISO 8601. Opcional si all_day=true.' },
                    description: { type: 'STRING', description: 'Descripción o notas del evento (opcional)' },
                    location:    { type: 'STRING', description: 'Lugar del evento (opcional)' },
                    all_day:     { type: 'BOOLEAN', description: 'true si es un evento de día completo' }
                },
                required: ['title', 'start']
            }
        },
        // ── Memoria local cifrada (requiere La Garra online) ────────────────
        {
            name: 'save_memory',
            description: 'Guarda un recuerdo sensible en el Engram local cifrado de la PC. Usar para datos privados, contraseñas, información personal sensible. Requiere que La Garra esté online.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    content:  { type: 'STRING', description: 'Contenido del recuerdo' },
                    category: { type: 'STRING', description: 'Categoría: identity, preference, rule, context' }
                },
                required: ['content', 'category']
            }
        },
        // ── Cloud Engram (disponible siempre, sin La Garra) ─────────────────
        {
            name: 'save_cloud_memory',
            description: 'Guarda un recuerdo no sensible en el Cloud Engram (Firestore). Disponible aunque La Garra esté offline. Usar para preferencias, estilo de comunicación, contexto general, hábitos, gustos.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    key:      { type: 'STRING', description: 'Identificador único del recuerdo (ej: "prefiere_respuestas_cortas", "trabaja_de_noche")' },
                    value:    { type: 'STRING', description: 'Valor o descripción del recuerdo' },
                    category: { type: 'STRING', description: 'Categoría: preference, habit, context, personality' }
                },
                required: ['key', 'value', 'category']
            }
        },
        {
            name: 'delete_cloud_memory',
            description: 'Elimina un recuerdo del Cloud Engram por su clave.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    key: { type: 'STRING', description: 'Clave del recuerdo a eliminar' }
                },
                required: ['key']
            }
        },
        // ── Recordatorios (ejecutados en la nube, sin La Garra) ─────────────
        {
            name: 'set_reminder',
            description: 'Guarda un recordatorio. El briefing matutino los incluirá o se enviará un mensaje cuando llegue la hora.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    message:  { type: 'STRING', description: 'Texto del recordatorio' },
                    datetime: { type: 'STRING', description: 'Fecha y hora en formato ISO 8601 (ej: 2026-03-14T09:00:00). Opcional.' },
                    repeat:   { type: 'STRING', description: 'Repetición: daily, weekly, monthly. Opcional.' }
                },
                required: ['message']
            }
        },
        {
            name: 'list_reminders',
            description: 'Lista todos los recordatorios activos del usuario.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'delete_reminder',
            description: 'Elimina un recordatorio por su número de índice (1, 2, 3...).',
            parameters: {
                type: 'OBJECT',
                properties: {
                    index: { type: 'INTEGER', description: 'Número del recordatorio a eliminar (ver list_reminders)' }
                },
                required: ['index']
            }
        }
    ]
}];

// ── Utilidades Telegram (sin librería, usa fetch nativo de Node 20) ───────────
async function tg(token, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

// ── Cloud Function principal ──────────────────────────────────────────────────
export const telegramWebhook = onRequest(
    {
        secrets: [GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID, OPENWEATHER_API_KEY, GOOGLE_CALENDAR_REFRESH_TOKEN, GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET],
        region: 'us-central1',
        timeoutSeconds: 60,
        memory: '256MiB'
    },
    async (req, res) => {
        // IMPORTANTE: NO enviar res.send() hasta el final.
        // Cloud Run (Gen2) corta la CPU al responder, matando el trabajo async.
        const body = req.body;
        const token = TELEGRAM_BOT_TOKEN.value();
        const allowedId = parseInt(TELEGRAM_ALLOWED_ID.value(), 10);
        const db = getFirestore();

        try {
            // ── Caso 1: Callback de botones Aduana (Aprobar / Denegar) ───────────
            if (body?.callback_query) {
                const cb = body.callback_query;
                const [action, jobId] = (cb.data || '').split(':');

                if ((action === 'approve' || action === 'deny') && jobId) {
                    const jobRef = db.collection('PC_Jobs').doc(jobId);
                    await jobRef.update({ status: action === 'approve' ? 'approved' : 'denied' });

                    const statusText = action === 'approve'
                        ? '✅ *Aprobado.* La Garra ejecutando...'
                        : '🛑 *Denegado.* El agente recalculará.';

                    await tg(token, 'editMessageText', {
                        chat_id:    cb.message.chat.id,
                        message_id: cb.message.message_id,
                        text:       statusText + '\n\n' + cb.message.text,
                        parse_mode: 'Markdown'
                    });
                    await tg(token, 'answerCallbackQuery', { callback_query_id: cb.id });
                }
                return res.status(200).send('OK');
            }

            // ── Caso 2: Mensaje de texto ──────────────────────────────────────────
            if (!body?.message?.text) return res.status(200).send('OK');

            const msg     = body.message;
            const chatId  = msg.chat.id;
            const userId  = msg.from.id;
            const text    = msg.text;

            console.log(`[Brain] Mensaje de userId=${userId}, text="${text}"`);

            // Seguridad: solo el propietario
            if (userId !== allowedId) {
                console.log(`[Brain] Acceso denegado para userId=${userId}`);
                await tg(token, 'sendMessage', { chat_id: chatId, text: '🚫 Acceso denegado.' });
                return res.status(200).send('OK');
            }

            // Comando /start
            if (text === '/start') {
                await tg(token, 'sendMessage', {
                    chat_id:    chatId,
                    text:       '🤖 *JARVIS online*\n\nEscribime lo que necesitás. Si requiero acceso a tu PC te pediré aprobación primero.',
                    parse_mode: 'Markdown'
                });
                return res.status(200).send('OK');
            }

            // Comando /briefing — dispara el resumen matutino ahora
            if (text === '/briefing') {
                const db2 = getFirestore();
                const weatherKey = OPENWEATHER_API_KEY.value();
                let weatherBlock = '🌡️ _(clima no disponible)_';
                try {
                    const wr = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Mendoza,AR&appid=${weatherKey}&units=metric&lang=es`);
                    const w  = await wr.json();
                    const icons = { Clear:'☀️', Clouds:'☁️', Rain:'🌧️', Drizzle:'🌦️', Thunderstorm:'⛈️', Snow:'❄️', Mist:'🌫️', Fog:'🌫️' };
                    const icon = icons[w.weather[0].main] || '🌡️';
                    const desc = w.weather[0].description;
                    weatherBlock = `${icon} *${desc.charAt(0).toUpperCase()+desc.slice(1)}* — ${Math.round(w.main.temp)}°C (sensación ${Math.round(w.main.feels_like)}°C)\n💧 ${w.main.humidity}% | 💨 ${Math.round((w.wind?.speed||0)*3.6)} km/h`;
                } catch {}
                let remindersBlock = '';
                try {
                    const today = new Date(); today.setHours(0,0,0,0);
                    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
                    const snap = await db2.collection('Reminders').doc(String(chatId)).collection('items').where('active','==',true).get();
                    const todayR = snap.docs.map(d=>d.data()).filter(r=>{ if(!r.datetime) return false; const d=new Date(r.datetime); return d>=today&&d<tomorrow; });
                    if (todayR.length>0) remindersBlock = `\n\n📋 *Hoy:*\n${todayR.map(r=>`• ${r.message}`).join('\n')}`;
                } catch {}
                const now  = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Argentina/Mendoza'}));
                const date = now.toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
                const msg  = `🌅 *Briefing manual*\n\n📅 *${date.charAt(0).toUpperCase()+date.slice(1)}*\n\n🌦️ *Mendoza:*\n${weatherBlock}${remindersBlock}\n\n_JARVIS listo para lo que necesites._`;
                await tg(token, 'sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
                return res.status(200).send('OK');
            }

            // Indicador de escritura
            await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });

            // ── Cargar Cloud_Context (quién es el usuario) ────────────────────────
            const [ctxSnap, pcSnap, screenshotSnap, cloudEngramSnap] = await Promise.all([
                db.collection('Cloud_Context').doc(String(userId)).get(),
                db.collection('Cloud_Context').doc('pc_info').get(),
                db.collection('Cloud_Context').doc('last_screenshot').get(),
                db.collection('Cloud_Engram').doc(String(userId)).get()
            ]);
            const ctx         = ctxSnap.exists ? ctxSnap.data() : { userName: 'Usuario', agentPersona: 'JARVIS' };
            const pcInfo      = pcSnap.exists  ? pcSnap.data()  : {};
            const cloudEngram = cloudEngramSnap.exists ? cloudEngramSnap.data() : {};
            // Screenshot reciente (menos de 5 minutos)
            const screenshotData = screenshotSnap.exists ? screenshotSnap.data() : null;
            const recentScreenshot = screenshotData && (Date.now() - screenshotData.timestamp) < 300_000
                ? screenshotData : null;

            // ── Cargar historial reciente de conversación (Sliding Window) ─────────
            const histSnap = await db
                .collection('conversations').doc(String(userId))
                .collection('messages')
                .orderBy('timestamp', 'desc')
                .limit(5)
                .get();

            const history = histSnap.docs.reverse().map(d => d.data());
            const historyText = history.length > 0
                ? '\n\n[Historial reciente]\n' + history.map(m => `${m.role === 'user' ? 'Usuario' : 'JARVIS'}: ${m.content}`).join('\n')
                : '';

            // ── Procesar con Gemini ───────────────────────────────────────────────
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

            // Determinar si el mensaje requiere contexto visual
            const visualKeywords = /pantalla|screenshot|captura|click|clic|cursor|ver|mirá|mira|dónde|donde|abrir|ventana|botón|boton|icono|ícono|posición|posicion|coordenada/i;
            const needsVision = !!(recentScreenshot?.base64 && visualKeywords.test(text));

            const pcHint = pcInfo.homeDir
                ? `\n\nPC conectada: usuario="${pcInfo.username}", home="${pcInfo.homeDir}", hostname="${pcInfo.hostname}". IMPORTANTE: Siempre usá rutas absolutas completas al llamar herramientas (ej: "${pcInfo.homeDir}\\Pictures\\foto.png"). Nunca uses {username}, ~, ni rutas relativas.`
                : '';

            const visionHint = needsVision
                ? `\n\nSe adjunta una captura de pantalla reciente de la PC. Analizá la imagen para identificar elementos de UI y determinar sus coordenadas exactas (x,y) antes de llamar a mouse_click. NUNCA adivines coordenadas — siempre basate en la imagen adjunta.`
                : `\n\nREGLA CRÍTICA: Si el usuario pide hacer click en algo, PRIMERO llamá a take_screenshot para ver el estado actual de la pantalla. NUNCA uses mouse_click con coordenadas adivinadas — siempre analizá la imagen primero.`;

            const calendarHint = `\n\nREGLA OBLIGATORIA — Google Calendar: SIEMPRE que el usuario pregunte por eventos, reuniones, agenda, qué tiene pendiente, o cualquier consulta de calendario, DEBÉS llamar a list_calendar_events. NUNCA respondas que no tenés acceso al calendario — tenés la herramienta list_calendar_events y DEBÉS usarla. El calendario vive en la PC del usuario (La Garra lo ejecuta).`;

            // Cloud Engram — memoria no sensible siempre disponible
            const engramEntries = Object.entries(cloudEngram).filter(([k]) => k !== '_updated');
            const engramHint = engramEntries.length > 0
                ? '\n\n[Cloud Engram — lo que sabés del usuario]\n' +
                  engramEntries.map(([k, v]) => `- ${k}: ${typeof v === 'object' ? v.value : v}`).join('\n')
                : '';

            const systemPrompt = `Eres ${ctx.agentPersona || 'JARVIS'}, el asistente personal de ${ctx.userName || 'tu usuario'}.
Respondés desde la nube vía Telegram. Tenés acceso a herramientas que ejecutan operaciones en la PC del usuario (con su aprobación previa).
Si el usuario pide acceso a archivos o memoria, usa las herramientas disponibles.
Si no necesitás herramientas, respondé directamente.${pcHint}${visionHint}${calendarHint}${engramHint}${historyText}`;

            const chatSession = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: { systemInstruction: systemPrompt, tools: TOOLS, temperature: 0.2 }
            });

            // Adjuntar screenshot solo si el mensaje tiene contexto visual relevante
            const geminiMessage = needsVision
                ? [{ text }, { inlineData: { mimeType: recentScreenshot.mimeType || 'image/png', data: recentScreenshot.base64 } }]
                : text;

            let geminiResponse;
            try {
                geminiResponse = await chatSession.sendMessage({ message: geminiMessage });
            } catch (err) {
                console.error('[Brain] Error Gemini:', err.message);
                await tg(token, 'sendMessage', { chat_id: chatId, text: `⚠️ Error de API: ${err.message}` });
                return res.status(200).send('OK');
            }

            // ── Guardar mensaje del usuario en historial ──────────────────────────
            const convRef = db.collection('conversations').doc(String(userId)).collection('messages');
            await convRef.add({ role: 'user', content: text, timestamp: Timestamp.now() });

            // ── Manejar respuesta ─────────────────────────────────────────────────
            // ── Herramientas cloud (sin La Garra — ejecutadas aquí mismo) ─────────
            const CLOUD_TOOLS = new Set(['set_reminder', 'list_reminders', 'delete_reminder', 'save_cloud_memory', 'delete_cloud_memory', 'list_calendar_events', 'add_calendar_event']);

            if (geminiResponse.functionCalls?.length > 0) {
                const call = geminiResponse.functionCalls[0];

                if (CLOUD_TOOLS.has(call.name)) {
                    const remRef = db.collection('Reminders').doc(String(userId)).collection('items');
                    let cloudResult = '';

                    if (call.name === 'set_reminder') {
                        await remRef.add({
                            message:   call.args.message,
                            datetime:  call.args.datetime || null,
                            repeat:    call.args.repeat   || null,
                            createdAt: Timestamp.now(),
                            active:    true
                        });
                        cloudResult = `✅ Recordatorio guardado: "${call.args.message}"` +
                            (call.args.datetime ? ` para el ${call.args.datetime}` : '');
                    }

                    if (call.name === 'list_reminders') {
                        const snap = await remRef.where('active', '==', true).orderBy('createdAt').get();
                        if (snap.empty) {
                            cloudResult = 'No tenés recordatorios activos.';
                        } else {
                            const lines = snap.docs.map((d, i) => {
                                const r = d.data();
                                return `${i + 1}. ${r.message}${r.datetime ? ` — ${r.datetime}` : ''}`;
                            }).join('\n');
                            cloudResult = `📋 *Recordatorios activos:*\n${lines}`;
                        }
                    }

                    if (call.name === 'delete_reminder') {
                        const snap = await remRef.where('active', '==', true).orderBy('createdAt').get();
                        const idx  = (call.args.index || 1) - 1;
                        if (idx >= 0 && idx < snap.docs.length) {
                            await snap.docs[idx].ref.update({ active: false });
                            cloudResult = '🗑️ Recordatorio eliminado.';
                        } else {
                            cloudResult = '❌ Índice inválido. Usá list_reminders para ver los disponibles.';
                        }
                    }

                    // ── Cloud Engram ──────────────────────────────────────────────
                    if (call.name === 'save_cloud_memory') {
                        const engramRef = db.collection('Cloud_Engram').doc(String(userId));
                        await engramRef.set({
                            [call.args.key]: { value: call.args.value, category: call.args.category },
                            _updated: Timestamp.now()
                        }, { merge: true });
                        cloudResult = `✅ Recuerdo guardado: \`${call.args.key}\` → "${call.args.value}"`;
                    }

                    if (call.name === 'delete_cloud_memory') {
                        const { FieldValue } = await import('firebase-admin/firestore');
                        const engramRef = db.collection('Cloud_Engram').doc(String(userId));
                        await engramRef.update({ [call.args.key]: FieldValue.delete() });
                        cloudResult = `🗑️ Recuerdo \`${call.args.key}\` eliminado del Cloud Engram.`;
                    }

                    // ── Google Calendar (cloud-side, sin La Garra) ─────────────────
                    if (call.name === 'list_calendar_events') {
                        try {
                            const cal = await getCalendarClient();
                            const now = new Date();
                            const maxDate = new Date();
                            maxDate.setDate(maxDate.getDate() + (call.args.days || 7));
                            const res = await cal.events.list({
                                calendarId: 'primary',
                                timeMin: now.toISOString(),
                                timeMax: maxDate.toISOString(),
                                maxResults: 20,
                                singleEvents: true,
                                orderBy: 'startTime'
                            });
                            const events = res.data.items || [];
                            if (events.length === 0) {
                                cloudResult = '📅 No tenés eventos próximos.';
                            } else {
                                const lines = events.map(e => {
                                    const start = e.start.dateTime
                                        ? new Date(e.start.dateTime).toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                                        : e.start.date;
                                    return `• *${e.summary}* — ${start}`;
                                });
                                cloudResult = `📅 *Próximos eventos:*\n${lines.join('\n')}`;
                            }
                        } catch (e) {
                            cloudResult = `❌ Error leyendo calendario: ${e.message}`;
                        }
                    }

                    if (call.name === 'add_calendar_event') {
                        try {
                            const cal = await getCalendarClient();
                            const endDateTime = call.args.end ||
                                new Date(new Date(call.args.start).getTime() + 60 * 60 * 1000).toISOString();
                            const event = {
                                summary: call.args.title,
                                description: call.args.description || '',
                                location: call.args.location || '',
                                start: { dateTime: call.args.start, timeZone: 'America/Argentina/Mendoza' },
                                end:   { dateTime: endDateTime,      timeZone: 'America/Argentina/Mendoza' }
                            };
                            const res = await cal.events.insert({ calendarId: 'primary', requestBody: event });
                            cloudResult = `✅ Evento creado: *${res.data.summary}* — ${new Date(res.data.start.dateTime).toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}`;
                        } catch (e) {
                            cloudResult = `❌ Error creando evento: ${e.message}`;
                        }
                    }

                    await tg(token, 'sendMessage', { chat_id: chatId, text: cloudResult, parse_mode: 'Markdown' });
                    await convRef.add({ role: 'assistant', content: cloudResult, timestamp: Timestamp.now() });

                } else {
                    // ── Herramienta de PC → crear job para La Garra ──────────────
                    const jobRef = await db.collection('PC_Jobs').add({
                        chatId:    chatId,
                        userId:    String(userId),
                        tool:      call.name,
                        params:    call.args || {},
                        status:    'pending',
                        createdAt: Timestamp.now(),
                        expiresAt: Timestamp.fromMillis(Date.now() + 120_000)
                    });

                    await convRef.add({
                        role:      'assistant',
                        content:   `[Solicitó herramienta: ${call.name} — Job: ${jobRef.id}]`,
                        timestamp: Timestamp.now()
                    });

                    await tg(token, 'sendMessage', {
                        chat_id:    chatId,
                        text:       `⏳ *JARVIS necesita acceso a tu PC*\n\nHerramienta: \`${call.name}\`\n\nTu dispositivo local enviará los botones de aprobación en un momento.`,
                        parse_mode: 'Markdown'
                    });
                }

            } else {
                const replyText = geminiResponse.text || '(sin respuesta)';
                await tg(token, 'sendMessage', { chat_id: chatId, text: replyText });
                await convRef.add({
                    role:      'assistant',
                    content:   replyText,
                    timestamp: Timestamp.now()
                });
            }

        } catch (err) {
            console.error('[Brain] Error no manejado:', err.message);
        }

        res.status(200).send('OK');
    }
);

// ── Briefing Matutino — Cloud Scheduler ──────────────────────────────────────
const WEATHER_ICONS = {
    Clear: '☀️', Clouds: '☁️', Rain: '🌧️', Drizzle: '🌦️',
    Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️', Haze: '🌫️'
};

// ── Helpers proactividad ──────────────────────────────────────────────────────

/** Obtiene el FCM token del dispositivo Android más recientemente registrado */
async function getActiveFcmToken(db) {
    try {
        const snap = await db.collection('AndroidDevices').limit(1).get();
        if (snap.empty) return null;
        return snap.docs[0].id;
    } catch (e) {
        console.error('[FCM] Error obteniendo token:', e.message);
        return null;
    }
}

/**
 * Obtiene el documento HealthData más reciente junto con el FCM token que lo escribió.
 * Resuelve el problema de token mismatch: HealthData puede haber sido escrito con un
 * token diferente al que está en AndroidDevices si el token rotó entre sesiones.
 * @returns {{ token: string, data: object } | null}
 */
async function getLatestHealthData(db) {
    try {
        const snap = await db.collection('HealthData')
            .orderBy('last_sync', 'desc')
            .limit(1)
            .get();
        if (snap.empty) return null;
        const doc = snap.docs[0];
        return { token: doc.id, data: doc.data() };
    } catch (e) {
        console.error('[Health] Error obteniendo datos de salud:', e.message);
        return null;
    }
}

/** Envía push notification al dispositivo Android (llega también al reloj vía Mi Fitness) */
async function sendFcmPush(fcmToken, title, body) {
    const { getMessaging } = await import('firebase-admin/messaging');
    await getMessaging().send({
        token: fcmToken,
        notification: { title, body },
        android: { priority: 'high' }
    });
}

/** Verifica si ya se envió una notificación con esta clave hoy */
async function wasAlreadyNotified(db, logKey) {
    const doc = await db.collection('ProactiveLog').doc(logKey).get();
    return doc.exists;
}

/** Registra que se envió la notificación para evitar duplicados */
async function markNotified(db, logKey) {
    await db.collection('ProactiveLog').doc(logKey).set({ sentAt: Timestamp.now() });
}

export const morningBriefing = onSchedule(
    {
        schedule:    '0 8 * * *',
        timeZone:    'America/Argentina/Mendoza',
        secrets:     [TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID, OPENWEATHER_API_KEY, GOOGLE_CALENDAR_REFRESH_TOKEN, GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET],
        region:      'us-central1',
        timeoutSeconds: 30
    },
    async () => {
        const token    = TELEGRAM_BOT_TOKEN.value();
        const chatId   = parseInt(TELEGRAM_ALLOWED_ID.value(), 10);
        const db       = getFirestore();

        // ── Clima en Mendoza ──────────────────────────────────────────────────
        let weatherBlock = '🌡️ _(clima no disponible)_';
        try {
            const res = await fetch(
                `https://api.openweathermap.org/data/2.5/weather?q=Mendoza,AR&appid=${OPENWEATHER_API_KEY.value()}&units=metric&lang=es`
            );
            const w = await res.json();
            const icon = WEATHER_ICONS[w.weather[0].main] || '🌡️';
            const desc = w.weather[0].description;
            const temp     = Math.round(w.main.temp);
            const feels    = Math.round(w.main.feels_like);
            const humidity = w.main.humidity;
            const wind     = Math.round((w.wind?.speed || 0) * 3.6);
            weatherBlock = `${icon} *${desc.charAt(0).toUpperCase() + desc.slice(1)}* — ${temp}°C (sensación ${feels}°C)\n💧 Humedad: ${humidity}% | 💨 Viento: ${wind} km/h`;
        } catch (e) {
            console.error('[Briefing] Error clima:', e.message);
        }

        // ── Recordatorios del día ─────────────────────────────────────────────
        let remindersBlock = '';
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const snap = await db
                .collection('Reminders').doc(String(chatId)).collection('items')
                .where('active', '==', true)
                .get();

            const todayReminders = snap.docs
                .map(d => d.data())
                .filter(r => {
                    if (!r.datetime) return false;
                    const d = new Date(r.datetime);
                    return d >= today && d < tomorrow;
                });

            if (todayReminders.length > 0) {
                const lines = todayReminders.map(r => `• ${r.message}`).join('\n');
                remindersBlock = `\n\n📋 *Recordatorios de hoy:*\n${lines}`;
            }
        } catch (e) {
            console.error('[Briefing] Error recordatorios:', e.message);
        }

        // ── Eventos del calendario hoy ────────────────────────────────────────
        let calendarBlock = '';
        try {
            const cal = await getCalendarClient();
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);
            const calRes = await cal.events.list({
                calendarId: 'primary',
                timeMin: todayStart.toISOString(),
                timeMax: todayEnd.toISOString(),
                maxResults: 10,
                singleEvents: true,
                orderBy: 'startTime',
                timeZone: 'America/Argentina/Mendoza'
            });
            const events = calRes.data.items || [];
            if (events.length > 0) {
                const lines = events.map(e => {
                    const start = e.start.dateTime
                        ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Mendoza', hour: '2-digit', minute: '2-digit' })
                        : 'Todo el día';
                    return `• ${start} — *${e.summary}*`;
                });
                calendarBlock = `\n\n📆 *Agenda de hoy:*\n${lines.join('\n')}`;
            }
        } catch (e) {
            console.error('[Briefing] Error calendario:', e.message);
        }

        // ── Sueño de anoche (desde Firestore HealthData) ─────────────────────
        let sleepBlock = '';
        try {
            const healthEntry = await getLatestHealthData(db);
            if (healthEntry) {
                const health = healthEntry.data;
                if (health.sleep_hours_last_night) {
                    const h = Math.floor(health.sleep_hours_last_night);
                    const m = Math.round((health.sleep_hours_last_night - h) * 60);
                    const quality = health.sleep_hours_last_night >= 7 ? 'bien descansado'
                                  : health.sleep_hours_last_night >= 5 ? 'sueño corto'
                                  : 'poco sueño, cuidate';
                    sleepBlock = `\n\n💤 *Sueño anoche:* ${h}h ${m}min — ${quality}`;
                }
            }
        } catch (e) {
            console.error('[Briefing] Error sueño:', e.message);
        }

        // ── Construir y enviar mensaje ────────────────────────────────────────
        const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Mendoza' }));
        const date = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        const dateCapitalized = date.charAt(0).toUpperCase() + date.slice(1);

        const msg = `🌅 *¡Buenos días, Sebastián!*\n\n📅 *${dateCapitalized}*\n\n🌦️ *Mendoza:*\n${weatherBlock}${sleepBlock}${calendarBlock}${remindersBlock}\n\n_JARVIS listo para lo que necesites._`;

        await tg(token, 'sendMessage', {
            chat_id:    chatId,
            text:       msg,
            parse_mode: 'Markdown'
        });

        console.log('[Briefing] Enviado correctamente.');
    }
);

// ── Proactividad: Pasos del día (19:00 Mendoza) ───────────────────────────────
export const proactiveSteps = onSchedule(
    {
        schedule:       '0 19 * * *',
        timeZone:       'America/Argentina/Mendoza',
        secrets:        [TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID],
        region:         'us-central1',
        timeoutSeconds: 30
    },
    async () => {
        const db     = getFirestore();
        const token  = TELEGRAM_BOT_TOKEN.value();
        const chatId = parseInt(TELEGRAM_ALLOWED_ID.value(), 10);
        const today  = new Date().toISOString().split('T')[0];
        const logKey = `steps_${today}`;

        if (await wasAlreadyNotified(db, logKey)) {
            console.log('[Steps] Ya notificado hoy.');
            return;
        }

        const healthEntry = await getLatestHealthData(db);
        if (!healthEntry) { console.log('[Steps] Sin datos de salud.'); return; }

        const fcmToken  = healthEntry.token;
        const health    = healthEntry.data;
        const steps     = health.steps_today || 0;
        const goal      = health.steps_goal  || 10000;
        const remaining = goal - steps;

        const msg = steps >= goal
            ? `Llegaste a tu meta: ${steps.toLocaleString('es-AR')} pasos hoy.`
            : `${steps.toLocaleString('es-AR')} pasos hoy. Te faltan ${remaining.toLocaleString('es-AR')} para la meta. ¿Salís un rato?`;

        await tg(token, 'sendMessage', { chat_id: chatId, text: msg });

        try { await sendFcmPush(fcmToken, 'JARVIS — Pasos', msg); }
        catch (e) { console.error('[Steps] Error FCM:', e.message); }

        await markNotified(db, logKey);
        console.log(`[Steps] Notificado: ${steps} pasos.`);
    }
);

// ── Proactividad: Recordatorio de calendario (cada 30 min, 07-22 Mendoza) ────
export const proactiveCalendar = onSchedule(
    {
        schedule:       '*/30 * * * *',
        timeZone:       'America/Argentina/Mendoza',
        secrets:        [TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID, GOOGLE_CALENDAR_REFRESH_TOKEN, GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET],
        region:         'us-central1',
        timeoutSeconds: 30
    },
    async () => {
        const now         = new Date();
        const mendozaHour = parseInt(now.toLocaleString('en-US', {
            timeZone: 'America/Argentina/Mendoza', hour: 'numeric', hour12: false
        }));

        // Ventana inteligente: solo avisar en horario razonable
        if (mendozaHour < 7 || mendozaHour >= 22) {
            console.log(`[Calendar] Fuera de ventana (${mendozaHour}hs Mendoza).`);
            return;
        }

        const db     = getFirestore();
        const token  = TELEGRAM_BOT_TOKEN.value();
        const chatId = parseInt(TELEGRAM_ALLOWED_ID.value(), 10);
        const today  = now.toISOString().split('T')[0];

        // Eventos que arrancan entre 30 y 90 minutos desde ahora
        const timeMin = new Date(now.getTime() + 30 * 60 * 1000);
        const timeMax = new Date(now.getTime() + 90 * 60 * 1000);

        let events = [];
        try {
            const cal    = await getCalendarClient();
            const calRes = await cal.events.list({
                calendarId:   'primary',
                timeMin:      timeMin.toISOString(),
                timeMax:      timeMax.toISOString(),
                maxResults:   5,
                singleEvents: true,
                orderBy:      'startTime'
            });
            events = calRes.data.items || [];
        } catch (e) {
            console.error('[Calendar] Error obteniendo eventos:', e.message);
            return;
        }

        const fcmToken = await getActiveFcmToken(db);

        for (const event of events) {
            const logKey = `calendar_${event.id}_${today}`;
            if (await wasAlreadyNotified(db, logKey)) continue;

            const startDate     = new Date(event.start.dateTime || event.start.date);
            const minutesUntil  = Math.round((startDate - now) / 60000);
            const startTime     = event.start.dateTime
                ? startDate.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Mendoza', hour: '2-digit', minute: '2-digit' })
                : 'Todo el día';

            const msg = `En ${minutesUntil} minutos: *${event.summary}* (${startTime})`;

            await tg(token, 'sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });

            if (fcmToken) {
                try { await sendFcmPush(fcmToken, 'JARVIS — Reunión próxima', `En ${minutesUntil} min: ${event.summary}`); }
                catch (e) { console.error('[Calendar] Error FCM:', e.message); }
            }

            await markNotified(db, logKey);
            console.log(`[Calendar] Recordatorio: ${event.summary} en ${minutesUntil} min.`);
        }
    }
);

// ── voiceWebhook: recibe audio del Android, procesa con Gemini, devuelve acción ──
// Arquitectura: Android → POST {audioBase64} → Gemini 2.5 Flash → {text, androidAction}
// El API key queda server-side. Android ejecuta la acción localmente.

const ANDROID_TOOLS = [{
    functionDeclarations: [
        {
            name: 'open_app',
            description: 'Abre una aplicación instalada en el teléfono de Sebastián',
            parameters: {
                type: 'object',
                properties: {
                    package_name: { type: 'string', description: 'Package name, ej: com.whatsapp, com.instagram.android, com.spotify.music' }
                },
                required: ['package_name']
            }
        },
        {
            name: 'send_whatsapp',
            description: 'Abre WhatsApp con el chat y el mensaje pre-escrito. IMPORTANTE: esto NO envía el mensaje automáticamente — abre WhatsApp con el mensaje listo para que el usuario toque Enviar. Responde siempre "WhatsApp abierto, revisá y tocá Enviar" y NUNCA digas "mensaje enviado".',
            parameters: {
                type: 'object',
                properties: {
                    phone:   { type: 'string', description: 'Número con código de país, ej: 5492615551234' },
                    message: { type: 'string', description: 'El texto del mensaje' }
                },
                required: ['phone', 'message']
            }
        },
        {
            name: 'send_sms',
            description: 'Abre la app de mensajes con número y texto listos para enviar',
            parameters: {
                type: 'object',
                properties: {
                    phone:   { type: 'string', description: 'Número de teléfono' },
                    message: { type: 'string', description: 'El texto del SMS' }
                },
                required: ['phone', 'message']
            }
        },
        {
            name: 'make_call',
            description: 'Abre el marcador del teléfono con el número listo para llamar',
            parameters: {
                type: 'object',
                properties: {
                    phone: { type: 'string', description: 'Número de teléfono' }
                },
                required: ['phone']
            }
        },
        {
            name: 'get_contacts',
            description: 'Busca contactos en la agenda del teléfono',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Nombre a buscar, vacío para todos' }
                },
                required: []
            }
        },
        {
            name: 'set_alarm',
            description: 'Configura una alarma en el reloj del teléfono',
            parameters: {
                type: 'object',
                properties: {
                    hour:   { type: 'integer', description: 'Hora en formato 24h (0-23)' },
                    minute: { type: 'integer', description: 'Minutos (0-59)' },
                    label:  { type: 'string',  description: 'Etiqueta opcional' }
                },
                required: ['hour', 'minute']
            }
        },
        {
            name: 'get_battery',
            description: 'Obtiene el nivel de batería del teléfono',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'list_apps',
            description: 'Lista las aplicaciones instaladas en el teléfono',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'open_camera',
            description: 'Abre la cámara del teléfono para tomar una foto o video',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'open_maps',
            description: 'Abre Google Maps para navegar a un lugar o buscar lugares cercanos. Usar navigate=true para indicaciones GPS, false para buscar.',
            parameters: {
                type: 'object',
                properties: {
                    query:    { type: 'string',  description: 'Lugar, dirección o búsqueda. Ej: "pizzería", "Hospital Central Mendoza", "farmacia cerca"' },
                    navigate: { type: 'boolean', description: 'true para navegación GPS, false para búsqueda en mapa' }
                },
                required: ['query']
            }
        },
        {
            name: 'music_control',
            description: 'Controla la música del teléfono. Para reproducir un artista o canción específica usa action=play con query. Para play/pause/siguiente no hace falta query.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'play, pause, next, prev, stop' },
                    query:  { type: 'string', description: 'Artista o canción para buscar en Spotify (solo con action=play)' }
                },
                required: ['action']
            }
        }
    ]
}];

export const voiceWebhook = onRequest(
    {
        region:         'us-central1',
        timeoutSeconds: 30,
        secrets:        [GEMINI_API_KEY]
    },
    async (req, res) => {
        if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

        const { audioBase64, toolName, toolResult, history: historyJson, conversationHistory } = req.body;
        const isFollowUp = !!toolName;
        if (!audioBase64 && !isFollowUp) { res.status(400).json({ error: 'Missing audioBase64' }); return; }

        try {
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

            const SYSTEM =
                'Eres JARVIS, asistente personal de Sebastián en Mendoza, Argentina. ' +
                'Recibes comandos de voz y respondes en español de forma breve y directa. ' +
                'REGLA CRÍTICA: Para CUALQUIER acción en el teléfono DEBES llamar la herramienta correspondiente. ' +
                'NUNCA digas que ejecutaste algo sin haber llamado primero la herramienta. ' +
                '\n\nFLUJO OBLIGATORIO PARA LLAMADAS POR NOMBRE:' +
                '\n1. Si piden llamar a alguien por nombre (ej: "llamá a Juan", "llamar a mamá"):' +
                '\n   - Primero llama get_contacts con el nombre para obtener el número.' +
                '\n   - Cuando recibas el resultado con el número, llama make_call con ese número.' +
                '\n   - NUNCA respondas con texto sin haber llamado make_call.' +
                '\n2. Si piden "abrir el marcador", "abrir llamadas" o "quiero llamar":' +
                '\n   - Llama make_call con phone="" para abrir el marcador vacío.' +
                '\n3. Si piden mandar WhatsApp a alguien por nombre:' +
                '\n   - Si el usuario especificó un mensaje: get_contacts para el número, luego send_whatsapp con ese número y el mensaje.' +
                '\n   - Si NO especificó qué decir: preguntá "¿qué le querés decir?" ANTES de llamar cualquier tool. No llames send_whatsapp con mensaje vacío.' +
                '\n\nCuando recibas el resultado de get_contacts:' +
                '\n- Si hay UN solo contacto: ejecuta inmediatamente la acción pedida (make_call o send_whatsapp) con ese número. No preguntes confirmación.' +
                '\n- Si hay MÚLTIPLES contactos: listalós brevemente y preguntá cuál. Cuando el usuario elija ("el primero", el nombre, etc), ejecutá la acción con ese número usando la herramienta correcta.' +
                '\n- NUNCA digas "mensaje enviado" — send_whatsapp solo abre WhatsApp con el mensaje listo para que el usuario toque Enviar. Siempre decí "listo, tocá Enviar".' +
                '\n\nMAPS: Para "llevame a X", "cómo llego a X", "indicaciones para X" → open_maps con navigate=true. ' +
                'Para "buscá hamburguesas", "farmacias cerca", "dónde hay X" → open_maps con navigate=false.' +
                '\n\nMÚSICA: Para "poné música de X", "poneme a X" → music_control action=play query="X". ' +
                'Para "pausá", "seguí", "siguiente", "anterior" → music_control con el action correspondiente sin query.';

            // Construir el historial de conversación
            const prevHistory = conversationHistory ? JSON.parse(conversationHistory) : [];

            let contents;
            if (isFollowUp) {
                // Follow-up: Android devuelve el resultado de una herramienta
                const toolHistory = JSON.parse(historyJson || '[]');
                contents = [
                    ...toolHistory,
                    { role: 'user', parts: [{ functionResponse: { name: toolName, response: { result: toolResult } } }] }
                ];
            } else {
                // Llamada inicial: incluir historial de conversación previo + audio nuevo
                contents = [
                    ...prevHistory,
                    { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audioBase64 } }] }
                ];
            }

            // ── Turno 1: detectar si Gemini quiere llamar una función ────────
            const r1 = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents,
                config: { systemInstruction: SYSTEM, tools: ANDROID_TOOLS }
            });

            console.log('[Voice] R1 parts:', JSON.stringify(r1.candidates?.[0]?.content?.parts?.map(p => Object.keys(p))));

            const parts1 = r1.candidates?.[0]?.content?.parts || [];
            let text         = '';
            let androidAction = null;
            let funcCall      = null;

            for (const part of parts1) {
                if (part.text)         text     = part.text;
                if (part.functionCall) funcCall = part.functionCall;
            }

            // Historial acumulado para follow-ups
            const modelParts1 = r1.candidates?.[0]?.content?.parts || [];
            const updatedHistory = [
                ...contents,
                { role: 'model', parts: modelParts1 }
            ];

            if (funcCall) {
                androidAction = { tool: funcCall.name, params: funcCall.args || {} };

                // Para tools que NO necesitan resultado del teléfono (open_app, set_alarm, etc.),
                // hacemos Turno 2 inmediatamente con "ejecutado" para obtener confirmación verbal.
                // Para get_contacts, el resultado real viene del teléfono vía follow-up.
                const needsPhoneResult = ['get_contacts', 'list_apps', 'get_battery'].includes(funcCall.name);

                if (!needsPhoneResult) {
                    const r2 = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [
                            ...contents,
                            { role: 'model', parts: [{ functionCall: funcCall }] },
                            { role: 'user', parts: [{ functionResponse: { name: funcCall.name, response: { result: 'ejecutado correctamente' } } }] }
                        ],
                        config: { systemInstruction: SYSTEM }
                    });
                    text = r2.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
                }
                // Si needsPhoneResult=true: el teléfono ejecuta la tool, recibe el resultado,
                // y hace un follow-up POST con {toolName, toolResult, history}
            }

            console.log(`[Voice] funcCall=${funcCall?.name} text="${text}" action=${JSON.stringify(androidAction)}`);

            // Historial para follow-up de tools dentro del mismo comando
            const historyOut = JSON.stringify(updatedHistory.map(c => ({
                role: c.role,
                parts: c.parts.map(p => p.functionCall ? { functionCall: p.functionCall }
                                   : p.functionResponse ? { functionResponse: p.functionResponse }
                                   : { text: p.text || '' })
            })));

            // conversationHistory para memoria cross-comando: solo pares user/model text.
            // Reemplaza el audio con placeholder y descarta function calls internos.
            // Esto garantiza que Gemini siempre recibe un historial válido (user → model → user → ...).
            const newPair = text ? [
                { role: 'user',  parts: [{ text: '[comando de voz]' }] },
                { role: 'model', parts: [{ text }] }
            ] : [];
            const lightHistory = [...prevHistory, ...newPair].slice(-6); // últimas 3 conversaciones

            res.json({
                text,
                androidAction,
                history: historyOut,
                conversationHistory: JSON.stringify(lightHistory)
            });

        } catch (e) {
            console.error('[Voice] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    }
);
