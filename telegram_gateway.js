/**
 * telegram_gateway.js
 * Gateway móvil de JARVIS via Telegram Bot.
 * Permite acceder a JARVIS desde cualquier dispositivo (celular, tablet, otra PC)
 * usando la app de Telegram. Enruta los mensajes al Brain existente y adapta
 * la Aduana (HITL) a confirmaciones por botones inline de Telegram.
 * 
 * Prerequisito: TELEGRAM_BOT_TOKEN en .env (obtener de @BotFather en Telegram)
 * Prerequisito: TELEGRAM_ALLOWED_USER en .env (tu username de Telegram sin @)
 */
import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = process.env.TELEGRAM_ALLOWED_ID
    ? parseInt(process.env.TELEGRAM_ALLOWED_ID, 10)
    : null; // Si está vacío, acepta a cualquiera (modo configuración)

class TelegramGateway {
    constructor(brain, tts) {
        this.brain = brain;
        this.tts = tts;
        this.bot = null;
        this.pendingApprovals = new Map(); // Para el HITL inline
    }

    start() {
        if (!BOT_TOKEN) {
            console.log('\n⚠️ [Telegram Gateway]: TELEGRAM_BOT_TOKEN no configurado. Gateway móvil inactivo.');
            return;
        }

        this.bot = new Telegraf(BOT_TOKEN);

        // ── Seguridad: Rechazar cualquier usuario que no sea el propietario ──
        this.bot.use((ctx, next) => {
            const userId = ctx.from?.id;

            // Primera vez: mostrar ID en consola para configuración
            if (!ALLOWED_ID) {
                console.log(`\n🔑 [Telegram Gateway]: Mensaje de userId=${userId}. Para activar seguridad, agrega TELEGRAM_ALLOWED_ID=${userId} en tu .env`);
            } else if (userId !== ALLOWED_ID) {
                console.warn(`\n🚨 [Telegram Gateway]: Acceso bloqueado para userId=${userId}`);
                return ctx.reply('🚫 Acceso denegado. Este es un asistente privado.');
            }
            return next();
        });

        // ── Comando /start ─────────────────────────────────────────────────────
        this.bot.command('start', (ctx) => {
            ctx.reply(
                `🤖 *JARVIS activado en Telegram*\n\nEscribime cualquier mensaje y te respondo.\n\n` +
                `Comandos disponibles:\n` +
                `/start - Este mensaje\n` +
                `/estado - Estado del sistema`,
                { parse_mode: 'Markdown' }
            );
        });

        // ── Comando /estado ────────────────────────────────────────────────────
        this.bot.command('estado', async (ctx) => {
            const memSummary = this.brain.memoryService
                ? await this.brain.memoryService.getEngram()
                : 'Memoria no disponible';
            ctx.reply(
                `🟢 *JARVIS online*\n\n` +
                `📅 ${new Date().toLocaleString('es-AR')}\n` +
                `🧠 Sesión activa en PC`,
                { parse_mode: 'Markdown' }
            );
        });

        // ── Mensajes de texto ──────────────────────────────────────────────────
        this.bot.on('text', async (ctx) => {
            const userMessage = ctx.message.text;
            if (userMessage.startsWith('/')) return; // Ignorar comandos no definidos

            console.log(`\n📱 [Telegram de @${ctx.from.username}]: ${userMessage}`);

            // Indicador de "escribiendo..."
            await ctx.sendChatAction('typing');

            try {
                const response = await this.brain.processInput(userMessage, 0, null, (toolRequest) => {
                    // Callback para el HITL de la Aduana vía Telegram
                    return this._askApprovalViaTelegram(ctx, toolRequest);
                });

                if (response.type === 'chat_response') {
                    // Responder texto en Telegram
                    await ctx.reply(`${response.text}`);

                    // También hablar en la PC si está en casa (TTS local)
                    this.tts.speak(response.text);
                }
            } catch (err) {
                console.error('[Telegram Gateway Error]:', err.message);
                await ctx.reply(`⚠️ Error procesando tu solicitud: ${err.message}`);
            }
        });

        // ── Mensajes de audio/voz (notas de voz de Telegram) ──────────────────
        this.bot.on('voice', async (ctx) => {
            await ctx.sendChatAction('typing');
            await ctx.reply('🎙️ Recibí tu nota de voz. Procesando... (próximamente transcribo audio de Telegram también)');
        });

        // ── Manejo de callback de botones inline (Aduana HITL) ─────────────────
        this.bot.on('callback_query', (ctx) => {
            const [action, approvalId] = ctx.callbackQuery.data.split(':');
            const resolver = this.pendingApprovals.get(approvalId);

            if (resolver) {
                this.pendingApprovals.delete(approvalId);
                ctx.answerCbQuery();

                if (action === 'approve') {
                    ctx.editMessageText('✅ *Aprobado.* Ejecutando...\n\n' + ctx.callbackQuery.message.text, { parse_mode: 'Markdown' });
                    resolver(true);
                } else {
                    ctx.editMessageText('🛑 *Denegado.* El agente recalculará.\n\n' + ctx.callbackQuery.message.text, { parse_mode: 'Markdown' });
                    resolver(false);
                }
            }
        });

        // Lanzar el bot en modo polling (long-polling, no requiere servidor)
        this.bot.launch();
        console.log(`\n📱 [Telegram Gateway]: Bot activo. Abrilo en Telegram y escribile!`);

        // Graceful shutdown
        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    // Reemplaza el prompt de teclado de la Aduana con botones inline de Telegram
    async _askApprovalViaTelegram(ctx, toolRequest) {
        const approvalId = Date.now().toString();

        const message =
            `⚠️ *JARVIS solicita permiso*\n\n` +
            `🔧 Herramienta: \`${toolRequest.tool}\`\n` +
            `📋 Parámetros: \`${JSON.stringify(toolRequest.params || {})}\`\n\n` +
            `¿Autorizás esta acción?`;

        await ctx.reply(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('✅ Aprobar', `approve:${approvalId}`),
                Markup.button.callback('🛑 Denegar', `deny:${approvalId}`)
            ])
        });

        // Retorna una Promise que resuelve cuando el usuario toca el botón
        return new Promise((resolve) => {
            this.pendingApprovals.set(approvalId, resolve);
            // Timeout: si no responde en 60s, denegar automáticamente
            setTimeout(() => {
                if (this.pendingApprovals.has(approvalId)) {
                    this.pendingApprovals.delete(approvalId);
                    ctx.reply('⏱️ Tiempo de aprobación expirado. Acción denegada automáticamente.');
                    resolve(false);
                }
            }, 60000);
        });
    }

    stop() {
        if (this.bot) {
            this.bot.stop();
            console.log('\n📵 [Telegram Gateway]: Bot detenido.');
        }
    }
}

export default TelegramGateway;
