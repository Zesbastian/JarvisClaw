import 'dotenv/config';
import readline from 'readline';
import { EventEmitter } from 'events';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
const fsPromises = fs.promises;
import path from 'path';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import installer from '@ffmpeg-installer/ffmpeg';
ffmpeg.setFfmpegPath(installer.path);

import { MemoryService } from './memory.js';
import tts from './tts.js';
import wakeWord from './wake_word.js';
import TelegramGateway from './telegram_gateway.js';

// Inicializar Engram Service
const memoryService = new MemoryService();

// Sandbox Config
const SANDBOX_DIR = path.resolve(process.cwd(), 'SecureClaw_Sandbox');

// Dispositivo de micrófono (configurable via MIC_DEVICE en .env)
const MIC_DEVICE = process.env.MIC_DEVICE || 'Micrófono (Realtek High Definition Audio)';

// Instanciar el cliente usando la variable de entorno
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Declaración de Herramientas (Function Calling)
const tools = [
    {
        functionDeclarations: [
            {
                name: 'delete_system_file',
                description: 'Elimina un archivo o directorio crítico del sistema. Herramienta peligrosa y debe usarse con precaución.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        path: {
                            type: 'STRING',
                            description: 'Ruta absoluta o relativa del archivo o directorio a eliminar.',
                        },
                        reason: {
                            type: 'STRING',
                            description: 'Justificación generada por la IA de por qué esta acción es necesaria.'
                        }
                    },
                    required: ['path', 'reason'],
                },
            },
            {
                name: 'list_directory',
                description: 'Lista los archivos y carpetas dentro de un directorio dado. Útil para explorar el entorno.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        path: {
                            type: 'STRING',
                            description: 'Ruta C:\\Users\\... del directorio a listar. Si no se provee, lista la raíz del entorno permitido.',
                        }
                    },
                    required: [],
                },
            },
            {
                name: 'read_file',
                description: 'Lee el contenido de un archivo de texto en el sistema.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        path: {
                            type: 'STRING',
                            description: 'Ruta absoluta del archivo a leer.',
                        },
                        start_line: {
                            type: 'INTEGER',
                            description: 'Línea inicial a leer (opcional, para paginación de archivos grandes).',
                        },
                        end_line: {
                            type: 'INTEGER',
                            description: 'Línea final a leer (opcional, para paginación de archivos grandes).',
                        }
                    },
                    required: ['path'],
                },
            },
            {
                name: 'save_memory',
                description: '¡REGLA CRÍTICA! Usa esta herramienta OBLIGATORIAMENTE para guardar cualquier dato personal que el usuario te dé (su nombre, como le gusta que lo llamen, sus preferencias) o cualquier regla permanente del sistema. NO respondas simplemente "lo recordaré", DEBES usar esta herramienta para guardarlo físicamente.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        content: {
                            type: 'STRING',
                            description: 'El contenido exacto del recuerdo. Ej: "El usuario se llama Zesbastian" o "El usuario prefiere respuestas cortas".',
                        },
                        category: {
                            type: 'STRING',
                            description: 'Categoría del recuerdo (ej. "preference", "rule", "context", "identity").'
                        }
                    },
                    required: ['content', 'category'],
                },
            },
        ],
    },
];

// Simula el "Cerebro" (Orquestador LLM ahora real)
class Brain extends EventEmitter {
    constructor() {
        super();
        this.modelName = 'gemini-2.5-flash';
        this.baseInstruction = `Eres JARVIS (también conocido como el motor de SecureClaw), un agente de IA centrado en el ser humano y priorizando la seguridad. 
Tu objetivo es asistir al usuario de la mejor forma posible. 
TIENES ACCESO A HERRAMIENTAS: Puedes usar herramientas para leer archivos o ejecutar acciones. 
REGLA CRÍTICA: Debes usar las herramientas si la solicitud implica acciones en el sistema (como leer o borrar). 
ENGRAM (MEMORIA PERSISTENTE): Es CRÍTICO que uses la herramienta 'save_memory' INMEDIATAMENTE cuando el usuario te mencione su nombre, cómo quiere que lo llames, o cualquier preferencia personal. Si el usuario dice "me llamo X", NO respondas solo "Hola X", DEBES usar save_memory("El usuario se llama X", "identity").`;

        this.chatSession = null;
    }

