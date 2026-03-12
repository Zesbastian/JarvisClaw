/**
 * garra.js — La Garra (Nodo Local)
 *
 * Responsabilidades:
 *  1. Conectarse a Firestore via Firebase Admin SDK
 *  2. Escuchar PC_Jobs con status "pending" → enviar botones Aduana a Telegram
 *  3. Escuchar PC_Jobs con status "approved" → ejecutar herramienta → enviar resultado
 *  4. Preservar Conciencia (sandbox check) antes de cualquier ejecución
 *
 * Este script NO arranca un polling de Telegram.
 * El Brain (Cloud Function) maneja todo el tráfico de Telegram.
 * La Garra solo ENVÍA mensajes via bot.telegram.* (sin escuchar).
 */

import 'dotenv/config';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs/promises';
import path from 'path';

// ── Inicializar Firebase Admin ────────────────────────────────────────────────
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccount.json';
let serviceAccount;
try {
    serviceAccount = JSON.parse(await fs.readFile(serviceAccountPath, 'utf8'));
} catch {
    console.error('❌ [La Garra]: No se encontró serviceAccount.json. Descargalo de Firebase Console → Configuración → Cuentas de servicio.');
    process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Telegram (solo para ENVIAR — sin polling) ─────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Sandbox ───────────────────────────────────────────────────────────────────
const SANDBOX_DIR      = path.resolve(process.cwd(), 'SecureClaw_Sandbox');
const FORBIDDEN_TOOLS  = ['delete_system_file', 'format_drive'];

// ── Conciencia: filtro automático antes de la Aduana ─────────────────────────
function evaluateConscience(tool, params) {
    if (FORBIDDEN_TOOLS.includes(tool)) {
        return { approved: false, reason: `Herramienta prohibida: ${tool}` };
    }
    if (params?.path) {
        const requested = path.resolve(params.path);
        if (!requested.startsWith(SANDBOX_DIR)) {
            return { approved: false, reason: `Sandbox violation: ${requested}` };
        }
    }
    return { approved: true };
}

// ── Ejecutar herramienta aprobada ─────────────────────────────────────────────
async function executeTool(tool, params) {
    const targetPath = params?.path ? path.resolve(params.path) : SANDBOX_DIR;

    if (tool === 'list_directory') {
        const files = await fs.readdir(targetPath);
        return files.length > 0
            ? `📁 *${targetPath}*\n\n${files.map(f => `• ${f}`).join('\n')}`
            : `📁 *${targetPath}*\n\n_(directorio vacío)_`;
    }

    if (tool === 'read_file') {
        const content = await fs.readFile(targetPath, 'utf8');
        const lines   = content.split('\n');
        const start   = params.start_line ? Math.max(0, params.start_line - 1) : 0;
        const end     = params.end_line   ? params.end_line : Math.min(lines.length, 100);
        const slice   = lines.slice(start, end).join('\n');
        const header  = lines.length > 100
            ? `[Mostrando líneas ${start + 1}-${end} de ${lines.length}]\n`
            : '';
        return header + '```\n' + slice + '\n```';
    }

    if (tool === 'save_memory') {
        // Importar MemoryService local para guardar en el Engram cifrado
        const { MemoryService } = await import('./memory.js');
        const mem = new MemoryService();
        await mem.init();
        await mem.addMemory(params.content, params.category);
        return `✅ Recuerdo guardado en Engram: [${params.category}] ${params.content}`;
    }

    return `⚠️ Herramienta desconocida: ${tool}`;
}

// ── Procesar un PC_Job ────────────────────────────────────────────────────────
async function processJob(jobId, job) {
    console.log(`\n📥 [La Garra]: Nuevo job recibido — ${job.tool} (${jobId})`);

    const jobRef = db.collection('PC_Jobs').doc(jobId);

    // Marcar como "procesando" para evitar doble ejecución
    await jobRef.update({ status: 'processing' });

    // ── Capa 1: Conciencia ────────────────────────────────────────────────────
    const conscience = evaluateConscience(job.tool, job.params);

    if (!conscience.approved) {
        console.log(`🛑 [Conciencia]: Bloqueado — ${conscience.reason}`);
        await bot.telegram.sendMessage(
            job.chatId,
            `🛑 *Conciencia bloqueó la acción automáticamente*\n\n_Razón: ${conscience.reason}_`,
            { parse_mode: 'Markdown' }
        );
        await jobRef.update({ status: 'blocked', result: conscience.reason });
        return;
    }

    // ── Capa 2: Aduana HITL — enviar botones al celular ───────────────────────
    console.log(`🛡️ [Aduana]: Enviando solicitud de aprobación a Telegram...`);

    const paramsText = JSON.stringify(job.params || {}, null, 2);
    const aduanaMsg  = await bot.telegram.sendMessage(
        job.chatId,
        `⚠️ *JARVIS solicita permiso*\n\n🔧 Herramienta: \`${job.tool}\`\n📋 Parámetros:\n\`\`\`\n${paramsText}\n\`\`\`\n¿Autorizás esta acción?`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('✅ Aprobar', `approve:${jobId}`),
                Markup.button.callback('🛑 Denegar', `deny:${jobId}`)
            ])
        }
    );

    // ── Esperar decisión del usuario (via Firestore onSnapshot) ──────────────
    await new Promise((resolve) => {
        const unsubscribe = jobRef.onSnapshot((snap) => {
            const data = snap.data();
            if (data?.status === 'approved' || data?.status === 'denied') {
                unsubscribe();
                resolve(data.status);
            }
        });

        // Timeout: 120 segundos sin respuesta → denegar automáticamente
        setTimeout(async () => {
            unsubscribe();
            await jobRef.update({ status: 'denied', result: 'Timeout — sin respuesta del usuario.' });
            await bot.telegram.sendMessage(job.chatId, '⏱️ Tiempo expirado. Acción denegada automáticamente.');
            resolve('timeout');
        }, 120_000);
    });

    // Leer estado actualizado
    const updatedJob = (await jobRef.get()).data();

    if (updatedJob.status === 'denied') {
        console.log(`🛑 [Aduana]: Denegado por el usuario.`);
        await jobRef.update({ status: 'done' });
        return;
    }

    // ── Ejecutar herramienta aprobada ─────────────────────────────────────────
    console.log(`✅ [La Garra]: Ejecutando ${job.tool}...`);
    let result;
    try {
        result = await executeTool(job.tool, job.params);
    } catch (err) {
        result = `❌ Error ejecutando ${job.tool}: ${err.message}`;
    }

    // ── Enviar resultado al usuario via Telegram ──────────────────────────────
    await bot.telegram.sendMessage(job.chatId, result, { parse_mode: 'Markdown' });

    // ── Marcar job como completado ────────────────────────────────────────────
    await jobRef.update({ status: 'done', result: result.substring(0, 500) });
    console.log(`✅ [La Garra]: Job ${jobId} completado.`);
}

// ── Escuchar PC_Jobs nuevos en Firestore ──────────────────────────────────────
console.log('🐾 [La Garra]: Conectando a Firestore...');

db.collection('PC_Jobs')
    .where('status', '==', 'pending')
    .onSnapshot(
        (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const job   = change.doc.data();
                    const jobId = change.doc.id;

                    // Ignorar jobs expirados
                    if (job.expiresAt && job.expiresAt.toMillis() < Date.now()) {
                        console.log(`⏭️ [La Garra]: Job ${jobId} expirado, ignorando.`);
                        change.doc.ref.update({ status: 'expired' });
                        return;
                    }

                    processJob(jobId, job).catch(err => {
                        console.error(`❌ [La Garra]: Error procesando job ${jobId}:`, err.message);
                    });
                }
            });
        },
        (err) => {
            console.error('❌ [La Garra]: Error en listener de Firestore:', err.message);
        }
    );

console.log('🐾 [La Garra]: Escuchando PC_Jobs en Firestore. En espera de órdenes del Cerebro...');
