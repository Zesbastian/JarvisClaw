# SecureClaw

**Un Agente de IA "Human-First" con Conciencia, Sandboxing Físico y Gateway Móvil.**

SecureClaw nace como la antítesis arquitectónica a herramientas como OpenClaw. Mientras que otros agentes asumen control total de tu máquina (con acceso irrestricto a `bash` o sistema de archivos) y esperan no cometer errores, SecureClaw se basa en el principio de **"Seguridad por Defecto"** y **"Desconfianza Arquitectónica"**.

## La Filosofía

Darle a un LLM acceso de escritura a la terminal de tu sistema operativo es inherentemente peligroso. Las alucinaciones o malinterpretaciones pueden llevar a borrados accidentales de repositorios o modificaciones de carpetas críticas del sistema.

**La IA no es el riesgo. La confianza ciega en la IA sí lo es.**

## Arquitectura de 3 Capas

SecureClaw no confía en la IA. Todas las peticiones del LLM pasan por dos filtros antes de ejecutarse:

1. **El Cerebro (LLM):** Motor de razonamiento (Gemini Flash) conectado mediante *Function Calling*. Decide qué herramientas necesita usar, pero **no** las ejecuta directamente.
2. **La Conciencia (Sandboxing Físico):** Intercepta la intención del LLM antes de cualquier ejecución.
   - Si el LLM intenta operar fuera del directorio `SecureClaw_Sandbox/`, devuelve `SANDBOX VIOLATION`.
   - Si el LLM intenta usar herramientas destructivas, devuelve `HERRAMIENTA PROHIBIDA`.
   - El LLM no sabe que está siendo bloqueado hasta que recibe el rebote.
3. **La Aduana (Human-in-the-Loop):** Para cualquier acción que haya pasado la Conciencia, el sistema frena y pide confirmación humana — por consola o por botones inline de Telegram desde el celular. **El humano es el último firewall.**

---

## Estado Actual

### ✅ Fase 1: CLI & Function Calling
- SDK oficial `@google/genai` con herramientas reales (`list_directory`, `read_file`, `save_memory`).
- Manejo de cuotas (errores 429) con reintentos automáticos y cuenta regresiva visible.

### ✅ Fase 2: Sandboxing Físico
- Jail lógico: el agente opera exclusivamente dentro de `SecureClaw_Sandbox/`.
- Cualquier intento de acceder a rutas del sistema operativo es vetado por la Conciencia.

### ✅ Fase 3: Memoria Persistente (Engram)
- Memoria a largo plazo cifrada con **AES-256-GCM**. La clave vive en el **Windows Credential Manager** (via `keytar`), nunca en el `.env`.
- Migración automática: si detecta un engrama en texto plano de versiones anteriores, lo cifra al vuelo.
- [📄 Documentación de Arquitectura](documentacion/Fases1-4_Core_y_Optimizacion.md)

### ✅ Fase 4: Optimización de Costos (RAG Local)
- **RAG semántico de $0:** `string-similarity` recupera solo los 3 recuerdos más relevantes por pregunta, sin inflar el contexto.
- **Sliding Window:** historial de sesión acotado a 10 turnos para mantener costos planos.
- **Paginación de herramientas:** `read_file` trunca a 100 líneas por defecto, con `start_line`/`end_line` para paginación explícita.

### ✅ Fase 5: Voz (TTS + STT)
- **TTS:** SAPI5 nativo de Windows vía PowerShell (`tts.js`). Costo cero, sin APIs externas.
- **STT:** FFmpeg captura el micrófono (DirectShow) y envía el audio a Gemini Multimodal. Sin PyAudio, sin Whisper local.
- [📄 Bitácora de implementación (con errores y soluciones)](documentacion/Fase5_Voice.md)

### ✅ Fase 6: Wake Word + Gateway Móvil
- **Wake Word "Jarvis":** Porcupine (Picovoice) corre 100% local, sin internet. Streaming PCM directo desde FFmpeg sin archivos temporales.
- **Mutex anti-doble activación:** evita que la voz de respuesta del agente reactive el wake word.
- **Gateway Telegram:** bot con autenticación por ID numérico. La Aduana se adapta a botones inline `[Aprobar] [Denegar]` en el celular.
- **Daemon silencioso:** instalador VBScript en `shell:startup`. JARVIS arranca invisible con cada login de Windows, con acceso al micrófono (resuelve el Session 0 Isolation de Windows).
- [📄 Bitácora de implementación](documentacion/Fase6_WakeWord.md)

---

## Instalación

```bash
git clone https://github.com/tu-usuario/SecureClaw.git
cd SecureClaw
npm install
cp .env.example .env
# Editar .env con tus claves (ver instrucciones dentro del archivo)
node index.js
```

**Requisitos:** Node.js 18+, Windows (TTS y Wake Word usan APIs nativas de Windows).

---

## Próximo: Fase 7 — Cerebro Dual (Nube + Local)

Separación del agente en dos nodos independientes:
- **El Cerebro (Firebase Cloud Functions):** atiende Telegram desde la nube, 24/7, sin depender de que la PC esté encendida.
- **La Garra (Node local):** sigue siendo la fuente de verdad. Engram cifrado físicamente en tu disco. Se conecta al Cerebro via Firestore como bus de mensajes efímero.

La soberanía del Engram permanece local. La nube es solo un router.
