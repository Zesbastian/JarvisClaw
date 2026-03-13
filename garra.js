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
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const execAsync = promisify(exec);

// Convierte PNG a JPEG redimensionado usando ffmpeg (Node.js, no PowerShell → no AV)
function compressScreenshot(pngPath, jpgPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(pngPath)
            .outputOptions(['-q:v 5', '-vf scale=1280:-1'])
            .output(jpgPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

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
        const ts      = Date.now();
        const pngFile = path.join(os.tmpdir(), `screenshot_${ts}.png`);
        const jpgFile = path.join(os.tmpdir(), `screenshot_${ts}.jpg`);

        // 1. Capturar pantalla completa como PNG (PowerShell — funciona sin AV)
        const psCmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=$s.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${pngFile}',[System.Drawing.Imaging.ImageFormat]::Png)`;
        await execAsync(psCmd, { shell: 'powershell.exe', windowsHide: true, timeout: 15_000 });

        // 2. Comprimir a JPEG 1280px via ffmpeg (Node.js — sin PowerShell, el AV no lo toca)
        await compressScreenshot(pngFile, jpgFile);

        // 3. Enviar JPEG al chat de Telegram
        await bot.telegram.sendPhoto(chatId, { source: jpgFile });

        // 4. Guardar en Firestore como base64 para que Gemini pueda ver la pantalla
        try {
            const jpgBuffer = await fs.readFile(jpgFile);
            await db.collection('Cloud_Context').doc('last_screenshot').set({
                base64:    jpgBuffer.toString('base64'),
                mimeType:  'image/jpeg',
                timestamp: ts
            });
            console.log(`📸 [La Garra]: Screenshot guardado en Firestore (${Math.round(jpgBuffer.length / 1024)}KB JPEG)`);
        } catch (e) {
            console.warn('[La Garra]: No se pudo guardar screenshot en Firestore:', e.message);
        }

        // 5. Limpiar temporales
        await fs.rm(pngFile).catch(() => {});
        await fs.rm(jpgFile).catch(() => {});
        return '✅ Captura de pantalla enviada.';
    }

    // ── Foto de webcam ─────────────────────────────────────────────────────────
    if (tool === 'take_webcam_photo') {
        const photoFile = path.join(os.tmpdir(), `webcam_${Date.now()}.jpg`);

        // 1. Listar dispositivos de video disponibles
        const { stderr: devOut } = await execAsync(
            `"${ffmpegInstaller.path}" -f dshow -list_devices true -i dummy`,
            { windowsHide: true }
        ).catch(e => ({ stderr: e.stderr || '' }));

        const videoMatch = devOut.match(/"([^"]+)"\s*\(video\)/);
        if (!videoMatch) return '❌ No se encontró ninguna cámara. Verificá que la webcam esté conectada.';
        const videoDevice = videoMatch[1];

        // 2. Capturar un frame
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(`video=${videoDevice}`)
                .inputFormat('dshow')
                .frames(1)
                .output(photoFile)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // 3. Enviar al chat
        await bot.telegram.sendPhoto(chatId, { source: photoFile });
        await fs.rm(photoFile).catch(() => {});
        return `📷 Foto de webcam enviada (\`${videoDevice}\`).`;
    }

    // ── Grabación de micrófono ─────────────────────────────────────────────────
    if (tool === 'record_audio') {
        const seconds   = Math.min(parseInt(params.seconds) || 5, 30);
        const audioFile = path.join(os.tmpdir(), `audio_${Date.now()}.mp3`);

        // 1. Listar dispositivos de audio
        const { stderr: devOut } = await execAsync(
            `"${ffmpegInstaller.path}" -f dshow -list_devices true -i dummy`,
            { windowsHide: true }
        ).catch(e => ({ stderr: e.stderr || '' }));

        const audioMatch = devOut.match(/"([^"]+)"\s*\(audio\)/);
        if (!audioMatch) return '❌ No se encontró micrófono. Verificá que esté conectado y habilitado.';
        const audioDevice = audioMatch[1];

        // 2. Grabar N segundos
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(`audio=${audioDevice}`)
                .inputFormat('dshow')
                .duration(seconds)
                .audioCodec('libmp3lame')
                .audioBitrate('64k')
                .output(audioFile)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // 3. Enviar audio al chat
        await bot.telegram.sendAudio(chatId, { source: audioFile }, { title: `Grabación ${seconds}s` });
        await fs.rm(audioFile).catch(() => {});
        return `🎤 Audio de ${seconds}s grabado y enviado.`;
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

    // ── Control del mouse ──────────────────────────────────────────────────────
    if (tool === 'mouse_click') {
        const x      = parseInt(params.x);
        const y      = parseInt(params.y);
        const button = params.button || 'left'; // left | right | double
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Windows.Forms;
public class MouseOps {
    [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, int i);
    const uint LDOWN=0x0002, LUP=0x0004, RDOWN=0x0008, RUP=0x0010;
    public static void Do(int x, int y, string btn) {
        Cursor.Position = new Point(x, y);
        System.Threading.Thread.Sleep(120);
        if (btn == "right")       { mouse_event(RDOWN,0,0,0,0); mouse_event(RUP,0,0,0,0); }
        else if (btn == "double") { mouse_event(LDOWN,0,0,0,0); mouse_event(LUP,0,0,0,0); System.Threading.Thread.Sleep(80); mouse_event(LDOWN,0,0,0,0); mouse_event(LUP,0,0,0,0); }
        else                      { mouse_event(LDOWN,0,0,0,0); mouse_event(LUP,0,0,0,0); }
    }
}
"@
[MouseOps]::Do(${x}, ${y}, "${button}")
Write-Output "OK"`.trim();
        await execAsync(psScript, { shell: 'powershell.exe', windowsHide: true });
        const labels = { left: 'Click izquierdo', right: 'Click derecho', double: 'Doble click' };
        return `🖱️ ${labels[button] || 'Click'} en (${x}, ${y})`;
    }

    // ── Control multimedia (teclas globales vía keybd_event) ──────────────────
    if (tool === 'media_control') {
        // SendKeys NO soporta teclas multimedia — se usan Virtual Key Codes con keybd_event
        const vkMap = {
            play_pause:  '0xB3',
            next:        '0xB0',
            prev:        '0xB1',
            mute:        '0xAD',
            volume_up:   '0xAF',
            volume_down: '0xAE',
        };
        const vk = vkMap[params.action];
        if (!vk) return `⚠️ Acción no reconocida: \`${escapeMd(params.action)}\`. Opciones: play_pause, next, prev, volume_up, volume_down, mute.`;
        const psScript = `Add-Type @"
using System.Runtime.InteropServices;
public class MK {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
    public static void Press(byte vk) { keybd_event(vk,0,1,0); keybd_event(vk,0,3,0); }
}
"@
[MK]::Press(${vk})
Write-Output "OK"`;
        await execAsync(psScript, { shell: 'powershell.exe', windowsHide: true });
        const labels = { play_pause: '⏯️ Play/Pause', next: '⏭️ Siguiente', prev: '⏮️ Anterior', volume_up: '🔊 Volumen +', volume_down: '🔉 Volumen -', mute: '🔇 Mute' };
        return `${labels[params.action]} enviado.`;
    }

    // ── Enviar teclas a una aplicación específica ──────────────────────────────
    if (tool === 'send_keys_to_app') {
        const appName = params.app;
        const keys    = params.keys;
        // Focalizar la ventana de la app y enviar las teclas
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$proc = Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.ProcessName -like '*${appName}*' } | Select-Object -First 1
if ($proc) {
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
"@
    [Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')
    Write-Output "OK: $($proc.ProcessName) — $($proc.MainWindowTitle)"
} else {
    Write-Output "ERROR: No se encontró ventana activa para '${ appName }'"
}`.trim();
        const { stdout } = await execAsync(psScript, { shell: 'powershell.exe', windowsHide: true });
        const out = stdout.trim();
        if (out.startsWith('ERROR:')) return `⚠️ ${escapeMd(out)}`;
        return `✅ Teclas \`${escapeMd(keys)}\` enviadas a \`${escapeMd(out.replace('OK: ', ''))}\``;
    }

    // ── Portapapeles ───────────────────────────────────────────────────────────
    if (tool === 'get_clipboard') {
        const { stdout } = await execAsync('Get-Clipboard', { shell: 'powershell.exe', windowsHide: true });
        const content = stdout.trim();
        return content ? `📋 *Portapapeles:*\n\`\`\`\n${content.substring(0, 2000)}\n\`\`\`` : '_(portapapeles vacío)_';
    }

    if (tool === 'set_clipboard') {
        await execAsync(`Set-Clipboard -Value ${JSON.stringify(params.text)}`, { shell: 'powershell.exe', windowsHide: true });
        return `✅ Portapapeles actualizado.`;
    }

    // ── Control de teclado ─────────────────────────────────────────────────────
    if (tool === 'type_text') {
        const escaped = params.text.replace(/'/g, "''");
        await execAsync(
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
            { shell: 'powershell.exe', windowsHide: true }
        );
        return `✅ Texto escrito en la ventana activa.`;
    }

    if (tool === 'get_active_window') {
        const { stdout } = await execAsync(
            `Add-Type -AssemblyName System.Windows; $h=[System.Windows.Interop.WindowInteropHelper]; $w=Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object CPU -Descending | Select-Object -First 1; "$($w.ProcessName) — $($w.MainWindowTitle)"`,
            { shell: 'powershell.exe', windowsHide: true }
        );
        return `🖥️ Ventana activa: \`${stdout.trim()}\``;
    }

    // ── Búsqueda de archivos ───────────────────────────────────────────────────
    if (tool === 'search_files') {
        const searchDir = params.directory ? path.resolve(params.directory) : os.homedir();
        const { stdout } = await execAsync(
            `Get-ChildItem -Path ${JSON.stringify(searchDir)} -Recurse -ErrorAction SilentlyContinue -Filter ${JSON.stringify(params.pattern)} | Select-Object -First 20 FullName | ConvertTo-Json`,
            { shell: 'powershell.exe', windowsHide: true, timeout: 30_000 }
        );
        if (!stdout.trim()) return `_(No se encontraron archivos con patrón \`${escapeMd(params.pattern)}\`)_`;
        const results = JSON.parse(stdout);
        const arr = Array.isArray(results) ? results : [results];
        const lines = arr.map(r => `📄 ${escapeMd(r.FullName || r)}`).join('\n');
        return `🔍 *Resultados para \`${escapeMd(params.pattern)}\`:*\n\n${lines}`;
    }

    // ── Descarga de archivos ───────────────────────────────────────────────────
    if (tool === 'download_file') {
        const dest = params.destination ? path.resolve(params.destination) : path.join(os.homedir(), 'Downloads', path.basename(new URL(params.url).pathname) || 'descarga');
        await execAsync(
            `Invoke-WebRequest -Uri ${JSON.stringify(params.url)} -OutFile ${JSON.stringify(dest)}`,
            { shell: 'powershell.exe', windowsHide: true, timeout: 60_000 }
        );
        return `✅ Descargado en: \`${dest}\``;
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
