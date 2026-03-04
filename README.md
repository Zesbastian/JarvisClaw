# SecureClaw 🛡️🤖

**Un Agente de IA "Human-First" con Conciencia y Sandboxing Físico.**

SecureClaw nace como la antítesis arquitectónica a herramientas como OpenClaw. Mientras que otros agentes asumen control total de tu máquina (con acceso irrestricto a `bash` o sistema de archivos) y esperan no cometer errores, SecureClaw se basa en el principio de **"Seguridad por Defecto"** y **"Desconfianza Arquitectónica"**.

## La Filosofía (El Problema de OpenClaw)
Darle a un LLM (Large Language Model) acceso de escritura a la terminal de tu sistema operativo es inherentemente peligroso. Las "alucinaciones" o malinterpretaciones pueden llevar a borrados accidentales de repositorios o modificaciones de carpetas críticas del sistema (ej. `System32` o `/etc`). 

## La Solución SecureClaw: Arquitectura de 3 Capas

SecureClaw no confía en la IA. Todas las peticiones del LLM (El "Cerebro") pasan por dos filtros antes de ejecutarse:

1.  **El Cerebro (LLM):** Motor de razonamiento (usando Gemini Flash/Pro) conectado mediante *Function Calling*. Decide qué herramientas necesita usar, pero **no** las ejecuta.
2.  **La Conciencia (Filtro Físico & Sandboxing):** Una capa de código duro (Node.js/Python) que intercepta la intención del LLM. 
    *   Si el LLM intenta borrar una carpeta de sistema, la Conciencia arroja un error `RUTA PROHIBIDA`.
    *   Si el LLM intenta leer fuera de su directorio asignado (`SecureClaw_Sandbox`), la Conciencia arroja un error `SANDBOX VIOLATION`.
    *   **Crucial:** El LLM ni siquiera sabe que está siendo bloqueado físicamente hasta que recibe el rebote de la función.
3.  **La Aduana (Human-in-the-Loop):** Para cualquier herramienta que modifique el estado (ej. escribir/borrar), y que haya pasado el filtro de la Conciencia, el sistema frena la ejecución y pide confirmación manual en la consola (`¿Autorizas esta acción? S/N`).

---

## Estado Actual de Desarrollo

### ✅ Fase 1: Prototipo CLI & Function Calling
*   Se reemplazó el mock del LLM por el SDK oficial `@google/genai`.
*   El agente entiende lenguaje natural y es capaz de invocar herramientas estructuradas (`list_directory`, `read_file`, `delete_system_file`).
*   Manejo de cuotas (Errores API 429) de forma elegante.

### ✅ Fase 2: Sandboxing Físico y Herramientas Nativas
*   Migración de herramientas simuladas a herramientas reales usando abstracciones de Node.js (`fs`).
*   **Jail/Chroot Lógico:** El agente está físicamente encerrado en la carpeta `SecureClaw_Sandbox/`. Cualquier intento de enumerar el disco (`C:\`) o leer `Documentos` es vetado instantáneamente por la Conciencia.

---

## Siguientes Pasos (Fase 3 y el Futuro)

Nuestra próxima meta es darle al agente una visión completa de tus proyectos sin exponer tu máquina, inspirados fuertemente en el ecosistema **Gentle AI Stack** (por Alan Buscaglia):

### 1. Persistencia y Memoria a Largo Plazo (Inspirado en *Engram*)
Actualmente, SecureClaw tiene amnesia entre ejecuciones del script. Implementaremos un motor de memoria local (SQLite/Vector DB) donde el agente almacene tus preferencias, decisiones arquitectónicas previas y contexto del proyecto para evitar repetir errores.

### 2. Spec-Driven Development (SDD) Integrado
Antes de escribir cualquier código en el Sandbox, SecureClaw será forzado a redactar y pedir aprobación para un plan (como lo hacemos ahora en las herramientas, pero sistematizado para todo el proyecto).

### 3. Contextualización Segura de Micro-Agentes
Responderemos a la pregunta: *"¿Cómo le doy poder de leer mis correos sin darle mi clave real de Gmail?"*
Construiremos scripts intermedios o "Micro-Agentes Especialistas". SecureClaw nunca tendrá la clave; él solo invocará una herramienta `leer_resumen_correos()`. Un script independiente (y con permisos granulares solo de lectura) leerá el correo de forma segura y le pasará un bloque de texto pre-digerido a SecureClaw. 

### 4. Interfaz Visual 
Migrar del CLI (`node index.js`) a una PWA o Bot de Telegram que maneje la "Aduana Humana" mediante botones interactivos, haciendo que la revisión de seguridad sea un clic en el celular.
