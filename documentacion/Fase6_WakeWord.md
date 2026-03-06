# Documentación - Fase 6: Wake Word y Modo Manos Libres (Hands-Free)

**Objetivo:** Transformar a JARVIS de un asistente de consola manual (donde el usuario debía escribir `/voz`) a un agente verdaderamente manos libres que detecta su nombre en segundo plano usando inteligencia de sonido local completamente offline y gratuita.

## El Problema a Resolver
La Fase 5 dejó a JARVIS con capacidad de grabar voz y hablar, pero sólo al escribir el comando `/voz` en la consola. Eso no es una interfaz Siri/Alexa. Un JARVIS real debe escuchar constantemente y reaccionar al escuchar su nombre.

---

## Arquitectura Implementada

### ¿Por qué NO podemos usar Gemini 24/7 para escuchar?
Enviar el audio del micrófono continuamente al API de Google consumiría toda la cuota de facturación en horas. La solución industrial correcta es usar un motor local ("tiny model") que corra 100% en CPU sin internet.

### El Motor Elegido: Picovoice Porcupine
*   **Librería NPM:** `@picovoice/porcupine-node`
*   **Por qué funciona en Windows:** A diferencia de librerías como `vosk` (que fallan por requerir compilación de C++ con `node-gyp`), Porcupine distribuye binarios pre-compilados. Instaló sin errores con `npm install`.
*   **Keyword integrada:** Porcupine incluye la keyword `JARVIS` en su enum `BuiltinKeyword.JARVIS`. No fue necesario generar ni descargar ningún modelo personalizado. Se autenticó con la API Key personal de PicoVoice (plan gratuito).
*   **Costo de cómputo:** Mínimo. El motor corre en ~50ms de CPU por frame.

### El Pipeline de Audio (Sin Archivo Temporal)
A diferencia del STT (que graba a un `.wav` en disco), el Wake Word funciona con streaming:
1. FFMpeg abre el micrófono (`dshow`) y emite PCM crudo de 16bit/16kHz por `stdout` (sin crear archivo).
2. `wake_word.js` acumula los chunks de audio en un buffer interno.
3. Cada vez que el buffer llega a un frame de 512 samples (el tamaño que Porcupine necesita), lo convierte a un `Int16Array` y llama a `porcupine.process(frame)`.
4. Si `porcupine.process()` devuelve un índice >= 0, se detectó la keyword "JARVIS".

---

## Bugs Encontrados y Corregidos

### Problema #1: Doble Activación
**Síntoma:** En los logs aparecía `🔥 WAKE WORD DETECTADA` dos veces seguidas, iniciando dos grabaciones concurrentes.  
**Causa:** Porcupine seguía escuchando mientras la propia voz de JARVIS (TTS, "Escuchando.") pasaba por el parlante y los micrófonos recogían ese audio, el cual contenía la palabra "Jarvis" implícita en la frase. El motor lo re-detectaba instantáneamente.  
**Solución:** Implementamos un mutex `isProcessing` (booleano simple) en `index.js`. Al detectar la Wake Word, se pone en `true`. Cualquier detección posterior se ignora con un log hasta que se libere volviendo a `false` una vez JARVIS terminó de responder.

### Problema #2: Grab de Audio Mientras JARVIS Habla (Desincronización)
**Síntoma:** JARVIS decía "Escuchando" y simultáneamente se empezaba a grabar. En los 7 segundos de grabación, el audio capturado incluía la propia voz de JARVIS, confundiendo a Gemini.  
**Causa:** La llamada `tts.speak("Escuchando")` era asíncrona y no se esperaba. FFMpeg se lanzaba inmediatamente al siguiente tick del event loop.  
**Solución:** Convertimos a `await tts.speak("Escuchando.")` antes de llamar al recorder y `await tts.speak(response.text)` al responder.

---

## Sensibilidad del Motor
*   **Configuración inicial:** `0.7` (demasiado conservadora para ambientes con ruido ambiente moderado).
*   **Configuración final aplicada:** `0.9` (detecta el nombre con mayor facilidad en entornos normales de hogar/escritorio).
*   **Nota:** Si el entorno tiene mucho ruido de fondo, puede haber falsos positivos. El mutex `isProcessing` protege contra activaciones accidentales dobladas.

---

## Módulos Creados / Modificados
*   **`wake_word.js`** [NUEVO]: Clase `WakeWordListener extends EventEmitter`. Contiene toda la lógica de Porcupine y streaming de FFMpeg.
*   **`index.js`** [MODIFICADO]: Importa `wake_word.js`, lo inicia en `startApp()` y escucha el evento `wakeWord` con protección mutex.
*   **`.env`** [MODIFICADO]: Añadida la variable `PICOVOICE_KEY`.
