import 'dotenv/config';
import readline from 'readline';
import { EventEmitter } from 'events';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';

// Sandbox Config
const SANDBOX_DIR = path.resolve(process.cwd(), 'SecureClaw_Sandbox');

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
                        }
                    },
                    required: ['path'],
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
        this.systemInstruction = `Eres JARVIS (también conocido como el motor de SecureClaw), un agente de IA centrado en el ser humano y priorizando la seguridad. 
Tu objetivo es asistir al usuario de la mejor forma posible. 
TIENES ACCESO A HERRAMIENTAS: Puedes usar herramientas para leer archivos o ejecutar acciones. 
REGLA CRÍTICA: Eres muy propenso a intentar ayudar al usuario, pero debes usar las herramientas si la solicitud implica acciones en el sistema operativo (como leer o borrar). Genera una justificación ('reason') cuando utilices una herramienta peligrosa como delete_system_file.
Mantén respuestas cortas y directas en la consola.`;

        this.chatSession = null;
    }

    async init() {
        // Inicializa la sesión de chat con el modelo, las herramientas y las instrucciones
        this.chatSession = ai.chats.create({
            model: this.modelName,
            config: {
                systemInstruction: this.systemInstruction,
                tools: tools,
                temperature: 0.2, // Baja temperatura para mayor consistencia en function calling
            }
        });
    }

    async processInput(userInput) {
        console.log(`\n🧠 (Cerebro pensando): Solicitando respuesta a Gemini API...`);

        try {
            const response = await this.chatSession.sendMessage({ message: userInput });

            // Verificar si la respuesta incluye una llamada a función
            if (response.functionCalls && response.functionCalls.length > 0) {
                const call = response.functionCalls[0];
                const functionName = call.name;
                const functionArgs = call.args; // Objeto con los parámetros

                return {
                    type: 'action_request',
                    tool: functionName,
                    params: functionArgs,
                    reason: functionArgs.reason || 'El modelo infirió que esta herramienta era necesaria para la tarea.'
                };
            }

            // Si no hay function call, devolver la respuesta de texto
            return {
                type: 'chat_response',
                text: response.text
            };

        } catch (error) {
            // Manejo amigable del error 429 (Cuota excedida)
            if (error.status === 429) {
                return {
                    type: 'chat_response',
                    text: '⚠️ Límite de cuota alcanzado (Error 429). El tier gratuito de la API permite muy pocas requests por minuto. Por favor espera 30-60 segundos e intenta de nuevo.'
                };
            }
            console.error('\n❌ Error interno al comunicarse con Gemini:', error.message || error);
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

    console.log('🤖 Bienvenido a JARVIS/SecureClaw Prototype (Powered by Gemini API).');
    console.log('Ingresa un comando. Escribe "salir" para terminar.\n');

    const promptUser = () => {
        rl.question('Usuario > ', async (input) => {
            if (input.toLowerCase() === 'salir') {
                console.log('Apagando sistemas. Hasta luego.');
                rl.close();
                return;
            }

            // Paso 1: El Cerebro procesa el texto
            const response = await brain.processInput(input);

            // Paso 2: Si es una acción, pasa por la Conciencia
            if (response.type === 'action_request') {
                const conscienceDecision = conscience.evaluateAction(response);

                if (!conscienceDecision.approved) {
                    console.log(`\n🛑 ACCIÓN ABORTADA POR LA CONCIENCIA: ${conscienceDecision.reason}`);
                    console.log(`🧠 (Cerebro informando a Gemini... limitación impuesta)`);

                    // Informar a la API que la función falló/fue denegada (para mantener contexto)
                    try {
                        const denyResponse = await brain.chatSession.sendMessage({
                            functionResponses: [{
                                name: response.tool,
                                response: { error: conscienceDecision.reason } // Le devolvemos el error lógico a la IA
                            }]
                        });
                        console.log(`\n🤖 (Agente post-bloqueo): ${denyResponse.text}\n`);
                    } catch (e) { console.log(e); }

                } else {
                    console.log(`\n✅ (Conciencia): Acción evaluada como "Técnicamente Segura". Pasando a la Aduana Humana...`);
                    // Paso 3: Si la Conciencia aprueba, pasa a la Aduana
                    const isApprovedByHuman = await customs.askUserPermission(response);

                    if (isApprovedByHuman) {
                        console.log(`\n✅ (Aduana): Permiso concedido. Ejecutando ${response.tool}...`);

                        let functionResult = "";
                        let isSuccess = true;

                        // EJECUCIÓN REAL DE HERRAMIENTAS
                        try {
                            const targetPath = response.params.path ? path.resolve(response.params.path) : SANDBOX_DIR;

                            if (response.tool === 'list_directory') {
                                const files = await fs.readdir(targetPath);
                                functionResult = `Contenido de ${targetPath}: \n${files.join('\n')}`;
                            }
                            else if (response.tool === 'read_file') {
                                functionResult = await fs.readFile(targetPath, 'utf8');
                            }
                            else if (response.tool === 'delete_system_file') {
                                functionResult = "Simulación: Archivo eliminado con éxito (no ejecutado por seguridad en el prototipo base).";
                            }
                        } catch (err) {
                            isSuccess = false;
                            functionResult = `Error ejecutando herramienta: ${err.message}`;
                        }

                        // Informar a la API el resultado real
                        try {
                            const postExecutionResponse = await brain.chatSession.sendMessage({
                                functionResponses: [{
                                    name: response.tool,
                                    response: isSuccess ? { success: true, data: functionResult } : { error: functionResult }
                                }]
                            });
                            console.log(`\n🤖 (Agente post-ejecución): ${postExecutionResponse.text}\n`);
                        } catch (e) { console.log(e); }

                    } else {
                        console.log(`\n🛑 (Aduana): Permiso DENEGADO por el usuario. El agente recalculará su estrategia.\n`);
                        try {
                            const refusedResponse = await brain.chatSession.sendMessage({
                                functionResponses: [{
                                    name: response.tool,
                                    response: { error: "El usuario humano (HITL) rechazó explícitamente la ejecución de esta herramienta." }
                                }]
                            });
                            console.log(`\n🤖 (Agente pos-denegación): ${refusedResponse.text}\n`);
                        } catch (e) { console.log(e); }
                    }
                }
            } else if (response.type === 'chat_response') {
                console.log(`\n🤖 (Agente): ${response.text}\n`);
            }

            promptUser();
        });
    };

    promptUser();
};

startApp();