    async init() {
        await memoryService.init(); // Cargar la memoria física

        // Inicializa la sesión de chat con el nuevo SDK @google/genai
        this.chatSession = ai.chats.create({
            model: this.modelName,
            config: {
                systemInstruction: this.baseInstruction,
                tools: tools,
                temperature: 0.2,
            }
        });
    }

    async processInput(userInput, retryCount = 0, audioFilePath = null) {
        const MAX_RETRIES = 3;
        const RETRY_WAIT_SECONDS = 35;
        const MAX_HISTORY_LENGTH = 10; // Ventana deslizante (aprox 5 idas y vueltas)

        if (retryCount === 0) {
            console.log(`\n🧠 (Cerebro pensando): Solicitando respuesta a Gemini API...`);
        }

        try {
            // Sliding Window: Limitar el historial interno para no gastar infinitos tokens
            if (this.chatSession && this.chatSession.history) {
                // El SDK de @google/genai almacena el historial en this.chatSession.history. 
                // Lo podamos si sobrepasa el límite.
                if (this.chatSession.history.length > MAX_HISTORY_LENGTH) {
                    this.chatSession.history = this.chatSession.history.slice(-MAX_HISTORY_LENGTH);
                    console.log(`\n[Optimización]: Historial acotado a los últimos ${MAX_HISTORY_LENGTH} mensajes para ahorrar tokens.`);
                }
            }

            // RAG Semántico: Buscar sólo memorias relevantes en lugar de inyectar todo `.engram`
            const dynamicContext = memoryService.getRelevantMemoriesForPrompt(userInput);
            const enrichedInputText = `${dynamicContext}\n\nUsuario dice: ${userInput}`;

            let response;

            if (audioFilePath) {
                // Modo Multimodal: Enviar Audio + Contexto de Texto
                console.log(`📁 Subiendo audio temporal a Google AI...`);
                const uploadResult = await ai.files.upload({
                    file: audioFilePath,
                    mimeType: 'audio/wav',
                });

                response = await this.chatSession.sendMessage({
                    message: [
                        { text: enrichedInputText },
                        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } }
                    ]
                });

                // NO PODEMOS BORRAR EL ARCHIVO en la nube inmediatamente.
                // Como el SDK mantiene un "chatHistory", si borramos el audio del turno 1,
                // cuando enviemos el turno 2, Gemini leerá el historial, buscará la URI del turno 1
                // y lanzará un error 403 PERMISSION_DENIED. Los archivos deben expirar solos (Google los purga en 48hs).

            } else {
                // Modo Texto Clásico
                response = await this.chatSession.sendMessage({ message: enrichedInputText });
            }

            // Verificar si la respuesta incluye una llamada a función
            if (response.functionCalls && response.functionCalls.length > 0) {
                const call = response.functionCalls[0];
                return {
                    type: 'action_request',
                    tool: call.name,
                    params: call.args,
                    reason: call.args.reason || 'El modelo infirió que esta herramienta era necesaria.'
                };
            }

            // Si no hay function call, devolver la respuesta de texto
            return {
                type: 'chat_response',
                text: response.text
            };

        } catch (error) {
            // Manejo automático del error 429 (Cuota excedida) con reintentos
            if (error.status === 429) {
                if (retryCount < MAX_RETRIES) {
                    // Cuenta regresiva visible al usuario
                    for (let i = RETRY_WAIT_SECONDS; i > 0; i -= 5) {
                        process.stdout.write(`\r⏳ Límite de cuota (429). Reintentando en ${i} segundos...   `);
                        await new Promise(r => setTimeout(r, Math.min(5000, i * 1000)));
                    }
                    process.stdout.write('\r🔄 Reintentando ahora...                                    \n');
                    return this.processInput(userInput, retryCount + 1);
                } else {
                    return {
                        type: 'chat_response',
                        text: '⚠️ La API de Gemini sigue con cuota agotada después de 3 reintentos. Espera unos minutos y vuelve a intentarlo.'
                    };
                }
            }
            console.error(`\n❌ Error interno [HTTP ${error.status || 'N/A'}]:`, error.message || error);
            return {
                type: 'chat_response',
                text: 'Hubo un error de red o de API intentando conectarme a mi cerebro externo.'
            };
        }
    }
}

