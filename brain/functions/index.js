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
const GEMINI_API_KEY       = defineSecret('GEMINI_API_KEY');
const TELEGRAM_BOT_TOKEN   = defineSecret('TELEGRAM_BOT_TOKEN');
const TELEGRAM_ALLOWED_ID  = defineSecret('TELEGRAM_ALLOWED_ID');
const OPENWEATHER_API_KEY  = defineSecret('OPENWEATHER_API_KEY');

initializeApp();

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
        // ── Memoria cifrada ─────────────────────────────────────────────────
        {
            name: 'save_memory',
            description: 'Guarda un recuerdo permanente en el Engram local cifrado del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    content:  { type: 'STRING', description: 'Contenido del recuerdo' },
                    category: { type: 'STRING', description: 'Categoría: identity, preference, rule, context' }
                },
                required: ['content', 'category']
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
        secrets: [GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID],
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
            const [ctxSnap, pcSnap, screenshotSnap] = await Promise.all([
                db.collection('Cloud_Context').doc(String(userId)).get(),
                db.collection('Cloud_Context').doc('pc_info').get(),
                db.collection('Cloud_Context').doc('last_screenshot').get()
            ]);
            const ctx    = ctxSnap.exists ? ctxSnap.data() : { userName: 'Usuario', agentPersona: 'JARVIS' };
            const pcInfo = pcSnap.exists  ? pcSnap.data()  : {};
            // Screenshot reciente (menos de 5 minutos)
            const screenshotData = screenshotSnap.exists ? screenshotSnap.data() : null;
            const recentScreenshot = screenshotData && (Date.now() - screenshotData.timestamp) < 300_000
                ? screenshotData : null;

            // ── Cargar historial reciente de conversación (Sliding Window) ─────────
            const histSnap = await db
                .collection('conversations').doc(String(userId))
                .collection('messages')
                .orderBy('timestamp', 'desc')
                .limit(10)
                .get();

            const history = histSnap.docs.reverse().map(d => d.data());
            const historyText = history.length > 0
                ? '\n\n[Historial reciente]\n' + history.map(m => `${m.role === 'user' ? 'Usuario' : 'JARVIS'}: ${m.content}`).join('\n')
                : '';

            // ── Procesar con Gemini ───────────────────────────────────────────────
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() });

            const pcHint = pcInfo.homeDir
                ? `\n\nPC conectada: usuario="${pcInfo.username}", home="${pcInfo.homeDir}", hostname="${pcInfo.hostname}". IMPORTANTE: Siempre usá rutas absolutas completas al llamar herramientas (ej: "${pcInfo.homeDir}\\Pictures\\foto.png"). Nunca uses {username}, ~, ni rutas relativas.`
                : '';

            const visionHint = recentScreenshot
                ? `\n\nSe adjunta una captura de pantalla reciente de la PC. Analizá la imagen para identificar elementos de UI y determinar sus coordenadas exactas (x,y) antes de llamar a mouse_click. NUNCA adivines coordenadas — siempre basate en la imagen adjunta.`
                : `\n\nREGLA CRÍTICA: Si el usuario pide hacer click en algo, PRIMERO llamá a take_screenshot para ver el estado actual de la pantalla. NUNCA uses mouse_click con coordenadas adivinadas — siempre analizá la imagen primero.`;

            const systemPrompt = `Eres ${ctx.agentPersona || 'JARVIS'}, el asistente personal de ${ctx.userName || 'tu usuario'}.
Respondés desde la nube vía Telegram. Tenés acceso a herramientas que ejecutan operaciones en la PC del usuario (con su aprobación previa).
Si el usuario pide acceso a archivos o memoria, usa las herramientas disponibles.
Si no necesitás herramientas, respondé directamente.${pcHint}${visionHint}${historyText}`;

            const chatSession = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: { systemInstruction: systemPrompt, tools: TOOLS, temperature: 0.2 }
            });

            // Si hay screenshot reciente, enviarlo como imagen inline para que Gemini lo analice
            const geminiMessage = recentScreenshot?.base64
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
            const CLOUD_TOOLS = new Set(['set_reminder', 'list_reminders', 'delete_reminder']);

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

export const morningBriefing = onSchedule(
    {
        schedule:    '0 8 * * *',
        timeZone:    'America/Argentina/Mendoza',
        secrets:     [TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_ID, OPENWEATHER_API_KEY],
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

        // ── Construir y enviar mensaje ────────────────────────────────────────
        const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Mendoza' }));
        const date = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        const dateCapitalized = date.charAt(0).toUpperCase() + date.slice(1);

        const msg = `🌅 *¡Buenos días, Sebastián!*\n\n📅 *${dateCapitalized}*\n\n🌦️ *Mendoza:*\n${weatherBlock}${remindersBlock}\n\n_JARVIS listo para lo que necesites._`;

        await tg(token, 'sendMessage', {
            chat_id:    chatId,
            text:       msg,
            parse_mode: 'Markdown'
        });

        console.log('[Briefing] Enviado correctamente.');
    }
);
