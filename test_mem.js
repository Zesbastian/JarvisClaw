import 'dotenv/config';
import { EventEmitter } from 'events';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import { MemoryService } from './memory.js';

const memoryService = new MemoryService();
const SANDBOX_DIR = path.resolve(process.cwd(), 'SecureClaw_Sandbox');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const tools = [
    {
        functionDeclarations: [
            {
                name: 'save_memory',
                description: 'Guarda un recuerdo importante.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        content: { type: 'STRING' },
                        category: { type: 'STRING' }
                    },
                    required: ['content', 'category'],
                },
            },
        ],
    },
];

class Brain extends EventEmitter {
    constructor() {
        super();
        this.modelName = 'gemini-2.5-flash';
        this.chatSession = null;
    }

    async init() {
        await memoryService.init();
        this.chatSession = ai.chats.create({
            model: this.modelName,
            config: {
                systemInstruction: "Si el usuario dice su nombre, DEBES guardarlo con save_memory.",
                tools: tools,
                temperature: 0.2,
            }
        });
    }

    async testInput() {
        console.log("-> Enviando mensaje...");
        const response = await this.chatSession.sendMessage({ message: "Hola, me llamo Zesbastian" });

        console.log("-> Respuesta:", JSON.stringify(response.functionCalls, null, 2));
        if (response.functionCalls && response.functionCalls.length > 0) {
            const call = response.functionCalls[0];

            console.log("-> Simulando ejecución exitosa y respondiendo a API...");
            try {
                const res = await this.chatSession.sendMessage([
                    {
                        functionResponse: {
                            name: call.name,
                            response: { result: "Memoria guardada." }
                        }
                    }
                ]);
                console.log("-> Respuesta final LLM:", res.text);
            } catch (e) {
                console.error("CRASH EN FUNCTION RESPONSE:");
                console.error(e);
            }
        }
    }
}

const b = new Brain();
b.init().then(() => b.testInput());
