import fs from 'fs/promises';
import { MemoryService } from './memory.js';

async function run() {
    console.log("Iniciando prueba de migración criptográfica AES-256...");
    const mem = new MemoryService();
    
    try {
        await mem.init();
        console.log("Memoria cargada exitosamente. Cantidad de recuerdos en RAM:", mem.memories.length);
        
        // Añadir un recuerdo de prueba para forzar escritura cifrada si el archivo estaba vacío
        await mem.addMemory("JARVIS encriptación AES-256 verificada el " + new Date().toISOString(), "sistema");
        
        // Leemos el archivo crudo desde el disco
        const raw = await fs.readFile('.engram.json', 'utf8');
        console.log("\n--- Contenido crudo (RAW) en el disco '.engram.json' ---");
        console.log(raw.substring(0, 150) + "...");
        
        // Verificamos si aparenta ser texto plano o no
        if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
            console.error("\n❌ FALLO: El archivo aparenta estar en texto plano JSON.");
            process.exit(1);
        } else if (raw.includes(':')) {
            console.log("\n✅ ÉXITO: El archivo está correctamente cifrado (formato GCM -> iv:authTag:data).");
            process.exit(0);
        } else {
            console.log("\n❓ El formato no es reconocible.");
            process.exit(1);
        }
    } catch (e) {
        console.error("❌ Error durante la ejecución del test:", e);
        process.exit(1);
    }
}
run();