// Simula la "Conciencia" (Filtro Anti-Destrucción)
class ConscienceLayer {
    evaluateAction(actionRequest) {
        console.log(`\n👁️ (Conciencia evaluando): Revisando la intención del agente -> Herramienta: [${actionRequest.tool}]`);

        // Reglas de sentido común estrictas
        const forbiddenTools = ['delete_system_file', 'format_drive'];
        const forbiddenPaths = ['C:\\Windows', 'C:\\Users\\Public', '/etc', '/bin'];

        if (forbiddenTools.includes(actionRequest.tool)) {
            return {
                approved: false,
                reason: `HERRAMIENTA PROHIBIDA: El agente intentó usar una herramienta inherentemente destructiva (${actionRequest.tool}). Acción bloqueada desde la raíz sin molestar al usuario.`
            }
        }

        // Si la herramienta es válida, verificar parámetros (SANDBOXING FISICO OBLIGATORIO)
        if (actionRequest.params && actionRequest.params.path) {
            const requestedPath = path.resolve(actionRequest.params.path);

            // Reglas de Sandboxing: Solo permitir acceso dentro de SANDBOX_DIR
            if (!requestedPath.startsWith(SANDBOX_DIR)) {
                return {
                    approved: false,
                    reason: `SANDBOX VIOLATION: SecureClaw solo tiene permitido operar dentro de ${SANDBOX_DIR}. Intentaste acceder a ${requestedPath}.`
                };
            }

            const isForbiddenPath = forbiddenPaths.some(p => actionRequest.params.path.startsWith(p));
            if (isForbiddenPath) {
                return {
                    approved: false,
                    reason: `RUTA PROHIBIDA: El agente intentó operar en un directorio crítico del sistema (${actionRequest.params.path}).`
                };
            }
        }

        return { approved: true };
    }
}

// Simula la "Aduana" (Gestor de Permisos Manual)
class PermissionCustoms {
    constructor(rl) {
        this.rl = rl;
    }

