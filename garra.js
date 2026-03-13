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
import { getFirestore } from 'firebase-admin/firestore';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

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

// ── Publicar info de la PC en Firestore para que el Brain genere rutas correctas
await db.collection('Cloud_Context').doc('pc_info').set({
    homeDir:  os.homedir(),
    username: os.userInfo().username,
    hostname: os.hostname(),
    updatedAt: new Date().toISOString()
}, { merge: true });
console.log(`🏠 [La Garra]: PC context publicado — ${os.userInfo().username}@${os.hostname()} (${os.homedir()})`);

// ── Conciencia: lista de comandos/herramientas absolutamente prohibidos ────────
// La Aduana HITL es la capa de seguridad principal. La Conciencia solo bloquea
// acciones que nunca deben ejecutarse, sin importar qué apruebe el usuario.
const FORBIDDEN_PATTERNS = [
    /format\s+(c:|d:|e:)/i,
    /rm\s+-rf\s+\//i,
    /del\s+\/[sf].*system32/i,
    /bcdedit/i,
    /diskpart/i,
    /sfc\s+\/scannow/i,
];

// ── Conciencia: filtro automático antes de la Aduana ─────────────────────────
function evaluateConscience(tool, params) {
    if (tool === 'run_command' && params?.command) {
        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(params.command)) {
                return { approved: false, reason: `Comando bloqueado por Conciencia: ${params.command}` };
            }
        }
    }
    return { approved: true };
}

