import fs from 'fs/promises';
import path from 'path';

async function install() {
    console.log("Instalando JARVIS Daemon (User-Session)...");
    
    // Ruta al inicio del usuario en Windows
    const startupFolder = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbsPath = path.join(startupFolder, 'SecureClaw_JARVIS.vbs');
    
    const projectDir = process.cwd();
    const nodePath = process.execPath; // Ruta absoluta real del Node.js actual
    
    // El VBScript arranca ambos procesos de forma invisible al iniciar Windows
    const vbsContent = `
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "${projectDir}"
WshShell.Run """${nodePath}"" ""${path.join(projectDir, 'index.js')}""", 0, false
WshShell.Run """${nodePath}"" ""${path.join(projectDir, 'garra.js')}""", 0, false
    `.trim();

    try {
        await fs.writeFile(vbsPath, vbsContent, 'utf8');
        console.log("✅ ÉXITO: Daemon de Background instalado correctamente.");
        console.log("📍 Ruta del Auto-Arranque: " + vbsPath);
        console.log("JARVIS ahora se iniciará de forma invisible cada vez que inicies sesión en Windows.");
    } catch (e) {
        console.error("❌ Error instalando el Daemon:", e);
    }
}

install();
