import fs from 'fs/promises';
import path from 'path';
import stringSimilarity from 'string-similarity';
import { CryptoService } from './crypto_service.js';

const MEMORY_FILE = path.resolve(process.cwd(), '.engram.json');

export class MemoryService {
    constructor() {
        this.memories = [];
    }

    async init() {
        try {
            // Intenta leer el archivo de memorias
            const data = await fs.readFile(MEMORY_FILE, 'utf8');
            try {
                const decryptedData = await CryptoService.decryptData(data);
                this.memories = JSON.parse(decryptedData);
            } catch (decryptionError) {
                try {
                    this.memories = JSON.parse(data);
                    console.log("⚠️ [MemoryService]: Engram en texto plano detectado. Migrando al vuelo a AES-256...");
                    await this.saveToFile();
                } catch (parseError) {
                    console.error("❌ [MemoryService]: No se pudo procesar la lectura de memoria:", parseError.message);
                    this.memories = [];
                }
            }
        } catch (error) {
            // Si no existe, inicializa un arreglo vacío
            if (error.code === 'ENOENT') {
                this.memories = [];
                await this.saveToFile();
            } else {
                console.error('Error leyendo Engram del disco:', error);
            }
        }
    }

    async addMemory(content, category) {
        const memory = {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            content,
            category
        };
        this.memories.push(memory);
        await this.saveToFile();
        return memory;
    }

    async saveToFile() {
        try {
            const jsonText = JSON.stringify(this.memories, null, 2);
            const encryptedData = await CryptoService.encryptData(jsonText);
            await fs.writeFile(MEMORY_FILE, encryptedData, 'utf8');
        } catch (error) {
            console.error('❌ [MemoryService]: Error guardando Engram cifrado:', error);
        }
    }

    // Devuelve un string optimizado buscando las N memorias más relevantes al input (RAG Seco)
    getRelevantMemoriesForPrompt(userPrompt = "", topN = 3) {
        if (this.memories.length === 0) return "No hay recuerdos a largo plazo todavía.";

        // Si no hay prompt o hay muy pocas memorias, devolvemos todo limitando al topN
        if (!userPrompt || this.memories.length <= topN) {
            const memoryStrings = this.memories.slice(0, topN).map(m => `[${m.category.toUpperCase()}] ${m.content}`);
            return `=== MEMORIAS ENGRAM CONOCIDAS ===\n${memoryStrings.join('\n')}\n===================================`;
        }

        try {
            // Creamos un array de strings (el target a buscar) mezclando categoria y contenido
            const targetStrings = this.memories.map(m => `${m.category} ${m.content}`);

            // Buscamos similitud contra el prompt del usuario
            const matches = stringSimilarity.findBestMatch(userPrompt, targetStrings);

            // Ordenamos de mayor a menor rating manteniendo la referencia original
            const scoredMemories = this.memories.map((m, i) => ({
                memory: m,
                score: matches.ratings[i].rating
            })).sort((a, b) => b.score - a.score);

            // Filtramos las memorias que tienen algo de relevancia (>0) o simplemente tomamos el Top N
            const topMemories = scoredMemories
                .filter(m => m.score > 0.01) // Umbral minimo de relevancia
                .slice(0, topN)
                .map(m => `[${m.memory.category.toUpperCase()}] ${m.memory.content}`);

            if (topMemories.length === 0) return "No hay recuerdos relevantes vinculados a este contexto.";

            return `=== CONTEXTO RELEVANTE RECUPERADO DE LA MEMORIA ===\n${topMemories.join('\n')}\n===================================================`;

        } catch (error) {
            console.error("Error en RAG Semantico Local:", error);
            // Fallback seguro: devolver las ultimas memorias añadidas
            const fallbackMemories = this.memories.slice(-topN).map(m => `[${m.category.toUpperCase()}] ${m.content}`);
            return `=== ULTIMAS MEMORIAS (Fallback) ===\n${fallbackMemories.join('\n')}\n===================================`;
        }
    }
}
