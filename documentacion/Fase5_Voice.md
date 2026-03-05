# Documentación - Fase 5: Modo JARVIS (Bitácora de STT y TTS)

**Objetivo:** Dotar a SecureClaw de la capacidad de oír al usuario (Speech-to-Text) y hablarle (Text-to-Speech) de forma nativa en Windows, sin servicios de nube de terceros pagos, y lograr una integración nativa y de baja latencia adecuada para la arquitectura de nuestro agente.

## 1. El Reto de los Oídos (Speech-to-Text en local)
Lograr que Node.js escuche el micrófono en Windows fue una de las tareas arquitectónicas más complejas del proyecto, dado el frágil ecosistema de compilaciones C++ y drivers en ese SO.

### Intento #1: Python + PyAudio
*   **Teoría:** Python tiene librerías consolidadas para el manejo de hardware (PyAudio) que podríamos llamar desde Node.js en un child_process para capturar la voz y generar un archivo `.wav`.
*   **Práctica:** Falló porque la versión instalada de Python en la máquina del host (Python 3.14) no tiene "wheels" o binarios precompilados de PyAudio disponibles. Esto forzó al sistema operativo a intentar compilar la librería desde cero en C++, lo cual requiere herramientas pesadas (Microsoft Visual C++ Build Tools) que usualmente no están y rompieron el flujo por falta de la dependencia `portaudio.h`.
*   **Conclusión:** Descartado para mantener SecureClaw ligero y no obligar al usuario a instalar entornos de compilación monstruosos.

### Intento #2: node-record-lpcm16 con SoX (Global)
*   **Teoría:** Existen librerías de NPM nativas que puentean micrófonos siempre y cuando existan aplicaciones de línea de comandos, clásicamente `SoX` (Sound eXchange).
*   **Práctica:** Falló por el "infierno de dependencias" en Windows. Intentamos instalar SoX de manera global usando `winget`. Primero se congeló porque requería aprobaciones manuales a términos y condiciones del Microsoft Store que rompían la automatización. Al forzarlas, el gestor de paquetes de Windows ni siquiera encontró el paquete adecuado.
*   **Conclusión:** Depender de instaladores de terceros a nivel del Sistema Operativo en Windows es demasiado frágil para un asistente que pretende ser portátil.

### Intento #3: SoX Portable (Binarios empacados)
*   **Teoría:** Si SoX no se puede instalar globalmente, descargar un ejecutable `.zip` portátil e incluirlo en la carpeta del repositorio para que Node llame `.\sox\sox.exe` directamente.
*   **Práctica:** Falló miserablemente porque los enlaces de descarga de SourceForge ofrecían archivos `.zip` malformados para las librerías modernas de PowerShell. Al correr `Expand-Archive`, Windows arrojaba errores en `System.IO.Compression.ZipArchive`. Descargar repositorios con wget o curl en powershell de Windows es sumamente problemático.
*   **Conclusión:** Frustración con herramientas antiguas, además SoX tiene poca documentación sobre su driver local (`waveaudio`) en versiones nuevas de Windows.

### LA SOLUCIÓN FUNCIONAL: FFmpeg Nativo (DirectShow)
*   **Teoría:** Utilizar el rey de todo procesamiento multimedia: FFMPEG.
*   **Práctica (ÉXITO):** 
    1. Usamos NPM para instalar `@ffmpeg-installer/ffmpeg` (que mágicamente baja el binario precompilado estático de FFmpeg necesario, resolviendo todo el tema del PATH de Windows sin instalaciones globales).
    2. Usamos `fluent-ffmpeg` en Node para envolver los comandos.
    3. Para conectarnos al micrófono físico usamos el inputFormat `dshow` (DirectShow de Windows). 
    4. Tuvimos un último obstáculo donde FFmpeg no encontraba el dispositivo *"Microphone"*, esto ocurrió por la **regionalización** del sistema operativo del usuario. Consultamos por consola los drivers instalados y lo cambiamos al local exacto: `Micrófono (Realtek High Definition Audio)`.
*   **Paso STT (Gemini Multimodal):** Con el audio PCM `.wav` generado, en vez de usar Whisper local (requiere GPUs) usamos The File API del SDK de Google (`@google/genai`). Adjuntamos el audio directamente a la petición del chat.

## 2. La Voz (Text-to-Speech)
### La Solución Implementada
Decidimos utilizar un motor que las PCs modernas ya incluyen: **SAPI5**.
*   **Módulo:** `tts.js`
*   **Funcionamiento:** Un script de PowerShell `System.Speech.Synthesis.SpeechSynthesizer` convocado desde Node a través de `spawn('powershell.exe')`. 
*   **Beneficios:** Es 100% gratuito (Zero Cost), latencia inmejorablemente baja, libre de dependencias y no requiere enviar los textos creados por el LLM a servidores de terceros para ser leídos. Funciona incluso sin internet si se requiriese.

### Los Ajustes Finales (Evitando la Voz Muda)
La primera implementación de TTS falló silenciosamente (el bot decía estar hablando pero no había audio). Esto se debió a dos problemas intrínsecos de llamar a PowerShell desde Node.js en un entorno hispanohablante:
1.  **Codificación de Caracteres (El Infierno del Encoding):** Al pasar texto con tildes, "ñ", comillas o nombres propios en español (Ej: *"Sauron"*) por línea de comandos a PowerShell, se rompía el string y el script moría pasivamente. **La solución:** Node.js ahora convierte mágicamente todo el texto a **Base64** antes de enviarlo. El comando de PowerShell (`[System.Convert]::FromBase64String`) lo decodifica y recupera el texto perfecto e irrompible.
2.  **Volumen de la Consola:** Agregamos explícitamente el flag `$synth.Volume = 100` en el script nativo de Windows, para que ninguna limitación de fondo apague la voz del agente.

Con esto, SecureClaw tiene los "Sentidos" (Voz y Oídos) completos e interactivos nativamente.