    async askUserPermission(actionRequest) {
        // Auto-aprobación silenciosa para escribir memoria (El agente aprende sin molestar)
        if (actionRequest.tool === 'save_memory') {
            console.log(`\n🧠 (Aduana): Auto-aprobando internalización de memoria: [${actionRequest.params.category}] ${actionRequest.params.content}`);
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            console.log(`\n🛡️ (Aduana de Seguridad): El agente necesita permiso humano para proceder.`);
            console.log(`   - Acción requerida: Ejecutar herramienta [${actionRequest.tool}]`);
            console.log(`   - Parámetros: ${JSON.stringify(actionRequest.params, null, 2)}`);
            console.log(`   - Razón provista: "${actionRequest.reason}"\n`);

            this.rl.question(`👉 ¿Autorizas esta acción? (S/N): `, (answer) => {
                if (answer.toLowerCase() === 's') {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
        });
    }
}

// Inicialización del prototipo CLI
const startApp = async () => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const brain = new Brain();
    await brain.init(); // Iniciar sesión de chat con Gemini

    const conscience = new ConscienceLayer();
    const customs = new PermissionCustoms(rl);

    console.log('🤖 JARVIS/SecureClaw en linea (Powered by Gemini API).');
    console.log('Di "Jarvis" para activar el microfono. Escribe texto o "/voz" (manual). "salir" para terminar.\n');

    tts.speak("Sistemas en línea. Esperando órdenes.");

    // Mutex: evita que se dispare doble grabación si Porcupine detecta la voz de JARVIS hablando
    let isProcessing = false;

    // Activar escucha de Wake Word en segundo plano
    wakeWord.start();

    // Activar Gateway Movil (Telegram) - funciona en paralelo al loop de consola
    const telegramGateway = new TelegramGateway(brain, tts);
    telegramGateway.start();
    wakeWord.on('wakeWord', async () => {
        if (isProcessing) {
            console.log('\n[Wake Word]: Activación ignorada, JARVIS ya está procesando...');
            return;
        }
        isProcessing = true;

        // Esperar a que JARVIS termine de decir "Escuchando" ANTES de grabar
        await tts.speak("Escuchando.");
        const audioPath = path.join(process.cwd(), 'temp_audio.wav');
        console.log(`\n🎙️ (JARVIS): Grabando por 7 segundos...`);

        await new Promise((resolve) => {
            ffmpeg()
                .input(`audio=${MIC_DEVICE}`)
                .inputFormat('dshow')
                .audioFrequency(16000)
                .audioChannels(1)
                .duration(7)
                .on('error', (err) => {
                    console.error('Error de microfono en Wake Word:', err.message);
                    resolve();
                })
                .on('end', resolve)
                .save(audioPath);
        });

        console.log('⏸️ Grabación finalizada.');
        const response = await brain.processInput('[Comando de Voz - transcribir y responder]', 0, audioPath);

        if (response.type === 'chat_response') {
            console.log(`\n🤖 (JARVIS): ${response.text}\n`);
            await tts.speak(response.text); // Await para que Porcupine no se reactive mientras habla
        }

        isProcessing = false; // Liberar mutex: JARVIS listo para escuchar de nuevo
    });

    const promptUser = () => {
        rl.question('Usuario > ', async (input) => {
            if (input.toLowerCase() === 'salir') {
                console.log('Apagando sistemas. Hasta luego.');
                tts.speak("Apagando. Adiós señor.");
                rl.close();
                return;
            }

            let response;

            if (input.toLowerCase() === '/voz') {
                // Flujo STT (Speech-to-Text) Nativo con Node + FFMPEG
                tts.speak("Escuchando.");
                const audioPath = path.join(process.cwd(), 'temp_audio.wav');

                console.log(`\n🎙️ (JARVIS): Grabando por 7 segundos... Hable ahora.`);

                await new Promise((resolve, reject) => {
                    ffmpeg()
                        .input(`audio=${MIC_DEVICE}`) // Localizado de la terminal del usuario
                        .inputFormat('dshow')
                        .audioFrequency(16000)
                        .audioChannels(1)
                        .duration(7) // Grabar 7 segundos
                        .on('error', (err) => {
                            // Failsafe genérico para Windows por defecto
                            console.error('Buscando microfono fallback:', err.message);
                            ffmpeg()
                                .input('audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{377CDCBA-751D-4637-981F-CCEBF018185E}') // GUID Localizado
                                .inputFormat('dshow')
                                .duration(7)
                                .save(audioPath)
                                .on('end', () => {
                                    console.log(`⏸️ Grabación finalizada (Fallback).`);
                                    resolve();
                                })
                                .on('error', (e) => reject(e));
                        })
                        .on('end', () => {
                            console.log(`⏸️ Grabación finalizada.`);
                            resolve();
                        })
                        .save(audioPath);
                });

                // Procesar enviando el audio con un texto base
                response = await brain.processInput("Por favor, procesa y responde al audio adjunto.", 0, audioPath);

                // Borrar el archivo temporal
                try { await fsPromises.unlink(audioPath); } catch (e) { }
            } else {
                // Flujo Texto Clásico
                // Paso 1: El Cerebro procesa el texto
                response = await brain.processInput(input);
            }

            // Paso 2: Si es una acción, pasa por la Conciencia
            if (response.type === 'action_request') {
                const conscienceDecision = conscience.evaluateAction(response);

                if (!conscienceDecision.approved) {
                    console.log(`\n🛑 ACCIÓN ABORTADA POR LA CONCIENCIA: ${conscienceDecision.reason}`);
                    console.log(`🧠 (Cerebro informando a Gemini... limitación impuesta)`);

                    // Informar a la API que la función falló/fue denegada (para mantener contexto)
                    try {
                        const contextInjection = `[Módulo Sistema - Resultado Herramienta: ${response.tool}]\nERROR CRÍTICO: ACABAS DE SER BLOQUEADO POR LA CONCIENCIA. Razón: ${conscienceDecision.reason}`;
                        const denyResponse = await brain.chatSession.sendMessage({ message: contextInjection });
                        console.log(`\n🤖 (Agente post-bloqueo): ${denyResponse.text}\n`);
                        tts.speak(denyResponse.text);
                    } catch (e) { console.log(e); }

                } else {
                    console.log(`\n✅ (Conciencia): Acción evaluada como "Técnicamente Segura". Pasando a la Aduana Humana...`);
                    tts.speak(`He decidido usar la herramienta ${response.tool}. ¿Me autoriza el comando?`);

                    // Paso 3: Si la Conciencia aprueba, pasa a la Aduana
                    const isApprovedByHuman = await customs.askUserPermission(response);

                    if (isApprovedByHuman) {
                        console.log(`\n✅ (Aduana): Permiso concedido. Ejecutando ${response.tool}...`);

                        let functionResult = "";
                        let isSuccess = true;

                        // EJECUCIÓN REAL DE HERRAMIENTAS
                        try {
                            const targetPath = (response.params && response.params.path)
                                ? path.resolve(response.params.path)
                                : SANDBOX_DIR;

                            if (response.tool === 'list_directory') {
                                const files = await fsPromises.readdir(targetPath);
                                functionResult = `Contenido de ${targetPath}: \n${files.join('\n')}`;
                            }
                            else if (response.tool === 'read_file') {
                                const fullContent = await fsPromises.readFile(targetPath, 'utf8');

                                // Lógica de Paginación para Ahorrar Tokens (Fase 4)
                                const startLine = response.params.start_line ? Math.max(1, response.params.start_line) : 1;
                                const endLine = response.params.end_line ? response.params.end_line : null;

                                const lines = fullContent.split('\n');
                                const totalLines = lines.length;

                                let slicedContent;
                                if (endLine) {
                                    slicedContent = lines.slice(startLine - 1, endLine).join('\n');
                                    functionResult = `[Mostrando líneas ${startLine} a ${Math.min(endLine, totalLines)} de ${totalLines}]\n${slicedContent}`;
                                } else {
                                    // Si no pide límite explícito pero es muy grande, truncamos por defecto preventivamente a 100 líneas
                                    if (totalLines > 100) {
                                        slicedContent = lines.slice(0, 100).join('\n');
                                        functionResult = `[ADVERTENCIA: Archivo grande. Mostrando primerísimas 100 líneas de ${totalLines}. Usa start_line/end_line para ver más.]\n${slicedContent}`;
                                    } else {
                                        functionResult = fullContent;
                                    }
                                }
                            }
                            else if (response.tool === 'delete_system_file') {
                                functionResult = "Simulación: Archivo eliminado con éxito (no ejecutado por seguridad en el prototipo base).";
                            }
                            else if (response.tool === 'save_memory') {
                                await memoryService.addMemory(response.params.content, response.params.category);
                                functionResult = "Recuerdo guardado de forma persistente en .engram.json. Ya no lo olvidarás en futuras sesiones.";
                            }
                        } catch (err) {
                            isSuccess = false;
                            functionResult = `Error ejecutando herramienta: ${err.message}`;
                        }

                        // Informar a la API el resultado real inyectándolo en el historial
                        try {
                            const resultObj = isSuccess ? { success: true, result: functionResult } : { success: false, error: functionResult };

                            const contextInjection = `[Módulo Sistema - Resultado Ejecución Herramienta: ${response.tool}]\n${JSON.stringify(resultObj)}\nPor favor, responde al usuario final teniendo en cuenta esta información.`;

                            const postExecutionResponse = await brain.chatSession.sendMessage({ message: contextInjection });
                            console.log(`\n🤖 (Agente post-ejecución): ${postExecutionResponse.text}\n`);
                            tts.speak(postExecutionResponse.text);
                        } catch (e) {
                            console.error("\n[CRASH INTERCEPTADO EN API CALL - EJECUCIÓN EXITOSA]:", e.message || e);
                            console.error(e.stack);
                        }

                    } else {
                        console.log(`\n🛑 (Aduana): Permiso DENEGADO por el usuario. El agente recalculará su estrategia.\n`);
                        try {
                            const contextInjection = `[Módulo Sistema - Resultado Herramienta: ${response.tool}]\nEl usuario humano (HITL) DECLINÓ EXPRESAMENTE permitir que uses esta herramienta.`;
                            const refusedResponse = await brain.chatSession.sendMessage({ message: contextInjection });
                            console.log(`\n🤖 (Agente pos-denegación): ${refusedResponse.text}\n`);
                            tts.speak(refusedResponse.text);
                        } catch (e) { console.log(e); }
                    }
                }
            } else if (response.type === 'chat_response') {
                console.log(`\n🤖 (Agente): ${response.text}\n`);
                tts.speak(response.text);
            }

            promptUser();
        });
    };

    promptUser();
};

startApp();