// ── Helper: escapar caracteres especiales de Markdown v1 de Telegram ──────────
function escapeMd(str) {
    return String(str).replace(/[_*`\[]/g, '\\$&');
}

// ── Ejecutar herramienta aprobada ─────────────────────────────────────────────
async function executeTool(tool, params, chatId) {
    const targetPath = params?.path ? path.resolve(params.path) : null;

    // ── Archivos y directorios ─────────────────────────────────────────────────
    if (tool === 'list_directory') {
        const dir = targetPath || process.cwd();
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.length === 0) return `📁 *${escapeMd(dir)}*\n\n_(directorio vacío)_`;
        const lines = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${escapeMd(e.name)}`).join('\n');
        return `📁 *${escapeMd(dir)}*\n\n${lines}`;
    }

    if (tool === 'read_file') {
        const content = await fs.readFile(targetPath, 'utf8');
        const lines   = content.split('\n');
        const start   = params.start_line ? Math.max(0, params.start_line - 1) : 0;
        const end     = params.end_line   ? params.end_line : Math.min(lines.length, 100);
        const slice   = lines.slice(start, end).join('\n').replace(/```/g, "'''");
        const header  = lines.length > 100 ? `[Líneas ${start + 1}-${end} de ${lines.length}]\n` : '';
        return header + '```\n' + slice + '\n```';
    }

    if (tool === 'write_file') {
        await fs.writeFile(targetPath, params.content, 'utf8');
        return `✅ Archivo guardado: \`${targetPath}\``;
    }

    if (tool === 'delete_file') {
        await fs.rm(targetPath, { recursive: params.recursive || false });
        return `🗑️ Eliminado: \`${targetPath}\``;
    }

    if (tool === 'create_directory') {
        await fs.mkdir(targetPath, { recursive: true });
        return `✅ Directorio creado: \`${targetPath}\``;
    }

    // ── Comandos del sistema ───────────────────────────────────────────────────
    if (tool === 'run_command') {
        const { stdout, stderr } = await execAsync(params.command, {
            shell: 'powershell.exe',
            timeout: 30_000,
            windowsHide: true
        });
        const raw = (stdout || '') + (stderr ? `\n⚠️ stderr:\n${stderr}` : '');
        const output = raw.replace(/```/g, "'''");
        return output.trim()
            ? '```\n' + output.trim().substring(0, 3000) + '\n```'
            : '_(sin salida)_';
    }

    if (tool === 'get_system_info') {
        const freeRam  = (os.freemem()  / 1024 ** 3).toFixed(2);
        const totalRam = (os.totalmem() / 1024 ** 3).toFixed(2);
        const uptime   = Math.floor(os.uptime() / 3600);
        const cpus     = os.cpus();
        const { stdout: diskRaw } = await execAsync(
            'Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N="UsedGB";E={[math]::Round($_.Used/1GB,1)}},@{N="FreeGB";E={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json',
            { shell: 'powershell.exe', windowsHide: true }
        );
        let diskText = '';
        try {
            const disks = JSON.parse(diskRaw);
            const arr = Array.isArray(disks) ? disks : [disks];
            diskText = arr.map(d => `  ${d.Name}: ${d.UsedGB}GB usado / ${d.FreeGB}GB libre`).join('\n');
        } catch { diskText = diskRaw.trim(); }
        return `💻 *Sistema*\n• CPU: ${escapeMd(cpus[0].model)} (${cpus.length} cores)\n• RAM: ${freeRam}/${totalRam} GB libre\n• Uptime: ${uptime}h\n• OS: ${escapeMd(os.type())} ${escapeMd(os.release())}\n\n💾 *Discos*\n${diskText}`;
    }

    if (tool === 'list_processes') {
        const { stdout } = await execAsync(
            'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,@{N="CPU";E={[math]::Round($_.CPU,1)}},@{N="RAM_MB";E={[math]::Round($_.WorkingSet/1MB,0)}} | ConvertTo-Json',
            { shell: 'powershell.exe', windowsHide: true }
        );
        const procs = JSON.parse(stdout);
        const lines = procs.map(p => `• ${escapeMd(p.Name)} (PID ${p.Id}) — CPU: ${p.CPU}s, RAM: ${p.RAM_MB}MB`).join('\n');
        return `⚙️ *Top 20 procesos*\n\n${lines}`;
    }

    if (tool === 'kill_process') {
        const target = params.pid ? `Stop-Process -Id ${params.pid} -Force` : `Stop-Process -Name "${params.name}" -Force`;
        await execAsync(target, { shell: 'powershell.exe', windowsHide: true });
        return `✅ Proceso terminado: \`${params.pid || params.name}\``;
    }

    if (tool === 'open_app') {
        execAsync(`Start-Process "${params.app}"`, { shell: 'powershell.exe', windowsHide: true }).catch(() => {});
        return `✅ Abriendo: \`${params.app}\``;
    }

    // ── Captura de pantalla ────────────────────────────────────────────────────
    if (tool === 'take_screenshot') {
        const filename = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
        const psCmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=$s.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${filename}',[System.Drawing.Imaging.ImageFormat]::Png)`;
        await execAsync(psCmd, { shell: 'powershell.exe', windowsHide: true, timeout: 15_000 });
        await bot.telegram.sendPhoto(chatId, { source: filename });
        await fs.rm(filename).catch(() => {});
        return '✅ Captura de pantalla enviada.';
    }

    // ── Enviar archivo al chat ─────────────────────────────────────────────────
    if (tool === 'send_file') {
        await fs.access(targetPath); // lanza error si no existe
        const ext = path.extname(targetPath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        const audioExts = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];
        if (imageExts.includes(ext)) {
            await bot.telegram.sendPhoto(chatId, { source: targetPath });
        } else if (videoExts.includes(ext)) {
            await bot.telegram.sendVideo(chatId, { source: targetPath });
        } else if (audioExts.includes(ext)) {
            await bot.telegram.sendAudio(chatId, { source: targetPath });
        } else {
            await bot.telegram.sendDocument(chatId, { source: targetPath });
        }
        return `✅ Archivo enviado: \`${path.basename(targetPath)}\``;
    }

    // ── Memoria cifrada ────────────────────────────────────────────────────────
    if (tool === 'save_memory') {
        const { MemoryService } = await import('./memory.js');
        const mem = new MemoryService();
        await mem.init();
        await mem.addMemory(params.content, params.category);
        return `✅ Recuerdo guardado en Engram: [${escapeMd(params.category)}] ${escapeMd(params.content)}`;
    }

    return `⚠️ Herramienta desconocida: ${escapeMd(tool)}`;
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
    await bot.telegram.sendMessage(
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
        let timeoutId;
        const unsubscribe = jobRef.onSnapshot((snap) => {
            const data = snap.data();
            if (data?.status === 'approved' || data?.status === 'denied') {
                clearTimeout(timeoutId);
                unsubscribe();
                resolve(data.status);
            }
        });

        // Timeout: 120 segundos sin respuesta → denegar automáticamente
        timeoutId = setTimeout(async () => {
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
        result = await executeTool(job.tool, job.params, job.chatId);
    } catch (err) {
        result = `❌ Error ejecutando ${job.tool}: ${err.message}`;
    }

    // ── Enviar resultado al usuario via Telegram ──────────────────────────────
    try {
        await bot.telegram.sendMessage(job.chatId, result, { parse_mode: 'Markdown' });
    } catch {
        // Fallback: enviar sin Markdown si hay error de parseo
        await bot.telegram.sendMessage(job.chatId, result.replace(/[\\*_`\[\]]/g, ''));
    }

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
