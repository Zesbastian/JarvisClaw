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
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import { defineSecret } from 'firebase-functions/params';

// ── Secretos (configurar con: firebase functions:secrets:set NOMBRE) ──────────
const GEMINI_API_KEY      = defineSecret('GEMINI_API_KEY');
const TELEGRAM_BOT_TOKEN  = defineSecret('TELEGRAM_BOT_TOKEN');
const TELEGRAM_ALLOWED_ID = defineSecret('TELEGRAM_ALLOWED_ID');

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
                ? `\n\nSe adjunta una captura de pantalla reciente de la PC (${recentScreenshot.dimensions}). Podés analizarla para identificar elementos, determinar coordenadas (x,y) y llamar a mouse_click sin pedirle las coordenadas al usuario.`
                : '';

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
            if (geminiResponse.functionCalls?.length > 0) {
                const call = geminiResponse.functionCalls[0];

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
