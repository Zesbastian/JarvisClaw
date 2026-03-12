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
        {
            name: 'list_directory',
            description: 'Lista los archivos y carpetas en el directorio sandbox de la PC del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    path: { type: 'STRING', description: 'Ruta dentro del sandbox (opcional)' }
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
                    path:       { type: 'STRING',  description: 'Ruta del archivo' },
                    start_line: { type: 'INTEGER', description: 'Línea inicial (paginación)' },
                    end_line:   { type: 'INTEGER', description: 'Línea final (paginación)' }
                },
                required: ['path']
            }
        },
        {
            name: 'save_memory',
            description: 'Guarda un recuerdo permanente en el Engram local del usuario.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    content:  { type: 'STRING', description: 'Contenido del recuerdo' },
                    category: { type: 'STRING', description: 'Categoría (identity, preference, rule, context)' }
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
            const ctxSnap = await db.collection('Cloud_Context').doc(String(userId)).get();
            const ctx = ctxSnap.exists
                ? ctxSnap.data()
                : { userName: 'Usuario', agentPersona: 'JARVIS' };

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

            const systemPrompt = `Eres ${ctx.agentPersona || 'JARVIS'}, el asistente personal de ${ctx.userName || 'tu usuario'}.
Respondés desde la nube vía Telegram. Tenés acceso a herramientas que ejecutan operaciones en la PC del usuario (con su aprobación previa).
Si el usuario pide acceso a archivos o memoria, usa las herramientas disponibles.
Si no necesitás herramientas, respondé directamente.${historyText}`;

            const chatSession = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: { systemInstruction: systemPrompt, tools: TOOLS, temperature: 0.2 }
            });

            let geminiResponse;
            try {
                geminiResponse = await chatSession.sendMessage({ message: text });
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
